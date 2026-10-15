import type { Db } from "./db.ts";
import type { Harness } from "./index.ts";

// Messages between sessions wait in swb.db until the target's line takes them. Every live line polls for its own.

export type MessageKind = "message" | "cancel";

export type Message = {
	id: string;
	kind: MessageKind;
	sourceId: string;
	targetId: string;
	body: string;
	requestResponse: boolean;
	createdAt: number;
};

const HARNESS_NAMES: Record<Harness, string> = { pi: "pi", claude: "Claude Code", codex: "Codex" };

export function harnessName(harness: Harness): string {
	return HARNESS_NAMES[harness];
}

/** Undelivered messages to a session, oldest first, or none once it's archived. */
export function pendingFor(db: Db, targetId: string): Message[] {
	return db
		.all(
			`SELECT id, kind, source_id, target_id, body, request_response, created_at FROM messages
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
	const row = db.get("SELECT title, harness FROM sessions WHERE session_id = ?", sourceId);
	return { title: (row?.title as string | null) ?? sourceId, harness: (row?.harness as Harness | undefined) ?? null };
}

/** The message as the model reads it: who it's from, how to answer, and the body. */
export function frame(db: Db, m: Message): string {
	const from = sender(db, m.sourceId);
	const harness = from.harness ? `, ${harnessName(from.harness)}` : "";
	const reply = m.requestResponse ? `\n\nResponse requested: reply with session_send_message to session ${m.sourceId}.` : "";
	return `Message from session "${from.title}" (session: ${m.sourceId}${harness}):\n\n${m.body}${reply}`;
}
