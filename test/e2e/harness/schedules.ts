import { entry } from "./deck.ts";
import { type LsEntry, type Scenario, until } from "./index.ts";

export const ready = 60_000;

export async function launched(s: Scenario, harness: "pi" | "claude" | "codex", goal: string): Promise<LsEntry> {
	const out = JSON.parse(
		await Bun.spawn([`${s.bin}/swb`, "launch", "--harness", harness, "--cwd", s.project], {
			env: s.env,
			cwd: s.project,
			stdin: new Blob([goal]),
			stdout: "pipe",
			stderr: "inherit",
		}).stdout.text(),
	) as { details: { id: string } };
	const id = out.details.id;
	return until(() => s.ls().find((e) => e.id === id && e.activity === "idle"), ready, `the ${harness} session's first turn to settle`);
}

/** Runs an swb line command with a body on stdin, as a line's tool does. */
export async function swbIn(s: Scenario, body: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn([`${s.bin}/swb`, ...args], {
		env: s.env,
		cwd: s.project,
		stdin: new Blob([body]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	return { code, out, err };
}

export async function scheduled(
	s: Scenario,
	body: string,
	...args: string[]
): Promise<{ text: string; details: { id: string; nextAt: number } }> {
	const result = await swbIn(s, body, "schedule", ...args);
	if (result.code !== 0) throw new Error(`swb schedule: ${result.err}`);
	return JSON.parse(result.out);
}

export function host(s: Scenario, id: string): string {
	return s.query<{ tmux_session: string }>("select tmux_session from runtimes where session_id = ?", id)[0]?.tmux_session as string;
}

/** The harness's screen, with its own wrapping undone: whitespace runs read as one space. */
export function pane(s: Scenario, id: string): string {
	return s.tmux(s.servers.sessions, "capture-pane", "-p", "-J", "-S", "-500", "-t", `=${host(s, id)}:`).replace(/\s+/g, " ");
}

export function type(s: Scenario, id: string, text: string): void {
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(s, id)}:`, "-l", text);
	Bun.sleepSync(300);
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(s, id)}:`, "Enter");
}

type Snoozed = LsEntry & { snoozed: boolean; snoozedUntil: number | null };

export const snoozeOf = (s: Scenario, id: string) => entry(s, id) as Snoozed;
