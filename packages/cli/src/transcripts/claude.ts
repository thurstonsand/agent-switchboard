import { type Conversation, type Entry, lines, type Part, textOf } from "./conversation.ts";

type ClaudeBlock = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown };
type ClaudeEntry = {
	type?: string;
	subtype?: string;
	uuid?: string;
	parentUuid?: string | null;
	logicalParentUuid?: string;
	timestamp?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	isCompactSummary?: boolean;
	isApiErrorMessage?: boolean;
	message?: { role: string; content: unknown };
};

/** What Claude Code writes as the user's message when Esc stops a turn. */
const CLAUDE_STOPPED = "[Request interrupted by user";

function entry(e: ClaudeEntry): Pick<Entry, "role" | "parts" | "ending"> {
	if ((e.type !== "user" && e.type !== "assistant") || !e.message) return { role: "context", parts: [], ending: null };
	const body = textOf(e.message.content).trim();
	const text: Part[] = body === "" ? [] : [{ type: "text", text: body }];
	const blocks = Array.isArray(e.message.content) ? (e.message.content as ClaudeBlock[]) : [];
	if (e.isApiErrorMessage) return { role: "agent", parts: [], ending: { kind: "error", message: body.replace(/^API Error: /, "") } };
	if (e.type === "assistant") {
		const calls = blocks.flatMap((b): Part[] =>
			b.type === "tool_use" ? [{ type: "call", id: b.id ?? null, name: b.name ?? "tool", args: b.input }] : [],
		);
		return { role: e.isMeta ? "context" : "agent", parts: [...text, ...calls], ending: null };
	}
	if (e.isCompactSummary) return { role: "compaction", parts: text, ending: null };
	if (body.startsWith(CLAUDE_STOPPED)) return { role: "user", parts: [], ending: { kind: "stopped" } };
	const results = blocks.flatMap((b): Part[] =>
		b.type === "tool_result" ? [{ type: "result", id: b.tool_use_id ?? null, text: textOf(b.content) }] : [],
	);
	// Claude Code wraps its own commands and reminders in tags; only what was typed or answered is the user's.
	if (e.isMeta || body.startsWith("<")) return { role: "context", parts: [...text, ...results], ending: null };
	return { role: text.length === 0 && results.length > 0 ? "tool" : "user", parts: [...text, ...results], ending: null };
}

/**
 * Claude Code: entries link by parentUuid, and a compaction's boundary by logicalParentUuid to the history it
 * summarized. The session continues from the last leaf, not simply the last line: a conversation Claude Code writes as
 * it exits can come out of order, a branch of its attachments last. Refs are a uuid's first 8 characters, or all of it
 * where two share them.
 */
export function readClaude(path: string): Conversation {
	const raw = (lines(path) as (ClaudeEntry & { uuid: string })[]).filter((e) => e.uuid && !e.isSidechain);
	const heads = new Map<string, number>();
	for (const { uuid } of raw) heads.set(uuid.slice(0, 8), (heads.get(uuid.slice(0, 8)) ?? 0) + 1);
	const refs = new Map(raw.map(({ uuid }) => [uuid, heads.get(uuid.slice(0, 8)) === 1 ? uuid.slice(0, 8) : uuid]));
	const entries = raw.map((e): Entry => {
		const parent = e.subtype === "compact_boundary" ? (e.logicalParentUuid ?? e.parentUuid) : e.parentUuid;
		return { ref: refs.get(e.uuid) as string, parent: (parent && refs.get(parent)) || null, at: e.timestamp ?? null, ...entry(e) };
	});
	const parents = new Set(entries.map((e) => e.parent));
	return { entries, leaf: entries.findLast((e) => !parents.has(e.ref))?.ref ?? null };
}

/** The session's latest given name (`--name`, `/rename`), else the latest title Claude Code generated for it. */
export function claudeTitle(path: string): string | null {
	let custom: string | null = null;
	let ai: string | null = null;
	for (const entry of lines(path) as { type?: string; aiTitle?: string; customTitle?: string }[]) {
		if (entry.type === "custom-title" && entry.customTitle) custom = entry.customTitle;
		else if (entry.type === "ai-title" && entry.aiTitle) ai = entry.aiTitle;
	}
	return custom ?? ai;
}
