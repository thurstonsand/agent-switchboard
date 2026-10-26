import type { Harness } from "@swb/shared";
import { activePath, type Ending } from "../transcripts/conversation.ts";
import { readConversation } from "../transcripts/read.ts";
import type { Transcript, Turn } from "./protocol.ts";

// What a dormant card shows: every prompt and text reply on the active branch, oldest first, then where the last turn
// stopped if it never replied: the tool calls it made after its last text, and whether it was stopped or its provider
// failed.

/** One line for a tool call: a shell command as typed, a file tool by its path, anything else by its name. */
function step(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const command = a.command ?? a.cmd;
	const shell = Array.isArray(command) ? command.join(" ") : command;
	if (typeof shell === "string") return `$ ${shell.split("\n")[0]}`;
	const path = a.file_path ?? a.path;
	return typeof path === "string" ? `${name} ${path}` : name;
}

export function readTranscript(path: string, harness: Harness): Transcript {
	const turns: Turn[] = [];
	let tail: string[] = [];
	let ending: Ending | null = null;
	for (const entry of activePath(readConversation(path, harness))) {
		for (const part of entry.parts) {
			if (part.type === "call") tail.push(step(part.name, part.args));
			else if (part.type === "text" && (entry.role === "user" || entry.role === "agent")) {
				turns.push({ who: entry.role === "user" ? "you" : "agent", text: part.text });
				tail = [];
			} else continue;
			ending = null;
		}
		if (entry.ending) ending = entry.ending;
	}
	return { turns, tail, ending };
}
