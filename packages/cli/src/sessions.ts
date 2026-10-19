import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { bootId, type Db, dbPath, type Harness, operatorDir, projectRoot, stateDir } from "@swb/shared";
import { markArchived } from "@swb/shared/record";
import { now, since } from "@swb/shared/trace";
import { archivedInCodex } from "./deck/transcript.ts";
import { type RuntimeRow, runtimeLive } from "./derive.ts";
import { SwbError } from "./errors.ts";
import { writeClaudeLine } from "./lines.ts";
import { claudeOperatorSettings } from "./operator.ts";
import { openStore } from "./store.ts";
import { CLIENT_CWD, cleanEnv, killServer, listSessions, quote, SESSIONS, tmux, tmuxBin, tmuxTry } from "./tmux.ts";
import { VERSION } from "./version.ts";

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
		"set -as terminal-features ',*:RGB:hyperlinks:extkeys:sync'",
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
		// tmux 3.8 restyled popups and copy mode in its own theme colours, whatever the terminal's: the Peek a dark grey
		// box, copy mode's highlights fixed X11 colours. These are 3.7's, which take the terminal's palette.
		"set -g popup-style default",
		"set -g mode-style noattr,bg=yellow,fg=black",
		"set -g copy-mode-match-style bg=cyan,fg=black",
		"set -g copy-mode-current-match-style bg=magenta,fg=black",
		"set -g copy-mode-mark-style bg=red,fg=black",
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

/** Whether release a is newer than b. A server from before swb stamped its version has none, which is oldest. */
export function newer(a: string, b: string): boolean {
	const parse = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? [-1, -1, -1]) as number[];
	const [x, y] = [parse(a), parse(b)];
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) > (y[i] as number);
	return false;
}

/**
 * Brings a server in line with this swb. A newer swb's server is left alone, so an old Deck can't drag it back;
 * the old Deck says so instead. An older one is restarted when `upgrade` finds it safe, and reloaded in place
 * otherwise; the same version with a changed config just reloads. Two swbs upgrading at once serialize on the
 * db's write lock, so the second finds the first's fresh server instead of killing it.
 */
export function ensureServer(server: string, conf: string, start: (confPath: string) => void, upgrade: () => boolean): void {
	const version = confVersion(conf);
	if (current(server, version)) return;
	const db = openStore();
	try {
		db.tx(() => {
			if (current(server, version)) return;
			const dir = join(stateDir(), "tmux");
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const path = join(dir, `${server}.conf`);
			writeFileSync(path, `${conf}\nset -g @swb_conf_version ${version}\nset -g @swb_version ${VERSION}\n`);
			const up = tmuxTry(server, "show", "-gqv", "@swb_version");
			if (up.ok && newer(VERSION, up.out) && upgrade()) killServer(server);
			else if (up.ok) {
				tmux(server, "source-file", path);
				return;
			}
			try {
				start(path);
			} catch (error) {
				// An swb from before this lock started the server between the check and the start.
				if (!tmuxTry(server, "show", "-gqv", "@swb_conf_version").ok) throw error;
				tmux(server, "source-file", path);
			}
		});
	} finally {
		db.close();
	}
}

/** Up, and either on this config or owned by a newer swb. */
function current(server: string, version: string): boolean {
	const conf = tmuxTry(server, "show", "-gqv", "@swb_conf_version");
	if (!conf.ok) return false;
	const running = tmux(server, "show", "-gqv", "@swb_version");
	return newer(running, VERSION) || (running === VERSION && conf.out === version);
}

/** An upgrade ends every idle session, so the next wake runs the new swb. Their shutdown writes the db, so this runs outside its lock. */
function stopIdlePis(): void {
	const hosts = new Set(listSessions(SESSIONS).map(([name]) => name as string));
	const db = openStore();
	let idle: RuntimeRow[];
	try {
		idle = db.all("SELECT r.* FROM runtimes r JOIN sessions s USING (session_id) WHERE s.phase = 'idle'") as RuntimeRow[];
	} finally {
		db.close();
	}
	stopPis(idle.filter((runtime) => runtimeLive(runtime, bootId(), hosts)));
}

/**
 * Closing a pane hangs pi up on a dead terminal, and it exits before its shutdown hooks run; SIGTERM lets the
 * recorder save the draft and clear its runtime. One that ignores it has its pane closed after 5 s.
 */
export function stopPis(stopping: RuntimeRow[]): void {
	for (const runtime of stopping) process.kill(runtime.pid, "SIGTERM");
	const deadline = Date.now() + 5000;
	const open = () => {
		const left = new Set(listSessions(SESSIONS).map(([name]) => name as string));
		return stopping.filter((runtime) => left.has(runtime.tmux_session));
	};
	while (open().length > 0 && Date.now() < deadline) Bun.sleepSync(20);
	for (const runtime of open()) tmuxTry(SESSIONS, "kill-session", "-t", `=${runtime.tmux_session}`);
}

export function onlyControl(server: string): boolean {
	return listSessions(server, "#{@swb_kind}").every(([, kind]) => kind === "control");
}

/** Starts the server from a scrubbed environment, so project credentials from mise or direnv stay out of it. */
export function startScrubbed(server: string, args: string[]): void {
	const script = [
		'if command -v mise >/dev/null 2>&1; then eval "$(mise -C / hook-env -s bash 2>/dev/null)"; fi',
		'if command -v direnv >/dev/null 2>&1; then exec direnv exec / "$@"; fi',
		'exec "$@"',
	].join("\n");
	const result = Bun.spawnSync(["/bin/sh", "-c", script, "sh", tmuxBin(), "-L", server, ...args], {
		cwd: CLIENT_CWD,
		env: cleanEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new SwbError(`starting tmux -L ${server}: ${result.stderr.toString().trim()}`);
}

export function ensureSessionsServer(): void {
	const running = tmuxTry(SESSIONS, "show", "-gqv", "@swb_version");
	if (running.ok && newer(VERSION, running.out)) stopIdlePis();
	ensureServer(
		SESSIONS,
		sessionsConf(),
		(path) => startScrubbed(SESSIONS, ["-f", path, "new-session", "-d", "-s", CONTROL, ...clockArgs()]),
		() => onlyControl(SESSIONS),
	);
	ensureClock();
}

/** The sessions server's own session, whose pane runs the clock that fires schedules. */
const CONTROL = "swb-ctl";

/** Which swb the clock runs: its release, and this binary's mtime, which a reinstall of the same release still moves. */
function clockStamp(): string {
	return `${VERSION}:${statSync(SWB).mtimeMs}`;
}

/** The clock command, then its session's options: a clock that exits leaves its pane, for the next swb to respawn. */
function clockArgs(): string[] {
	const target = `=${CONTROL}:`;
	return [
		`exec ${quote(SWB)} __clock`,
		";",
		"set",
		"-t",
		CONTROL,
		"@swb_kind",
		"control",
		";",
		"set",
		"-t",
		CONTROL,
		"@swb_clock",
		clockStamp(),
		";",
		"set",
		"-p",
		"-t",
		target,
		"remain-on-exit",
		"on",
	];
}

/**
 * Starts the clock if it's gone, or restarts it on this swb if it runs another; a newer swb's is left alone. Two swbs
 * at once serialize on the db's write lock, so the second finds the first's clock instead of replacing it.
 */
function ensureClock(): void {
	if (clockCurrent()) return;
	const db = openStore();
	try {
		db.tx(() => {
			const current = clockCurrent();
			if (current) return;
			if (current === null) tmux(SESSIONS, "new-session", "-d", "-s", CONTROL, ...clockArgs());
			else
				tmux(
					SESSIONS,
					"respawn-pane",
					"-k",
					"-t",
					`=${CONTROL}:`,
					`exec ${quote(SWB)} __clock`,
					";",
					"set",
					"-t",
					CONTROL,
					"@swb_clock",
					clockStamp(),
				);
		});
	} finally {
		db.close();
	}
}

/** Whether the clock runs this swb or a newer one; null when its session is gone. */
function clockCurrent(): boolean | null {
	const info = tmuxTry(SESSIONS, "display", "-p", "-t", `=${CONTROL}:`, "#{pane_dead}\t#{@swb_clock}");
	if (!info.ok) return null;
	const [dead, stamp = ""] = info.out.split("\t");
	return dead !== "1" && (stamp === clockStamp() || newer(stamp.split(":")[0] ?? "", VERSION));
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

export type LaunchSpec = {
	harness: Harness;
	cwd: string;
	/** The session to resume, when it has run before, and its recorded transcript. */
	resume: { id: string; transcript: string } | null;
	/** A new session's id, for the harnesses that take one up front (pi, Claude Code). */
	sessionId?: string;
	/** The first turn's prompt. */
	prompt?: string;
	/** The name a launcher gave it; Claude Code keeps it as the session's own. */
	title?: string;
	model?: string;
	/** The session that launched this one; an agent launch also skips pi's trust prompt. */
	parentId?: string;
};

/** The harness's own command line for a launch, run by the user's login shell. */
function harnessCommand(spec: LaunchSpec, host: string): string[] {
	const model = spec.model ? ["--model", spec.model] : [];
	const prompt = spec.prompt ? [spec.prompt] : [];
	switch (spec.harness) {
		case "pi": {
			// --session-id only searches the starting directory's sessions, and a moved-away one would mint a fresh
			// session under this id. The transcript reaches pi's own missing-cwd prompt instead.
			const id = spec.resume ? ["--session", spec.resume.transcript] : spec.sessionId ? ["--session-id", spec.sessionId] : [];
			// An agent's launch has no one at the trust prompt.
			const approve = spec.parentId || spec.sessionId ? ["--approve"] : [];
			return ["pi", ...id, ...approve, ...model, ...prompt];
		}
		case "claude": {
			const id = spec.resume ? ["--resume", spec.resume.id] : spec.sessionId ? ["--session-id", spec.sessionId] : [];
			const operator = spec.cwd === operatorDir() ? ["--settings", claudeOperatorSettings()] : [];
			const name = spec.title ? ["--name", spec.title] : [];
			// /loop's self-pacing wakeup outlives CLAUDE_CODE_DISABLE_CRON. Its flag takes a list, so another option follows.
			const scheduler = ["--disallowed-tools", "ScheduleWakeup"];
			return ["claude", ...id, ...scheduler, "--plugin-dir", writeClaudeLine(), ...operator, ...name, ...model, ...prompt];
		}
		case "codex":
			return [
				SWB,
				"__codex",
				"--host",
				host,
				...(spec.resume ? ["--resume", spec.resume.id] : []),
				...(spec.cwd === operatorDir() ? ["--operator"] : []),
				...model,
				...prompt.flatMap((p) => ["--prompt", p]),
			];
	}
}

/** Starts a managed session in the background and returns its tmux session; the harness comes up on its own time. */
export function launch(spec: LaunchSpec): string {
	const at = now();
	const { cwd, resume } = spec;
	const name = `${basename(projectRoot(cwd)).replaceAll(/[.:]/g, "_")}-${randomHex(2)}`;
	const shell = loginShell();
	const command = `exec ${harnessCommand(spec, name).map(quote).join(" ")}`;
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
		// pi asks tmux whether its client forwards hyperlinks, but it starts with no client; both servers always forward them.
		"-e",
		"PI_HYPERLINKS=1",
		// The terminal attached to the Deck may be on another machine, which pi can't see through tmux; OSC 52 reaches it.
		"-e",
		"PI_CLIPBOARD_OSC52=1",
		// Claude Code's own scheduler dies with its process; swb's schedules are the ones that last.
		...(spec.harness === "claude" ? ["-e", "CLAUDE_CODE_DISABLE_CRON=1"] : []),
		...(spec.parentId ? ["-e", `SWB_PARENT=${spec.parentId}`] : []),
		`exec env -u TMUX -u TMUX_PANE SHELL=${shell} ${shell} -lic ${quote(command)}`,
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
		...(resume ? [";", "set", "-t", name, "@swb_launch_id", resume.id] : []),
	);
	since(`launch.${spec.harness}`, at);
	return name;
}

/** The Editor for a directory, started if missing. Two Decks asking at once serialize on the db's write lock. */
export function ensureEditor(db: Db, dir: string, editor: string): string {
	return ensureDirSession(
		db,
		"editor",
		dir,
		nvimEditor(editor) ? `${editor} -c ${quote(`lua dofile(${JSON.stringify(nvimNav())})`)}` : editor,
	);
}

/** Only nvim gets swb's ctrl-hjkl; any other Editor keeps those keys to itself. */
export function nvimEditor(editor: string): boolean {
	return basename(editor.trim().split(/\s+/)[0] ?? "") === "nvim";
}

/** The directory's shell for the Stage; it ends with its shell, which hides it. */
export function ensureShell(db: Db, dir: string): string {
	return ensureDirSession(db, "shell", dir, null);
}

function ensureDirSession(db: Db, kind: "editor" | "shell", dir: string, command: string | null): string {
	ensureSessionsServer();
	return db.tx(() => {
		const existing = listSessions(SESSIONS, "#{@swb_kind}", "#{@swb_dir}").find(([, k, d]) => k === kind && d === dir);
		if (existing) return existing[0] as string;
		const name = `${basename(dir).replaceAll(/[.:]/g, "_")}-${kind === "editor" ? "edit" : "sh"}-${randomHex(2)}`;
		const shell = loginShell();
		const run = command
			? `SWB_EDITOR=${quote(name)} SHELL=${shell} ${shell} -lic ${quote(`exec ${command}`)}`
			: `SHELL=${shell} ${shell} -l`;
		tmux(
			SESSIONS,
			"new-session",
			"-d",
			"-s",
			name,
			"-c",
			dir,
			`exec env -u TMUX -u TMUX_PANE ${run}`,
			";",
			"set",
			"-t",
			name,
			"@swb_kind",
			kind,
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
 * ctrl-hjkl in an nvim Editor: between its own windows, and at an edge on into the Deck's panes, which the Deck's
 * bindings hand ctrl-hjkl to whenever the Editor has the keyboard.
 */
function nvimNav(): string {
	const path = join(stateDir(), "nvim-nav.lua");
	const lua = `-- Written by swb for its Editors.
local function maps(buffer)
  for _, k in ipairs({ "h", "j", "k", "l" }) do
    vim.keymap.set("n", "<C-" .. k .. ">", function()
      if vim.fn.winnr(k) ~= vim.fn.winnr() then
        vim.cmd("wincmd " .. k)
      else
        vim.fn.jobstart({ ${JSON.stringify(SWB)}, "__nav", k })
      end
    end, { buffer = buffer, desc = "swb: window or Deck pane " .. k })
  end
end
maps(false)
-- LazyVim maps its own window keys at lazy.nvim's VeryLazy, after -c ran this, so take them back once it has.
vim.api.nvim_create_autocmd("User", { pattern = "VeryLazy", once = true, callback = function() maps(false) end })
-- netrw maps <C-h> and <C-l> in its own buffers, over the global ones.
vim.api.nvim_create_autocmd("FileType", { pattern = "netrw", callback = function(ev) maps(ev.buf) end })
-- Out of focus, the Editor's line highlight goes with its cursor, and back in, each window gets back exactly its own.
vim.api.nvim_create_autocmd("FocusLost", { callback = function()
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if vim.wo[win].cursorline then
      vim.w[win].swb_cursorline = true
      vim.wo[win].cursorline = false
    end
  end
end })
vim.api.nvim_create_autocmd("FocusGained", { callback = function()
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if vim.w[win].swb_cursorline then
      vim.w[win].swb_cursorline = nil
      vim.wo[win].cursorline = true
    end
  end
end })
`;
	mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
	writeFileSync(path, lua);
	return path;
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
		const session = db.get("SELECT cwd, project_root, harness, transcript FROM sessions WHERE session_id = ?", id);
		if (!session) throw new SwbError(`no session ${id}`);
		// tmux starts a missing directory in $HOME, away from the session's Project.
		const cwd = existsSync(session.cwd as string) ? (session.cwd as string) : (session.project_root as string);
		return launch({ harness: session.harness as Harness, cwd, resume: { id, transcript: session.transcript as string } });
	});
}

/** The tmux session a live pi hosts this session in, if any. */
function liveHost(db: Db, id: string, hosts: Set<string>): string | null {
	return liveRuntime(db, id, hosts)?.tmux_session ?? null;
}

function liveRuntime(db: Db, id: string, hosts: Set<string>): RuntimeRow | null {
	const runtime = db.get("SELECT tmux_session, boot_id, pid FROM runtimes WHERE session_id = ?", id) as RuntimeRow | null;
	return runtime && runtimeLive(runtime, bootId(), hosts) ? runtime : null;
}

/** Archives a session, refusing mid-turn; an idle live pi is killed, and editors nobody needs any more go with it. */
export function archive(db: Db, id: string): void {
	const hosts = new Set(listSessions(SESSIONS).map(([name]) => name as string));
	const runtime = db.tx(() => {
		const session = db.get("SELECT phase FROM sessions WHERE session_id = ?", id);
		if (!session) throw new SwbError(`no session ${id}`);
		const runtime = liveRuntime(db, id, hosts);
		if (runtime && session.phase !== "idle") throw new SwbError("turn running: wait for it to complete");
		markArchived(db, id);
		return runtime;
	});
	if (runtime) stopPis([runtime]);
	gc(db);
}

/** Stops a live idle pi, keeping its session open to wake later; refuses mid-turn, as archive does. */
export function stop(db: Db, id: string): void {
	const hosts = new Set(listSessions(SESSIONS).map(([name]) => name as string));
	const session = db.get("SELECT phase FROM sessions WHERE session_id = ?", id);
	if (!session) throw new SwbError(`no session ${id}`);
	const runtime = liveRuntime(db, id, hosts);
	if (!runtime) throw new SwbError("not running");
	if (session.phase !== "idle") throw new SwbError("turn running: wait for it to complete");
	stopPis([runtime]);
}

/** Back to open; nothing restarts. */
export function unarchive(db: Db, id: string): void {
	const session = db.get("SELECT harness, transcript FROM sessions WHERE session_id = ?", id);
	if (!session) throw new SwbError(`no session ${id}`);
	// A thread Codex archived itself is unarchived there too, so Codex's own picker lists it again.
	if (session.harness === "codex" && archivedInCodex(session.transcript as string)) {
		const result = Bun.spawnSync(["codex", "unarchive", id], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new SwbError(`codex unarchive ${id}: ${result.stderr.toString().trim()}`);
	}
	db.tx(() => {
		db.run("INSERT INTO marks (session_id, archived_at) VALUES (?, NULL) ON CONFLICT (session_id) DO UPDATE SET archived_at = NULL", id);
	});
}

/** Kills each Editor and shell whose directory no open session uses any more. */
export function gc(db: Db): void {
	const listed = listSessions(SESSIONS, "#{@swb_kind}", "#{@swb_dir}");
	const owned = listed.filter(([, kind]) => kind === "editor" || kind === "shell");
	if (owned.length === 0) return;
	const hosts = new Set(listed.map(([name]) => name as string));
	const open = db.all(
		`SELECT s.cwd FROM sessions s LEFT JOIN marks m USING (session_id)
		 WHERE m.archived_at IS NULL OR m.archived_at < s.last_prompt_at`,
	);
	const provisional = db
		.all("SELECT cwd, tmux_session FROM runtimes WHERE session_id NOT IN (SELECT session_id FROM sessions)")
		.filter((row) => hosts.has(row.tmux_session as string));
	const used = new Set([...open, ...provisional].map((row) => row.cwd as string));
	for (const [name, , dir] of owned) {
		if (!used.has(dir as string)) tmuxTry(SESSIONS, "kill-session", "-t", `=${name}`);
	}
}
