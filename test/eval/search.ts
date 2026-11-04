import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { displayName, type SessionState, states } from "../../packages/cli/src/derive.ts";
import { parseQuery, type Query } from "../../packages/cli/src/recall/query.ts";
import { passes, rank, SEARCH_LIMIT, sessionsToIndex } from "../../packages/cli/src/recall/search.ts";
import { openRecall } from "../../packages/cli/src/recall/store.ts";
import { prune, syncSessions } from "../../packages/cli/src/recall/sync.ts";
import { openStore } from "../../packages/cli/src/store.ts";
import { locateTranscript, readConversation } from "../../packages/cli/src/transcripts/read.ts";
import { stateDir } from "../../packages/shared/src/index.ts";
import { TOOLS } from "../../packages/shared/src/tools.ts";

// Every session_search this machine's agents made is an example, labelled by the session they then acted on: asked,
// showed, messaged, updated, or scheduled, in that turn or the next. Each is replayed against this checkout's ranker as
// the index stood when it was made: only sessions that existed then, only what they had said by then, and recency
// counted from then. Nothing calls a model, and nothing it reads leaves this machine: results/ is gitignored.

const USAGE = `mise run eval:search [-- OPTIONS]     replay every recorded session_search against this checkout's ranker
mise run eval:compare [BASE.json OTHER.json]   two runs, the latest two by default
mise run eval:search -- history       every run so far, oldest first

  --note TEXT     what this run tries, kept with its results
  --state DIR     the swb state to read (default: this machine's, ${stateDir()})
  --out DIR       where runs are kept, and the index they share (default: test/eval/results)
  --holdout       also list the held-out examples' misses; leave it off while tuning
  --json          print the results as JSON on stdout

Every run writes <out>/<date>-<sha>.json. A fifth of the examples, chosen by a hash of each, are held
out: their scores show, their misses don't.`;

const { values, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: {
		note: { type: "string", default: "" },
		state: { type: "string" },
		out: { type: "string" },
		holdout: { type: "boolean", default: false },
		json: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
	},
});

const here = import.meta.dir;
const repo = resolve(here, "../..");
const resultsDir = resolve(values.out ?? join(here, "results"));
const log = (text: string) => process.stderr.write(`${text}\n`);

type Example = {
	/** The searching session and the call's place in its transcript, stable across runs. */
	key: string;
	split: "tune" | "holdout";
	from: string;
	harness: string;
	query: string;
	limit: number;
	at: number;
	target: string;
	targetTitle: string;
	/** Where the target stood in what the agent was shown, or null when it wasn't listed. */
	shownAt: number | null;
	/** Where this checkout's ranker puts it, or null when it doesn't list it at all. */
	rank: number | null;
	/** What this ranker puts above it. */
	above: string[];
};

type Skipped = { key: string; from: string; query: string; why: "unpicked" | "target-newer" | "bad-query" | "no-time" };

type Summary = { examples: number; top1: number; mrr: number; listed: number };

type Results = {
	meta: { date: string; sha: string; dirty: boolean; branch: string; note: string; host: string; sessions: number };
	tune: Summary;
	holdout: Summary;
	examples: Example[];
	skipped: Skipped[];
};

function git(...args: string[]): string {
	return Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe" })
		.stdout.toString()
		.trim();
}

/** A tool's own name, without the prefix Claude Code and Codex give an MCP server's tools. */
const tool = (name: string) => name.split("__").at(-1) as string;

const argsOf = (args: unknown): Record<string, unknown> => {
	if (typeof args !== "string") return (args ?? {}) as Record<string, unknown>;
	try {
		return JSON.parse(args) as Record<string, unknown>;
	} catch {
		return {};
	}
};

type Search = { key: string; from: string; harness: string; query: string; limit: number; at: number | null; turn: number; shown: string };
type Pick = { search: Search; target: string } | { search: Search; target: null };

/** Names swb's tools had when older transcripts were written: those calls still say which session an agent picked. */
const PAST_NAMES = new Set(["session_ask"]);

/** Each session_search in a session's transcript, with the session the agent acted on next, if it did in time. */
function searches(s: SessionState, transcript: string): Pick[] {
	const conversation = readConversation(locateTranscript(transcript, s.harness), s.harness);
	const picks: Pick[] = [];
	const results = new Map<string, string>();
	for (const entry of conversation.entries)
		for (const part of entry.parts) if (part.type === "result" && part.id) results.set(part.id, part.text);
	let pending: Search | null = null;
	let turn = 0;
	const unpicked = () => {
		if (pending) picks.push({ search: pending, target: null });
		pending = null;
	};
	for (const entry of conversation.entries) {
		if (entry.role === "user" && entry.parts.some((p) => p.type === "text")) {
			turn++;
			if (pending && turn - pending.turn > 1) unpicked();
		}
		for (const part of entry.parts) {
			if (part.type !== "call") continue;
			const name = tool(part.name);
			const args = argsOf(part.args);
			if (name === "session_search" && typeof args.query === "string") {
				unpicked();
				pending = {
					key: `${s.id}#${entry.ref}#${part.id ?? ""}`,
					from: s.id,
					harness: s.harness,
					query: args.query,
					limit: typeof args.limit === "number" ? args.limit : SEARCH_LIMIT,
					at: entry.at === null ? null : Date.parse(entry.at),
					turn,
					shown: part.id ? (results.get(part.id) ?? "") : "",
				};
			} else if (pending && (name in TOOLS || PAST_NAMES.has(name)) && typeof args.session === "string") {
				picks.push({ search: pending, target: args.session });
				pending = null;
			}
		}
	}
	unpicked();
	return picks;
}

/** Each session's latest activity at or before a time: when it last prompted or answered, as its transcript says. */
function activityAsOf(index: ReturnType<typeof openRecall>): (s: SessionState, at: number) => number {
	const times = new Map<string, number[]>();
	for (const row of index.all(
		`SELECT s.session_id, c.at FROM chunks c JOIN sources s ON s.id = c.source
		 WHERE s.subagent IS NULL AND c.kind IN ('user','agent') AND c.at IS NOT NULL ORDER BY c.at`,
	)) {
		const id = row.session_id as string;
		if (!times.has(id)) times.set(id, []);
		times.get(id)?.push(row.at as number);
	}
	return (s, at) => {
		const own = times.get(s.id) ?? [];
		let best = s.createdAt;
		for (const t of own) if (t <= at) best = Math.max(best, t);
		return best;
	};
}

const summarize = (examples: Example[]): Summary => ({
	examples: examples.length,
	top1: examples.filter((e) => e.rank === 1).length,
	mrr: examples.length === 0 ? 0 : examples.reduce((sum, e) => sum + (e.rank ? 1 / e.rank : 0), 0) / examples.length,
	listed: examples.filter((e) => e.rank !== null && e.rank <= e.limit).length,
});

function evaluate(): Results {
	const source = join(values.state ?? stateDir(), "swb.db");
	// The run reads a copy of swb.db, so this checkout's migrations never touch the real one, and builds its own
	// index, so a ranker that changes the index never touches recall.db.
	const cache = join(resultsDir, "cache");
	mkdirSync(join(cache, "agent-switchboard"), { recursive: true });
	const copy = join(cache, "agent-switchboard", "swb.db");
	for (const file of [copy, `${copy}-wal`, `${copy}-shm`]) rmSync(file, { force: true });
	const real = new Database(source, { readonly: true });
	try {
		real.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
	} finally {
		real.close();
	}
	process.env.XDG_STATE_HOME = cache;
	const db = openStore();
	const all = states(db);
	const transcripts = new Map(sessionsToIndex(db, all).map((s) => [s.id, s.transcript]));
	const byId = new Map(all.map((s) => [s.id, s]));
	const index = openRecall();
	try {
		log(`indexing ${all.length} sessions…`);
		prune(
			index,
			all.map((s) => s.id),
		);
		syncSessions(index, sessionsToIndex(db, all));
		const asOf = activityAsOf(index);
		const examples: Example[] = [];
		const skipped: Skipped[] = [];
		for (const s of all) {
			let picks: Pick[];
			try {
				picks = searches(s, transcripts.get(s.id) as string);
			} catch (error) {
				log(`${s.id}: transcript unreadable, left out: ${(error as Error).message}`);
				continue;
			}
			for (const { search, target } of picks) {
				const skip = (why: Skipped["why"]) => skipped.push({ key: search.key, from: search.from, query: search.query, why });
				const subject = target === null ? undefined : byId.get(target);
				if (!subject) {
					skip("unpicked");
					continue;
				}
				if (search.at === null) {
					skip("no-time");
					continue;
				}
				const at = search.at;
				if (subject.createdAt > at) {
					skip("target-newer");
					continue;
				}
				let query: Query;
				try {
					query = parseQuery(search.query);
				} catch {
					skip("bad-query");
					continue;
				}
				query.filters.before = Math.min(query.filters.before ?? at, at);
				const candidates = all
					.filter((c) => c.id !== search.from && passes(c, query.filters))
					.map((c) => ({ ...c, activityAt: asOf(c, at) }));
				const ranked = rank(index, query, candidates, search.limit, at).map((r) => r.s.id);
				const position = ranked.indexOf(subject.id);
				const shown = all
					.filter((c) => search.shown.includes(c.id))
					.sort((a, b) => search.shown.indexOf(a.id) - search.shown.indexOf(b.id))
					.map((c) => c.id);
				examples.push({
					key: search.key,
					split: BigInt(Bun.hash(search.key)) % 5n === 0n ? "holdout" : "tune",
					from: search.from,
					harness: search.harness,
					query: search.query,
					limit: search.limit,
					at,
					target: subject.id,
					targetTitle: displayName(subject),
					shownAt: shown.includes(subject.id) ? shown.indexOf(subject.id) + 1 : null,
					rank: position === -1 ? null : position + 1,
					above: (position === -1 ? ranked.slice(0, 3) : ranked.slice(0, Math.min(position, 3))).map((id) => {
						const above = byId.get(id);
						return above ? displayName(above) : id;
					}),
				});
			}
		}
		const sha = git("rev-parse", "--short", "HEAD");
		return {
			meta: {
				date: new Date().toISOString(),
				sha,
				dirty: git("status", "--porcelain", "--", "packages") !== "",
				branch: git("rev-parse", "--abbrev-ref", "HEAD"),
				note: values.note,
				host: hostname(),
				sessions: all.length,
			},
			tune: summarize(examples.filter((e) => e.split === "tune")),
			holdout: summarize(examples.filter((e) => e.split === "holdout")),
			examples,
			skipped,
		};
	} finally {
		index.close();
		db.close();
	}
}

const mrr = (s: Summary) => (s.examples === 0 ? "—" : s.mrr.toFixed(3));
const pct = (n: number, of: number) => (of === 0 ? "—" : `${n}/${of} (${Math.round((100 * n) / of)}%)`);
const line = (name: string, s: Summary) =>
	`${name.padEnd(8)} top-1 ${pct(s.top1, s.examples).padEnd(16)} MRR ${mrr(s)}   listed ${pct(s.listed, s.examples)}`;

function report(r: Results): string {
	const misses = r.examples.filter((e) => e.rank !== 1 && (values.holdout || e.split === "tune"));
	const why = (w: Skipped["why"]) => r.skipped.filter((s) => s.why === w).length;
	return [
		`${r.meta.branch}@${r.meta.sha}${r.meta.dirty ? "+" : ""}${r.meta.note ? ` · ${r.meta.note}` : ""} · ${r.meta.sessions} sessions`,
		line("tune", r.tune),
		line("holdout", r.holdout),
		`left out: ${why("unpicked")} searches nothing followed, ${why("target-newer")} picked a session that didn't exist yet, ${why("bad-query")} malformed, ${why("no-time")} untimed`,
		...(misses.length > 0
			? ["", `misses${values.holdout ? "" : " (tune)"}: rank now · as shown then · query → target · ranked above it`]
			: []),
		...misses.map(
			(e) =>
				`  ${String(e.rank ?? "—").padStart(3)} · ${String(e.shownAt ?? "—").padStart(3)} · ${JSON.stringify(e.query)} → "${e.targetTitle}" · ${e.above.map((t) => `"${t}"`).join(", ")}`,
		),
	].join("\n");
}

function runs(): string[] {
	try {
		return readdirSync(resultsDir)
			.filter((f) => f.endsWith(".json"))
			.sort()
			.map((f) => join(resultsDir, f));
	} catch {
		return [];
	}
}

const load = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Results;

/** Two runs on the examples both have, so a history that grew in between doesn't move the score. */
function compare(baseFile: string, otherFile: string): string {
	const [base, other] = [load(baseFile), load(otherFile)];
	const theirs = new Map(base.examples.map((e) => [e.key, e]));
	const both = other.examples.filter((e) => theirs.has(e.key));
	const before = both.map((e) => theirs.get(e.key) as Example);
	const label = (r: Results, file: string) => `${basename(file, ".json")}${r.meta.note ? ` · ${r.meta.note}` : ""}`;
	const moved = both.flatMap((e) => {
		const was = (theirs.get(e.key) as Example).rank;
		const score = (rank: number | null) => (rank ? 1 / rank : 0);
		return score(e.rank) === score(was) || (!values.holdout && e.split === "holdout")
			? []
			: [{ e, was, better: score(e.rank) > score(was) }];
	});
	const rows = (better: boolean) =>
		moved
			.filter((m) => m.better === better)
			.map(
				(m) =>
					`  ${String(m.was ?? "—").padStart(3)} → ${String(m.e.rank ?? "—").padEnd(3)} ${JSON.stringify(m.e.query)} → "${m.e.targetTitle}"`,
			);
	const split = (examples: Example[], name: Example["split"]) => summarize(examples.filter((e) => e.split === name));
	const lost = moved.filter((m) => !m.better && m.was === 1).length;
	return [
		`base:  ${label(base, baseFile)}`,
		`other: ${label(other, otherFile)}`,
		`${both.length} examples in both (${base.examples.length - both.length} only in base, ${other.examples.length - both.length} only in other)`,
		"",
		`base    ${line("tune", split(before, "tune"))}`,
		`other   ${line("tune", split(both, "tune"))}`,
		`base    ${line("holdout", split(before, "holdout"))}`,
		`other   ${line("holdout", split(both, "holdout"))}`,
		"",
		`better (${rows(true).length}):`,
		...rows(true),
		`worse (${rows(false).length}${lost > 0 ? `, ${lost} of them lost top-1` : ""}):`,
		...rows(false),
	].join("\n");
}

if (values.help) {
	console.log(USAGE);
	process.exit(0);
}

if (positionals[0] === "compare") {
	const [baseFile, otherFile] = positionals.length === 3 ? positionals.slice(1) : runs().slice(-2);
	if (!baseFile || !otherFile) throw new Error(`compare takes two results files, or needs two runs in ${resultsDir}\n\n${USAGE}`);
	console.log(compare(baseFile, otherFile));
	process.exit(0);
}

if (positionals[0] === "history") {
	for (const file of runs()) {
		const r = load(file);
		console.log(
			`${basename(file, ".json").padEnd(32)} ${line("tune", r.tune)} · holdout MRR ${mrr(r.holdout)}${r.meta.note ? ` · ${r.meta.note}` : ""}`,
		);
	}
	process.exit(0);
}

if (positionals.length > 0) throw new Error(`unknown command ${positionals[0]}\n\n${USAGE}`);

const results = evaluate();
mkdirSync(resultsDir, { recursive: true });
const file = join(
	resultsDir,
	`${results.meta.date.replaceAll(/[:.]/g, "-").slice(0, 23)}-${results.meta.sha}${results.meta.dirty ? "+" : ""}.json`,
);
writeFileSync(file, `${JSON.stringify(results, null, 1)}\n`);
if (values.json) console.log(JSON.stringify(results));
log(`\n${report(results)}\n\nresults: ${file}`);
