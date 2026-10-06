import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bootId, branch, Db, pidAlive, projectRoot, type Row, SCHEMA_VERSION } from "@swb/shared";

type Launch = { readonly db: string; readonly tmuxSession: string };
// Outlives /reload, which re-imports this module with a fresh module cache.
type Process = { launch: Launch; failure?: string; db?: Db; attention: Set<string> };
type Ui = ExtensionContext["ui"];

const KEY = Symbol.for("agent-switchboard.recorder");
const store = globalThis as { [KEY]?: Process };

function claim(): Process | undefined {
	const env = process.env;
	if (env.SWB_MANAGED === "1" && env.SWB_DB && env.SWB_TMUX_SESSION) {
		store[KEY] = { launch: Object.freeze({ db: env.SWB_DB, tmuxSession: env.SWB_TMUX_SESSION }), attention: new Set() };
	}
	// Consumed so no child process (subagents, handoffs, bash) inherits management.
	delete env.SWB_MANAGED;
	delete env.SWB_DB;
	delete env.SWB_TMUX_SESSION;
	return store[KEY];
}

/** Another managed pi in this boot already hosts the session: two writers on one transcript would corrupt it. */
function liveHost(row: Row | undefined): string | undefined {
	if (row && row.boot_id === bootId() && pidAlive(row.pid as number)) return row.tmux_session as string;
	return undefined;
}

function hostOfSession(db: Db, proc: Process, sessionId: string): string | undefined {
	return liveHost(
		db.get(
			"SELECT tmux_session, boot_id, pid FROM runtimes WHERE session_id = ? AND tmux_session != ?",
			sessionId,
			proc.launch.tmuxSession,
		),
	);
}

function hostOfTranscript(db: Db, proc: Process, transcript: string): string | undefined {
	return liveHost(
		db.get(
			"SELECT r.tmux_session, r.boot_id, r.pid FROM runtimes r JOIN sessions s USING (session_id) WHERE s.transcript = ? AND r.tmux_session != ?",
			transcript,
			proc.launch.tmuxSession,
		),
	);
}

export default function (pi: ExtensionAPI) {
	const claimed = claim();
	if (!claimed) return;
	const proc: Process = claimed;
	let ui: Ui | undefined;

	const showFailure = () => ui?.setStatus("swb", ui.theme.fg("error", `swb: not recording: ${proc.failure}`));

	const connect = (): Db => {
		proc.db ??= new Db(proc.launch.db, { create: false });
		return proc.db;
	};

	const fail = (error: unknown) => {
		proc.failure = error instanceof Error ? error.message : String(error);
		showFailure();
		ui?.notify(`swb: not recording: ${proc.failure}`, "error");
	};

	const write = (sessionId: string, body: (db: Db, sessionId: string) => void): void => {
		if (proc.failure) {
			showFailure();
			return;
		}
		try {
			const db = connect();
			db.tx(() => {
				const version = db.userVersion();
				if (version !== SCHEMA_VERSION) throw new Error(`db schema is v${version}, this recorder writes v${SCHEMA_VERSION}`);
				body(db, sessionId);
			});
		} catch (error) {
			fail(error);
		}
	};

	const writeFor = (ctx: ExtensionContext, body: (db: Db, sessionId: string) => void): void => {
		ui = ctx.ui;
		write(ctx.sessionManager.getSessionId(), body);
	};

	let current: string | undefined;

	pi.on("session_before_switch", (event, ctx) => {
		if (event.reason !== "resume" || !event.targetSessionFile || proc.failure) return;
		ui = ctx.ui;
		let host: string | undefined;
		try {
			host = hostOfTranscript(connect(), proc, event.targetSessionFile);
		} catch (error) {
			fail(error);
			return;
		}
		if (!host) return;
		ctx.ui.notify(`swb: that session is already open in another pi (${host})`, "error");
		return { cancel: true };
	});

	pi.on("session_start", (_event, ctx) => {
		current = ctx.sessionManager.getSessionId();
		proc.attention.clear();
		writeFor(ctx, (db, id) => {
			const host = hostOfSession(db, proc, id);
			if (host) throw new Error(`session ${id} is already open in another pi (${host})`);
			db.run("DELETE FROM runtimes WHERE session_id = ? AND tmux_session != ?", id, proc.launch.tmuxSession);
			db.run(
				`INSERT INTO runtimes (tmux_session, session_id, cwd, project_root, boot_id, pid, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (tmux_session) DO UPDATE SET session_id = excluded.session_id, cwd = excluded.cwd,
				   project_root = excluded.project_root, boot_id = excluded.boot_id, pid = excluded.pid`,
				proc.launch.tmuxSession,
				id,
				ctx.cwd,
				projectRoot(ctx.cwd),
				bootId(),
				process.pid,
				Date.now(),
			);
			db.run("UPDATE sessions SET phase = 'idle' WHERE session_id = ?", id);
		});
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "user") return;
		writeFor(ctx, (db, id) => {
			const transcript = ctx.sessionManager.getSessionFile();
			if (!transcript) throw new Error("pi is running without a session file");
			const now = Date.now();
			db.run(
				`INSERT INTO sessions (session_id, tool, cwd, project_root, transcript, title, branch, phase, created_at, last_prompt_at)
				 VALUES (?, 'pi', ?, ?, ?, ?, ?, 'working', ?, ?)
				 ON CONFLICT (session_id) DO UPDATE SET phase = 'working', last_prompt_at = excluded.last_prompt_at`,
				id,
				ctx.cwd,
				projectRoot(ctx.cwd),
				transcript,
				ctx.sessionManager.getSessionName() ?? null,
				branch(ctx.cwd),
				now,
				now,
			);
		});
	});

	pi.on("agent_start", (_event, ctx) => {
		writeFor(ctx, (db, id) => db.run("UPDATE sessions SET phase = 'working' WHERE session_id = ?", id));
	});

	const attention = (open: boolean) => (data: unknown) => {
		const attentionId = (data as { attentionId?: unknown }).attentionId;
		if (typeof attentionId !== "string" || !current) return;
		if (open) proc.attention.add(attentionId);
		else proc.attention.delete(attentionId);
		const phase = proc.attention.size > 0 ? "blocked" : "working";
		write(current, (db, id) => db.run("UPDATE sessions SET phase = ? WHERE session_id = ? AND phase != 'idle'", phase, id));
	};
	pi.events.on("glimpseui:attention:request", attention(true));
	pi.events.on("glimpseui:attention:resolve", attention(false));

	pi.on("agent_settled", (_event, ctx) => {
		proc.attention.clear();
		writeFor(ctx, (db, id) => {
			db.run(
				"UPDATE sessions SET phase = 'idle', last_settled_at = ?, cwd = ?, branch = ?, title = ? WHERE session_id = ?",
				Date.now(),
				ctx.cwd,
				branch(ctx.cwd),
				ctx.sessionManager.getSessionName() ?? null,
				id,
			);
			db.run("UPDATE runtimes SET cwd = ? WHERE tmux_session = ?", ctx.cwd, proc.launch.tmuxSession);
		});
	});

	pi.on("session_info_changed", (event, ctx) => {
		writeFor(ctx, (db, id) => db.run("UPDATE sessions SET title = ? WHERE session_id = ?", event.name ?? null, id));
	});

	pi.on("session_shutdown", (event, ctx) => {
		if (event.reason !== "quit") return;
		writeFor(ctx, (db) => db.run("DELETE FROM runtimes WHERE tmux_session = ?", proc.launch.tmuxSession));
	});
}
