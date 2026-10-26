import { SwbError } from "../errors.ts";
import { type Conversation, type Ending, type Entry, lines, type Part, type Subagent, textOf } from "./conversation.ts";

type PiBlock = { type?: string; text?: string; id?: string; name?: string; arguments?: unknown };
type PiMessage = {
	role: string;
	content: unknown;
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	command?: string;
	output?: string;
};
type PiEntry = {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: PiMessage;
	content?: unknown;
	summary?: string;
	customType?: string;
	data?: { childSessionId?: string; childSessionFile?: string; title?: string };
};

function ending({ stopReason, errorMessage }: PiMessage): Ending | null {
	// Esc during a tool call aborts pi's next model request before it's sent, and pi-ai records that as an error
	// carrying the AbortError's own message.
	if (stopReason === "aborted" || errorMessage === "This operation was aborted") return { kind: "stopped" };
	if (stopReason === "error") return { kind: "error", message: errorMessage ?? "unknown error" };
	return null;
}

function message(m: PiMessage): Pick<Entry, "role" | "parts" | "ending"> {
	const text = (body: string): Part[] => (body.trim() === "" ? [] : [{ type: "text", text: body.trim() }]);
	switch (m.role) {
		case "user":
			return { role: "user", parts: text(textOf(m.content)), ending: null };
		case "assistant": {
			const blocks = Array.isArray(m.content) ? (m.content as PiBlock[]) : [{ type: "text", text: String(m.content) }];
			const parts = blocks.flatMap((block): Part[] => {
				if (block.type === "text") return text(block.text ?? "");
				if (block.type === "toolCall") return [{ type: "call", id: block.id ?? null, name: block.name ?? "tool", args: block.arguments }];
				return [];
			});
			return { role: "agent", parts, ending: ending(m) };
		}
		case "toolResult":
			return { role: "tool", parts: [{ type: "result", id: m.toolCallId ?? null, text: textOf(m.content) }], ending: null };
		case "bashExecution":
			return { role: "context", parts: text(`$ ${m.command ?? ""}\n${m.output ?? ""}`), ending: null };
		default:
			return { role: "context", parts: text(textOf(m.content)), ending: null };
	}
}

function entry(e: PiEntry): Pick<Entry, "role" | "parts" | "ending"> {
	const summary = (role: "compaction" | "branch") => ({ role, parts: [{ type: "text" as const, text: e.summary ?? "" }], ending: null });
	if (e.type === "message" && e.message) return message(e.message);
	if (e.type === "compaction") return summary("compaction");
	if (e.type === "branch_summary") return summary("branch");
	if (e.type === "custom_message") return { role: "context", parts: [{ type: "text", text: textOf(e.content) }], ending: null };
	return { role: "context", parts: [], ending: null };
}

/** pi-sessions records each subagent it launches in the parent, with the child's own session file. */
function subagent(e: PiEntry): Subagent[] {
	const d = e.data;
	if (e.type !== "custom" || e.customType !== "pi-sessions.subagent_launched" || !d?.childSessionId || !d.childSessionFile) return [];
	return [{ id: d.childSessionId, label: d.title ?? d.childSessionId, path: d.childSessionFile }];
}

/** pi v3: entries link by parentId, and the session continues from the last one. */
export function readPi(path: string): Conversation {
	const all = lines(path) as PiEntry[];
	const header = all[0] as { type: string; version: number } | undefined;
	if (header?.type !== "session" || header.version !== 3)
		throw new SwbError(`${path}: pi session format v${header?.version}, swb reads v3`);
	const entries = all
		.slice(1)
		.filter((e) => e.id !== undefined)
		.map((e): Entry => ({ ref: e.id as string, parent: e.parentId ?? null, at: e.timestamp ?? null, ...entry(e) }));
	return { entries, leaf: entries.at(-1)?.ref ?? null, subagents: all.flatMap(subagent) };
}

/** The model and thinking level pi last switched to. */
export function piInUse(path: string): { model: string | null; effort: string | null } {
	const entries = lines(path) as Record<string, unknown>[];
	const model = entries.findLast((e) => e.type === "model_change");
	const level = entries.findLast((e) => e.type === "thinking_level_change");
	return {
		model: model ? `${model.provider}/${model.modelId}` : null,
		effort: (level?.thinkingLevel as string | undefined) ?? null,
	};
}
