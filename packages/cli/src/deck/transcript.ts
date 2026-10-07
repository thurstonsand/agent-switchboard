import { readFileSync } from "node:fs";
import { SwbError } from "../errors.ts";
import type { Turn } from "./protocol.ts";

type Entry = { type: string; id?: string; parentId?: string | null; message?: { role: string; content: unknown } };

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

/**
 * Every prompt and text reply on a pi v3 transcript's active branch, oldest first: entries link by parentId, so the
 * branch is the chain walked back from the last entry. Tool calls and thinking are skipped.
 */
export function readTranscript(path: string): Turn[] {
	const lines = readFileSync(path, "utf8").split("\n");
	const header = JSON.parse(lines[0] as string) as { type: string; version: number };
	if (header.type !== "session" || header.version !== 3) throw new SwbError(`${path}: pi session format v${header.version}, swb reads v3`);
	const byId = new Map<string, Entry>();
	let last: Entry | undefined;
	for (const line of lines.slice(1)) {
		if (line === "") continue;
		const entry = JSON.parse(line) as Entry;
		if (entry.id === undefined) continue;
		byId.set(entry.id, entry);
		last = entry;
	}
	const turns: Turn[] = [];
	for (let entry = last; entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
		if (entry.type !== "message" || !entry.message) continue;
		const { role, content } = entry.message;
		if (role !== "user" && role !== "assistant") continue;
		const body = text(content).trim();
		if (body !== "") turns.push({ who: role === "user" ? "you" : "pi", text: body });
	}
	return turns.reverse();
}
