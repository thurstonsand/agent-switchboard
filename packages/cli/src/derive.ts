import { basename } from "node:path";
import { bootId, type Db, type Harness, operatorDir, type Phase, pidAlive, type View } from "@swb/shared";
import { loadConfig } from "./config.ts";
import { SwbError } from "./errors.ts";
import { listSessions, SESSIONS } from "./tmux.ts";

/** One Session with every derived state, as `swb ls --json` prints it. */
export type SessionState = {
	id: string;
	harness: Harness;
	/** The session that launched this one, if one did. */
	parentId: string | null;
	title: string | null;
	project: string;
	cwd: string;
	branch: string | null;
	group: string | null;
	/** It coordinates from the Operator folder instead of working in a Project. */
	operator: boolean;
	open: boolean;
	live: boolean;
	activity: Phase;
	unseen: boolean;
	/**
	 * How a dormant session's process ended mid-turn, or null: its harness shut down cleanly (quit, swb quit --force,
	 * its pane closed), it died without one (killed, crashed, its tmux server gone), or it went with the machine.
	 */
	cutOff: CutOff | null;
	/** Its last turn ended on its provider's error, and none has started since. */
	errored: boolean;
	inactive: boolean;
	/** Out of the way until a time or its next message; blocked, cut off, or errored, it shows anyway. */
	snoozed: boolean;
	/** When a snoozed session's snooze ends; null while it waits for a message, or isn't snoozed. */
	snoozedUntil: number | null;
	createdAt: number;
	activityAt: number;
	visitedAt: number | null;
	archivedAt: number | null;
};

/** What derivation needs from outside the db, read once per snapshot. */
export type World = { now: number; bootId: string; hosts: Set<string>; inactiveAfterMs: number };

export function world(inactiveAfterMs: number): World {
	return { now: Date.now(), bootId: bootId(), hosts: new Set(listSessions(SESSIONS).map(([name]) => name as string)), inactiveAfterMs };
}

export type CutOff = "shutdown" | "killed" | "restart";

export type RuntimeRow = { tmux_session: string; boot_id: string; pid: number };

export function runtimeLive(runtime: RuntimeRow, boot: string, hosts: Set<string>): boolean {
	return runtime.boot_id === boot && hosts.has(runtime.tmux_session) && pidAlive(runtime.pid);
}

export type SessionRow = {
	session_id: string;
	harness: Harness;
	parent_id: string | null;
	title: string | null;
	project_root: string;
	cwd: string;
	branch: string | null;
	transcript: string;
	phase: Phase;
	created_at: number;
	last_prompt_at: number;
	last_settled_at: number | null;
	errored_at: number | null;
	archived_at: number | null;
	visited_at: number | null;
	view: View | null;
	group_name: string | null;
	snoozed_at: number | null;
	snoozed_until: number | null;
	/** The last message sent to it, delivered or not; one after a next_message snooze ends it. */
	last_message_at: number | null;
	runtime: RuntimeRow | null;
};

export function sessionRows(db: Db): SessionRow[] {
	return db
		.all(
			`SELECT s.session_id, s.harness, s.parent_id, coalesce(m.title, s.title) AS title, s.project_root, s.cwd, s.branch, s.transcript, s.phase, s.created_at, s.last_prompt_at, s.last_settled_at, s.errored_at,
		        m.archived_at, m.visited_at, m.view, m.group_name, m.snoozed_at, m.snoozed_until, r.tmux_session, r.boot_id, r.pid,
		        (SELECT max(created_at) FROM messages WHERE target_id = s.session_id AND kind = 'message') AS last_message_at
		 FROM sessions s LEFT JOIN marks m USING (session_id) LEFT JOIN runtimes r USING (session_id)`,
		)
		.map((r) => ({
			session_id: r.session_id as string,
			harness: r.harness as Harness,
			parent_id: r.parent_id as string | null,
			title: r.title as string | null,
			project_root: r.project_root as string,
			cwd: r.cwd as string,
			branch: r.branch as string | null,
			transcript: r.transcript as string,
			phase: r.phase as Phase,
			created_at: r.created_at as number,
			last_prompt_at: r.last_prompt_at as number,
			last_settled_at: r.last_settled_at as number | null,
			errored_at: r.errored_at as number | null,
			archived_at: r.archived_at as number | null,
			visited_at: r.visited_at as number | null,
			view: r.view as View | null,
			group_name: r.group_name as string | null,
			snoozed_at: r.snoozed_at as number | null,
			snoozed_until: r.snoozed_until as number | null,
			last_message_at: r.last_message_at as number | null,
			runtime:
				r.tmux_session === null ? null : { tmux_session: r.tmux_session as string, boot_id: r.boot_id as string, pid: r.pid as number },
		}));
}

/** Every runtime the recorder registered, including ones whose session has no row yet. */
export type RuntimeRecord = {
	tmux_session: string;
	session_id: string;
	harness: Harness;
	cwd: string;
	project_root: string;
	boot_id: string;
	pid: number;
	started_at: number;
};

export function runtimeRecords(db: Db): RuntimeRecord[] {
	return db.all("SELECT tmux_session, session_id, harness, cwd, project_root, boot_id, pid, started_at FROM runtimes").map((r) => ({
		tmux_session: r.tmux_session as string,
		session_id: r.session_id as string,
		harness: r.harness as Harness,
		cwd: r.cwd as string,
		project_root: r.project_root as string,
		boot_id: r.boot_id as string,
		pid: r.pid as number,
		started_at: r.started_at as number,
	}));
}

/**
 * Every session's states. A family, a session together with everything it started short of an Operator, is Inactive
 * only as a whole: while any open member is still active, none of them are.
 */
export function deriveSessions(rows: SessionRow[], w: World): SessionState[] {
	const states = rows.map((row) => derive(row, w));
	const byId = new Map(states.map((s) => [s.id, s]));
	const rootOf = (s: SessionState): string => {
		let at = s;
		for (;;) {
			const up = at.parentId === null ? undefined : byId.get(at.parentId);
			if (!up || up.operator) return at.id;
			at = up;
		}
	};
	const active = new Set(states.filter((s) => s.open && !s.operator && !s.inactive && !s.snoozed).map(rootOf));
	for (const s of states) if (s.inactive && active.has(rootOf(s))) s.inactive = false;
	return states;
}

function derive(row: SessionRow, w: World): SessionState {
	const live = row.runtime !== null && runtimeLive(row.runtime, w.bootId, w.hosts);
	const open = row.archived_at === null || row.archived_at < row.last_prompt_at;
	const activity: Phase = live ? row.phase : "idle";
	// A clean shutdown takes its runtime row with it; a killed process leaves one behind, from this boot or an earlier one.
	const cutOff: CutOff | null =
		live || row.phase === "idle" ? null : row.runtime === null ? "shutdown" : row.runtime.boot_id === w.bootId ? "killed" : "restart";
	// A timed snooze holds through any conversation; next_message's ends with the next message or prompt.
	const holds =
		row.snoozed_at !== null &&
		(row.snoozed_until === null
			? row.snoozed_at >= row.last_prompt_at && (row.last_message_at ?? 0) < row.snoozed_at
			: row.snoozed_until > w.now);
	const errored = activity === "idle" && !cutOff && row.errored_at !== null && row.errored_at >= row.last_prompt_at;
	const snoozed = open && holds && activity !== "blocked" && !cutOff && !errored;
	// A timed snooze running out is news: Unseen until I look, and fresh for inactive_after.
	const woke = row.snoozed_until !== null && row.snoozed_until <= w.now ? row.snoozed_until : 0;
	const activityAt = Math.max(row.last_prompt_at, row.last_settled_at ?? 0, woke);
	const unseen = open && !snoozed && Math.max(row.last_settled_at ?? 0, woke) > (row.visited_at ?? 0);
	const operator = row.cwd === operatorDir();
	return {
		id: row.session_id,
		harness: row.harness,
		parentId: row.parent_id,
		title: row.title,
		project: row.project_root,
		cwd: row.cwd,
		branch: row.branch,
		group: row.group_name,
		operator,
		open,
		live,
		activity,
		unseen,
		cutOff,
		errored,
		inactive: open && !operator && !snoozed && activityAt < w.now - w.inactiveAfterMs && activity !== "blocked" && !unseen,
		snoozed,
		snoozedUntil: snoozed ? row.snoozed_until : null,
		createdAt: row.created_at,
		activityAt,
		visitedAt: row.visited_at,
		archivedAt: open ? null : row.archived_at,
	};
}

/** Every recorded Session as of now. */
export function states(db: Db): SessionState[] {
	const w = world(loadConfig().inactiveAfterMs);
	return deriveSessions(sessionRows(db), w);
}

/** One Session as of now, for a tool that names it. */
export function sessionState(db: Db, id: string): SessionState {
	const found = states(db).find((s) => s.id === id);
	if (!found) throw new SwbError(`no session ${id}; session_reachable lists them`);
	return found;
}

/** The open sessions a session started, and those they started, short of an Operator: its Family below it. */
export function openDescendants<S extends SessionState>(sessions: Iterable<S>, id: string): S[] {
	const all = [...sessions];
	const out: S[] = [];
	const visit = (parent: string) => {
		for (const child of all) {
			if (child.parentId !== parent || child.operator) continue;
			if (child.open) out.push(child);
			visit(child.id);
		}
	};
	visit(id);
	return out;
}

export function displayName(state: { id: string; title: string | null }): string {
	return state.title ?? state.id;
}

export function projectName(root: string): string {
	return basename(root);
}
