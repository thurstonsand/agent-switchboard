import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export { Db, type Param, type Row } from "./db.ts";

export const SCHEMA_VERSION = 2;

export type Phase = "idle" | "working" | "blocked";
export type View = "pi" | "editor" | "split";

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

function git(cwd: string, ...args: string[]): string | null {
	try {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

/** The parent of the git common dir, so every worktree of a repository shares one project; else the cwd. */
export function projectRoot(cwd: string): string {
	const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
	return common ? dirname(common) : cwd;
}

export function branch(cwd: string): string | null {
	const name = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
	return name === "HEAD" ? git(cwd, "rev-parse", "--short", "HEAD") : name;
}
