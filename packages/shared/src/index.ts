import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

export { Db, isBusy, type Param, type Row } from "./db.ts";

export const SCHEMA_VERSION = 14;

/** How swb exits when its db stayed locked past busy_timeout, EX_TEMPFAIL: a caller may try again. */
export const BUSY_EXIT = 75;

export type Phase = "idle" | "working" | "blocked";
/** The Stage's views of a session: its own agent, whichever harness runs it, its Editor, or both. */
export const VIEWS = ["agent", "editor", "split"] as const;
export type View = (typeof VIEWS)[number];
export const HARNESSES = ["pi", "claude", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export const SNOOZE_PRESETS = ["one_hour", "one_day", "monday", "next_message"] as const;
export type SnoozePreset = (typeof SNOOZE_PRESETS)[number];
/** What swb_update_session's snooze takes, and `swb snooze` too: a preset, off, or a time. */
export type Snooze = SnoozePreset | "off" | { until: string };

/** How a reload leaves a session: carrying on with its work, or waiting for its next prompt. */
export const RELOAD_MODES = ["continue", "idle"] as const;
export type ReloadMode = (typeof RELOAD_MODES)[number];

export function view(name: string): View {
	if (!(VIEWS as readonly string[]).includes(name)) throw new Error(`unknown view ${name}: one of ${VIEWS.join(", ")}`);
	return name as View;
}

export function harness(name: string): Harness {
	if (!(HARNESSES as readonly string[]).includes(name)) throw new Error(`unknown harness ${name}: one of ${HARNESSES.join(", ")}`);
	return name as Harness;
}

/** Suffix every tmux server name with the instance, so tests never touch a real server. */
export function instanced(name: string): string {
	const instance = process.env.SWB_INSTANCE;
	return instance ? `${name}-${instance}` : name;
}

export function stateDir(): string {
	return join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "agent-switchboard");
}

export function configDir(): string {
	return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-switchboard");
}

/** Where Operators live: sessions there coordinate every Project instead of belonging to one. */
export function operatorDir(): string {
	if (physicalOperatorDir) return physicalOperatorDir;
	const dir = join(configDir(), "operator");
	if (!existsSync(dir)) return dir;
	// pi's cwd is physical, so a symlinked ~/.config would otherwise never match.
	physicalOperatorDir = realpathSync(dir);
	return physicalOperatorDir;
}
let physicalOperatorDir: string | undefined;

/** The shortlist as agents read it, which swb writes and every line adds to session_launch's description. */
export function shortlistPath(): string {
	return join(stateDir(), "shortlist.txt");
}

/** The shortlist as swb last wrote it, for session_launch's description; empty before swb has found one. */
export function launchGuide(): string {
	try {
		return readFileSync(shortlistPath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

/** A tool's description as a line hands it out: session_launch's carries the shortlist. */
export function describeTool(name: string, description: string, guide: string): string {
	return name === "session_launch" && guide !== "" ? `${description}\n\n${guide}` : description;
}

export function dbPath(): string {
	return join(stateDir(), "swb.db");
}

export function bootId(): string {
	if (process.platform === "darwin") return execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" }).trim();
	return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

/** EPERM still means the process exists; it just belongs to someone else. */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

// A directory in a cloud drive (Google Drive's File Provider, say) can block git's first stat indefinitely; that
// answers as no repository rather than holding up a harness's startup or an import.
const GIT_TIMEOUT_MS = 5000;

function git(cwd: string, ...args: string[]): string | null {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: GIT_TIMEOUT_MS,
		}).trim();
	} catch {
		return null;
	}
}

const execFileAsync = promisify(execFile);

async function gitAsync(cwd: string, ...args: string[]): Promise<string | null> {
	try {
		return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS })).stdout.trim();
	} catch {
		return null;
	}
}

/**
 * The repository's main checkout, so every worktree of it shares one project; a bare clone has none, so each of its
 * worktrees is its own. Outside git, the cwd.
 */
export function projectRoot(cwd: string): string {
	const found = git(cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir");
	if (!found) return cwd;
	const [checkout, common] = found.split("\n") as [string, string];
	return mainCheckout(common) ?? checkout;
}

/**
 * The checkout a repository keeps as its own, from its git dir: beside it, or where core.worktree says, as a
 * submodule's does; null for a bare clone. `git worktree list` names a submodule's git dir instead.
 */
function mainCheckout(common: string): string | null {
	const config = git(common, "config", "--type=bool-or-str", "--get-regexp", "^core\\.(bare|worktree)$") ?? "";
	const value = (key: string) =>
		config
			.split("\n")
			.find((line) => line.startsWith(`${key} `))
			?.slice(key.length + 1);
	if (value("core.bare") === "true") return null;
	const worktree = value("core.worktree");
	return worktree ? resolve(common, worktree) : dirname(common);
}

/** The top of the checkout cwd is in, a linked worktree's own; else the cwd. */
export function checkoutRoot(cwd: string): string {
	return git(cwd, "rev-parse", "--show-toplevel") ?? cwd;
}

const WORKTREE_QUERY = ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"];

function worktreeFrom(result: string | null): { path: string; common: string } | null {
	if (!result) return null;
	const [path, dir, common] = result.split("\n") as [string, string, string];
	return dir !== common ? { path, common } : null;
}

/** A linked checkout, including when cwd is beneath it; never the repository's main checkout. */
export function linkedWorktree(cwd: string): { path: string; common: string } | null {
	return worktreeFrom(git(cwd, ...WORKTREE_QUERY));
}

/** linkedWorktree without blocking, for a caller asking about many directories at once. */
export async function linkedWorktreeAsync(cwd: string): Promise<{ path: string; common: string } | null> {
	return worktreeFrom(await gitAsync(cwd, ...WORKTREE_QUERY));
}

export function branch(cwd: string): string | null {
	const name = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
	return name === "HEAD" ? git(cwd, "rev-parse", "--short", "HEAD") : name;
}
