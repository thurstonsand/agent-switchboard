/// <reference lib="webworker" />
import { span } from "@swb/shared/trace";
import { filterText, states } from "../derive.ts";
import { parseTyped } from "../recall/query.ts";
import { passes, rank, titled } from "../recall/search.ts";
import { openRecall } from "../recall/store.ts";
import { openStore } from "../store.ts";
import type { FromSearcher, ToSearcher } from "./protocol.ts";

// The roster's search runs here, apart from the roster's worker: a query as broad as one letter reads most of a large
// index, and the snapshots shouldn't wait on it. A search that stays on the roster is answered again as the clock
// indexes new turns, which it does at most every 5 seconds; so does this.

declare const self: Worker;

const POLL_MS = 5000;
/** How many sessions a search shows. */
const SHOWN = 15;

const db = openStore();
const recall = openRecall();
/** The search's query, and the version of the index it was last answered at. */
let search: { query: string; at: string } | null = null;

/** Answers the query, unless the index hasn't changed since it last did. */
function answer(): void {
	if (!search) return;
	const { query } = search;
	let found: FromSearcher;
	try {
		const at = String(recall.dataVersion());
		if (at === search.at) return;
		search.at = at;
		found = { query, ...span("searcher.search", () => best(query)), error: null };
	} catch (error) {
		found = { query, ids: [], total: 0, error: (error as Error).message };
	}
	self.postMessage(found);
}

/**
 * The best sessions for the query, as session_search ranks them: one whose roster row shows what's typed, in its
 * title, Project, branch, or Group, counts as a match by title.
 */
function best(query: string): { ids: string[]; total: number } {
	const parsed = parseTyped(query);
	const typed = query.toLowerCase();
	const candidates = states(db).filter((s) => passes(s, parsed.filters));
	const ranked = rank(recall, parsed, candidates, SHOWN, Date.now(), (s) => titled(s, parsed) || filterText(s, s.group).includes(typed));
	return { ids: ranked.slice(0, SHOWN).map(({ s }) => s.id), total: ranked.length };
}

self.onmessage = (event: MessageEvent<ToSearcher>) => {
	// Keys typed in a burst arrive together: only the last query runs.
	const waiting = search?.at === "";
	search = event.data.query === "" ? null : { query: event.data.query, at: "" };
	if (search && !waiting) setTimeout(answer, 0);
};

setInterval(answer, POLL_MS);
