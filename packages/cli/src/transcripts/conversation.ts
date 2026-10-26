import { readFileSync } from "node:fs";
import { SwbError } from "../errors.ts";

// A session's conversation as every harness's transcript reduces to it: entries with stable refs, each linked to the
// one before it. pi and Claude Code branch, so several entries can share a parent; Codex is a single line.

/** How a turn ended without a reply: you stopped it, or its provider failed. */
export type Ending = { kind: "stopped" } | { kind: "error"; message: string };

export type Part =
	| { type: "text"; text: string }
	| { type: "call"; id: string | null; name: string; args: unknown }
	| { type: "result"; id: string | null; text: string };

/**
 * user and agent are what was typed and answered; tool carries results; context is what the harness put in the
 * conversation itself (instructions, reminders, command output, metadata); compaction and branch are summaries
 * standing in for history that is out of the model's context.
 */
export type Role = "user" | "agent" | "tool" | "context" | "compaction" | "branch";

export type Entry = {
	/** pi's entry id, the head of Claude Code's uuid, or the line number in a Codex rollout. */
	ref: string;
	parent: string | null;
	at: string | null;
	role: Role;
	parts: Part[];
	ending: Ending | null;
};

export type Conversation = { entries: Entry[]; leaf: string | null };

/** A transcript's JSON lines; the last may be mid-write, and is skipped until it parses. */
export function lines(path: string): unknown[] {
	const raw = path.endsWith(".zst") ? new TextDecoder().decode(Bun.zstdDecompressSync(readFileSync(path))) : readFileSync(path, "utf8");
	return raw
		.split("\n")
		.filter((line) => line !== "")
		.flatMap((line, i, all) => {
			try {
				return [JSON.parse(line)];
			} catch (error) {
				if (i === all.length - 1) return [];
				throw new SwbError(`${path} line ${i + 1}: ${(error as Error).message}`);
			}
		});
}

/** The entries from the first to `ref`, following parents. */
export function pathTo(conversation: Conversation, ref: string | null): Entry[] {
	const byRef = new Map(conversation.entries.map((e) => [e.ref, e]));
	const path: Entry[] = [];
	for (let entry = ref === null ? undefined : byRef.get(ref); entry; entry = entry.parent === null ? undefined : byRef.get(entry.parent))
		path.push(entry);
	return path.reverse();
}

/** The branch the session continues from. */
export function activePath(conversation: Conversation): Entry[] {
	return pathTo(conversation, conversation.leaf);
}

/** Text from content that is a string or a list of typed parts, keeping the parts of one type. */
export function textOf(content: unknown, type = "text"): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as { type?: string; text?: string }[])
		.filter((part) => part?.type === type && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}
