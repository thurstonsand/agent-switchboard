import { rmSync, statSync } from "node:fs";
import { instanced } from "@swb/shared";
import { SwbError } from "./errors.ts";

export const SESSIONS = instanced("swb");
export const DRIVE = instanced("swb-drive");

export const SWB = process.execPath;

/** Runs an swb command from tmux; its output and exit status are dropped, because `run-shell -b` paints either over the pane. */
export function notify(command: string): string {
	if (!/^[A-Za-z0-9/._+@-]+$/.test(SWB))
		throw new SwbError(`swb's path ${SWB} has characters tmux hooks can't quote; move it somewhere plainer`);
	return `run-shell -b "${SWB} ${command} >/dev/null 2>&1 || true"`;
}

export function hook(name: string, command: string): string {
	return `set-hook -g ${name}[0] '${notify(command)}'`;
}

const MIN_MAJOR = 3;
const MIN_MINOR = 8;

function resolveTmux(): string {
	const bin = Bun.which("tmux");
	if (!bin) throw new SwbError("tmux not found on PATH: swb needs tmux 3.8 or newer");
	const out = Bun.spawnSync([bin, "-V"]).stdout.toString().trim();
	const match = /(\d+)\.(\d+)/.exec(out);
	const [major, minor] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
	if (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR)) {
		throw new SwbError(`${bin} is ${out || "an unknown version"}: swb needs tmux 3.8 or newer`);
	}
	return bin;
}

let resolved: string | undefined;
function tmuxBin(): string {
	resolved ??= resolveTmux();
	return resolved;
}

/**
 * The command for a tmux client on server. `-u` declares it UTF-8 whatever its locale: swb reads tab-separated formats
 * and draws UTF-8, and a client with no UTF-8 locale, as launchd, cron, or a bare shell starts one, prints a tab as `_`.
 */
export function tmuxClient(server: string): string[] {
	return [tmuxBin(), "-u", "-L", server];
}

/** Every client swb starts behaves the same inside or outside another tmux. */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env = { ...process.env, ...extra } as Record<string, string>;
	delete env.TMUX;
	delete env.TMUX_PANE;
	return env;
}

/** Clients run from /, so a mise tmux shim can't apply the caller's project env to the panes they create. */
export const CLIENT_CWD = "/";

type Result = { ok: boolean; out: string; err: string };

export function tmuxTry(server: string, ...args: string[]): Result {
	const result = Bun.spawnSync([...tmuxClient(server), ...args], { cwd: CLIENT_CWD, env: cleanEnv(), stdout: "pipe", stderr: "pipe" });
	return { ok: result.exitCode === 0, out: result.stdout.toString().replace(/\n$/, ""), err: result.stderr.toString().trim() };
}

export function tmux(server: string, ...args: string[]): string {
	const result = tmuxTry(server, ...args);
	if (!result.ok) throw new SwbError(`tmux -L ${server} ${args.join(" ")}: ${result.err}`);
	return result.out;
}

export async function tmuxAsync(server: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn([...tmuxClient(server), ...args], { cwd: CLIENT_CWD, env: cleanEnv(), stdout: "pipe", stderr: "pipe" });
	const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if (code !== 0) throw new SwbError(`tmux -L ${server} ${args.join(" ")}: ${err.trim()}`);
	return out.replace(/\n$/, "");
}

/** kill-server returns before the server exits; a new-session in that window reaches the dying server and fails. */
export function killServer(server: string): void {
	const running = tmuxTry(server, "display", "-p", "#{pid}\t#{socket_path}");
	if (!running.ok) return;
	const [pid, socket] = running.out.split("\t") as [string, string];
	const listening = inode(socket);
	// A second upgrader can lose the race to the first; the server is gone either way.
	tmuxTry(server, "kill-server");
	for (;;) {
		try {
			process.kill(Number(pid), 0);
		} catch {
			break;
		}
		Bun.sleepSync(10);
	}
	// A job the server forked for a hook, like session-closed's `swb gc`, holds its listening socket until it execs, and
	// the next server's first client would connect to that and read EOF. Unless another swb already started a new one there.
	if (listening !== null && inode(socket) === listening) rmSync(socket, { force: true });
}

/** A socket's inode, or null once it's gone: another swb can stop the server first. */
function inode(path: string): number | null {
	try {
		return statSync(path).ino;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
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

/**
 * Every harness pane on the sessions server, by its host: the name of the tmux session it was launched in, which its
 * pane carries as @swb_host, so it's found wherever the Deck has put it. With the given format fields.
 */
export function listHosts(...fields: string[]): string[][] {
	return listPanes(SESSIONS, "#{@swb_host}", ...fields).filter(([host]) => host !== "");
}

/** The pane a host's harness runs in, or null once it's gone. */
export function hostPane(host: string): string | null {
	return listHosts("#{pane_id}").find(([name]) => name === host)?.[1] ?? null;
}

/**
 * Ends the pane whose own session is `home`, wherever it is, and with it that session. One on the Deck's Stage goes home
 * first, and the stand-in that held its place there takes its slot back, so the Deck's layout never moves.
 */
export function killHome(home: string): void {
	for (let tries = 0; tries < 5; tries++) {
		const pane = listPanes(SESSIONS, "#{pane_id}", "#{session_name}", "#{@swb_home}", "#{@swb_slot}").find(([, , owner]) => owner === home);
		if (!pane) return;
		const [id, at, , slot] = pane as [string, string, string, string];
		// The Stage may move the pane between that listing and this, so tmux checks it's still where it was as it acts.
		const away = [
			`set -p -t ${quote(`=${home}:`)} @swb_slot ${quote(slot)}`,
			`swap-pane -d -Z -s ${id} -t ${quote(`=${home}:`)}`,
			`kill-pane -t ${id}`,
		].join(" ; ");
		const result = tmuxTry(
			SESSIONS,
			...["if", "-F", "-t", id, `#{==:#{session_name},${home}}`, `kill-pane -t ${id}`],
			`if -F -t ${id} ${quote(`#{&&:#{==:#{session_name},${at}},#{==:#{@swb_slot},${slot}}}`)} ${quote(away)} 'display -p moved'`,
		);
		if (!result.ok || result.out !== "moved") return;
	}
	throw new Error(`${home}'s pane kept moving while swb closed it`);
}

/**
 * Commands, to follow the one creating a session, that give its pane the palette the Deck last mirrored: tmux handles the
 * whole list before the pane's program can ask, so its first OSC 4 query is answered with the terminal's colors rather
 * than none, which it would get off the Deck until the worker's next tick.
 */
export function seedPalette(session: string): string[] {
	const target = quote(`=${session}:`);
	const seeds = Array.from({ length: 16 }, (_, i) => `set -pF -t ${target} 'pane-colours[${i}]' '#{@swb_palette_${i}}'`);
	return [";", "if", "-F", "#{@swb_palette_0}", seeds.join(" ; ")];
}

/** Quotes one argument for a tmux command string. */
export function quote(arg: string): string {
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}
