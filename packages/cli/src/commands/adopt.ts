import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { branch, projectRoot } from "@swb/shared";
import { openDeck } from "../deck/deck.ts";
import { SwbError, UsageError } from "../errors.ts";
import { markVisited, openStore } from "../store.ts";

type Entry = {
	type: string;
	timestamp: string;
	id?: string;
	cwd?: string;
	name?: string;
	customType?: string;
	data?: { subagent?: unknown };
};

const agentDir = (): string => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");

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

function findTranscript(id: string): string {
	const custom = process.env.PI_CODING_AGENT_SESSION_DIR ?? settingsSessionDir(join(agentDir(), "settings.json"));
	const roots = [join(agentDir(), "sessions"), ...(custom ? [expand(custom)] : [])];
	const found = roots.flatMap((root) =>
		existsSync(root)
			? [`*/*_${id}.jsonl`, `*_${id}.jsonl`].flatMap((p) => [...new Bun.Glob(p).scanSync({ cwd: root, absolute: true })])
			: [],
	);
	if (found.length === 0) throw new SwbError(`adopt: no pi session ${id} under ${roots.join(" or ")}; pass its .jsonl path instead`);
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

/** Tracks a session pi ran outside swb, as a dormant row, and opens a Deck on it. */
export async function adopt(args: string[]): Promise<void> {
	const target = args[0];
	if (!target) throw new UsageError("adopt: a session id or transcript path is required");
	const transcript = target.endsWith(".jsonl") ? resolve(target) : findTranscript(target);
	const entries = readEntries(transcript);
	const header = entries[0];
	if (header?.type !== "session" || !header.id || !header.cwd) throw new SwbError(`adopt: ${transcript} is not a pi session`);
	const { id, cwd } = header;
	if (entries.length === 1) throw new SwbError(`adopt: ${id} has no turns yet`);
	if (entries.some((e) => e.customType === "pi-sessions.handoff-bootstrap" && e.data?.subagent)) {
		throw new SwbError(`adopt: ${id} is a pi-sessions subagent; its parent owns it`);
	}
	if (!existsSync(cwd)) throw new SwbError(`adopt: its directory ${cwd} is gone`);
	if (dirname(transcript) !== piSessionDir(cwd)) {
		throw new SwbError(`adopt: pi won't find ${id} from ${cwd}; move it to ${piSessionDir(cwd)}`);
	}
	const last = Date.parse((entries.at(-1) as Entry).timestamp);
	const db = openStore();
	db.tx(() => {
		if (db.get("SELECT 1 FROM sessions WHERE session_id = ?", id)) throw new SwbError(`adopt: ${id} is already tracked; swb open ${id}`);
		db.run(
			`INSERT INTO sessions (session_id, tool, cwd, project_root, transcript, title, branch, phase, created_at, last_prompt_at, last_settled_at)
			 VALUES (?, 'pi', ?, ?, ?, ?, ?, 'idle', ?, ?, ?)`,
			id,
			cwd,
			projectRoot(cwd),
			transcript,
			entries.findLast((e) => e.type === "session_info")?.name ?? null,
			branch(cwd),
			Date.parse(header.timestamp),
			last,
			last,
		);
		markVisited(db, id);
	});
	await openDeck({ select: id, newCwd: null });
}
