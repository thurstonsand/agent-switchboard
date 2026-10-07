import { instanced } from "@swb/shared";
import { SwbError } from "./errors.ts";

export const SESSIONS = instanced("swb");
export const UI = instanced("swb-ui");
export const DRIVE = instanced("swb-drive");

const MIN_MAJOR = 3;
const MIN_MINOR = 7;

function resolveTmux(): string {
	const bin = Bun.which("tmux");
	if (!bin) throw new SwbError("tmux not found on PATH: swb needs tmux 3.7 or newer");
	const out = Bun.spawnSync([bin, "-V"]).stdout.toString().trim();
	const match = /(\d+)\.(\d+)/.exec(out);
	const [major, minor] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
	if (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR)) {
		throw new SwbError(`${bin} is ${out || "an unknown version"}: swb needs tmux 3.7 or newer`);
	}
	return bin;
}

let resolved: string | undefined;
export function tmuxBin(): string {
	resolved ??= resolveTmux();
	return resolved;
}

/** Every client swb starts behaves the same inside or outside another tmux. */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env = { ...process.env, ...extra } as Record<string, string>;
	delete env.TMUX;
	delete env.TMUX_PANE;
	return env;
}

type Result = { ok: boolean; out: string; err: string };

export function tmuxTry(server: string, ...args: string[]): Result {
	const result = Bun.spawnSync([tmuxBin(), "-L", server, ...args], { env: cleanEnv(), stdout: "pipe", stderr: "pipe" });
	return { ok: result.exitCode === 0, out: result.stdout.toString().replace(/\n$/, ""), err: result.stderr.toString().trim() };
}

export function tmux(server: string, ...args: string[]): string {
	const result = tmuxTry(server, ...args);
	if (!result.ok) throw new SwbError(`tmux -L ${server} ${args.join(" ")}: ${result.err}`);
	return result.out;
}

export async function tmuxAsync(server: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn([tmuxBin(), "-L", server, ...args], { env: cleanEnv(), stdout: "pipe", stderr: "pipe" });
	const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if (code !== 0) throw new SwbError(`tmux -L ${server} ${args.join(" ")}: ${err.trim()}`);
	return out.replace(/\n$/, "");
}

/** Session names on a server, with the given format fields, or none when the server is down. */
export function listSessions(server: string, ...fields: string[]): string[][] {
	const result = tmuxTry(server, "list-sessions", "-F", ["#{session_name}", ...fields].join("\t"));
	if (!result.ok) return [];
	return result.out
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t"));
}

/** Every pane on a server, with the given format fields, or none when the server is down. */
export function listPanes(server: string, ...fields: string[]): string[][] {
	const result = tmuxTry(server, "list-panes", "-a", "-F", fields.join("\t"));
	if (!result.ok) return [];
	return result.out
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t"));
}

/** Quotes one argument for a tmux command string. */
export function quote(arg: string): string {
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}
