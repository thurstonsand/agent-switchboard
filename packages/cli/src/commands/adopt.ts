import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { branch, type Db, type Harness, projectRoot } from "@swb/shared";
import { harnessName } from "@swb/shared/mailbox";
import { openDeck } from "../deck/deck.ts";
import { SwbError, UsageError } from "../errors.ts";
import { syncAll } from "../recall/search.ts";
import { markVisited, openStore } from "../store.ts";
import { claudeTitle } from "../transcripts/claude.ts";
import { codexThreads } from "../transcripts/codex.ts";
import { type Conversation, lines } from "../transcripts/conversation.ts";
import { readConversation } from "../transcripts/read.ts";

type Entry = {
	type: string;
	timestamp?: string;
	id?: string;
	cwd?: string;
	name?: string;
	customType?: string;
	isSidechain?: boolean;
	gitBranch?: string;
	sessionId?: string;
	instructions?: unknown;
	data?: { subagent?: unknown; bootstrapMode?: string; launch?: string };
	payload?: { id?: string; cwd?: string; timestamp?: string; source?: string | { subagent?: unknown }; git?: { branch?: string } };
};

/** A session another harness process ran, as swb will track it. */
type Adoptable = {
	harness: Harness;
	id: string;
	cwd: string;
	transcript: string;
	title: string | null;
	/** The branch it ran on, as its transcript records it; null where it doesn't, and git says what's checked out now. */
	branch: string | null;
	createdAt: number;
	lastAt: number;
};

/**
 * Why a transcript isn't a session swb tracks: it has no turns, another session owns it (a subagent, or a thread Codex
 * ran for one), its harness wouldn't find it from its directory, or it's from a Codex too old for swb to read. `adopt`
 * says why; `adopt --all` counts them.
 */
type Skip = { skip: "empty" | "owned" | "elsewhere" | "old"; why: string };

const agentDir = (): string => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const claudeHome = (): string => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const codexHome = (): string => process.env.CODEX_HOME ?? join(homedir(), ".codex");

const expand = (dir: string): string => resolve(dir.replace(/^~(?=$|\/)/, homedir()));

function settingsSessionDir(file: string): string | undefined {
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { sessionDir?: string }).sessionDir : undefined;
}

/** The directory `pi --session-id` searches for a session started in cwd; mirrors pi's resolution chain. */
function piSessionDir(cwd: string): string {
	const custom =
		process.env.PI_CODING_AGENT_SESSION_DIR ??
		settingsSessionDir(join(cwd, ".pi/settings.json")) ??
		settingsSessionDir(join(agentDir(), "settings.json"));
	return custom ? expand(custom) : join(agentDir(), "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

/** The folder Claude Code keeps a directory's sessions in, and where `claude --resume` looks: every other character a dash. */
function claudeProjectDir(cwd: string): string {
	return join(claudeHome(), "projects", cwd.replaceAll(/[^A-Za-z0-9]/g, "-"));
}

function scan(root: string, patterns: string[]): string[] {
	return existsSync(root) ? patterns.flatMap((p) => [...new Bun.Glob(p).scanSync({ cwd: root, absolute: true })]) : [];
}

/** Where pi keeps sessions: its own directory, and any it's set to use instead. */
function piRoots(): string[] {
	const custom = process.env.PI_CODING_AGENT_SESSION_DIR ?? settingsSessionDir(join(agentDir(), "settings.json"));
	return [join(agentDir(), "sessions"), ...(custom ? [expand(custom)] : [])];
}

/**
 * Every session transcript on disk, by the id its file is named for: pi's, Claude Code's (not its subagents', a level
 * down), and each Codex thread's current rollout.
 */
function transcripts(): { id: string; path: string }[] {
	const named = (paths: string[], id: (path: string) => string | undefined) =>
		paths.flatMap((path) => {
			const found = id(path);
			return found ? [{ id: found, path }] : [];
		});
	return [
		...named(
			piRoots().flatMap((root) => scan(root, ["*/*.jsonl", "*.jsonl"])),
			(path) => /_([^_]+)\.jsonl$/.exec(path)?.[1],
		),
		...named(scan(join(claudeHome(), "projects"), ["*/*.jsonl"]), (path) => basename(path, ".jsonl")),
		...[...codexThreads(codexHome())].map(([id, path]) => ({ id, path })),
	];
}

/** The transcript of a session id, in whichever harness ran it. */
function findTranscript(id: string): string {
	const found = transcripts().filter((t) => t.id === id);
	if (found.length === 0) throw new SwbError(`adopt: no pi, Claude Code, or Codex session ${id}; pass its .jsonl path instead`);
	if (found.length > 1) throw new SwbError(`adopt: session ${id} has several transcripts:\n${found.map((t) => t.path).join("\n")}`);
	return (found[0] as { path: string }).path;
}

const timestamps = (entries: Entry[]): number[] => entries.flatMap((e) => (e.timestamp ? [Date.parse(e.timestamp)] : []));

/**
 * Something typed or answered, on any branch: an extension can end a conversation back at its start. Settings,
 * titles, and commands alone aren't a turn.
 */
const hasTurn = (conversation: Conversation): boolean =>
	conversation.entries.some((e) => (e.role === "user" || e.role === "agent") && e.parts.some((p) => p.type === "text"));

function pi(transcript: string, entries: Entry[]): Adoptable | Skip {
	const header = entries[0] as Entry;
	if (!header.id || !header.cwd || !header.timestamp) throw new SwbError(`adopt: ${transcript} has no pi session header`);
	const { id, cwd } = header;
	// pi-sessions marks a subagent's bootstrap with `subagent`; for a few days in July 2026 it didn't, and an automatic
	// bootstrap with no `launch` was one. A handoff is reviewed, or launched somewhere.
	const bootstrap = entries.find((e) => e.customType === "pi-sessions.handoff-bootstrap")?.data;
	if (bootstrap?.subagent || (bootstrap?.bootstrapMode === "automatic" && bootstrap.launch === undefined))
		return { skip: "owned", why: `${id} is a pi-sessions subagent; its parent owns it` };
	if (!hasTurn(readConversation(transcript, "pi"))) return { skip: "empty", why: `${id} has no turns yet` };
	if (existsSync(cwd) && dirname(transcript) !== piSessionDir(cwd))
		return { skip: "elsewhere", why: `pi won't find ${id} from ${cwd}; move it to ${piSessionDir(cwd)}` };
	return {
		harness: "pi",
		id,
		cwd,
		transcript,
		title: entries.findLast((e) => e.type === "session_info")?.name ?? null,
		branch: null,
		createdAt: Date.parse(header.timestamp),
		lastAt: Math.max(...timestamps(entries)),
	};
}

function claude(transcript: string, entries: Entry[]): Adoptable | Skip {
	const id = basename(transcript, ".jsonl");
	if (entries.some((e) => e.isSidechain)) return { skip: "owned", why: `${id} is a Claude Code subagent; its parent owns it` };
	const cwd = entries.find((e) => e.cwd)?.cwd;
	if (!cwd || !hasTurn(readConversation(transcript, "claude"))) return { skip: "empty", why: `${id} has no turns yet` };
	if (existsSync(cwd) && dirname(transcript) !== claudeProjectDir(cwd))
		return { skip: "elsewhere", why: `Claude Code won't find ${id} from ${cwd}; move it to ${claudeProjectDir(cwd)}` };
	const at = timestamps(entries);
	// Detached, Claude Code records HEAD.
	const ranOn = entries.findLast((e) => e.gitBranch)?.gitBranch;
	return {
		harness: "claude",
		id,
		cwd,
		transcript,
		title: claudeTitle(transcript),
		branch: ranOn && ranOn !== "HEAD" ? ranOn : null,
		createdAt: Math.min(...at),
		lastAt: Math.max(...at),
	};
}

/** The names Codex keeps for its threads: append-only lines in its session index, the latest winning. */
function codexNames(): Map<string, string> {
	const index = join(codexHome(), "session_index.jsonl");
	if (!existsSync(index)) return new Map();
	return new Map((lines(index) as { id: string; thread_name: string }[]).map((entry) => [entry.id, entry.thread_name]));
}

/** A Codex thread from its current rollout, which a revert may have started after the first. */
function codex(transcript: string, entries: Entry[], names: Map<string, string>): Adoptable | Skip {
	const meta = (entries[0] as Entry).payload;
	if (!meta?.id || !meta.cwd || !meta.timestamp) throw new SwbError(`adopt: ${transcript} has no Codex session header`);
	const { id, cwd } = meta;
	// Every Codex version marks a thread another one ran, subagent or guardian, this way; `thread_source` is newer.
	if (typeof meta.source === "object" && meta.source.subagent)
		return { skip: "owned", why: `${id} is a thread another Codex session ran; its parent owns it` };
	// Read through every rollout of the thread: its first turns, and the first one's time, may be in an earlier one.
	const conversation = readConversation(transcript, "codex");
	if (!hasTurn(conversation)) return { skip: "empty", why: `${id} has no turns yet` };
	const at = conversation.entries.flatMap((e) => (e.at ? [Date.parse(e.at)] : []));
	return {
		harness: "codex",
		id,
		cwd,
		transcript,
		title: names.get(id) ?? null,
		branch: meta.git?.branch ?? null,
		createdAt: Math.min(...at),
		lastAt: Math.max(...at),
	};
}

/** Lines Claude Code writes around a conversation, which alone hold none: summaries and file snapshots. */
const CLAUDE_ASIDES = new Set(["summary", "file-history-snapshot"]);

/** The harness that wrote a transcript, from its first line: pi's session header, Codex's session_meta, else Claude Code. */
function read(transcript: string, names: () => Map<string, string>): Adoptable | Skip {
	const entries = lines(transcript) as Entry[];
	const first = entries[0];
	if (!first) return { skip: "empty", why: `${transcript} is empty` };
	// Codex wrote this header, with no type, before it had session_meta (2025).
	if (first.type === undefined && first.id && "instructions" in first)
		return { skip: "old", why: `${transcript} is from a Codex too old for swb to read` };
	switch (first.type) {
		case "session":
			return pi(transcript, entries);
		case "session_meta":
			return codex(transcript, entries, names());
		default:
			if (!entries.some((e) => e.sessionId)) {
				if (entries.every((e) => CLAUDE_ASIDES.has(e.type))) return { skip: "empty", why: `${transcript} has no turns` };
				throw new SwbError(`adopt: ${transcript} is not a pi, Claude Code, or Codex session`);
			}
			return claude(transcript, entries);
	}
}

/** Where a session ran: its project, and its branch. Asked of git before the db is locked, since git can be slow. */
type Place = { root: string; branch: string | null };

/** A session's row; one adopted to look at now is seen, one adopted with the rest is archived as of its last turn. */
function track(db: Db, s: Adoptable, archived: boolean, at: Place): void {
	db.run(
		`INSERT INTO sessions (session_id, harness, cwd, project_root, transcript, title, branch, phase, created_at, last_prompt_at, last_settled_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)`,
		s.id,
		s.harness,
		s.cwd,
		at.root,
		s.transcript,
		s.title,
		at.branch,
		s.createdAt,
		s.lastAt,
		s.lastAt,
	);
	if (archived) db.run("INSERT INTO marks (session_id, archived_at, visited_at) VALUES (?, ?, ?)", s.id, s.lastAt, s.lastAt);
	else markVisited(db, s.id);
}

/** Tracks a session pi, Claude Code, or Codex ran outside swb, as a dormant row, and opens a Deck on it. */
export async function adopt(args: string[]): Promise<void> {
	const target = args[0];
	if (!target) throw new UsageError("adopt: a session id, a transcript path, or --all is required");
	if (target === "--all") return adoptAll();
	const s = read(target.endsWith(".jsonl") ? resolve(target) : findTranscript(target), codexNames);
	if ("skip" in s) throw new SwbError(`adopt: ${s.why}`);
	if (!existsSync(s.cwd)) throw new SwbError(`adopt: its directory ${s.cwd} is gone`);
	const at = { root: projectRoot(s.cwd), branch: s.branch ?? branch(s.cwd) };
	const db = openStore();
	db.tx(() => {
		if (db.get("SELECT 1 FROM sessions WHERE session_id = ?", s.id))
			throw new SwbError(`adopt: ${s.id} is already tracked; swb open ${s.id}`);
		track(db, s, false, at);
	});
	await openDeck({ select: s.id, newCwd: null, continue: false });
}

const SKIPPED: Record<Skip["skip"], (n: number) => string> = {
	empty: (n) => `${n} with no turns`,
	owned: (n) => (n === 1 ? "1 subagent or thread another session ran" : `${n} subagents and threads another session ran`),
	elsewhere: (n) => (n === 1 ? "1 where its harness wouldn't find it" : `${n} where their harness wouldn't find them`),
	old: (n) => `${n} from a Codex too old for swb to read`,
};

/**
 * Tracks every session pi, Claude Code, and Codex ran outside swb, archived as of its last turn, and indexes them for
 * search. One whose directory is gone comes too: its conversation is still worth finding. Run again, it adds only
 * what's new.
 */
async function adoptAll(): Promise<void> {
	const db = openStore();
	const tracked = new Set(db.all("SELECT session_id FROM sessions").map((r) => r.session_id as string));
	const found = transcripts();
	let names: Map<string, string> | undefined;
	const adopted: Adoptable[] = [];
	const skipped = new Map<Skip["skip"], number>();
	const unreadable: string[] = [];
	for (const { id, path } of found) {
		if (tracked.has(id)) continue;
		let s: Adoptable | Skip;
		try {
			s = read(path, () => {
				names ??= codexNames();
				return names;
			});
		} catch (error) {
			if (!(error instanceof SwbError)) throw error;
			unreadable.push(error.message.replace(/^adopt: /, ""));
			continue;
		}
		if ("skip" in s) skipped.set(s.skip, (skipped.get(s.skip) ?? 0) + 1);
		else if (!tracked.has(s.id)) {
			tracked.add(s.id);
			adopted.push(s);
		}
	}
	// Sessions in one directory share its project and branch; git answers once for each, and only when asked.
	const memo = <T>(of: (cwd: string) => T) => {
		const seen = new Map<string, T>();
		return (cwd: string): T => {
			if (!seen.has(cwd)) seen.set(cwd, of(cwd));
			return seen.get(cwd) as T;
		};
	};
	const root = memo(projectRoot);
	const head = memo(branch);
	const places = adopted.map((s): Place => ({ root: root(s.cwd), branch: s.branch ?? head(s.cwd) }));
	db.tx(() => {
		adopted.forEach((s, i) => {
			track(db, s, true, places[i] as Place);
		});
	});
	const sessions = `${adopted.length} session${adopted.length === 1 ? "" : "s"}`;
	if (adopted.length > 0) {
		console.log(`Indexing ${sessions}…`);
		syncAll(db);
	}
	const by = (harness: Harness) => adopted.filter((s) => s.harness === harness).length;
	console.log(
		adopted.length === 0
			? "No new sessions to adopt."
			: `Adopted ${sessions}, archived and indexed: ${by("pi")} ${harnessName("pi")}, ${by("claude")} ${harnessName("claude")}, ${by("codex")} ${harnessName("codex")}.`,
	);
	const skips = (Object.keys(SKIPPED) as Skip["skip"][]).flatMap((kind) => {
		const n = skipped.get(kind);
		return n ? [SKIPPED[kind](n)] : [];
	});
	if (skips.length > 0) console.log(`Skipped ${skips.join(", ")}.`);
	if (unreadable.length > 0) console.log(`Couldn't read ${unreadable.length}:\n${unreadable.map((why) => `  ${why}`).join("\n")}`);
}
