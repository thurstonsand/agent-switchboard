import { existsSync } from "node:fs";
import { type Conversation, type Entry, lines, type Part, textOf } from "./conversation.ts";

type CodexLine = {
	type?: string;
	timestamp?: string;
	payload?: {
		type?: string;
		role?: string;
		content?: unknown;
		name?: string;
		call_id?: string;
		arguments?: unknown;
		input?: unknown;
		output?: unknown;
		message?: string;
		error?: { message?: string };
	};
};

/** Codex records a provider's error body as it came; its own message is inside. */
function codexError(message: string): string {
	try {
		return (JSON.parse(message) as { error?: { message?: string } }).error?.message ?? message;
	} catch {
		return message;
	}
}

/** A function call's arguments, which Codex records as JSON text. */
function parsed(args: unknown): unknown {
	if (typeof args !== "string") return args;
	try {
		return JSON.parse(args);
	} catch {
		return {};
	}
}

/** A tool's output: text, or content items, or both under content. */
function output(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return [textOf(value, "input_text"), textOf(value, "output_text")].filter((t) => t !== "").join("\n");
	const content = (value as { content?: unknown } | null)?.content;
	return content === undefined ? "" : output(content);
}

function entry({ type, payload: p }: CodexLine): Pick<Entry, "role" | "parts" | "ending"> | null {
	if (type === "event_msg" && p?.type === "turn_aborted") return { role: "context", parts: [], ending: { kind: "stopped" } };
	if (type === "event_msg" && p?.type === "task_complete" && p.error)
		return { role: "context", parts: [], ending: { kind: "error", message: codexError(p.error.message ?? "unknown error") } };
	if (type === "compacted") return { role: "compaction", parts: [{ type: "text", text: p?.message ?? "" }], ending: null };
	if (type !== "response_item" || !p) return null;
	const call = (args: unknown): Part[] => [{ type: "call", id: p.call_id ?? null, name: p.name ?? "tool", args }];
	if (p.type === "function_call") return { role: "agent", parts: call(parsed(p.arguments)), ending: null };
	if (p.type === "custom_tool_call") return { role: "agent", parts: call(p.input), ending: null };
	if (p.type === "function_call_output" || p.type === "custom_tool_call_output")
		return { role: "tool", parts: [{ type: "result", id: p.call_id ?? null, text: output(p.output) }], ending: null };
	if (p.type !== "message") return null;
	const body = textOf(p.content, p.role === "assistant" ? "output_text" : "input_text").trim();
	const parts: Part[] = body === "" ? [] : [{ type: "text", text: body }];
	if (p.role === "assistant") return { role: "agent", parts, ending: null };
	// The context Codex injects as user text starts with a tag.
	if (p.role === "user" && !body.startsWith("<")) return { role: "user", parts, ending: null };
	return { role: "context", parts, ending: null };
}

/** Codex rollouts: one line of items in order, each entry's ref its line number. */
export function readCodex(path: string): Conversation {
	const entries: Entry[] = [];
	(lines(path) as CodexLine[]).forEach((line, i) => {
		const read = entry(line);
		if (read) entries.push({ ref: String(i + 1), parent: entries.at(-1)?.ref ?? null, at: line.timestamp ?? null, ...read });
	});
	return { entries, leaf: entries.at(-1)?.ref ?? null, subagents: [] };
}

/**
 * Where a rollout is now. Codex moves an archived thread's rollout to archived_sessions/ and back on unarchive, and
 * compresses week-old ones, so its recorded path may have moved.
 */
export function locateRollout(path: string): string {
	const archived = path.replace(/\/sessions\/\d{4}\/\d{2}\/\d{2}\/([^/]+)$/, "/archived_sessions/$1");
	return [path, `${path}.zst`, archived, `${archived}.zst`].find((candidate) => existsSync(candidate)) ?? path;
}

/** Whether Codex holds a rollout as archived, so its thread can't resume until Codex unarchives it. */
export function archivedInCodex(path: string): boolean {
	return locateRollout(path).includes("/archived_sessions/");
}

/** The model and effort of Codex's last turn, an effort of null being Codex's own default. */
export function codexInUse(path: string): { model: string | null; effort: string | null } {
	type Context = { model?: string; effort?: string | null; collaboration_mode?: { settings?: { reasoning_effort?: string | null } } };
	const context = (lines(locateRollout(path)) as CodexLine[]).findLast((e) => e.type === "turn_context")?.payload as Context | undefined;
	return {
		model: context?.model ?? null,
		effort: context?.effort ?? context?.collaboration_mode?.settings?.reasoning_effort ?? null,
	};
}
