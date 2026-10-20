import { type FSWatcher, mkdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "./db.ts";
import type { Harness } from "./index.ts";
import { titleOf } from "./record.ts";

// Messages between sessions wait in swb.db until the target's line takes them. A sender rings the target's doorbell
// once its message commits, and every live line listens for its own, polling as well for a sender that didn't ring.
// The db's own files can't stand in for a doorbell: the WAL's last write lands before its commit is visible.

function doorbells(db: Db): string {
	const dir = join(dirname(db.path), "doorbells");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Tells the target's line it has mail, by a file named for it that comes and goes. Only after the commit. */
export function ring(db: Db, targetId: string): void {
	const bell = join(doorbells(db), targetId);
	writeFileSync(bell, "");
	rmSync(bell, { force: true });
}

/** Hears every ring, with the session it's for, until closed; it doesn't hold the process open. */
export function listen(db: Db, heard: (targetId: string) => void): FSWatcher {
	const watcher = watch(doorbells(db), (_event, name) => {
		if (name) heard(name.toString());
	});
	watcher.unref();
	return watcher;
}

export type MessageKind = "message" | "cancel";

export type Message = {
	id: string;
	kind: MessageKind;
	sourceId: string;
	targetId: string;
	body: string;
	requestResponse: boolean;
	createdAt: number;
	/** What a schedule delivers: which one, and when it was due. */
	scheduleId: string | null;
	scheduledFor: number | null;
};

const HARNESS_NAMES: Record<Harness, string> = { pi: "pi", claude: "Claude Code", codex: "Codex" };

export function harnessName(harness: Harness): string {
	return HARNESS_NAMES[harness];
}

/** Undelivered messages to a session, oldest first, or none once it's archived. */
export function pendingFor(db: Db, targetId: string): Message[] {
	return db
		.all(
			`SELECT id, kind, source_id, target_id, body, request_response, created_at, schedule_id, scheduled_for FROM messages
			 WHERE target_id = ? AND delivered_at IS NULL AND cancelled_at IS NULL ORDER BY created_at, rowid`,
			targetId,
		)
		.map((row) => ({
			id: row.id as string,
			kind: row.kind as MessageKind,
			sourceId: row.source_id as string,
			targetId: row.target_id as string,
			body: row.body as string,
			requestResponse: row.request_response === 1,
			createdAt: row.created_at as number,
			scheduleId: row.schedule_id as string | null,
			scheduledFor: row.scheduled_for as number | null,
		}));
}

export function markOffered(db: Db, id: string): void {
	db.run("UPDATE messages SET offered_at = coalesce(offered_at, ?) WHERE id = ?", Date.now(), id);
}

export function markDelivered(db: Db, id: string): void {
	db.run("UPDATE messages SET delivered_at = coalesce(delivered_at, ?) WHERE id = ?", Date.now(), id);
}

/** Who a message is from, as the recipient's model reads it. */
export function sender(db: Db, sourceId: string): { title: string; harness: Harness | null } {
	const row = db.get("SELECT harness FROM sessions WHERE session_id = ?", sourceId);
	return { title: titleOf(db, sourceId) ?? sourceId, harness: (row?.harness as Harness | undefined) ?? null };
}

/** A moment as the person and the model both read it, in local time: "Sat Oct 17, 14:30". */
export function clockTime(ms: number): string {
	const d = new Date(ms);
	const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
	return `${day}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A delivery more than this past its time says when it came. */
const LATE_MS = 60_000;

/** The message as the model reads it: who it's from, when it was scheduled for, how to answer, and the body. */
export function frame(db: Db, m: Message, now = Date.now()): string {
	const from = sender(db, m.sourceId);
	const who = m.sourceId === m.targetId ? ", this session" : from.harness ? `, ${harnessName(from.harness)}` : "";
	let when = "";
	if (m.scheduledFor !== null) {
		when = `, scheduled for ${clockTime(m.scheduledFor)}`;
		if (now - m.scheduledFor > LATE_MS) when += `, delivered ${clockTime(now)}`;
		if (m.scheduleId) when += ` (schedule: ${m.scheduleId})`;
	}
	const reply = m.requestResponse ? `\n\nResponse requested: reply with session_send_message to session ${m.sourceId}.` : "";
	return `Message from session "${from.title}" (session: ${m.sourceId}${who})${when}:\n\n${m.body}${reply}`;
}
