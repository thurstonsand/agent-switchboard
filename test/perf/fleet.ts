import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { budgets, type LsEntry, type Scenario, until } from "../e2e/harness/index.ts";

// A roster the size of a heavy user's: one real session per harness, launched and settled through swb, then cloned
// into many dormant pi sessions across many Projects. Each clone is a copy of the real pi's own transcript with its
// id and directory swapped, and rows like the ones its line wrote, so cards, Peeks, and wakes read real files.

/** A session started through swb with `goal`, its first turn settled, and its harness stopped: dormant and Unseen. */
export async function dormant(s: Scenario, harness: "pi" | "claude" | "codex", goal: string, cwd = s.project): Promise<string> {
	const id = await launched(s, harness, goal, cwd);
	stop(s, id);
	return id;
}

/** A live, idle session started through swb with `goal`. */
export async function launched(s: Scenario, harness: "pi" | "claude" | "codex", goal: string, cwd = s.project): Promise<string> {
	const proc = Bun.spawn([`${s.bin}/swb`, "launch", "--harness", harness, "--cwd", cwd], {
		env: s.env,
		cwd: s.project,
		stdin: new Blob([goal]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	if (code !== 0) throw new Error(`swb launch --harness ${harness}: ${err}`);
	const id = (JSON.parse(out) as { details: { id: string } }).details.id;
	await until(() => entry(s, id)?.activity === "idle", 60_000, `the ${harness} session's first turn to settle`);
	return id;
}

export function entry(s: Scenario, id: string): LsEntry | undefined {
	return s.ls().find((e) => e.id === id);
}

export function host(s: Scenario, id: string): string | null {
	return s.query<{ tmux_session: string }>("SELECT tmux_session FROM runtimes WHERE session_id = ?", id)[0]?.tmux_session ?? null;
}

/** Kills a session's harness, as a crash or reboot would, and waits until swb sees it dormant. */
export function stop(s: Scenario, id: string): void {
	const name = host(s, id);
	// Already gone if its server went down with it; the runtime row outlives both.
	if (name) Bun.spawnSync([`${s.bin}/tmux`, "-L", s.servers.sessions, "kill-session", "-t", `=${name}`], { env: s.env });
	const deadline = Date.now() + budgets.settle;
	while (entry(s, id)?.live) {
		if (Date.now() > deadline) throw new Error(`${id} still live after its host was killed`);
		Bun.sleepSync(50);
	}
}

export type Fleet = { ids: string[]; projects: string[]; long: string | null };

/**
 * Clones the pi session `template` `sessions` times across `projects` directories: a tenth archived, a tenth
 * Inactive, a fifth Unseen. `longTurns` makes one more, titled "Long conversation", with that many extra turns.
 */
export function fleet(s: Scenario, template: string, options: { sessions: number; projects: number; longTurns: number }): Fleet {
	const [row] = s.query<{ transcript: string; cwd: string }>("SELECT transcript, cwd FROM sessions WHERE session_id = ?", template);
	if (!row) throw new Error(`no session ${template} to clone`);
	const text = readFileSync(row.transcript, "utf8");
	const dir = join(s.env.PI_CODING_AGENT_DIR as string, "sessions", "fleet");
	mkdirSync(dir, { recursive: true });
	const projects = Array.from({ length: options.projects }, (_, i) => {
		const path = join(s.root, "fleet", `project-${String(i).padStart(2, "0")}`);
		mkdirSync(path, { recursive: true });
		return path;
	});
	const hour = 3_600_000;
	const now = Date.now();
	const db = s.db();
	db.run("PRAGMA busy_timeout = 5000");
	const ids: string[] = [];
	let long: string | null = null;
	try {
		const insert = db.prepare(
			"INSERT INTO sessions (session_id, harness, cwd, project_root, transcript, title, phase, created_at, last_prompt_at, last_settled_at) VALUES (?, 'pi', ?, ?, ?, ?, 'idle', ?, ?, ?)",
		);
		const marks = db.prepare("INSERT INTO marks (session_id, archived_at, visited_at) VALUES (?, ?, ?)");
		db.transaction(() => {
			for (let i = 0; i <= options.sessions; i++) {
				const isLong = i === options.sessions;
				if (isLong && options.longTurns === 0) break;
				const id = crypto.randomUUID();
				const cwd = isLong ? s.project : (projects[i % projects.length] as string);
				const path = join(dir, `${id}.jsonl`);
				writeFileSync(path, text.replaceAll(template, id).replaceAll(row.cwd, cwd));
				// Spread over the last two days, and a tenth past inactive_after's three.
				const settled = i % 10 === 9 ? now - 100 * hour : now - ((i * 7919) % 48) * hour - i * 1000;
				insert.run(id, cwd, cwd, path, isLong ? "Long conversation" : `Fleet session ${i}`, settled - 60_000, settled - 60_000, settled);
				const archived = !isLong && i % 10 === 4 ? settled + 1000 : null;
				const visited = i % 5 === 2 ? null : settled + 1000;
				marks.run(id, archived, visited);
				if (isLong) long = id;
				else ids.push(id);
			}
		})();
	} finally {
		db.close();
	}
	if (long) lengthen(join(dir, `${long}.jsonl`), options.longTurns);
	return { ids, projects, long };
}

/** Appends `turns` prompt-and-reply pairs of about a kilobyte each to a pi transcript. */
function lengthen(path: string, turns: number): void {
	const words = "the quick brown fox jumps over the lazy dog while the build runs and the tests pass ".repeat(12);
	const pairs = Array.from({ length: turns }, (_, i): [string, string] => [`user turn ${i}: ${words}`, `assistant turn ${i}: ${words}`]);
	append(path, pairs);
}

/** Appends one prompt and its reply to a pi transcript, as its pi would have. */
export function say(path: string, prompt: string, reply: string): void {
	append(path, [[prompt, reply]]);
}

function append(path: string, pairs: [string, string][]): void {
	const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
	let parent = (JSON.parse(lines.at(-1) as string) as { id: string }).id;
	const extra = pairs.flatMap(([prompt, reply]) =>
		[
			["user", prompt],
			["assistant", reply],
		].map(([role, text]) => {
			const id = crypto.randomUUID().slice(0, 8);
			const line = JSON.stringify({ type: "message", id, parentId: parent, message: { role, content: [{ type: "text", text }] } });
			parent = id;
			return line;
		}),
	);
	appendFileSync(path, `${extra.join("\n")}\n`);
}
