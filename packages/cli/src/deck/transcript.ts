import { existsSync, readFileSync } from "node:fs";
import type { Harness } from "@swb/shared";
import { SwbError } from "../errors.ts";
import type { Ending, Transcript, Turn } from "./protocol.ts";

// What a dormant card shows: every prompt and text reply, oldest first, read straight from the harness's own
// transcript, then where the last turn stopped if it never replied: the tool calls it made after its last text, and
// whether it was stopped or its provider failed. Thinking is skipped. Each reader fails loudly on a format it doesn't know.

type Part = { type?: string; text?: string };

function text(content: unknown, type = "text"): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Part[])
		.filter((part) => part?.type === type && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

/** One line for a tool call: a shell command as typed, a file tool by its path, anything else by its name. */
function step(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const command = a.command ?? a.cmd;
	const shell = Array.isArray(command) ? command.join(" ") : command;
	if (typeof shell === "string") return `$ ${shell.split("\n")[0]}`;
	const path = a.file_path ?? a.path;
	return typeof path === "string" ? `${name} ${path}` : name;
}

/** Parses a tool call's arguments, which Codex records as JSON text. */
function parsed(args: unknown): unknown {
	if (typeof args !== "string") return args;
	try {
		return JSON.parse(args);
	} catch {
		return {};
	}
}

/** Follows a conversation from its first turn, keeping the tool calls since the last text and how the last turn ended. */
class Reading {
	turns: Turn[] = [];
	tail: string[] = [];
	ending: Ending | null = null;

	turn(who: "you" | "agent", text: string): void {
		if (text === "") return;
		this.turns.push({ who, text });
		this.tail = [];
		this.ending = null;
	}

	call(name: string, args: unknown): void {
		this.tail.push(step(name, parsed(args)));
		this.ending = null;
	}

	end(ending: Ending): void {
		this.ending = ending;
	}

	done(): Transcript {
		return { turns: this.turns, tail: this.tail, ending: this.ending };
	}
}

function lines(path: string): unknown[] {
	const raw = path.endsWith(".zst") ? new TextDecoder().decode(Bun.zstdDecompressSync(readFileSync(path))) : readFileSync(path, "utf8");
	return raw
		.split("\n")
		.filter((line) => line !== "")
		.flatMap((line, i, all) => {
			try {
				return [JSON.parse(line)];
			} catch (error) {
				// The harness may be mid-write on the last line.
				if (i === all.length - 1) return [];
				throw new SwbError(`${path} line ${i + 1}: ${(error as Error).message}`);
			}
		});
}

/**
 * Where a session's transcript is now. Codex moves an archived thread's rollout to archived_sessions/ and back on
 * unarchive, and compresses week-old ones, so its recorded path may have moved.
 */
export function locateTranscript(path: string, harness: Harness): string {
	if (harness !== "codex") return path;
	const archived = path.replace(/\/sessions\/\d{4}\/\d{2}\/\d{2}\/([^/]+)$/, "/archived_sessions/$1");
	return [path, `${path}.zst`, archived, `${archived}.zst`].find((candidate) => existsSync(candidate)) ?? path;
}

/** Whether Codex holds a rollout as archived, so its thread can't resume until Codex unarchives it. */
export function archivedInCodex(path: string): boolean {
	return locateTranscript(path, "codex").includes("/archived_sessions/");
}

export function readTranscript(path: string, harness: Harness): Transcript {
	switch (harness) {
		case "pi":
			return readPi(path);
		case "claude":
			return readClaude(path);
		case "codex":
			return readCodex(path);
	}
}

type PiBlock = { type?: string; text?: string; name?: string; arguments?: unknown };
type PiEntry = {
	type: string;
	id?: string;
	parentId?: string | null;
	message?: { role: string; content: unknown; stopReason?: string; errorMessage?: string };
};

/** pi v3: entries link by parentId, so the active branch is the chain walked back from the last entry. */
function readPi(path: string): Transcript {
	const entries = lines(path) as PiEntry[];
	const header = entries[0] as { type: string; version: number } | undefined;
	if (header?.type !== "session" || header.version !== 3)
		throw new SwbError(`${path}: pi session format v${header?.version}, swb reads v3`);
	const byId = new Map<string, PiEntry>();
	let last: PiEntry | undefined;
	for (const entry of entries.slice(1)) {
		if (entry.id === undefined) continue;
		byId.set(entry.id, entry);
		last = entry;
	}
	const branch: PiEntry[] = [];
	for (let entry = last; entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) branch.push(entry);
	const reading = new Reading();
	for (const entry of branch.reverse()) {
		if (entry.type !== "message" || !entry.message) continue;
		const { role, content, stopReason, errorMessage } = entry.message;
		if (role === "user") reading.turn("you", text(content).trim());
		if (role !== "assistant") continue;
		for (const block of Array.isArray(content) ? (content as PiBlock[]) : [{ type: "text", text: String(content) }]) {
			if (block.type === "text") reading.turn("agent", (block.text ?? "").trim());
			else if (block.type === "toolCall") reading.call(block.name ?? "tool", block.arguments);
		}
		// Esc during a tool call aborts pi's next model request before it's sent, and pi-ai records that as an error
		// carrying the AbortError's own message.
		if (stopReason === "aborted" || errorMessage === "This operation was aborted") reading.end({ kind: "stopped" });
		else if (stopReason === "error") reading.end({ kind: "error", message: errorMessage ?? "unknown error" });
	}
	return reading.done();
}

type ClaudeEntry = {
	type?: string;
	uuid?: string;
	parentUuid?: string | null;
	isSidechain?: boolean;
	isMeta?: boolean;
	isApiErrorMessage?: boolean;
	message?: { role: string; content: unknown };
};

/** What Claude Code writes as the user's message when Esc stops a turn. */
const CLAUDE_STOPPED = "[Request interrupted by user";

/**
 * Claude Code: user and assistant entries link by parentUuid; the active branch is the chain back from the last leaf.
 * Not simply the last line: a conversation Claude Code writes as it exits can come out of order, a branch of its
 * attachments last.
 */
function readClaude(path: string): Transcript {
	const entries = (lines(path) as ClaudeEntry[]).filter((e) => e.uuid && !e.isSidechain);
	const byId = new Map(entries.map((e) => [e.uuid as string, e]));
	const parents = new Set(entries.map((e) => e.parentUuid));
	const branch: ClaudeEntry[] = [];
	const leaf = entries.findLast((e) => !parents.has(e.uuid));
	for (let entry = leaf; entry; entry = entry.parentUuid ? byId.get(entry.parentUuid) : undefined) branch.push(entry);
	const reading = new Reading();
	for (const entry of branch.reverse()) {
		if ((entry.type !== "user" && entry.type !== "assistant") || !entry.message || entry.isMeta) continue;
		const body = text(entry.message.content).trim();
		if (entry.isApiErrorMessage) reading.end({ kind: "error", message: body.replace(/^API Error: /, "") });
		else if (body.startsWith(CLAUDE_STOPPED)) reading.end({ kind: "stopped" });
		// Claude Code wraps its own commands and reminders in tags; only what was typed or answered shows.
		else if (!body.startsWith("<")) reading.turn(entry.type === "user" ? "you" : "agent", body);
		if (entry.type !== "assistant" || !Array.isArray(entry.message.content)) continue;
		for (const block of entry.message.content as { type?: string; name?: string; input?: unknown }[])
			if (block.type === "tool_use") reading.call(block.name ?? "tool", block.input);
	}
	return reading.done();
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

type CodexEntry = {
	type?: string;
	payload?: {
		type?: string;
		role?: string;
		content?: unknown;
		name?: string;
		arguments?: unknown;
		input?: unknown;
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

/** Codex rollouts: response items in order; the context Codex injects as user text starts with a tag. */
function readCodex(path: string): Transcript {
	const reading = new Reading();
	for (const entry of lines(path) as CodexEntry[]) {
		const p = entry.payload;
		if (entry.type === "event_msg" && p?.type === "turn_aborted") reading.end({ kind: "stopped" });
		else if (entry.type === "event_msg" && p?.type === "task_complete" && p.error)
			reading.end({ kind: "error", message: codexError(p.error.message ?? "unknown error") });
		if (entry.type !== "response_item") continue;
		if (p?.type === "function_call") reading.call(p.name ?? "tool", p.arguments);
		else if (p?.type === "custom_tool_call") reading.call(p.name ?? "tool", p.input);
		if (p?.type !== "message" || (p.role !== "user" && p.role !== "assistant")) continue;
		const body = text(p.content, p.role === "user" ? "input_text" : "output_text").trim();
		if (!body.startsWith("<")) reading.turn(p.role === "user" ? "you" : "agent", body);
	}
	return reading.done();
}

/** The model and effort a session runs on now, as its transcript last records them; null where it records none. */
export type InUse = { model: string | null; effort: string | null };

/**
 * pi records each model and thinking level it switches to; Codex, the model and effort of each turn, an effort of null
 * being Codex's own default. Claude Code's transcript has no effort, so its line records both instead.
 */
export function inUse(path: string, harness: "pi" | "codex"): InUse {
	const entries = lines(locateTranscript(path, harness)) as Record<string, unknown>[];
	const last = (match: (e: Record<string, unknown>) => boolean) => entries.findLast(match);
	if (harness === "pi") {
		const model = last((e) => e.type === "model_change");
		const level = last((e) => e.type === "thinking_level_change");
		return {
			model: model ? `${model.provider}/${model.modelId}` : null,
			effort: (level?.thinkingLevel as string | undefined) ?? null,
		};
	}
	type Context = { model?: string; effort?: string | null; collaboration_mode?: { settings?: { reasoning_effort?: string | null } } };
	const context = last((e) => e.type === "turn_context")?.payload as Context | undefined;
	return {
		model: context?.model ?? null,
		effort: context?.effort ?? context?.collaboration_mode?.settings?.reasoning_effort ?? null,
	};
}
