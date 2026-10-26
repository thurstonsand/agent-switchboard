import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Db } from "@swb/shared";
import { harnessName } from "@swb/shared/mailbox";
import type { ToolResult } from "@swb/shared/tools";
import { displayName, projectName, type SessionState, states } from "../derive.ts";
import { type Filters, parseQuery, type Query } from "./query.ts";
import { openRecall } from "./store.ts";
import { type Indexed, prune, syncSessions } from "./sync.ts";

// session_search: every Session's conversation, its subagents' included, open or archived, ranked by how well and
// how recently it matches. The index catches up on whatever changed before each search answers.

export const SEARCH_LIMIT = 10;
const SEARCH_LIMIT_MAX = 50;
const SNIPPETS = 3;
/** What a match in each kind of text is worth, before its rank: what was asked and said outweighs what tools did. */
const WEIGHTS: Record<string, number> = { user: 180, agent: 150, call: 140, result: 110, summary: 100 };
const TITLE_WEIGHT = 360;
const RECENCY_MAX = 300;
const RECENCY_HALF_LIFE_DAYS = 21;

export type Hit = {
	sessionId: string;
	subagent: string | null;
	label: string | null;
	ref: string;
	kind: string;
	at: number | null;
	active: boolean;
	snippet: string;
};

const expand = (path: string) => resolve(path.replace(/^~(?=$|\/)/, homedir()));

/** A project by its name, or a path to its root. */
function inProject(s: SessionState, project: string): boolean {
	return /[/~]/.test(project) ? s.project === expand(project) : projectName(s.project).toLowerCase() === project.toLowerCase();
}

function passes(s: SessionState, f: Filters): boolean {
	if (f.harness && s.harness !== f.harness) return false;
	if (f.archived !== null && s.open === f.archived) return false;
	if (f.project && !inProject(s, f.project)) return false;
	if (f.after !== null && s.activityAt < f.after) return false;
	if (f.before !== null && s.createdAt > f.before) return false;
	return true;
}

/** LIKE patterns for a file and what's under it: a path names it; a relative one matches by its tail. */
export function filePatterns(file: string): [string, string] {
	if (file.startsWith("/") || file.startsWith("~")) {
		const path = like(expand(file));
		return [path, `${path}/%`];
	}
	const tail = like(file.replace(/^\.\//, "").replace(/\/$/, ""));
	return [`%/${tail}`, `%/${tail}/%`];
}

/** Sessions whose transcripts read or changed a file. */
function touching(index: Db, file: string, f: Filters): Set<string> {
	const rows = index.all(
		`SELECT DISTINCT s.session_id FROM touches t JOIN sources s ON s.id = t.source
		 WHERE (t.path LIKE ?1 ESCAPE '\\' OR t.path LIKE ?2 ESCAPE '\\') AND (?3 IS NULL OR t.at >= ?3) AND (?4 IS NULL OR t.at <= ?4)`,
		...filePatterns(file),
		f.after,
		f.before,
	);
	return new Set(rows.map((row) => row.session_id as string));
}

const like = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Sessions whose conversations hold anything the query excludes. */
function excluded(index: Db, query: Query): Set<string> {
	const ids = query.excludes.flatMap((match) =>
		index
			.all(
				"SELECT DISTINCT s.session_id FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN sources s ON s.id = c.source WHERE chunks_fts MATCH ?",
				match,
			)
			.map((row) => row.session_id as string),
	);
	return new Set(ids);
}

/**
 * Chunks matching the query, best first, among these sessions and within its time; the strict match first, then the
 * relaxed one when that finds too few. Its excludes are the caller's to apply, to whole sessions.
 */
export function matches(index: Db, query: Query, ids: string[], want: number): Hit[] {
	if (!query.match) return [];
	const fetch = (match: string) =>
		index
			.all(
				`SELECT c.id, s.session_id, s.subagent, s.label, c.ref, c.kind, c.at, c.active,
				        snippet(chunks_fts, 0, '**', '**', '…', 16) AS snippet
				 FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN sources s ON s.id = c.source
				 WHERE chunks_fts MATCH ?1 AND s.session_id IN (SELECT value FROM json_each(?2))
				   AND (?3 IS NULL OR c.at >= ?3) AND (?4 IS NULL OR c.at <= ?4)
				 ORDER BY bm25(chunks_fts) LIMIT ?5`,
				match,
				JSON.stringify(ids),
				query.filters.after,
				query.filters.before,
				Math.max(200, want * 25),
			)
			.map((row) => ({
				id: row.id as number,
				sessionId: row.session_id as string,
				subagent: row.subagent as string | null,
				label: row.label as string | null,
				ref: row.ref as string,
				kind: row.kind as string,
				at: row.at as number | null,
				active: row.active === 1,
				snippet: (row.snippet as string).replace(/\s+/g, " ").trim(),
			}));
	const strict = fetch(query.match);
	if (!query.relaxed || new Set(strict.map((h) => h.sessionId)).size >= want) return strict;
	const seen = new Set(strict.map((h) => h.id));
	return [...strict, ...fetch(query.relaxed).filter((h) => !seen.has(h.id))];
}

function sessionsToIndex(db: Db, sessions: SessionState[]): Indexed[] {
	const transcripts = new Map(
		db.all("SELECT session_id, transcript FROM sessions").map((r) => [r.session_id as string, r.transcript as string]),
	);
	return sessions.map((s) => ({ id: s.id, harness: s.harness, cwd: s.cwd, transcript: transcripts.get(s.id) as string }));
}

/** Indexes what changed in every Session's transcripts, for the clock to keep searches quick. */
export function syncAll(db: Db): void {
	const index = openRecall();
	try {
		const all = states(db);
		prune(
			index,
			all.map((s) => s.id),
		);
		syncSessions(index, sessionsToIndex(db, all));
	} finally {
		index.close();
	}
}

/** A time as the tools show it: local, to the minute. */
export const stamp = (at: number) => {
	const d = new Date(at);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const WHO: Record<string, string> = { user: "user", agent: "agent", call: "tool call", result: "tool result", summary: "summary" };

export function search(db: Db, from: string | null, input: string, limit = SEARCH_LIMIT): ToolResult {
	if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) throw new Error(`limit: 1 to ${SEARCH_LIMIT_MAX}`);
	const query = parseQuery(input);
	const all = states(db);
	let candidates = all.filter((s) => s.id !== from && passes(s, query.filters));
	const index = openRecall();
	try {
		prune(
			index,
			all.map((s) => s.id),
		);
		syncSessions(index, sessionsToIndex(db, candidates));
		if (query.filters.file) {
			const touched = touching(index, query.filters.file, query.filters);
			candidates = candidates.filter((s) => touched.has(s.id));
		}
		const left = excluded(index, query);
		candidates = candidates.filter((s) => !left.has(s.id));
		const hits = matches(
			index,
			query,
			candidates.map((s) => s.id),
			limit,
		);
		const now = Date.now();
		const ranked = candidates.flatMap((s) => {
			const own = hits.filter((h) => h.sessionId === s.id);
			const titled = query.terms.length > 0 && query.terms.every((t) => (s.title ?? "").toLowerCase().includes(t.toLowerCase()));
			if (query.match && own.length === 0 && !titled) return [];
			return [{ s, own, titled }];
		});
		// A session ranks by where its best match falls among all of them, then by how many more it has.
		const firsts = new Map<string, number>();
		for (const h of hits) if (!firsts.has(h.sessionId)) firsts.set(h.sessionId, firsts.size);
		const score = ({ s, own, titled }: (typeof ranked)[number]) => {
			const rank = firsts.get(s.id) ?? firsts.size;
			const text = own.slice(0, 5).reduce((sum, h, i) => sum + (WEIGHTS[h.kind] ?? 100) / (rank + 1) / (i + 1), 0);
			const ageDays = Math.max(0, (now - s.activityAt) / 86_400_000);
			return text + (titled ? TITLE_WEIGHT : 0) + RECENCY_MAX * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
		};
		const sorted = query.match ? ranked.sort((a, b) => score(b) - score(a)) : ranked.sort((a, b) => b.s.activityAt - a.s.activityAt);
		const shown = sorted.slice(0, limit);
		const describe = ({ s, own }: (typeof ranked)[number]) =>
			[
				`- ${s.id} · ${harnessName(s.harness)} · "${displayName(s)}" · ${s.open ? "open" : "archived"} · ${s.cwd} · last active ${stamp(s.activityAt)}`,
				...own
					.slice(0, SNIPPETS)
					.map((h) => `  - ${WHO[h.kind]}${h.subagent ? `, in subagent "${h.label}"` : ""}${h.at ? `, ${stamp(h.at)}` : ""}: ${h.snippet}`),
			].join("\n");
		// Codex's model reads these in place of the text, so they say everything it does.
		const sessions = shown.map(({ s, own }) => ({
			id: s.id,
			harness: s.harness,
			title: displayName(s),
			state: s.open ? "open" : "archived",
			cwd: s.cwd,
			lastActive: stamp(s.activityAt),
			matches: own.slice(0, SNIPPETS).map((h) => ({
				in: WHO[h.kind],
				...(h.subagent ? { subagent: h.label } : {}),
				...(h.at ? { at: stamp(h.at) } : {}),
				text: h.snippet,
			})),
		}));
		const more = sorted.length - shown.length;
		const text =
			shown.length === 0
				? "No sessions match."
				: [
						`Sessions (id · harness · title · open or archived · directory · last active), ${query.match ? "best match first" : "most recent first"}:`,
						...shown.map(describe),
						...(more > 0 ? [`${more} more match; narrow the query, or raise limit.`] : []),
					].join("\n");
		return { text, details: { sessions, more } };
	} finally {
		index.close();
	}
}
