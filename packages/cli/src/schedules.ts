import { existsSync, realpathSync } from "node:fs";
import { type Db, type Harness, SNOOZE_PRESETS, type Snooze, type SnoozePreset } from "@swb/shared";
import { clockTime, harnessName } from "@swb/shared/mailbox";
import { recordTx, titleOf } from "@swb/shared/record";
import type { ToolResult } from "@swb/shared/tools";
import { Cron } from "croner";
import { displayName, sessionState, states } from "./derive.ts";
import { SwbError } from "./errors.ts";
import { presetLaunch } from "./harnesses.ts";
import { randomHex } from "./sessions.ts";

// Schedules deliver a message later, once or on a cron, or launch a new session with it as the goal. They wait in
// swb.db; the clock in the sessions server fires them. Snooze is a mark beside them: derive() decides when it holds.

const HOUR = 3_600_000;
/** The latest moment a Date can hold. */
const MAX_TIME = 8.64e15;

/** When a snooze preset ends; next_message has no time. */
export function presetUntil(preset: SnoozePreset, now: number): number | null {
	switch (preset) {
		case "one_hour":
			return now + HOUR;
		case "one_day":
			return now + 24 * HOUR;
		case "monday": {
			// 9 AM local on the next Monday; on a Monday, the one after.
			const at = new Date(now);
			at.setDate(at.getDate() + ((8 - at.getDay()) % 7 || 7));
			return at.setHours(9, 0, 0, 0);
		}
		case "next_message":
			return null;
	}
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const ISO_DURATION = /^P(?=\d|T\d)(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** An ISO 8601 time, local unless it has an offset as cron is, or a duration from now, as epoch ms in the future. */
export function when(text: string, now: number, what: string): number {
	const duration = ISO_DURATION.exec(text);
	let at: number;
	if (duration) {
		const [w, d, h, m, s] = duration.slice(1).map((part) => Number(part ?? 0)) as [number, number, number, number, number];
		at = now + ((((w * 7 + d) * 24 + h) * 60 + m) * 60 + s) * 1000;
		if (at <= now) throw new SwbError(`${what}: ${text} is no time from now`);
	} else {
		if (!ISO_TIME.test(text)) throw new SwbError(`${what}: "${text}" is neither an ISO 8601 time nor a duration like "PT2H"`);
		at = Date.parse(text);
		if (Number.isNaN(at)) throw new SwbError(`${what}: "${text}" is no real time`);
		if (at <= now) throw new SwbError(`${what}: ${text} has passed`);
	}
	if (at > MAX_TIME) throw new SwbError(`${what}: ${text} is too far off`);
	return at;
}

function cronOf(expr: string): Cron {
	if (expr.trim().split(/\s+/).length !== 5) throw new SwbError(`cron: "${expr}" needs 5 fields, "M H DoM Mon DoW"`);
	try {
		return new Cron(expr, { paused: true, mode: "5-part" });
	} catch (error) {
		throw new SwbError(`cron: "${expr}": ${(error as Error).message}`);
	}
}

/** A cron's first run after `after`, or null when it never runs again; a run missed while the machine slept is not owed. */
export function nextRun(expr: string, after: number): number | null {
	return cronOf(expr).nextRun(new Date(after))?.getTime() ?? null;
}

/** A new session each time it fires, on the preset these fields choose, as session_launch's do. */
export type Launch = {
	harness: Harness | null;
	model: string | null;
	effort: string | null;
	agent: string | null;
	cwd: string | null;
	title: string;
};

/** "a new Claude Code session", or with no harness chosen, "a new session". */
export function newSessionName(launch: Launch): string {
	return `a new ${launch.harness ? `${harnessName(launch.harness)} ` : ""}session "${launch.title}"`;
}

export type ScheduleSpec = {
	from: string;
	/** The recipient; null with a launch, and this session with neither. */
	to: string | null;
	launch: Launch | null;
	body: string;
	at: string | null;
	cron: string | null;
	label: string;
	requestResponse: boolean;
	snooze: boolean;
	requestId: string | null;
};

type ScheduleRow = {
	id: string;
	source_id: string;
	target_id: string | null;
	launch: string | null;
	body: string;
	request_response: number;
	label: string;
	cron: string | null;
	next_at: number | null;
	last_fired_at: number | null;
	cancelled_at: number | null;
};

const COLUMNS = "id, source_id, target_id, launch, body, request_response, label, cron, next_at, last_fired_at, cancelled_at";

function rowOf(db: Db, id: string): ScheduleRow | undefined {
	return db.get(`SELECT ${COLUMNS} FROM schedules WHERE id = ?`, id) as ScheduleRow | undefined;
}

/** Who a schedule goes to, as the session asking reads it. */
function recipient(db: Db, row: ScheduleRow, from: string): string {
	if (row.launch) {
		return newSessionName(JSON.parse(row.launch) as Launch);
	}
	return sessionName(db, row.target_id as string, from);
}

function sessionName(db: Db, id: string, from: string): string {
	if (id === from) return "this session";
	return `"${titleOf(db, id) ?? id}"`;
}

function scheduled(db: Db, row: ScheduleRow, from: string, snoozed: boolean): ToolResult {
	const to = recipient(db, row, from);
	const next = clockTime(row.next_at as number);
	const text = row.cron
		? `Scheduled "${row.label}" (${row.cron}) to ${to} (schedule: ${row.id}); next ${next}.`
		: `Scheduled for ${next} to ${to} (schedule: ${row.id}).`;
	return {
		text: snoozed ? `${text} ${to === "this session" ? "This session is" : `${to} is`} snoozed until then.` : text,
		details: { ...publicRow(row), snoozed },
	};
}

/** Accepts a schedule; with snooze, its recipient is snoozed until the first fire. */
export async function schedule(db: Db, s: ScheduleSpec): Promise<ToolResult> {
	if (!s.body.trim()) throw new SwbError("the message is empty");
	if (!s.label.trim()) throw new SwbError("the label is empty");
	if ((s.at === null) === (s.cron === null)) throw new SwbError("give at, to run once, or cron, to recur: one of them");
	if (s.to !== null && s.launch !== null) throw new SwbError("give session or launch, not both");
	if (s.launch && s.snooze) throw new SwbError("snooze needs an existing session; a launch has none to snooze");
	const to = s.launch ? null : (s.to ?? s.from);
	if (to === s.from && s.requestResponse) throw new SwbError("a message to this session can't request a response from it");
	// Refused now rather than when it fires; it fires on the shortlist as it is then.
	if (s.launch) await presetLaunch(s.launch, null);
	// Under the write lock, so a retried call finds its first, and an archive can't land between the check and the insert.
	return recordTx(db, () => {
		if (s.requestId) {
			const existing = db.get(`SELECT ${COLUMNS} FROM schedules WHERE source_id = ? AND request_id = ?`, s.from, s.requestId);
			if (existing) {
				const row = existing as ScheduleRow;
				return { text: `Already scheduled: ${describe(db, row, s.from)}`, details: { ...publicRow(row), snoozed: false } };
			}
		}
		const now = Date.now();
		const source = sessionState(db, s.from);
		if (to !== null) {
			const target = sessionState(db, to);
			if (!target.open) throw new SwbError(`"${displayName(target)}" is archived; unarchive it first`);
		}
		let launch: string | null = null;
		if (s.launch) {
			const cwd = s.launch.cwd ?? source.cwd;
			if (!existsSync(cwd)) throw new SwbError(`no directory ${cwd}`);
			launch = JSON.stringify({ ...s.launch, cwd: realpathSync(cwd) } satisfies Launch);
		}
		const nextAt = s.cron !== null ? nextRun(s.cron, now) : when(s.at as string, now, "at");
		if (nextAt === null) throw new SwbError(`cron: "${s.cron}" never runs`);
		let id = randomHex(4);
		while (rowOf(db, id)) id = randomHex(4);
		db.run(
			`INSERT INTO schedules (id, source_id, target_id, launch, body, request_response, label, cron, request_id, created_at, next_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			s.from,
			to,
			launch,
			s.body,
			s.requestResponse ? 1 : 0,
			s.label,
			s.cron,
			s.requestId,
			now,
			nextAt,
		);
		if (s.snooze && to !== null) markSnoozed(db, to, now, nextAt);
		return scheduled(db, rowOf(db, id) as ScheduleRow, s.from, s.snooze);
	});
}

/** The schedules a session set or receives: pending first, soonest first, then the last ten finished. */
export function listSchedules(db: Db, from: string): ToolResult {
	const mine = "(source_id = ?1 OR target_id = ?1) AND cancelled_at IS NULL";
	const pending = db.all(`SELECT ${COLUMNS} FROM schedules WHERE ${mine} AND next_at IS NOT NULL ORDER BY next_at`, from) as ScheduleRow[];
	const finished = db.all(
		`SELECT ${COLUMNS} FROM schedules WHERE ${mine} AND next_at IS NULL ORDER BY last_fired_at DESC LIMIT 10`,
		from,
	) as ScheduleRow[];
	if (pending.length + finished.length === 0) return { text: "No schedules.", details: { schedules: [] } };
	const lines = [...pending, ...finished].map((row) => `- ${describe(db, row, from)}`);
	const text = `Schedules (id · when · runs · recipient):\n${lines.join("\n")}`;
	return { text, details: { schedules: [...pending, ...finished].map(publicRow) } };
}

/** One schedule as session_schedules lists it: id, when, its runs, who it goes to or comes from, and its message. */
function describe(db: Db, row: ScheduleRow, from: string): string {
	const direction = row.source_id === from ? `to ${recipient(db, row, from)}` : `from ${sessionName(db, row.source_id, from)}`;
	const when = row.cron ? `"${row.label}" (${row.cron})` : `"${row.label}"`;
	const runs = [
		...(row.next_at !== null ? [`next ${clockTime(row.next_at)}`] : []),
		...(row.last_fired_at !== null ? [`${row.next_at === null ? "ran" : "last ran"} ${clockTime(row.last_fired_at)}`] : []),
		...(row.cancelled_at !== null ? ["cancelled"] : []),
	].join(" · ");
	return `${row.id} · ${when} · ${runs} · ${direction}\n  ${row.body.replace(/\s+/g, " ").slice(0, 200)}`;
}

function publicRow(row: ScheduleRow) {
	return {
		id: row.id,
		source: row.source_id,
		target: row.target_id,
		launch: row.launch ? (JSON.parse(row.launch) as Launch) : null,
		label: row.label,
		cron: row.cron,
		nextAt: row.next_at,
		lastFiredAt: row.last_fired_at,
		message: row.body,
	};
}

/** Cancels a pending schedule this session set or receives. A snooze it set stays; that is the snooze's own. */
export function unschedule(db: Db, from: string, id: string): ToolResult {
	return recordTx(db, () => {
		const row = rowOf(db, id);
		if (!row || (row.source_id !== from && row.target_id !== from))
			throw new SwbError(`no schedule ${id} for this session; session_schedules lists them`);
		if (row.cancelled_at !== null) throw new SwbError(`schedule ${id} is already cancelled`);
		if (row.next_at === null) throw new SwbError(`schedule ${id} has already run`);
		db.run("UPDATE schedules SET cancelled_at = ? WHERE id = ?", Date.now(), id);
		return { text: `Unscheduled "${row.label}" (schedule: ${id}).`, details: { id } };
	});
}

function markSnoozed(db: Db, id: string, at: number | null, until: number | null): void {
	db.run(
		`INSERT INTO marks (session_id, snoozed_at, snoozed_until) VALUES (?, ?, ?)
		 ON CONFLICT (session_id) DO UPDATE SET snoozed_at = excluded.snoozed_at, snoozed_until = excluded.snoozed_until`,
		id,
		at,
		until,
	);
}

/** Snoozes a session until a time or its next message, or unsnoozes it. */
export function snooze(db: Db, from: string | null, id: string, value: Snooze): ToolResult {
	const target = states(db).find((s) => s.id === id);
	if (!target)
		throw new SwbError(
			db.get("SELECT 1 FROM runtimes WHERE session_id = ?", id) ? "nothing to snooze before the first prompt" : `no session ${id}`,
		);
	const name = from === id ? "this session" : `"${displayName(target)}"`;
	if (!target.open) throw new SwbError(`${name} is archived; unarchive it first`);
	const now = Date.now();
	if (value === "off") {
		recordTx(db, () => markSnoozed(db, id, null, null));
		return { text: target.snoozed ? `Unsnoozed ${name}.` : `${name} wasn't snoozed.`, details: { id, snoozed: false } };
	}
	const until = typeof value === "string" ? presetUntil(value, now) : when(value.until, now, "snooze until");
	recordTx(db, () => markSnoozed(db, id, now, until));
	const text = `Snoozed ${name} until ${until === null ? "its next message" : clockTime(until)}.`;
	return { text, details: { id, snoozed: true, until } };
}

/** `swb snooze`'s value, as the tool's: a preset, off, or a time. */
export function snoozeValue(text: string): Snooze {
	if (text === "off" || (SNOOZE_PRESETS as readonly string[]).includes(text)) return text as Snooze;
	return { until: text };
}

/** What a session's Peek shows of the schedules aimed at it, and the launches it set: pending ones, then its last finished. */
export type ScheduleView = { id: string; label: string; cron: string | null; nextAt: number | null; lastFiredAt: number | null };

export function schedulesBySession(db: Db): Map<string, ScheduleView[]> {
	const rows = db.all(
		`SELECT id, coalesce(target_id, source_id) AS owner, label, cron, next_at, last_fired_at FROM schedules
		 WHERE cancelled_at IS NULL AND (next_at IS NOT NULL OR last_fired_at IS NOT NULL)
		 ORDER BY next_at IS NULL, next_at, last_fired_at DESC`,
	);
	const by = new Map<string, ScheduleView[]>();
	for (const row of rows) {
		const list = by.get(row.owner as string) ?? [];
		const finished = row.next_at === null;
		// Every pending one, and only the latest that has finished.
		if (finished && list.some((v) => v.nextAt === null)) continue;
		list.push({
			id: row.id as string,
			label: row.label as string,
			cron: row.cron as string | null,
			nextAt: row.next_at as number | null,
			lastFiredAt: row.last_fired_at as number | null,
		});
		by.set(row.owner as string, list);
	}
	return by;
}

/** When the next schedule is due, if any is. */
export function nextDue(db: Db): number | null {
	return (
		(db.get("SELECT min(next_at) AS at FROM schedules WHERE next_at IS NOT NULL AND cancelled_at IS NULL")?.at as number | null) ?? null
	);
}

export type Fired = {
	targets: string[];
	launches: { scheduleId: string; scheduledFor: number; source: string; launch: Launch; body: string; requestResponse: boolean }[];
};

/**
 * Fires every schedule due by now, in one transaction: a message for each recipient, each recurring one moved past now,
 * so a cron that missed several runs while the machine slept runs once. Launches happen after, outside the lock.
 */
export function fire(db: Db, now: number): Fired {
	return recordTx(db, () => {
		const due = db.all(
			`SELECT ${COLUMNS} FROM schedules WHERE next_at IS NOT NULL AND cancelled_at IS NULL AND next_at <= ? ORDER BY next_at`,
			now,
		) as ScheduleRow[];
		const fired: Fired = { targets: [], launches: [] };
		for (const row of due) {
			const next = row.cron ? nextRun(row.cron, now) : null;
			db.run("UPDATE schedules SET next_at = ?, last_fired_at = ? WHERE id = ?", next, now, row.id);
			if (row.launch) {
				fired.launches.push({
					scheduleId: row.id,
					scheduledFor: row.next_at as number,
					source: row.source_id,
					launch: JSON.parse(row.launch) as Launch,
					body: row.body,
					requestResponse: row.request_response === 1,
				});
				continue;
			}
			db.run(
				`INSERT INTO messages (id, kind, source_id, target_id, body, request_response, created_at, schedule_id, scheduled_for)
				 VALUES (?, 'message', ?, ?, ?, ?, ?, ?, ?)`,
				crypto.randomUUID(),
				row.source_id,
				row.target_id,
				row.body,
				row.request_response,
				now,
				row.id,
				row.next_at,
			);
			fired.targets.push(row.target_id as string);
		}
		return fired;
	});
}
