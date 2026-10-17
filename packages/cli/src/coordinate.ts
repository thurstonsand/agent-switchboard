import { existsSync, realpathSync } from "node:fs";
import { type Db, type Harness, operatorDir, type Snooze } from "@swb/shared";
import { frame, harnessName, type MessageKind, ring } from "@swb/shared/mailbox";
import { isArchived, markArchived, recordTx } from "@swb/shared/record";
import type { ToolResult } from "@swb/shared/tools";
import { CodexClient } from "./codex/client.ts";
import { codexSocket } from "./codex/host.ts";
import { displayName, type SessionState, sessionState, states } from "./derive.ts";
import { SwbError } from "./errors.ts";
import { snooze } from "./schedules.ts";
import { archive, ensureSessionsServer, launch, unarchive, wake } from "./sessions.ts";

// The coordination every line's tools run. Each returns the text the model reads, so all three harnesses say the same
// thing, and the facts a line may render. The sender is always the line's own session, never a tool argument.

function describe(s: SessionState): string {
	const state = s.live ? s.activity : s.interrupted ? "interrupted" : "dormant";
	return `- ${s.id} · ${harnessName(s.harness)} · "${displayName(s)}" · ${state} · ${s.cwd}`;
}

export function reachable(db: Db, from: string): ToolResult {
	const open = states(db)
		.filter((s) => s.open && s.id !== from)
		.sort((a, b) => b.activityAt - a.activityAt);
	const text =
		open.length === 0
			? "No other open sessions."
			: `Open sessions (id · harness · title · state · directory); a dormant one wakes when messaged:\n${open.map(describe).join("\n")}`;
	const sessions = open.map((s) => ({
		id: s.id,
		harness: s.harness,
		title: s.title,
		cwd: s.cwd,
		project: s.project,
		live: s.live,
		activity: s.activity,
	}));
	return { text, details: { sessions } };
}

export type Send = { from: string; to: string; body: string; requestResponse: boolean; requestId: string | null; kind: MessageKind };

/** Accepts a message for a session, waking it if it's dormant, and waits a while for its line to deliver it. */
export async function send(db: Db, m: Send): Promise<ToolResult> {
	if (m.to === m.from) throw new SwbError("a session can't message itself");
	if (m.kind === "message" && !m.body.trim()) throw new SwbError("the message is empty");
	const target = sessionState(db, m.to);
	if (!target.open) throw new SwbError(`"${displayName(target)}" is archived; unarchive it first`);
	if (m.kind === "cancel" && !(target.live && target.activity !== "idle")) {
		return { text: `"${displayName(target)}" has no running turn to cancel.`, details: { delivered: false, target: m.to } };
	}
	const id = recordTx(db, () => {
		if (m.requestId) {
			const existing = db.get("SELECT id, target_id, body FROM messages WHERE source_id = ? AND request_id = ?", m.from, m.requestId);
			if (existing) {
				if (existing.target_id !== m.to || existing.body !== m.body)
					throw new SwbError(`request ${m.requestId} was already used for another message`);
				return existing.id as string;
			}
		}
		const id = crypto.randomUUID();
		db.run(
			`INSERT INTO messages (id, kind, source_id, target_id, body, request_response, request_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			m.kind,
			m.from,
			m.to,
			m.body,
			m.requestResponse ? 1 : 0,
			m.requestId,
			Date.now(),
		);
		return id;
	});
	ring(db, m.to);
	const woke = !target.live;
	if (woke) wake(db, m.to);
	const delivered = await deliveredWithin(db, id, woke ? 60_000 : 15_000);
	const name = `"${displayName(target)}"`;
	const text =
		m.kind === "cancel"
			? delivered
				? `Cancelled ${name}'s turn.`
				: `${name} hasn't taken the cancel yet.`
			: delivered
				? `Delivered to ${name}${woke ? ", which was woken for it" : ""}.${m.requestResponse ? " Its reply will arrive as a message; end your turn rather than waiting." : ""}`
				: `Queued for ${name}${woke ? ", which is starting" : ""}; it arrives when its session takes it.`;
	return { text, details: { id, delivered, woke, target: { id: target.id, title: target.title, harness: target.harness } } };
}

/** A live line delivers within milliseconds of the ring, which the sending agent waits for; a lookup costs microseconds. */
async function deliveredWithin(db: Db, id: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const row = db.get("SELECT delivered_at FROM messages WHERE id = ?", id);
		if (row?.delivered_at !== null && row?.delivered_at !== undefined) return true;
		if (Date.now() > deadline) return false;
		await Bun.sleep(10);
	}
}

export type Launch = {
	from: string | null;
	harness: Harness;
	goal: string;
	cwd: string | null;
	title: string | null;
	requestResponse: boolean;
	model: string | null;
	/** The schedule that launches it, and when that was due, which its goal's frame says. */
	scheduled: { id: string; at: number } | null;
};

/** Starts a new managed session whose first turn is the goal, and waits until its harness has registered it. */
export async function launchSession(db: Db, l: Launch): Promise<ToolResult> {
	if (!l.goal.trim()) throw new SwbError("the goal is empty");
	const cwd = l.cwd ?? (l.from ? sessionState(db, l.from).cwd : null);
	if (!cwd) throw new SwbError("a directory is required");
	if (!existsSync(cwd)) throw new SwbError(`no directory ${cwd}`);
	const dir = realpathSync(cwd);
	// An Operator that names no directory would start another Operator in its own folder; starting one is the user's call.
	if (l.from && dir === operatorDir() && sessionState(db, l.from).operator)
		throw new SwbError("an Operator can't start another Operator; name a project's directory as cwd");
	// pi and Claude Code take an id up front; Codex mints its own, which its host reports once it binds.
	const sessionId = l.harness === "codex" ? undefined : crypto.randomUUID();
	const prompt = l.from
		? frame(db, {
				id: "",
				kind: "message",
				sourceId: l.from,
				targetId: "",
				body: l.goal,
				requestResponse: l.requestResponse,
				createdAt: Date.now(),
				scheduleId: l.scheduled?.id ?? null,
				scheduledFor: l.scheduled?.at ?? null,
			})
		: l.goal;
	ensureSessionsServer();
	const host = launch({
		harness: l.harness,
		cwd: dir,
		resume: null,
		...(sessionId ? { sessionId } : {}),
		prompt,
		...(l.title && l.harness === "claude" ? { title: l.title } : {}),
		...(l.model ? { model: l.model } : {}),
		...(l.from ? { parentId: l.from } : {}),
	});
	const id = await registered(db, host, 60_000);
	if (l.title && l.harness === "codex") await nameThread(host, id, l.title);
	else if (l.title && l.harness === "pi") await titled(db, id, l.title);
	const text = `Launched a ${harnessName(l.harness)} session (session: ${id}) in ${dir}.${l.requestResponse ? " It will report back as a message; end your turn rather than waiting." : ""}`;
	return { text, details: { id, harness: l.harness, host, cwd: dir } };
}

async function registered(db: Db, host: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const row = db.get("SELECT session_id FROM runtimes WHERE tmux_session = ?", host);
		if (row) return row.session_id as string;
		if (Date.now() > deadline) throw new SwbError(`the new session (${host}) didn't start within ${timeoutMs / 1000} s`);
		await Bun.sleep(100);
	}
}

/** Codex keeps the name itself, where its resume picker shows it too; the session's host records it from there. */
async function nameThread(host: string, id: string, title: string): Promise<void> {
	const client = await CodexClient.connect(codexSocket(host), "swb");
	try {
		await client.request("thread/name/set", { threadId: id, name: title });
	} finally {
		client.close();
	}
}

/** A requested title, once the first turn has made the session's row and only while the harness hasn't named it. */
async function titled(db: Db, id: string, title: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (db.get("SELECT 1 FROM sessions WHERE session_id = ?", id)) {
			recordTx(db, () => db.run("UPDATE sessions SET title = ? WHERE session_id = ? AND title IS NULL", title, id));
			return;
		}
		await Bun.sleep(100);
	}
	throw new SwbError(`launched ${id}, but its first turn didn't start within 15 s, so it isn't titled "${title}"`);
}

export type Update = { archived: boolean } | { snooze: Snooze };

/** swb_update_session's arguments, which change one thing at a time. */
export function updateOf(args: { archived?: boolean; snooze?: Snooze }): Update {
	if ((args.archived === undefined) === (args.snooze === undefined)) throw new SwbError("give archived or snooze: one of them");
	return args.archived === undefined ? { snooze: args.snooze as Snooze } : { archived: args.archived };
}

/**
 * Archives, unarchives, snoozes, or unsnoozes. A session archiving itself may do so mid-turn: its line quits when the
 * turn ends. Anyone else's archive refuses a running turn.
 */
export function update(db: Db, from: string | null, id: string, change: Update): ToolResult {
	if ("snooze" in change) return snooze(db, from, id, change.snooze);
	const { archived } = change;
	const target = sessionState(db, id);
	const name = `"${displayName(target)}"`;
	if (!archived) {
		unarchive(db, id);
		return { text: `Unarchived ${name}. It stays dormant until messaged.`, details: { id, archived } };
	}
	if (from === id) {
		if (!recordTx(db, () => markArchived(db, id))) throw new SwbError("nothing to archive before the first prompt");
		return { text: "Archived. This session quits when this turn ends.", details: { id, archived } };
	}
	if (isArchived(db, id)) return { text: `${name} is already archived.`, details: { id, archived } };
	archive(db, [id]);
	return { text: `Archived ${name}.`, details: { id, archived } };
}
