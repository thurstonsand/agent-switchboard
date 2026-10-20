import type { Db, Row } from "./db.ts";
import { bootId, branch, type Harness, pidAlive, projectRoot, SCHEMA_VERSION } from "./index.ts";

// Every line records a session's lifecycle through these, so pi, Claude Code, and Codex rows mean the same thing.
// Each call is one write transaction that first asserts the schema it writes.

/** One write, refused when the db is on another schema: a line older or newer than swb must not write an old shape. */
export function recordTx<T>(db: Db, body: () => T): T {
	return db.tx(() => {
		const version = db.userVersion();
		if (version !== SCHEMA_VERSION) throw new Error(`db schema is v${version}, this line writes v${SCHEMA_VERSION}`);
		return body();
	});
}

/** Another process in this boot already hosts the session: two writers on one transcript would corrupt it. */
function liveHost(row: Row | undefined): string | undefined {
	if (row && row.boot_id === bootId() && pidAlive(row.pid as number)) return row.tmux_session as string;
	return undefined;
}

export function hostOfSession(db: Db, sessionId: string, exceptHost: string): string | undefined {
	return liveHost(
		db.get("SELECT tmux_session, boot_id, pid FROM runtimes WHERE session_id = ? AND tmux_session != ?", sessionId, exceptHost),
	);
}

export function hostOfTranscript(db: Db, transcript: string, exceptHost: string): string | undefined {
	return liveHost(
		db.get(
			"SELECT r.tmux_session, r.boot_id, r.pid FROM runtimes r JOIN sessions s USING (session_id) WHERE s.transcript = ? AND r.tmux_session != ?",
			transcript,
			exceptHost,
		),
	);
}

export type Hosting = { host: string; harness: Harness; sessionId: string; cwd: string; transcript: string; pid: number; idle: boolean };

/** A process starts hosting a session: its runtime row, keyed by its tmux session, now names it. */
export function startHosting(db: Db, h: Hosting): void {
	recordTx(db, () => {
		const other = hostOfSession(db, h.sessionId, h.host);
		if (other) throw new Error(`session ${h.sessionId} is already open in another process (${other})`);
		db.run("DELETE FROM runtimes WHERE session_id = ? AND tmux_session != ?", h.sessionId, h.host);
		db.run(
			`INSERT INTO runtimes (tmux_session, session_id, harness, cwd, project_root, boot_id, pid, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (tmux_session) DO UPDATE SET session_id = excluded.session_id, harness = excluded.harness, cwd = excluded.cwd,
			   project_root = excluded.project_root, boot_id = excluded.boot_id, pid = excluded.pid`,
			h.host,
			h.sessionId,
			h.harness,
			h.cwd,
			projectRoot(h.cwd),
			bootId(),
			h.pid,
			Date.now(),
		);
		// A move (pi's /mv and /wt, Codex's /cd) keeps the id in another directory, sometimes with a new transcript.
		// A turn can already be running: another pi extension's session_start may start one before the line's runs.
		db.run(
			"UPDATE sessions SET phase = CASE WHEN ? THEN 'idle' ELSE phase END, cwd = ?, project_root = ?, branch = ?, transcript = ? WHERE session_id = ?",
			h.idle ? 1 : 0,
			h.cwd,
			projectRoot(h.cwd),
			branch(h.cwd),
			h.transcript,
			h.sessionId,
		);
	});
}

export type Turn = { harness: Harness; sessionId: string; cwd: string; transcript: string; title: string | null; parentId: string | null };

/**
 * A turn begins: the session's row is created at its first turn. Only a turn that starts from idle moves
 * last_prompt_at, so a retry or a queued message inside one turn can't undo an archive made during it.
 */
export function startTurn(db: Db, t: Turn): void {
	recordTx(db, () => {
		const now = Date.now();
		const first = !db.get("SELECT 1 FROM sessions WHERE session_id = ?", t.sessionId);
		db.run(
			`INSERT INTO sessions (session_id, harness, parent_id, cwd, project_root, transcript, title, branch, phase, created_at, last_prompt_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'working', ?, ?)
			 ON CONFLICT (session_id) DO UPDATE SET phase = 'working',
			   last_prompt_at = CASE WHEN sessions.phase = 'idle' THEN excluded.last_prompt_at ELSE sessions.last_prompt_at END`,
			t.sessionId,
			t.harness,
			t.parentId,
			t.cwd,
			projectRoot(t.cwd),
			t.transcript,
			t.title,
			branch(t.cwd),
			now,
			now,
		);
		// A child starts in its parent's Group, copied once; from then on each one's Group is its own.
		if (first && t.parentId)
			db.run(
				`INSERT INTO marks (session_id, group_name)
				 SELECT ?, m.group_name FROM sessions p JOIN marks m USING (session_id)
				 WHERE p.session_id = ? AND p.project_root = ? AND m.group_name IS NOT NULL`,
				t.sessionId,
				t.parentId,
				projectRoot(t.cwd),
			);
	});
}

/** Blocked on the person, or back to working; never reopens an idle session. */
export function setPhase(db: Db, sessionId: string, phase: "working" | "blocked"): void {
	recordTx(db, () => db.run("UPDATE sessions SET phase = ? WHERE session_id = ? AND phase != 'idle'", phase, sessionId));
}

export type Settle = { host: string; sessionId: string; cwd: string; title: string | null };

/** The turn finished with nothing queued. Reports whether the session was archived during it, so its line can quit. */
export function settle(db: Db, s: Settle): { archived: boolean } {
	return recordTx(db, () => {
		harnessTitled(db, s.sessionId, s.title);
		db.run(
			"UPDATE sessions SET phase = 'idle', last_settled_at = ?, cwd = ?, project_root = ?, branch = ?, title = coalesce(?, title) WHERE session_id = ?",
			Date.now(),
			s.cwd,
			projectRoot(s.cwd),
			branch(s.cwd),
			s.title,
			s.sessionId,
		);
		db.run("UPDATE runtimes SET cwd = ?, project_root = ? WHERE tmux_session = ?", s.cwd, projectRoot(s.cwd), s.host);
		return { archived: isArchived(db, s.sessionId) };
	});
}

/** The turn ended on its provider's error. It stands until the next turn starts from idle. */
export function turnErrored(db: Db, sessionId: string): void {
	recordTx(db, () => db.run("UPDATE sessions SET errored_at = ? WHERE session_id = ?", Date.now(), sessionId));
}

export function setTitle(db: Db, sessionId: string, title: string | null): void {
	recordTx(db, () => {
		harnessTitled(db, sessionId, title);
		db.run("UPDATE sessions SET title = ? WHERE session_id = ?", title, sessionId);
	});
}

/**
 * A harness naming its session anew clears a title set through swb: either it took that title, or it was renamed in the
 * harness since, which wins. The same name again, as every settle reports, clears nothing.
 */
function harnessTitled(db: Db, sessionId: string, title: string | null): void {
	if (title === null) return;
	db.run(
		"UPDATE marks SET title = NULL WHERE session_id = ? AND ? IS NOT (SELECT title FROM sessions WHERE session_id = ?)",
		sessionId,
		title,
		sessionId,
	);
}

/** A title set through swb that the session's harness hasn't taken yet: its line hands it over, and the harness reports it back. */
export function pendingTitle(db: Db, sessionId: string): string | null {
	const row = db.get(
		"SELECT m.title FROM marks m JOIN sessions s USING (session_id) WHERE m.session_id = ? AND m.title IS NOT NULL AND m.title IS NOT s.title",
		sessionId,
	);
	return (row?.title as string | undefined) ?? null;
}

/** A session's title as the roster shows it: one set through swb, else its harness's. */
export function titleOf(db: Db, sessionId: string): string | null {
	const row = db.get(
		"SELECT coalesce(m.title, s.title) AS title FROM sessions s LEFT JOIN marks m USING (session_id) WHERE s.session_id = ?",
		sessionId,
	);
	return (row?.title as string | null | undefined) ?? null;
}

/** The process quit: its runtime row goes, and the phase stays, so a quit mid-turn reads as cut off. */
export function endHosting(db: Db, host: string): void {
	recordTx(db, () => db.run("DELETE FROM runtimes WHERE tmux_session = ?", host));
}

export function isArchived(db: Db, sessionId: string): boolean {
	return Boolean(
		db.get(
			"SELECT 1 FROM sessions s JOIN marks m USING (session_id) WHERE s.session_id = ? AND m.archived_at >= s.last_prompt_at",
			sessionId,
		),
	);
}

/**
 * Marks a session archived and cancels what it hasn't received, schedules aimed at it included, and its snooze; false
 * before its first turn, when there is nothing to archive.
 */
export function markArchived(db: Db, sessionId: string): boolean {
	if (!db.get("SELECT 1 FROM sessions WHERE session_id = ?", sessionId)) return false;
	const now = Date.now();
	db.run(
		`INSERT INTO marks (session_id, archived_at) VALUES (?, ?)
		 ON CONFLICT (session_id) DO UPDATE SET archived_at = excluded.archived_at, snoozed_at = NULL, snoozed_until = NULL`,
		sessionId,
		now,
	);
	db.run("UPDATE messages SET cancelled_at = ? WHERE target_id = ? AND delivered_at IS NULL AND cancelled_at IS NULL", now, sessionId);
	db.run("UPDATE schedules SET cancelled_at = ? WHERE target_id = ? AND next_at IS NOT NULL AND cancelled_at IS NULL", now, sessionId);
	return true;
}
