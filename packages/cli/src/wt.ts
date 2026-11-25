import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { branch as gitBranch, inGitRepo, linkedWorktree, projectRoot } from "@swb/shared";
import { SwbError } from "./errors.ts";

// Wrapper around the external `wt` CLI (git-wt on Windows). `wt` reports target `cd` paths on fd 3; we back fd 3 with
// a temp file rather than a Bun extra pipe to avoid Bun's async unix-socket unhandledRejection bug.

export type WtResult = {
	stdout: string;
	stderr: string;
	cd?: string;
	code: number;
	spawnErrorCode?: string;
};

export function wtBinary(): string {
	return process.platform === "win32" ? "git-wt" : "wt";
}

/** Whether `wt` is installed and runnable in `cwd` (guards against missing binary and inactive mise shims). */
export function isWtInstalled(cwd = process.cwd()): boolean {
	const bin = wtBinary();
	if (!Bun.which(bin)) return false;
	const checkCwd = existsSync(cwd) ? cwd : homedir();
	const probe = spawnSync(bin, ["--version"], { cwd: checkCwd, stdio: "ignore", timeout: 2000 });
	return probe.status === 0;
}

function openCdCapture(): { fd: number; collect: () => string } {
	const dir = mkdtempSync(join(tmpdir(), "swb-wt-cd-"));
	const path = join(dir, "cd");
	const fd = openSync(path, "w");
	return {
		fd,
		collect() {
			try {
				closeSync(fd);
			} catch {}
			let cd = "";
			try {
				cd = readFileSync(path, "utf8");
			} catch {}
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {}
			return cd.trim();
		},
	};
}

export function execWt(args: string[], cwd: string): Promise<WtResult> {
	return new Promise((done) => {
		const capture = openCdCapture();
		const bin = wtBinary();
		const child = spawn(bin, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe", capture.fd] });
		let stdout = "";
		let stderr = "";
		let spawnError: NodeJS.ErrnoException | undefined;
		const out = child.stdio[1] as Readable;
		const err = child.stdio[2] as Readable;
		out.setEncoding("utf8");
		err.setEncoding("utf8");
		out.on("data", (chunk: string) => {
			stdout += chunk;
		});
		err.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			spawnError = error as NodeJS.ErrnoException;
		});
		child.on("close", (code) => {
			const cd = capture.collect();
			if (spawnError) {
				done({
					stdout,
					stderr: stderr || (spawnError.code === "ENOENT" ? `${bin} binary not found on PATH` : spawnError.message),
					code: 127,
					...(spawnError.code ? { spawnErrorCode: spawnError.code } : {}),
				});
				return;
			}
			done({ stdout, stderr, ...(cd ? { cd } : {}), code: code ?? 1 });
		});
	});
}

export function execWtSync(args: string[], cwd: string): WtResult {
	const capture = openCdCapture();
	const bin = wtBinary();
	const result = spawnSync(bin, args, { cwd, shell: false, encoding: "utf8", stdio: ["ignore", "pipe", "pipe", capture.fd] });
	const cd = capture.collect();
	if (result.error) {
		const err = result.error as NodeJS.ErrnoException;
		return {
			stdout: result.stdout ?? "",
			stderr: (result.stderr ?? "") || (err.code === "ENOENT" ? `${bin} binary not found on PATH` : err.message),
			code: 127,
			...(err.code ? { spawnErrorCode: err.code } : {}),
		};
	}
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(cd ? { cd } : {}), code: result.status ?? 1 };
}

export async function runWt(args: string[], cwd: string): Promise<WtResult> {
	const result = await execWt(args, cwd);
	if (result.code !== 0) throw new SwbError(result.stderr.trim() || `${wtBinary()} ${args[0] ?? ""} exited ${result.code}`);
	return result;
}

/** Splits a shell-like slash command argument string, preserving single and double quoted tokens. */
export function tokenizeArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let started = false;
	for (const ch of input) {
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			started = true;
		} else if (/\s/.test(ch)) {
			if (started) {
				args.push(current);
				current = "";
				started = false;
			}
		} else {
			current += ch;
			started = true;
		}
	}
	if (started) args.push(current);
	return args;
}

/** Injects a flag before any `--` separator, replacing any existing copy of the same flag. */
export function injectFlag(args: string[], flag: string): string[] {
	const separator = args.indexOf("--");
	const options = separator < 0 ? args : args.slice(0, separator);
	const positionals = separator < 0 ? [] : args.slice(separator);
	const filtered = options.filter((arg) => arg !== flag && !arg.startsWith(`${flag}=`));
	return [...filtered, flag, ...positionals];
}

export function expandUserPath(input: string, cwd: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
	return resolve(cwd, input);
}

export function shortenHome(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function pathContains(parent: string, child: string): boolean {
	const p = existsSync(parent) ? realpathSync(parent) : resolve(parent);
	const c = existsSync(child) ? realpathSync(child) : resolve(child);
	return c === p || c.startsWith(p + sep);
}

export type WorktreeEntry = {
	repo?: string;
	name: string;
	current: boolean;
	branch: string;
	parent: string | null;
	state: string;
	path: string | null;
};

type GitWorktree = { path: string; branch: string | null };

export function gitWorktrees(cwd: string): GitWorktree[] {
	const out = Bun.spawnSync(["git", "-C", cwd, "worktree", "list", "--porcelain", "-z"], { stdout: "pipe", stderr: "pipe" });
	if (out.exitCode !== 0) return [];
	const items: GitWorktree[] = [];
	for (const record of out.stdout.toString().split("\0\0")) {
		if (!record) continue;
		const fields = record.split("\0");
		const wt = fields.find((f) => f.startsWith("worktree "))?.slice("worktree ".length);
		if (!wt) continue;
		const ref = fields.find((f) => f.startsWith("branch "))?.slice("branch ".length);
		const branch = ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : (ref ?? null);
		items.push({ path: wt, branch });
	}
	return items;
}

/** Parses `wt list` (or `wt list --all`) and enriches entries with absolute filesystem paths. */
export async function listWorktrees(cwd: string, all = false): Promise<{ entries: WorktreeEntry[]; raw: string }> {
	const result = await runWt(all ? ["list", "--all"] : ["list"], cwd);
	const raw = result.stdout.trim();
	if (!raw || raw === "No worktrees found.") return { entries: [], raw };
	const lines = raw.split("\n");
	const header = lines[0] ?? "";
	const entries: WorktreeEntry[] = [];
	if (all) {
		const repoCol = header.indexOf("REPO");
		const nameCol = header.indexOf("NAME");
		const branchCol = header.indexOf("BRANCH");
		const parentCol = header.indexOf("PARENT");
		const stateCol = header.indexOf("STATE");
		if (repoCol < 0 || nameCol < 0 || branchCol < 0) return { entries: [], raw };
		for (const line of lines.slice(1)) {
			if (!line.trim() || line.startsWith("repo:")) continue;
			const repo = line.slice(repoCol, nameCol).trim();
			const rawName = line.slice(nameCol, branchCol).trim();
			const current = rawName.endsWith(" *");
			const name = current ? rawName.slice(0, -2).trim() : rawName;
			const branch = (parentCol >= 0 ? line.slice(branchCol, parentCol) : line.slice(branchCol)).trim();
			const parentVal = (parentCol >= 0 ? (stateCol >= 0 ? line.slice(parentCol, stateCol) : line.slice(parentCol)) : "").trim();
			const state = (stateCol >= 0 ? line.slice(stateCol) : "").trim();
			const guessPath = join(homedir(), ".wt", "worktrees", repo, name);
			entries.push({
				repo,
				name,
				current,
				branch,
				parent: parentVal && parentVal !== "-" ? parentVal : null,
				state: state || "clean",
				path: existsSync(guessPath) ? realpathSync(guessPath) : null,
			});
		}
		return { entries, raw };
	}

	const nameCol = header.indexOf("NAME");
	const branchCol = header.indexOf("BRANCH");
	const parentCol = header.indexOf("PARENT");
	const stateCol = header.indexOf("STATE");
	if (nameCol < 0 || branchCol < 0) return { entries: [], raw };

	const gwt = gitWorktrees(cwd);
	const mainPath = gwt[0]?.path ?? projectRoot(cwd);

	for (const line of lines.slice(1)) {
		if (!line.trim() || line.startsWith("repo:")) continue;
		const rawName = line.slice(nameCol, branchCol).trim();
		const current = rawName.endsWith(" *");
		const name = current ? rawName.slice(0, -2).trim() : rawName;
		const branch = (parentCol >= 0 ? line.slice(branchCol, parentCol) : line.slice(branchCol)).trim();
		const parentVal = (parentCol >= 0 ? (stateCol >= 0 ? line.slice(parentCol, stateCol) : line.slice(parentCol)) : "").trim();
		const state = (stateCol >= 0 ? line.slice(stateCol) : "").trim();
		let path: string | null = null;
		if (name === "(root)") {
			path = mainPath;
		} else {
			const matched = gwt.find((w) => w.branch === branch) ?? gwt.find((w) => basename(w.path) === name);
			if (matched) path = matched.path;
			else {
				const resolved = await execWt(["path", name], cwd);
				if (resolved.code === 0 && resolved.stdout.trim()) path = resolved.stdout.trim();
			}
		}
		entries.push({
			name,
			current,
			branch,
			parent: parentVal && parentVal !== "-" ? parentVal : null,
			state: state || "clean",
			path,
		});
	}
	return { entries, raw };
}

export type WorktreeContext = {
	inGit: boolean;
	wtInstalled: boolean;
	isLinked: boolean;
	branch: string | null;
	worktreeName: string | null;
	parentBranch: string | null;
	dirty: boolean;
};

/** Inspects a directory's git and wt state for the Deck's Move menu. */
export async function worktreeContext(cwd: string): Promise<WorktreeContext> {
	const wtInstalled = isWtInstalled(cwd);
	const inGit = existsSync(cwd) && inGitRepo(cwd);
	if (!inGit) return { inGit: false, wtInstalled, isLinked: false, branch: null, worktreeName: null, parentBranch: null, dirty: false };
	const isLinked = linkedWorktree(cwd) !== null;
	const branch = gitBranch(cwd);
	const status = Bun.spawnSync(["git", "-C", cwd, "status", "--porcelain"], { stdout: "pipe", stderr: "pipe" });
	const dirty = status.exitCode === 0 && status.stdout.length > 0;
	if (!wtInstalled) return { inGit: true, wtInstalled: false, isLinked, branch, worktreeName: null, parentBranch: null, dirty };
	try {
		const { entries } = await listWorktrees(cwd, false);
		const current = entries.find((e) => e.current);
		const root = entries.find((e) => e.name === "(root)");
		return {
			inGit: true,
			wtInstalled: true,
			isLinked,
			branch: current?.branch ?? branch,
			worktreeName: current && current.name !== "(root)" ? current.name : null,
			parentBranch: current?.parent ?? (isLinked ? (root?.branch ?? "main") : null),
			dirty,
		};
	} catch {
		return { inGit: true, wtInstalled: true, isLinked, branch, worktreeName: null, parentBranch: null, dirty };
	}
}

export type CheckoutBranch = { name: string; remote: boolean };

/** Local and remote branches available to check out into a new worktree (excluding branches already checked out). */
export function availableCheckoutBranches(cwd: string): CheckoutBranch[] {
	const checkedOut = new Set(gitWorktrees(cwd).flatMap((w) => (w.branch ? [w.branch] : [])));
	const localOut = Bun.spawnSync(["git", "-C", cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const localNames =
		localOut.exitCode === 0
			? localOut.stdout
					.toString()
					.split("\n")
					.map((s) => s.trim())
					.filter((name) => name && !checkedOut.has(name))
			: [];
	const localSet = new Set(localNames);
	const remoteOut = Bun.spawnSync(["git", "-C", cwd, "for-each-ref", "--format=%(refname:short)", "refs/remotes"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const remoteNames =
		remoteOut.exitCode === 0
			? remoteOut.stdout
					.toString()
					.split("\n")
					.map((s) => s.trim())
					.filter((ref) => ref && !ref.endsWith("/HEAD"))
					.map((ref) => ref.replace(/^origin\//, ""))
					.filter((name) => name && !checkedOut.has(name) && !localSet.has(name))
			: [];
	const seen = new Set<string>();
	const out: CheckoutBranch[] = [];
	for (const name of localNames) {
		seen.add(name);
		out.push({ name, remote: false });
	}
	for (const name of remoteNames) {
		if (seen.has(name)) continue;
		seen.add(name);
		out.push({ name, remote: true });
	}
	return out;
}
