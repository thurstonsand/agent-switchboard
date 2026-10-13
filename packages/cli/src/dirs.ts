import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { type Db, operatorDir, projectRoot } from "@swb/shared";

export type DirsConfig = { scan: string[]; depth: number; exclude: string[]; include: string[]; sort: "name" | "recent" };

/** A directory the picker offers: a main checkout, one of its worktrees, or a plain directory. */
export type Target = {
	path: string;
	/** The main checkout this is a worktree of; null for a main checkout or a plain directory. */
	repo: string | null;
	branch: string | null;
};

/** A main checkout with its worktrees beneath it, or a plain directory alone. */
export type TargetTree = { root: Target; worktrees: Target[] };

export function expandHome(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

const isDir = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

/** A directory that vanished, or that I may not read, has nothing to offer; anything else is a real failure. */
function readable(dir: string): string[] | null {
	try {
		return readdirSync(dir);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") return null;
		throw error;
	}
}

/** Patterns work like .gitignore: a bare name at any depth, a pattern with a slash under each scan root, `~/` or `/` one directory. */
function excluded(path: string, roots: string[], patterns: string[]): boolean {
	for (const raw of patterns) {
		const pattern = expandHome(raw);
		if (pattern.startsWith("/")) {
			if (path === pattern || path.startsWith(`${pattern}/`)) return true;
		} else if (!pattern.includes("/")) {
			if (path.split("/").includes(pattern)) return true;
		} else {
			const glob = new Bun.Glob(pattern);
			for (const root of roots) {
				const rel = relative(root, path);
				if (rel === "" || rel.startsWith("..")) continue;
				const parts = rel.split("/");
				for (let i = 1; i <= parts.length; i++) if (glob.match(parts.slice(0, i).join("/"))) return true;
			}
		}
	}
	return false;
}

/** Git checkouts up to `depth` beneath dir, never entering one, skipping hidden directories, node_modules, and symlinks. */
function scan(dir: string, depth: number, out: string[]): void {
	if (depth === 0) return;
	for (const name of (readable(dir) ?? []).sort()) {
		if (name.startsWith(".") || name === "node_modules") continue;
		const path = join(dir, name);
		if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) continue;
		if (existsSync(join(path, ".git"))) out.push(path);
		else scan(path, depth - 1, out);
	}
}

type Worktree = { path: string; branch: string | null; bare: boolean };

/**
 * `git worktree list`, less bare entries and worktrees deleted without `git worktree remove`; null when git can't
 * read the checkout, such as a worktree whose main checkout was deleted.
 */
function worktrees(repo: string): Worktree[] | null {
	let porcelain: string;
	try {
		porcelain = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
	const out: Worktree[] = [];
	let current: Worktree | null = null;
	for (const line of porcelain.split("\n")) {
		if (line.startsWith("worktree ")) {
			current = { path: line.slice("worktree ".length), branch: null, bare: false };
			out.push(current);
		} else if (line.startsWith("branch refs/heads/") && current) current.branch = line.slice("branch refs/heads/".length);
		else if (line === "bare" && current) current.bare = true;
	}
	return out.filter((w) => !w.bare && isDir(w.path));
}

/**
 * Every directory the picker offers, as trees, ordered by `sort`: scanned checkouts, `include`, directories added in
 * the picker, and every directory a session has used, each still on disk and not removed. A git directory brings its
 * whole repository, worktrees beneath the main checkout; a removed main checkout takes its worktrees with it.
 * Added and removed directories that no longer exist are forgotten.
 */
export function targets(db: Db, config: DirsConfig): TargetTree[] {
	const roots = config.scan.map(expandHome);
	const marks = db.all("SELECT path, state FROM dirs") as { path: string; state: "added" | "removed" }[];
	for (const { path } of marks) if (!isDir(path)) db.run("DELETE FROM dirs WHERE path = ?", path);
	const removed = new Set(marks.filter((m) => m.state === "removed").map((m) => m.path));
	const recent = new Map<string, number>();
	for (const row of db.all("SELECT cwd, max(last_prompt_at, coalesce(last_settled_at, 0)) AS at FROM sessions"))
		recent.set(row.cwd as string, Math.max(recent.get(row.cwd as string) ?? 0, row.at as number));

	// include and the picker's adds are asked for by name, so exclude never hides them.
	const named = new Set([...config.include.map(expandHome), ...marks.filter((m) => m.state === "added").map((m) => m.path)]);
	const hidden = (path: string) => removed.has(path) || (!named.has(path) && excluded(path, roots, config.exclude));
	const paths = new Set<string>();
	const checkouts: string[] = [];
	for (const root of roots) scan(root, config.depth, checkouts);
	for (const path of [...checkouts, ...named, ...recent.keys()]) if (path !== operatorDir() && isDir(path)) paths.add(path);

	const trees = new Map<string, TargetTree>();
	const plain = (path: string) => {
		if (!hidden(path) && !trees.has(path)) trees.set(path, { root: { path, repo: null, branch: null }, worktrees: [] });
	};
	const repos = new Set<string>();
	for (const path of paths) {
		if (!existsSync(join(path, ".git"))) {
			plain(path);
			continue;
		}
		const repo = projectRoot(path);
		if (repos.has(repo)) continue;
		repos.add(repo);
		const all = worktrees(repo);
		if (all === null) {
			plain(path);
			continue;
		}
		const main = all.find((w) => w.path === repo);
		// A bare clone has no checkout of its own to start in, so each of its worktrees stands alone.
		if (!main) {
			for (const w of all) plain(w.path);
			continue;
		}
		if (hidden(repo)) continue;
		const tree: TargetTree = { root: { path: repo, repo: null, branch: main.branch }, worktrees: [] };
		for (const w of all) if (w.path !== repo && !hidden(w.path)) tree.worktrees.push({ path: w.path, repo, branch: w.branch });
		trees.set(repo, tree);
	}

	const last = (t: Target) => recent.get(t.path) ?? 0;
	const byName = (a: Target, b: Target) => targetName(a).localeCompare(targetName(b));
	const order = config.sort === "recent" ? (a: Target, b: Target) => last(b) - last(a) || byName(a, b) : byName;
	const out = [...trees.values()];
	for (const tree of out) tree.worktrees.sort(order);
	const treeLast = (t: TargetTree) => Math.max(last(t.root), ...t.worktrees.map(last));
	return out.sort((a, b) => (config.sort === "recent" ? treeLast(b) - treeLast(a) || byName(a.root, b.root) : byName(a.root, b.root)));
}

/** A worktree goes by its branch beneath its repository; anything else by its directory. */
export function targetName(t: Target): string {
	return t.repo ? (t.branch ?? basename(t.path)) : basename(t.path);
}

/** Adding a directory brings back its repository, if that was removed. */
export function addDir(db: Db, path: string): void {
	db.tx(() => {
		db.run("DELETE FROM dirs WHERE path = ? AND state = 'removed'", projectRoot(path));
		db.run("INSERT INTO dirs (path, state) VALUES (?, 'added') ON CONFLICT (path) DO UPDATE SET state = 'added'", path);
	});
}

export function removeDir(db: Db, path: string): void {
	db.run("INSERT INTO dirs (path, state) VALUES (?, 'removed') ON CONFLICT (path) DO UPDATE SET state = 'removed'", path);
}

/** Directories beneath what's typed: `~` and `/` lead anywhere, anything else is under base. */
export function completions(typed: string, base: string): string[] {
	const full = typed.startsWith("/") || typed.startsWith("~") ? expandHome(typed) : join(base, typed);
	const dir = typed === "" || typed.endsWith("/") ? full : dirname(full);
	const stem = typed === "" || typed.endsWith("/") ? "" : basename(full).toLowerCase();
	return (readable(dir) ?? [])
		.filter((name) => (stem.startsWith(".") || !name.startsWith(".")) && name.toLowerCase().startsWith(stem) && isDir(join(dir, name)))
		.map((name) => join(dir, name))
		.sort();
}
