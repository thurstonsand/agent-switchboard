import type { Db, Harness } from "@swb/shared";
import { harnessName } from "@swb/shared/mailbox";
import type { ToolArgs, ToolResult } from "@swb/shared/tools";
import { displayName, sessionState } from "../derive.ts";
import { SwbError } from "../errors.ts";
import { activePath, type Conversation, type Entry, pathTo } from "../transcripts/conversation.ts";
import { locateTranscript, readConversation } from "../transcripts/read.ts";
import { parseQuery } from "./query.ts";
import { filePatterns, stamp as localStamp, matches } from "./search.ts";
import { openRecall } from "./store.ts";
import { syncSessions } from "./sync.ts";

// What session_ask's reader works with, the same in every harness: a map of the session it was asked about, search
// within it, and reading it by ref. Search goes through the index; reading, straight to the transcript.

const TURNS_HEAD = 20;
const TURNS_TAIL = 50;
const EXCERPT = 160;
const PAGE_MAX = 50_000;
const ENTRY_MAX = 12_000;
const PREVIEW_MAX = 300;
const HITS = 20;

type Target = { id: string; harness: Harness; cwd: string; title: string; conversation: Conversation };

function target(db: Db, id: string): Target {
	const row = db.get("SELECT harness, cwd, transcript FROM sessions WHERE session_id = ?", id);
	if (!row) throw new SwbError(`no session ${id}`);
	const harness = row.harness as Harness;
	const conversation = readConversation(locateTranscript(row.transcript as string, harness), harness);
	return { id, harness, cwd: row.cwd as string, title: displayName(sessionState(db, id)), conversation };
}

const SUB = /^sub:([^/]+)\/(.*)$/;

/** The conversation a ref is in: the session's, or a subagent's under sub:<id>/. */
function conversationOf(t: Target, ref: string | undefined): { conversation: Conversation; prefix: string; ref: string | undefined } {
	const sub = ref === undefined ? null : SUB.exec(ref);
	if (!sub) return { conversation: t.conversation, prefix: "", ref };
	const subagent = t.conversation.subagents.find((s) => s.id === sub[1]);
	if (!subagent) throw new SwbError(`no subagent ${sub[1]}; the map lists them`);
	return { conversation: readConversation(subagent.path, t.harness, true), prefix: `sub:${subagent.id}/`, ref: sub[2] || undefined };
}

function find(conversation: Conversation, ref: string): Entry {
	const exact = conversation.entries.find((e) => e.ref === ref);
	if (exact) return exact;
	const found = conversation.entries.filter((e) => e.ref.startsWith(ref));
	if (found.length === 1) return found[0] as Entry;
	throw new SwbError(found.length === 0 ? `no entry ${ref}` : `${ref} names ${found.length} entries; give more of it`);
}

const stamp = (at: string | null) => (at ? localStamp(Date.parse(at)) : "");
const oneLine = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};
const textOf = (e: Entry) =>
	e.parts
		.flatMap((p) => (p.type === "text" ? [p.text] : []))
		.join("\n")
		.trim();
const isPrompt = (e: Entry) => e.role === "user" && textOf(e) !== "";
const size = (e: Entry) => render(e, "full").length;

/** The session's turns as its prompts start them, compactions where they fall, then where it ends. */
function turns(path: Entry[], prefix: string): string[] {
	const lines: string[] = [];
	let turn: { entry: Entry; count: number } | null = null;
	const close = () => {
		if (turn)
			lines.push(
				`- ${prefix}${turn.entry.ref} · ${stamp(turn.entry.at)} · ${turn.count} entries · "${oneLine(textOf(turn.entry), EXCERPT)}"`,
			);
		turn = null;
	};
	for (const e of path) {
		if (isPrompt(e)) {
			close();
			turn = { entry: e, count: 0 };
		}
		if (e.role === "compaction" || e.role === "branch") {
			close();
			lines.push(
				e.role === "compaction"
					? `- compaction ${prefix}${e.ref} · ${stamp(e.at)}: a summary of what came before, which the session read in its place`
					: `- branch summary ${prefix}${e.ref} · ${stamp(e.at)}: a summary of the branch the session rewound away from here`,
			);
		}
		if (turn) turn.count++;
	}
	close();
	if (lines.length <= TURNS_HEAD + TURNS_TAIL) return lines;
	return [
		...lines.slice(0, TURNS_HEAD),
		`- … ${lines.length - TURNS_HEAD - TURNS_TAIL} more between; recall_search finds them`,
		...lines.slice(-TURNS_TAIL),
	];
}

/** Rewinds the session left: each branch off the active one that says something, by where it starts. */
function abandoned(c: Conversation): string[] {
	const active = new Set(activePath(c).map((e) => e.ref));
	const children = new Map<string | null, Entry[]>();
	for (const e of c.entries) children.set(e.parent, [...(children.get(e.parent) ?? []), e]);
	const subtree = (e: Entry): Entry[] => [e, ...(children.get(e.ref) ?? []).flatMap(subtree)];
	return c.entries
		.filter((e) => !active.has(e.ref) && (e.parent === null || active.has(e.parent)))
		.flatMap((start) => {
			const all = subtree(start);
			const said = all.filter((e) => (e.role === "user" || e.role === "agent") && textOf(e) !== "");
			if (said.length === 0) return [];
			const prompt = said.find(isPrompt);
			const last =
				all
					.map((e) => e.at ?? "")
					.sort()
					.at(-1) ?? "";
			return [
				`- ${start.ref} · ${stamp(last)} · ${all.length} entries${start.parent ? `, off ${start.parent}` : ""}${prompt ? ` · "${oneLine(textOf(prompt), EXCERPT)}"` : ""}`,
			];
		});
}

/** session_ask's first message to its reader: the question, then a map of the session it's about. */
export function recallBegin(db: Db, id: string, question: string): ToolResult {
	const t = target(db, id);
	const path = activePath(t.conversation);
	const first = path[0];
	const last = path.at(-1);
	const branches = abandoned(t.conversation);
	const subagents = t.conversation.subagents.flatMap((s) => {
		try {
			const c = readConversation(s.path, t.harness, true);
			const prompt = activePath(c).find(isPrompt);
			return [
				`- sub:${s.id}/ · "${s.label}" · ${c.entries.length} entries · ${stamp(c.entries.at(-1)?.at ?? null)}${prompt ? ` · "${oneLine(textOf(prompt), EXCERPT)}"` : ""}`,
			];
		} catch (error) {
			return [`- sub:${s.id}/ · "${s.label}" · unreadable: ${(error as Error).message}`];
		}
	});
	const text = [
		`Question about session ${id}:`,
		"",
		question.trim(),
		"",
		"---",
		`The session: "${t.title}", ${harnessName(t.harness)}, in ${t.cwd}; ${t.conversation.entries.length} entries${first ? `, ${stamp(first.at)} to ${stamp(last?.at ?? null)}` : ""}.`,
		"",
		"Refs name its entries: recall_search finds them by what they say, and recall_read reads on from one along its branch. A subagent's refs are under sub:<id>/.",
		"",
		"Its turns on the active branch, the one it continues from, each by the ref of its prompt:",
		...(path.length === 0 ? ["- none yet"] : turns(path, "")),
		...(last ? [`- last entry: ${last.ref}`] : []),
		...(branches.length > 0 ? ["", "Abandoned branches, which the session rewound away from:", ...branches] : []),
		...(subagents.length > 0 ? ["", "Its subagents:", ...subagents] : []),
	].join("\n");
	return { text, details: { session: id, entries: t.conversation.entries.length } };
}

/** recall_search: the index, within the one session. */
export function recallSearch(db: Db, id: string, args: ToolArgs<"recall_search">): ToolResult {
	const t = target(db, id);
	const query = parseQuery(args.query);
	const f = query.filters;
	if (f.harness || f.project || f.archived !== null)
		throw new SwbError("recall_search: harness:, project:, and archived: filter sessions; this is one");
	const limit = args.limit ?? HITS;
	const index = openRecall();
	try {
		const transcript = db.get("SELECT transcript FROM sessions WHERE session_id = ?", id)?.transcript as string;
		syncSessions(index, [{ id, harness: t.harness, cwd: t.cwd, transcript }]);
		const subs = new Map<string, Conversation>();
		const conversation = (subagent: string | null) => {
			if (!subagent) return t.conversation;
			if (!subs.has(subagent)) subs.set(subagent, conversationOf(t, `sub:${subagent}/`).conversation);
			return subs.get(subagent) as Conversation;
		};
		/** Where a hit sits: its ref, the subagent it's in, the turn whose prompt began it or the abandoned branch, and its size. */
		const where = (subagent: string | null, label: string | null, ref: string) => {
			const c = conversation(subagent);
			const prefix = subagent ? `sub:${subagent}/` : "";
			const path = activePath(c);
			const at = path.findIndex((e) => e.ref === ref);
			const entry = c.entries.find((e) => e.ref === ref);
			const prompt = at === -1 ? undefined : path.slice(0, at + 1).findLast(isPrompt);
			const branch = at === -1 ? "abandoned branch" : prompt ? `turn ${prefix}${prompt.ref}` : "before the first prompt";
			return `${prefix}${ref} · ${subagent ? `subagent "${label}", ` : ""}${branch}${entry ? ` · ${size(entry).toLocaleString("en-US")} chars` : ""}`;
		};
		const lines: string[] = [];
		if (f.file) {
			const touches = index.all(
				`SELECT s.subagent, s.label, t.ref, t.path, t.op, t.at FROM touches t JOIN sources s ON s.id = t.source
				 WHERE s.session_id = ?1 AND (t.path LIKE ?2 ESCAPE '\\' OR t.path LIKE ?3 ESCAPE '\\') AND (?4 IS NULL OR t.at >= ?4) AND (?5 IS NULL OR t.at <= ?5)
				 ORDER BY t.at LIMIT ?6`,
				id,
				...filePatterns(f.file),
				f.after,
				f.before,
				limit,
			);
			for (const r of touches)
				lines.push(`- ${where(r.subagent as string | null, r.label as string | null, r.ref as string)}: ${r.op} ${r.path}`);
		}
		const hits = matches(index, query, [id], limit).slice(0, limit);
		for (const h of hits)
			lines.push(
				`- ${where(h.subagent, h.label, h.ref)} · ${h.kind === "call" ? "tool call" : h.kind === "result" ? "tool result" : h.kind}${h.at ? ` · ${localStamp(h.at)}` : ""}: ${h.snippet}`,
			);
		const text =
			lines.length === 0 ? "Nothing matches." : ["Hits, best first (ref · where · size · who · time: passage):", ...lines].join("\n");
		return { text, details: { hits: lines.length } };
	} finally {
		index.close();
	}
}

function render(e: Entry, body: "preview" | "full"): string {
	const cut = (text: string, max: number) =>
		text.length > max ? `${text.slice(0, max)}… (${text.length.toLocaleString("en-US")} chars; body "full" reads it all)` : text;
	const who = {
		user: "user",
		agent: "agent",
		tool: "tool result",
		context: "harness context",
		compaction: "compaction summary",
		branch: "branch summary",
	}[e.role];
	const lines: string[] = [`[${e.ref} · ${who}${e.at ? ` · ${stamp(e.at)}` : ""}]`];
	for (const p of e.parts) {
		if (p.type === "text") lines.push(e.role === "context" && body === "preview" ? cut(p.text, PREVIEW_MAX) : p.text);
		else if (p.type === "call") {
			const args = typeof p.args === "string" ? p.args : JSON.stringify(p.args ?? {});
			lines.push(`→ ${p.name} ${body === "preview" ? cut(args, PREVIEW_MAX) : args}`);
		} else lines.push(`← ${body === "preview" ? cut(p.text, PREVIEW_MAX) : p.text}`);
	}
	if (e.ending) lines.push(e.ending.kind === "stopped" ? "[the turn was stopped]" : `[the turn failed: ${e.ending.message}]`);
	const text = lines.join("\n");
	return text.length > ENTRY_MAX ? `${text.slice(0, ENTRY_MAX)}… (cut at ${ENTRY_MAX.toLocaleString("en-US")} chars)` : text;
}

/** The branch through an entry: the active one if it's on it, else on to the latest leaf below it. */
function branchThrough(c: Conversation, entry: Entry): Entry[] {
	const active = activePath(c);
	if (active.some((e) => e.ref === entry.ref)) return active;
	const children = new Map<string, Entry[]>();
	for (const e of c.entries) if (e.parent !== null) children.set(e.parent, [...(children.get(e.parent) ?? []), e]);
	let leaf = entry;
	for (let next = children.get(leaf.ref)?.at(-1); next; next = children.get(leaf.ref)?.at(-1)) leaf = next;
	return pathTo(c, leaf.ref);
}

/** recall_read: entries in order from a ref along its branch, as many as fit, saying where to read on. */
export function recallRead(db: Db, id: string, args: ToolArgs<"recall_read">): ToolResult {
	const t = target(db, id);
	const { conversation: c, prefix, ref } = conversationOf(t, args.ref);
	const start = ref === undefined ? activePath(c)[0] : find(c, ref);
	if (!start) return { text: "The session has no entries yet.", details: { entries: 0, next: null } };
	let path: Entry[];
	let end: number;
	if (args.to !== undefined) {
		const to = find(c, args.to.replace(SUB, "$2"));
		path = pathTo(c, to.ref);
		if (!path.some((e) => e.ref === start.ref)) throw new SwbError(`${to.ref} isn't later on ${start.ref}'s branch`);
		end = path.length - 1;
	} else {
		path = branchThrough(c, start);
		end = args.after === undefined ? path.length - 1 : Math.min(path.length - 1, path.findIndex((e) => e.ref === start.ref) + args.after);
	}
	const at = path.findIndex((e) => e.ref === start.ref);
	const from = Math.max(0, at - (args.before ?? 0));
	const out: string[] = [];
	let used = 0;
	let next: string | null = null;
	for (const e of path.slice(from, end + 1)) {
		if (e.parts.length === 0 && !e.ending) continue;
		const text = render(e, args.body ?? "preview");
		if (out.length > 0 && used + text.length > PAGE_MAX) {
			next = e.ref;
			break;
		}
		out.push(prefix ? text.replace(/^\[/, `[${prefix}`) : text);
		used += text.length;
	}
	const text = [...out, ...(next ? [`\n[more follows: recall_read from ${prefix}${next}]`] : [])].join("\n\n");
	return { text: text || "No entries with anything in them there.", details: { entries: out.length, next: next && `${prefix}${next}` } };
}
