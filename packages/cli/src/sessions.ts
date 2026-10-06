import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { dbPath, projectRoot, stateDir } from "@swb/shared";
import { SwbError } from "./errors.ts";
import { cleanEnv, quote, SESSIONS, tmux, tmuxBin, tmuxTry } from "./tmux.ts";

export const SWB = process.execPath;

/** A hook line; its output is dropped, because a failed `run-shell -b` paints its error over the pane. */
function hook(name: string, command: string): string {
	if (!/^[A-Za-z0-9/._+@-]+$/.test(SWB))
		throw new SwbError(`swb's path ${SWB} has characters tmux hooks can't quote; move it somewhere plainer`);
	return `set-hook -g ${name}[0] 'run-shell -b "${SWB} ${command} >/dev/null 2>&1"'`;
}

/** The whole config of the sessions server: the user's tmux config never loads here. */
function sessionsConf(): string {
	return [
		"set -g default-terminal tmux-256color",
		"set -g default-shell /bin/sh",
		"set -as terminal-features ',*:RGB:hyperlinks:extkeys'",
		"set -s extended-keys always",
		"set -s extended-keys-format csi-u",
		"set -s escape-time 0",
		"set -s focus-events on",
		"set -s set-clipboard on",
		"set -s exit-empty off",
		"set -g mouse on",
		"set -g mode-keys vi",
		"set -g history-limit 50000",
		"set -g prefix None",
		"set -g prefix2 None",
		// -q: once emptied, the table no longer exists, and a re-source would fail on it.
		"unbind -aq -T prefix",
		"set -g remain-on-exit off",
		"set -g destroy-unattached off",
		"set -g exit-unattached off",
		"set -g detach-on-destroy on",
		"set -g status off",
		"set -g pane-border-status off",
		"set -g set-titles off",
		// Nested tmux turns Alt+Enter into a legacy ESC CR, which pi reads as Enter.
		"bind-key -n M-Enter if-shell -F '#{m:*Ext*,#{pane_key_mode}}' 'send-keys -H 1b 5b 31 33 3b 33 75' 'send-keys M-Enter'",
		hook("client-focus-in", "visit --client #{client_tty} --in"),
		hook("client-focus-out", "visit --client #{client_tty} --out"),
		hook("client-detached", "detached --session #{session_name}"),
		hook("session-closed", "gc"),
	].join("\n");
}

function confVersion(conf: string): string {
	return Bun.hash(conf).toString(16);
}

/** Sources the embedded config into a server whenever it differs from what the server last loaded. */
export function ensureServer(server: string, conf: string, start: (confPath: string) => void): void {
	const version = confVersion(conf);
	const dir = join(stateDir(), "tmux");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${server}.conf`);
	const current = tmuxTry(server, "show", "-gqv", "@swb_conf_version");
	if (current.ok && current.out === version) return;
	writeFileSync(path, `${conf}\nset -g @swb_conf_version ${version}\n`);
	if (current.ok) tmux(server, "source-file", path);
	else start(path);
}

/** Starts the server from a scrubbed environment, so project credentials from mise or direnv stay out of it. */
function startScrubbed(server: string, args: string[]): void {
	const script = [
		'if command -v mise >/dev/null 2>&1; then eval "$(mise -C / hook-env -s bash 2>/dev/null)"; fi',
		'if command -v direnv >/dev/null 2>&1; then exec direnv exec / "$@"; fi',
		'exec "$@"',
	].join("\n");
	const result = Bun.spawnSync(["/bin/sh", "-c", script, "sh", tmuxBin(), "-L", server, ...args], {
		env: cleanEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new SwbError(`starting tmux -L ${server}: ${result.stderr.toString().trim()}`);
}

export function ensureSessionsServer(): void {
	ensureServer(SESSIONS, sessionsConf(), (path) =>
		startScrubbed(SESSIONS, ["-f", path, "new-session", "-d", "-s", "swb-ctl", ";", "set", "-t", "swb-ctl", "@swb_kind", "control"]),
	);
}

function hex4(): string {
	return crypto.getRandomValues(new Uint16Array(1))[0]?.toString(16).padStart(4, "0") as string;
}

/** Starts a managed pi in the background and returns its tmux session; pi comes up on its own time. */
export function launch(cwd: string, resume: string | null): string {
	ensureSessionsServer();
	const name = `${basename(projectRoot(cwd)).replaceAll(/[.:]/g, "_")}-${hex4()}`;
	const shell = process.env.SHELL || "/bin/sh";
	const pi = resume ? `exec pi --session-id ${resume}` : "exec pi";
	tmux(
		SESSIONS,
		"new-session",
		"-d",
		"-s",
		name,
		"-c",
		cwd,
		"-e",
		"SWB_MANAGED=1",
		"-e",
		`SWB_DB=${dbPath()}`,
		"-e",
		`SWB_TMUX_SESSION=${name}`,
		"-e",
		"PI_IMAGE_PROTOCOL=none",
		`env -u TMUX -u TMUX_PANE ${shell} -lic ${quote(pi)}`,
		";",
		"set",
		"-t",
		name,
		"@swb_kind",
		"pi",
		...(resume ? [";", "set", "-t", name, "@swb_launch_id", resume] : []),
	);
	return name;
}
