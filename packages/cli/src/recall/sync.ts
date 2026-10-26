import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Db, Harness } from "@swb/shared";
import { span } from "@swb/shared/trace";
import { activePath, type Conversation, type Entry, type Part } from "../transcripts/conversation.ts";
import { locateTranscript, readConversation } from "../transcripts/read.ts";

// Brings the index up to date with the transcripts. Any number of swb processes may do this at once: each parses
// outside a transaction, then writes a source only if no one else has since it read the source's checkpoint.

/** A Session as the index needs it. */
export type Indexed = { id: string; harness: Harness; cwd: string; transcript: string };

const CALL_MAX = 2000;
const RESULT_MAX = 500;

type Chunk = { ref: string; kind: string; at: number | null; active: boolean; text: string };
type Touch = { ref: string; path: string; op: "read" | "changed"; at: number | null };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** What a file tool's call says it read or changed: pi's and Claude Code's by their path, Codex's patches by theirs. */
function touched(part: Extract<Part, { type: "call" }>, cwd: string): { path: string; op: "read" | "changed" }[] {
	const at = (path: string) => (isAbsolute(path) ? path : resolve(cwd, path.replace(/^~(?=\/)/, process.env.HOME ?? "~")));
	if (part.name === "apply_patch" && typeof part.args === "string")
		return [...part.args.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((m) => ({
			path: at((m[1] ?? m[2] ?? "").trim()),
			op: "changed",
		}));
	const args = (part.args ?? {}) as Record<string, unknown>;
	const path = args.file_path ?? args.path ?? args.notebook_path;
	if (typeof path !== "string" || path === "") return [];
	const name = part.name.toLowerCase();
	if (name === "read") return [{ path: at(path), op: "read" }];
	if (["edit", "write", "multiedit", "notebookedit"].includes(name)) return [{ path: at(path), op: "changed" }];
	return [];
}

function extract(conversation: Conversation, cwd: string): { chunks: Chunk[]; touches: Touch[] } {
	const active = new Set(activePath(conversation).map((e) => e.ref));
	const chunks: Chunk[] = [];
	const touches: Touch[] = [];
	const kindOf = (entry: Entry, part: Part): string | null => {
		if (part.type === "call") return "call";
		if (part.type === "result") return "result";
		if (entry.role === "user" || entry.role === "agent") return entry.role;
		if (entry.role === "compaction" || entry.role === "branch") return "summary";
		return null;
	};
	for (const entry of conversation.entries) {
		const at = entry.at === null ? null : Date.parse(entry.at);
		for (const part of entry.parts) {
			const kind = kindOf(entry, part);
			if (!kind) continue;
			const text =
				part.type === "call"
					? clip(`${part.name} ${typeof part.args === "string" ? part.args : JSON.stringify(part.args ?? {})}`, CALL_MAX)
					: part.type === "result"
						? clip(part.text, RESULT_MAX)
						: part.text;
			if (text.trim() !== "") chunks.push({ ref: entry.ref, kind, at, active: active.has(entry.ref), text });
			if (part.type === "call") for (const t of touched(part, cwd)) touches.push({ ref: entry.ref, at, ...t });
		}
	}
	return { chunks, touches };
}

type Source = { path: string; subagent: string | null; label: string | null };

function checkpoint(path: string): { size: number; mtime: number } | null {
	try {
		const stat = statSync(path);
		return { size: stat.size, mtime: Math.trunc(stat.mtimeMs) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** Indexes one source if it changed since it was indexed, and returns the subagents its conversation names. */
function syncSource(index: Db, session: Indexed, source: Source): Source[] {
	const stored = index.get("SELECT size, mtime FROM sources WHERE path = ?", source.path);
	const now = checkpoint(source.path);
	if (!now) {
		if (stored) index.run("DELETE FROM sources WHERE path = ?", source.path);
		return [];
	}
	if (stored && stored.size === now.size && stored.mtime === now.mtime) return [];
	const conversation = readConversation(source.path, session.harness, source.subagent !== null);
	const { chunks, touches } = extract(conversation, session.cwd);
	index.tx(() => {
		const current = index.get("SELECT id, size, mtime FROM sources WHERE path = ?", source.path);
		if ((current?.size ?? null) !== (stored?.size ?? null) || (current?.mtime ?? null) !== (stored?.mtime ?? null)) return;
		index.run(
			`INSERT INTO sources (path, session_id, harness, subagent, label, size, mtime) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, label = excluded.label`,
			source.path,
			session.id,
			session.harness,
			source.subagent,
			source.label,
			now.size,
			now.mtime,
		);
		const id = index.get("SELECT id FROM sources WHERE path = ?", source.path)?.id as number;
		index.run("DELETE FROM chunks WHERE source = ?", id);
		index.run("DELETE FROM touches WHERE source = ?", id);
		for (const c of chunks)
			index.run(
				"INSERT INTO chunks (source, ref, kind, at, active, text) VALUES (?, ?, ?, ?, ?, ?)",
				id,
				c.ref,
				c.kind,
				c.at,
				c.active ? 1 : 0,
				c.text,
			);
		for (const t of touches)
			index.run("INSERT INTO touches (source, ref, path, op, at) VALUES (?, ?, ?, ?, ?)", id, t.ref, t.path, t.op, t.at);
	});
	return conversation.subagents.map((s) => ({ path: s.path, subagent: s.id, label: s.label }));
}

/**
 * Brings these Sessions' sources up to date: each one's transcript where it is now, the subagents it names, and every
 * source indexed for it before, which may have moved on since its parent last changed, or moved away.
 */
export function syncSessions(index: Db, sessions: Indexed[]): void {
	span("recall.sync", () => {
		for (const session of sessions) {
			const queue: Source[] = [
				{ path: locateTranscript(session.transcript, session.harness), subagent: null, label: null },
				...index
					.all("SELECT path, subagent, label FROM sources WHERE session_id = ?", session.id)
					.map((row) => ({ path: row.path as string, subagent: row.subagent as string | null, label: row.label as string | null })),
			];
			const seen = new Set<string>();
			for (let source = queue.shift(); source; source = queue.shift()) {
				if (seen.has(source.path)) continue;
				seen.add(source.path);
				queue.push(...syncSource(index, session, source));
			}
		}
	});
}

/** Drops what's indexed for sessions swb no longer has. */
export function prune(index: Db, ids: string[]): void {
	index.run("DELETE FROM sources WHERE session_id NOT IN (SELECT value FROM json_each(?))", JSON.stringify(ids));
}
