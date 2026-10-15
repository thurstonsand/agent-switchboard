import { existsSync, readFileSync } from "node:fs";
import type { Harness } from "@swb/shared";
import { SwbError } from "../errors.ts";
import type { Turn } from "./protocol.ts";

// What a dormant card shows: every prompt and text reply, oldest first, read straight from the harness's own
// transcript. Tool calls and thinking are skipped. Each reader fails loudly on a format it doesn't know.

type Part = { type?: string; text?: string };

function text(content: unknown, type = "text"): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Part[])
		.filter((part) => part?.type === type && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
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

export function readTranscript(path: string, harness: Harness): Turn[] {
	switch (harness) {
		case "pi":
			return readPi(path);
		case "claude":
			return readClaude(path);
		case "codex":
			return readCodex(path);
	}
}

type PiEntry = { type: string; id?: string; parentId?: string | null; message?: { role: string; content: unknown } };

/** pi v3: entries link by parentId, so the active branch is the chain walked back from the last entry. */
function readPi(path: string): Turn[] {
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
	const turns: Turn[] = [];
	for (let entry = last; entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
		if (entry.type !== "message" || !entry.message) continue;
		const { role, content } = entry.message;
		if (role !== "user" && role !== "assistant") continue;
		const body = text(content).trim();
		if (body !== "") turns.push({ who: role === "user" ? "you" : "agent", text: body });
	}
	return turns.reverse();
}

type ClaudeEntry = {
	type?: string;
	uuid?: string;
	parentUuid?: string | null;
	isSidechain?: boolean;
	isMeta?: boolean;
	message?: { role: string; content: unknown };
};

/** Claude Code: user and assistant entries link by parentUuid; the active branch is the chain back from the last. */
function readClaude(path: string): Turn[] {
	const entries = (lines(path) as ClaudeEntry[]).filter((e) => e.uuid && !e.isSidechain);
	const byId = new Map(entries.map((e) => [e.uuid as string, e]));
	const turns: Turn[] = [];
	for (let entry = entries.at(-1); entry; entry = entry.parentUuid ? byId.get(entry.parentUuid) : undefined) {
		if ((entry.type !== "user" && entry.type !== "assistant") || !entry.message || entry.isMeta) continue;
		const body = text(entry.message.content).trim();
		// Claude Code wraps its own commands and reminders in tags; only what was typed or answered shows.
		if (body !== "" && !body.startsWith("<")) turns.push({ who: entry.type === "user" ? "you" : "agent", text: body });
	}
	return turns.reverse();
}

/** The title Claude Code gave the session, or the one it was renamed to, whichever came last. */
export function claudeTitle(path: string): string | null {
	let title: string | null = null;
	for (const entry of lines(path) as { type?: string; aiTitle?: string; customTitle?: string }[]) {
		if (entry.type === "custom-title" && entry.customTitle) title = entry.customTitle;
		else if (entry.type === "ai-title" && entry.aiTitle) title = entry.aiTitle;
	}
	return title;
}

type CodexEntry = { type?: string; payload?: { type?: string; role?: string; content?: unknown } };

/** Codex rollouts: response items in order; the context Codex injects as user text starts with a tag. */
function readCodex(path: string): Turn[] {
	const turns: Turn[] = [];
	for (const entry of lines(path) as CodexEntry[]) {
		const p = entry.payload;
		if (entry.type !== "response_item" || p?.type !== "message" || (p.role !== "user" && p.role !== "assistant")) continue;
		const body = text(p.content, p.role === "user" ? "input_text" : "output_text").trim();
		if (body !== "" && !body.startsWith("<")) turns.push({ who: p.role === "user" ? "you" : "agent", text: body });
	}
	return turns;
}
