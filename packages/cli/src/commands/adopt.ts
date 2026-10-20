import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { branch, type Harness, projectRoot } from "@swb/shared";
import { openDeck } from "../deck/deck.ts";
import { claudeTitle, readTranscript } from "../deck/transcript.ts";
import { SwbError, UsageError } from "../errors.ts";
import { markVisited, openStore } from "../store.ts";

type Entry = {
	type: string;
	timestamp?: string;
	id?: string;
	cwd?: string;
	name?: string;
	customType?: string;
	isSidechain?: boolean;
	data?: { subagent?: unknown };
	payload?: { id?: string; cwd?: string; timestamp?: string; thread_source?: string };
};

/** A session another harness process ran, as swb will track it. */
type Adoptable = {
	harness: Harness;
	id: string;
	cwd: string;
	transcript: string;
	title: string | null;
	createdAt: number;
	lastAt: number;
};

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

/** Every harness's transcript for a session id: pi's, Claude Code's (not its subagents', a level down), and Codex's rollouts. */
function findTranscript(id: string): string {
	const custom = process.env.PI_CODING_AGENT_SESSION_DIR ?? settingsSessionDir(join(agentDir(), "settings.json"));
	const found = [
		...[join(agentDir(), "sessions"), ...(custom ? [expand(custom)] : [])].flatMap((root) =>
			scan(root, [`*/*_${id}.jsonl`, `*_${id}.jsonl`]),
		),
		...scan(join(claudeHome(), "projects"), [`*/${id}.jsonl`]),
		...scan(codexHome(), [`sessions/*/*/*/rollout-*-${id}.jsonl`, `archived_sessions/rollout-*-${id}.jsonl`]),
	];
	if (found.length === 0) throw new SwbError(`adopt: no pi, Claude Code, or Codex session ${id}; pass its .jsonl path instead`);
	if (found.length > 1) throw new SwbError(`adopt: session ${id} has several transcripts:\n${found.join("\n")}`);
	return found[0] as string;
}

function readEntries(transcript: string): Entry[] {
	const lines = readFileSync(transcript, "utf8").split("\n").filter(Boolean);
	return lines.flatMap((line, i) => {
		try {
			return [JSON.parse(line) as Entry];
		} catch {
			if (i === lines.length - 1) return [];
			throw new SwbError(`adopt: ${transcript} line ${i + 1} is not JSON`);
		}
	});
}

const timestamps = (entries: Entry[]): number[] => entries.flatMap((e) => (e.timestamp ? [Date.parse(e.timestamp)] : []));

function pi(transcript: string, entries: Entry[]): Adoptable {
	const header = entries[0] as Entry;
	if (!header.id || !header.cwd || !header.timestamp) throw new SwbError(`adopt: ${transcript} has no pi session header`);
	const { id, cwd } = header;
	if (entries.length === 1) throw new SwbError(`adopt: ${id} has no turns yet`);
	if (entries.some((e) => e.customType === "pi-sessions.handoff-bootstrap" && e.data?.subagent)) {
		throw new SwbError(`adopt: ${id} is a pi-sessions subagent; its parent owns it`);
	}
	if (existsSync(cwd) && dirname(transcript) !== piSessionDir(cwd)) {
		throw new SwbError(`adopt: pi won't find ${id} from ${cwd}; move it to ${piSessionDir(cwd)}`);
	}
	return {
		harness: "pi",
		id,
		cwd,
		transcript,
		title: entries.findLast((e) => e.type === "session_info")?.name ?? null,
		createdAt: Date.parse(header.timestamp),
		lastAt: Math.max(...timestamps(entries)),
	};
}

function claude(transcript: string, entries: Entry[]): Adoptable {
	const id = basename(transcript, ".jsonl");
	if (entries.some((e) => e.isSidechain)) throw new SwbError(`adopt: ${id} is a Claude Code subagent; its parent owns it`);
	const cwd = entries.find((e) => e.cwd)?.cwd;
	if (!cwd || readTranscript(transcript, "claude").turns.length === 0) throw new SwbError(`adopt: ${id} has no turns yet`);
	if (existsSync(cwd) && dirname(transcript) !== claudeProjectDir(cwd)) {
		throw new SwbError(`adopt: Claude Code won't find ${id} from ${cwd}; move it to ${claudeProjectDir(cwd)}`);
	}
	const at = timestamps(entries);
	return { harness: "claude", id, cwd, transcript, title: claudeTitle(transcript), createdAt: Math.min(...at), lastAt: Math.max(...at) };
}

/** The name Codex keeps for a thread: append-only lines in its session index, the latest winning. */
function codexName(id: string): string | null {
	const index = join(codexHome(), "session_index.jsonl");
	if (!existsSync(index)) return null;
	const named = readEntries(index) as unknown as { id: string; thread_name: string }[];
	return named.findLast((entry) => entry.id === id)?.thread_name ?? null;
}

function codex(transcript: string, entries: Entry[]): Adoptable {
	const meta = (entries[0] as Entry).payload;
	if (!meta?.id || !meta.cwd || !meta.timestamp) throw new SwbError(`adopt: ${transcript} has no Codex session header`);
	const { id, cwd } = meta;
	if (meta.thread_source && meta.thread_source !== "user")
		throw new SwbError(`adopt: ${id} is a Codex ${meta.thread_source} thread, not a session`);
	if (readTranscript(transcript, "codex").turns.length === 0) throw new SwbError(`adopt: ${id} has no turns yet`);
	return {
		harness: "codex",
		id,
		cwd,
		transcript,
		title: codexName(id),
		createdAt: Date.parse(meta.timestamp),
		lastAt: Math.max(...timestamps(entries)),
	};
}

/** The harness that wrote a transcript, from its first line: pi's session header, Codex's session_meta, else Claude Code. */
function read(transcript: string): Adoptable {
	const entries = readEntries(transcript);
	switch (entries[0]?.type) {
		case undefined:
			throw new SwbError(`adopt: ${transcript} is empty`);
		case "session":
			return pi(transcript, entries);
		case "session_meta":
			return codex(transcript, entries);
		default:
			if (!entries.some((e) => (e as { sessionId?: string }).sessionId)) {
				throw new SwbError(`adopt: ${transcript} is not a pi, Claude Code, or Codex session`);
			}
			return claude(transcript, entries);
	}
}

/** Tracks a session pi, Claude Code, or Codex ran outside swb, as a dormant row, and opens a Deck on it. */
export async function adopt(args: string[]): Promise<void> {
	const target = args[0];
	if (!target) throw new UsageError("adopt: a session id or transcript path is required");
	const s = read(target.endsWith(".jsonl") ? resolve(target) : findTranscript(target));
	if (!existsSync(s.cwd)) throw new SwbError(`adopt: its directory ${s.cwd} is gone`);
	const db = openStore();
	db.tx(() => {
		if (db.get("SELECT 1 FROM sessions WHERE session_id = ?", s.id))
			throw new SwbError(`adopt: ${s.id} is already tracked; swb open ${s.id}`);
		db.run(
			`INSERT INTO sessions (session_id, harness, cwd, project_root, transcript, title, branch, phase, created_at, last_prompt_at, last_settled_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)`,
			s.id,
			s.harness,
			s.cwd,
			projectRoot(s.cwd),
			s.transcript,
			s.title,
			branch(s.cwd),
			s.createdAt,
			s.lastAt,
			s.lastAt,
		);
		markVisited(db, s.id);
	});
	await openDeck({ select: s.id, newCwd: null, continue: false });
}
