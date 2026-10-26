import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SwbError } from "../errors.ts";
import { type Conversation, type Entry, lines, type Part, type Subagent, textOf } from "./conversation.ts";

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
		history_base?: { thread_id: string; end_ordinal_exclusive: number };
		subagent_history_start_ordinal?: number;
		id?: string;
		item?: Spawned;
	};
	ordinal?: number;
};

/**
 * How a session's rollout records a subagent it started: multi-agent v1 by its spawn_agent call, naming each child and
 * its nickname; v2 by the child starting, under its task's path.
 */
type Spawned = {
	type?: string;
	tool?: string;
	receiver_agents?: { thread_id: string; agent_nickname?: string | null }[];
	kind?: string;
	agent_thread_id?: string;
	agent_path?: string | null;
};

function spawned(item: Spawned | undefined): { id: string; label: string }[] {
	if (item?.type === "CollabAgentToolCall" && item.tool === "spawn_agent")
		return (item.receiver_agents ?? []).map((a) => ({ id: a.thread_id, label: a.agent_nickname ?? a.thread_id }));
	if (item?.type === "SubAgentActivity" && item.kind === "started" && item.agent_thread_id)
		return [{ id: item.agent_thread_id, label: item.agent_path?.split("/").at(-1) ?? item.agent_thread_id }];
	return [];
}

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

/**
 * What one agent tells another through Codex's own tools, a subagent's task among them, OpenAI encrypts as a Fernet
 * token that only it reads. It says nothing to search or read, so it stands as `[encrypted]`.
 */
const FERNET = /^gAAAAA[\w-]{20,}={0,2}$/;
function sealed(args: unknown): unknown {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
	return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" && FERNET.test(v) ? "[encrypted]" : v]));
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
	if (p.type === "function_call") return { role: "agent", parts: call(sealed(parsed(p.arguments))), ending: null };
	if (p.type === "custom_tool_call") return { role: "agent", parts: call(p.input), ending: null };
	if (p.type === "function_call_output" || p.type === "custom_tool_call_output")
		return { role: "tool", parts: [{ type: "result", id: p.call_id ?? null, text: output(p.output) }], ending: null };
	// A message from another agent: a v2 subagent's task, or its answer to its parent. OpenAI encrypts a task's payload,
	// and only its plain header is kept.
	if (p.type === "agent_message") {
		const body = textOf(p.content, "input_text").trim();
		return { role: "user", parts: body === "" ? [] : [{ type: "text", text: body }], ending: null };
	}
	if (p.type !== "message") return null;
	const body = textOf(p.content, p.role === "assistant" ? "output_text" : "input_text").trim();
	const parts: Part[] = body === "" ? [] : [{ type: "text", text: body }];
	if (p.role === "assistant") return { role: "agent", parts, ending: null };
	// The context Codex injects as user text starts with a tag, or a heading for AGENTS.md.
	if (p.role === "user" && !body.startsWith("<") && !body.startsWith("# AGENTS.md instructions"))
		return { role: "user", parts, ending: null };
	return { role: "context", parts, ending: null };
}

/** A Codex thread or rollout id is a UUIDv7, which says when Codex made it. */
const created = (id: string) => Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
const DAY = 86_400_000;

/**
 * A thread's rollouts made between two times: its first, `…-<thread id>.jsonl`, and each revert's,
 * `…-<thread id>_<rollout id>.jsonl`. Codex files a rollout under the local day it made it, a moment after its id,
 * unless it has since archived it, and may have compressed it.
 */
function rolloutsOf(
	near: string,
	thread: string,
	from: number,
	to: number,
	list: (dir: string) => string[],
): { id: string; path: string }[] {
	const home = /^(.*)\/(?:sessions\/\d{4}\/\d{2}\/\d{2}|archived_sessions)\/[^/]+$/.exec(near)?.[1];
	if (!home) throw new SwbError(`${near}: not in a Codex home, so the rollouts it names aren't found`);
	const day = (at: number) => {
		const d = new Date(at);
		return join(home, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
	};
	const dirs = new Set<string>();
	for (let at = from; at < to + DAY; at += DAY) dirs.add(day(Math.min(at, to + 60_000)));
	dirs.add(join(home, "archived_sessions"));
	const name = new RegExp(`-${thread}(?:_([0-9a-f-]{36}))?\\.jsonl(?:\\.zst)?$`);
	return [...dirs].flatMap((dir) =>
		list(dir).flatMap((file) => {
			const match = name.exec(file);
			if (!match) return [];
			const id = match[1] ?? thread;
			return created(id) >= from && created(id) <= to ? [{ id, path: join(dir, file) }] : [];
		}),
	);
}

/** A thread's rollout by its rollout id, its own id for its first. */
function findRollout(near: string, thread: string, id: string, list: (dir: string) => string[]): string | null {
	return rolloutsOf(near, thread, created(id), created(id), list).find((r) => r.id === id)?.path ?? null;
}

/**
 * Codex rollouts: items in order, each entry's ref its line number. A revert leaves the rollout as it was and goes on
 * in a new one, which starts from a point in it, or afresh when it undid every turn. A thread's conversation reads its
 * rollouts oldest first, numbering lines on through them, and what each revert cut off becomes a branch. A subagent's
 * rollout can open with a copy of its parent's conversation, which is the parent's and left out; its own subagents, if
 * Codex lets it have any, aren't kept.
 */
export function readCodex(path: string, subagent = false): Conversation {
	const entries: Entry[] = [];
	const children = new Map<string, string>();
	let tip: string | null = null;
	let ref = 0;
	const histories = new Map<string, { ordinal: number; tip: string | null }[]>();
	const listings = new Map<string, string[]>();
	const list = (dir: string) => {
		if (!listings.has(dir)) listings.set(dir, existsSync(dir) ? readdirSync(dir) : []);
		return listings.get(dir) as string[];
	};
	/**
	 * Reads one rollout after those before it, once, returning its history: the tip after each of its lines and those
	 * it continues, by ordinal. A revert's rollout comes after the one the thread was in, which is all cut off; it
	 * continues the part it keeps, from whichever rollout holds that, or starts afresh when it undid every turn.
	 */
	const read = (file: string): { ordinal: number; tip: string | null }[] => {
		const done = histories.get(file);
		if (done) return done;
		const all = lines(file) as CodexLine[];
		const meta = all[0]?.type === "session_meta" ? all[0].payload : undefined;
		const thread = meta?.id as string;
		const own = new RegExp(`-${thread}_([0-9a-f-]{36})\\.jsonl(?:\\.zst)?$`).exec(file)?.[1];
		const before = own
			? rolloutsOf(file, thread, created(thread), created(own) - 1, list)
					.sort((a, b) => created(a.id) - created(b.id))
					.at(-1)
			: undefined;
		if (before) read(before.path);
		let history: { ordinal: number; tip: string | null }[] = [];
		const base = meta?.history_base;
		if (base) {
			const from = findRollout(file, thread, base.thread_id, list);
			if (!from) throw new SwbError(`${file}: the rollout it continues, ${base.thread_id}, is gone`);
			history = read(from).filter((h) => h.ordinal < base.end_ordinal_exclusive);
		}
		tip = history.at(-1)?.tip ?? null;
		const start = meta?.subagent_history_start_ordinal ?? 0;
		all.forEach((line, i) => {
			ref += 1;
			const ordinal = line.ordinal ?? i;
			const item = ordinal < start ? null : entry(line);
			if (item) {
				entries.push({ ref: String(ref), parent: tip, at: line.timestamp ?? null, ...item });
				tip = String(ref);
			}
			history.push({ ordinal, tip });
			if (line.type === "event_msg" && line.payload?.type === "item_completed")
				for (const child of spawned(line.payload.item)) children.set(child.id, child.label);
		});
		histories.set(file, history);
		return history;
	};
	read(path);
	const subagents: Subagent[] = subagent
		? []
		: [...children].flatMap(([id, label]) => {
				// A child that hasn't written its rollout yet shows up once its parent's next line lands.
				const found = findRollout(path, id, id, list);
				return found ? [{ id, label, path: found }] : [];
			});
	return { entries, leaf: tip, subagents };
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROLLOUT = new RegExp(`-(${UUID})(?:_(${UUID}))?\\.jsonl(?:\\.zst)?$`);

/** Each Codex thread on disk, by its id, and the rollout it's in now: its newest, after any revert. */
export function codexThreads(home: string): Map<string, string> {
	const newest = new Map<string, { at: number; path: string }>();
	for (const dir of ["sessions", "archived_sessions"]) {
		const root = join(home, dir);
		if (!existsSync(root)) continue;
		for (const file of new Bun.Glob("**/rollout-*.jsonl*").scanSync(root)) {
			const [, thread, rollout] = ROLLOUT.exec(file) ?? [];
			if (!thread) continue;
			const at = created(rollout ?? thread);
			const was = newest.get(thread);
			if (!was || at > was.at) newest.set(thread, { at, path: join(root, file) });
		}
	}
	return new Map([...newest].map(([thread, { path }]) => [thread, path]));
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
