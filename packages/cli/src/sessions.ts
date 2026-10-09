import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { bootId, type Db, dbPath, projectRoot, stateDir } from "@swb/shared";
import { runtimeLive } from "./derive.ts";
import { SwbError } from "./errors.ts";
import { cleanEnv, listSessions, quote, SESSIONS, tmux, tmuxBin, tmuxTry } from "./tmux.ts";

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
	if (current.ok) {
		tmux(server, "source-file", path);
		return;
	}
	try {
		start(path);
	} catch (error) {
		// Another swb started the server between the check and the start.
		if (!tmuxTry(server, "show", "-gqv", "@swb_conf_version").ok) throw error;
		tmux(server, "source-file", path);
	}
}

/** Starts the server from a scrubbed environment, so project credentials from mise or direnv stay out of it. */
export function startScrubbed(server: string, args: string[]): void {
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

/**
 * From the passwd entry: inside swb's tmux servers $SHELL is always their default-shell, /bin/sh,
 * and Bun's os.userInfo() reads $SHELL instead of the passwd entry.
 */
function loginShell(): string {
	const query = process.platform === "darwin" ? ["/usr/bin/id", "-P"] : ["getent", "passwd", String(process.getuid?.())];
	const result = Bun.spawnSync(query, { stdout: "pipe", stderr: "pipe" });
	const shell = result.stdout.toString().trim().split(":").at(-1);
	if (result.exitCode !== 0 || !shell) throw new SwbError(`no login shell from ${query.join(" ")}: ${result.stderr.toString().trim()}`);
	return shell;
}

export function randomHex(bytes: number): string {
	return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Starts a managed pi in the background and returns its tmux session; pi comes up on its own time. */
export function launch(cwd: string, resume: string | null, piArgs: string[]): string {
	ensureSessionsServer();
	const name = `${basename(projectRoot(cwd)).replaceAll(/[.:]/g, "_")}-${randomHex(2)}`;
	const shell = loginShell();
	const pi = ["exec pi", ...[...(resume ? ["--session-id", resume] : []), ...piArgs].map(quote)].join(" ");
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
		`SWB_BIN=${SWB}`,
		"-e",
		"PI_IMAGE_PROTOCOL=none",
		`exec env -u TMUX -u TMUX_PANE ${shell} -lic ${quote(pi)}`,
		";",
		"set",
		"-t",
		name,
		"@swb_kind",
		"pi",
		// Kept until pi registers, so a pi that dies on startup leaves its last words for the Deck to show.
		";",
		"set",
		"-p",
		"-t",
		`=${name}:`,
		"remain-on-exit",
		"on",
		";",
		"set",
		"-p",
		"-t",
		`=${name}:`,
		"remain-on-exit-format",
		"",
		...(resume ? [";", "set", "-t", name, "@swb_launch_id", resume] : []),
	);
	return name;
}

/** The Editor for a directory, started if missing. Two Decks asking at once serialize on the db's write lock. */
export function ensureEditor(db: Db, dir: string, editor: string): string {
	ensureSessionsServer();
	return db.tx(() => {
		const existing = listSessions(SESSIONS, "#{@swb_kind}", "#{@swb_dir}").find(([, kind, d]) => kind === "editor" && d === dir);
		if (existing) return existing[0] as string;
		const name = `${basename(dir).replaceAll(/[.:]/g, "_")}-edit-${randomHex(2)}`;
		const shell = loginShell();
		tmux(
			SESSIONS,
			"new-session",
			"-d",
			"-s",
			name,
			"-c",
			dir,
			`exec env -u TMUX -u TMUX_PANE ${shell} -lic ${quote(`exec ${editor}`)}`,
			";",
			"set",
			"-t",
			name,
			"@swb_kind",
			"editor",
			";",
			"set",
			"-t",
			name,
			"@swb_dir",
			dir,
		);
		return name;
	});
}

/**
 * The tmux session hosting a session, starting pi on it if nothing does. Two Decks waking one session at once
 * serialize on the db's write lock, so only one pi ever starts: the second finds the first's live runtime, or its
 * launch still in flight (tagged with the id, no runtime row yet). Unlike a tmux wait-for lock, the kernel releases
 * it when a waker dies mid-launch.
 */
export function wake(db: Db, id: string): string {
	ensureSessionsServer();
	return db.tx(() => {
		const listed = listSessions(SESSIONS, "#{@swb_kind}", "#{@swb_launch_id}", "#{pane_dead}");
		// A pi that quit cleanly with no Deck to reap it leaves a dead pane still tagged with its id.
		for (const [name, kind, launchId, dead] of listed) {
			if (kind === "pi" && launchId === id && dead === "1") tmuxTry(SESSIONS, "kill-session", "-t", `=${name}`);
		}
		const hosts = listed.filter(([, , , dead]) => dead !== "1");
		const host = liveHost(db, id, new Set(hosts.map(([name]) => name as string)));
		if (host) return host;
		const recorded = new Set(db.all("SELECT tmux_session FROM runtimes").map((row) => row.tmux_session as string));
		const inFlight = hosts.find(([name, kind, launchId]) => kind === "pi" && launchId === id && !recorded.has(name as string));
		if (inFlight) return inFlight[0] as string;
		const session = db.get("SELECT cwd FROM sessions WHERE session_id = ?", id);
		if (!session) throw new SwbError(`no session ${id}`);
		return launch(session.cwd as string, id, []);
	});
}

/** The tmux session a live pi hosts this session in, if any. */
function liveHost(db: Db, id: string, hosts: Set<string>): string | null {
	const row = db.get("SELECT tmux_session, boot_id, pid FROM runtimes WHERE session_id = ?", id);
	if (!row) return null;
	const runtime = { tmux_session: row.tmux_session as string, boot_id: row.boot_id as string, pid: row.pid as number };
	return runtimeLive(runtime, bootId(), hosts) ? runtime.tmux_session : null;
}

/** Archives a session, refusing mid-turn; an idle live pi is killed, and editors nobody needs any more go with it. */
export function archive(db: Db, id: string): void {
	const hosts = new Set(listSessions(SESSIONS).map(([name]) => name as string));
	const host = db.tx(() => {
		const session = db.get("SELECT phase FROM sessions WHERE session_id = ?", id);
		if (!session) throw new SwbError(`no session ${id}`);
		const host = liveHost(db, id, hosts);
		if (host && session.phase !== "idle") throw new SwbError("turn running: wait for it to complete");
		db.run(
			"INSERT INTO marks (session_id, archived_at) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET archived_at = excluded.archived_at",
			id,
			Date.now(),
		);
		return host;
	});
	if (host) tmuxTry(SESSIONS, "kill-session", "-t", `=${host}`);
	gc(db);
}

/** Back to open; nothing restarts. */
export function unarchive(db: Db, id: string): void {
	db.tx(() => {
		if (!db.get("SELECT 1 FROM sessions WHERE session_id = ?", id)) throw new SwbError(`no session ${id}`);
		db.run("INSERT INTO marks (session_id, archived_at) VALUES (?, NULL) ON CONFLICT (session_id) DO UPDATE SET archived_at = NULL", id);
	});
}

/** Kills each editor whose directory no open session uses any more. */
export function gc(db: Db): void {
	const listed = listSessions(SESSIONS, "#{@swb_kind}", "#{@swb_dir}");
	const editors = listed.filter(([, kind]) => kind === "editor");
	if (editors.length === 0) return;
	const hosts = new Set(listed.map(([name]) => name as string));
	const open = db.all(
		`SELECT s.cwd FROM sessions s LEFT JOIN marks m USING (session_id)
		 WHERE m.archived_at IS NULL OR m.archived_at < s.last_prompt_at`,
	);
	const provisional = db
		.all("SELECT cwd, tmux_session FROM runtimes WHERE session_id NOT IN (SELECT session_id FROM sessions)")
		.filter((row) => hosts.has(row.tmux_session as string));
	const used = new Set([...open, ...provisional].map((row) => row.cwd as string));
	for (const [name, , dir] of editors) {
		if (!used.has(dir as string)) tmuxTry(SESSIONS, "kill-session", "-t", `=${name}`);
	}
}
