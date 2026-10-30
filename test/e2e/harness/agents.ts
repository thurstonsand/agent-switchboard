import { expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cursorTo, entry, waitState } from "./deck.ts";
import { budgets, type LsEntry, release, type Scenario, until } from "./index.ts";

export const ready = 60_000;

/**
 * Starts Claude Code's next sessions in auto mode, with Bash left to its classifier rather than allowed outright.
 * Through a gateway, as the fake is, auto mode first stops on a note about how it bills, acknowledged here.
 */
export function claudeAutoMode(s: Scenario): void {
	writeFileSync(
		join(s.home, ".claude/settings.json"),
		JSON.stringify({ permissions: { allow: ["mcp__plugin_swb_swb"], defaultMode: "auto" } }),
	);
	const claudeJson = join(s.home, ".claude.json");
	writeFileSync(
		claudeJson,
		JSON.stringify({ ...JSON.parse(readFileSync(claudeJson, "utf8")), autoModeClassifierBillingNoticeAcknowledgedAt: Date.now() }),
	);
}

/** Starts a session in a harness the way session_launch does, and returns its row once its first turn has settled. */
export async function launched(
	s: Scenario,
	harness: "pi" | "claude" | "codex" | null,
	goal: string,
	from?: string,
	flags: string[] = [],
): Promise<LsEntry> {
	const out = JSON.parse(
		await Bun.spawn(
			[
				`${s.bin}/swb`,
				"launch",
				...(harness ? ["--harness", harness] : []),
				...flags,
				"--cwd",
				s.project,
				...(from ? ["--from", from] : []),
			],
			{
				env: s.env,
				cwd: s.project,
				stdin: new Blob([goal]),
				stdout: "pipe",
				stderr: "inherit",
			},
		).stdout.text(),
	) as { details: { id: string } };
	const id = out.details.id;
	await settled(s, id, `the ${harness ?? "carried"} session's first turn to settle`);
	return entry(s, id);
}

/**
 * Waits until a session's turn is over, for swb and for the harness's own TUI. Codex's app-server settles a turn before
 * its TUI does, and until then the TUI refuses /new and /compact, and takes a prompt into the finishing turn, which can
 * end without it. The TUI puts its own status after the thread id in its pane title.
 */
export async function settled(s: Scenario, id: string, what: string): Promise<void> {
	const { harness } = await until(() => s.ls().find((e) => e.id === id && e.activity === "idle"), ready, what);
	if (harness === "codex")
		await until(
			() =>
				s
					.tmux(s.servers.sessions, "display", "-p", "-t", `=${host(s, id)}:`, "#{pane_title}")
					.trim()
					.endsWith("Ready"),
			ready,
			`${what}, in Codex's TUI`,
		);
}

/** Sends a message the way session_send_message does, from a session, and returns swb's receipt. */
export async function send(
	s: Scenario,
	from: string,
	to: string,
	body: string,
): Promise<{ text: string; details: { delivered: boolean } }> {
	const proc = Bun.spawn([`${s.bin}/swb`, "send", "--from", from, "--to", to], {
		env: s.env,
		cwd: s.project,
		stdin: new Blob([body]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	if (code !== 0) throw new Error(`swb send: ${err}`);
	return JSON.parse(out);
}

export function host(s: Scenario, id: string): string {
	return s.query<{ tmux_session: string }>("select tmux_session from runtimes where session_id = ?", id)[0]?.tmux_session as string;
}

/** Every running process's command line. */
export function commands(): string[] {
	return Bun.spawnSync(["ps", "-eo", "args="]).stdout.toString().split("\n");
}

export function pane(s: Scenario, id: string): string {
	return s.tmux(s.servers.sessions, "capture-pane", "-p", "-J", "-S", "-500", "-t", `=${host(s, id)}:`);
}

/**
 * Types a prompt into a session's own TUI, as a person would. Pasted, so a TUI that reads it late still sees the Enter
 * as its own key: Codex takes keys arriving with a burst of typing as part of a paste, and leaves the prompt unsent.
 */
export function type(s: Scenario, id: string, text: string): void {
	s.tmux(s.servers.sessions, "set-buffer", "-b", "e2e-type", "--", text);
	s.tmux(s.servers.sessions, "paste-buffer", "-p", "-d", "-b", "e2e-type", "-t", `=${host(s, id)}:`);
	Bun.sleepSync(300);
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(s, id)}:`, "Enter");
}

export async function cardEndings(s: Scenario, harness: "pi" | "claude" | "codex"): Promise<void> {
	const [cut, quit, stopped, failed] = (await Promise.all(
		["cut", "quit", "stopped", "failed"].map((name) => launched(s, harness, `reply ${name}`)),
	)) as [LsEntry, LsEntry, LsEntry, LsEntry];
	const held = (name: string) =>
		`run echo entered > ${s.home}/e2e-signals/${name}.entered; until [ -e ${s.home}/e2e-signals/${name}.release ]; do sleep 0.1; done`;
	type(s, cut.id, held("k1"));
	type(s, quit.id, held("q1"));
	type(s, stopped.id, held("e1"));
	type(s, failed.id, "fail boom");
	await until(() => ["k1", "q1", "e1"].every((name) => s.signal(`${name}.entered`) !== ""), ready, "the tool calls running");
	// Claude Code writes its transcript a few seconds behind.
	await Bun.sleep(5000);
	const pid = (id: string) => (s.query<{ pid: number }>("select pid from runtimes where session_id = ?", id)[0] as { pid: number }).pid;
	const socket = `${host(s, cut.id)}.sock`;
	process.kill(pid(cut.id), "SIGKILL");
	if (harness === "codex")
		await until(
			() =>
				!commands().some(
					(args) => (args.includes(socket) && args.includes("app-server")) || args.includes(`${s.home}/e2e-signals/k1.release`),
				),
			budgets.settle,
			"the app-server and its tool gone with their host",
		);
	// What swb quit --force sends.
	process.kill(pid(quit.id), "SIGTERM");
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(s, stopped.id)}:`, "Escape");
	await until(
		() =>
			!entry(s, cut.id).live &&
			!entry(s, quit.id).live &&
			entry(s, stopped.id).activity === "idle" &&
			entry(s, failed.id).activity === "idle",
		ready,
		"one killed, one shut down, one stopped, one failed",
	);
	expect([entry(s, cut.id).cutOff, entry(s, quit.id).cutOff]).toEqual(["killed", "shutdown"]);
	// Errored, live or not, marks its row as a cut-off one does; stopped doesn't.
	expect([cut, quit, stopped, failed].map(({ id }) => entry(s, id).errored)).toEqual([false, false, false, true]);
	for (const { id } of [stopped, failed]) s.tmux(s.servers.sessions, "kill-session", "-t", `=${host(s, id)}`);
	await until(() => !entry(s, stopped.id).live && !entry(s, failed.id).live, budgets.settle, "both dormant");
	expect([entry(s, stopped.id).cutOff, entry(s, failed.id).cutOff]).toEqual([null, null]);

	s.swb("drive", "start");
	const glyphs = await waitState(s, "every row", (x) => x.rows.filter((r) => r.kind === "session").length === 4);
	const glyphOf = (id: string) => glyphs.rows.flatMap((r) => (r.kind === "session" && r.id === id ? [r.glyph] : []))[0];
	expect([cut, quit, stopped, failed].map(({ id }) => glyphOf(id))).toEqual(["⚠", "⚠", "●", "⚠"]);
	const card = async (id: string, ...want: string[]) => {
		await cursorTo(s, id);
		await until(() => want.every((text) => s.screen().includes(text)), budgets.settle, want.join(", "));
		return s.screen();
	};
	const cutCard = await card(cut.id, "─ cut off ─", "$ echo entered", "cut off · killed · waking continues it");
	s.save("cut.txt", cutCard);
	s.save("quit.txt", await card(quit.id, "─ cut off ─", "$ echo entered", "cut off · shut down"));
	const stoppedCard = await card(stopped.id, "─ stopped ─", "$ echo entered");
	s.save("stopped.txt", stoppedCard);
	const failedCard = await card(failed.id, "─ errored ─", "invalid request: boom");
	s.save("failed.txt", failedCard);
	expect(stoppedCard).not.toContain("─ cut off ─");
	expect(failedCard).not.toContain("$ echo entered");
	for (const name of ["k1", "q1", "e1"]) release(s, name);

	// Waking the cut-off session starts a turn that picks its last one back up; waking the stopped one doesn't.
	const prompted = (id: string) =>
		(s.query<{ at: number }>("select last_prompt_at as at from sessions where session_id = ?", id)[0] as { at: number }).at;
	const before = { cut: prompted(cut.id), stopped: prompted(stopped.id) };
	await cursorTo(s, cut.id);
	s.keys("w");
	await until(
		() => entry(s, cut.id).live && entry(s, cut.id).activity === "idle" && prompted(cut.id) > before.cut,
		ready,
		"the cut-off turn continued and settled",
	);
	expect(entry(s, cut.id).cutOff).toBeNull();
	await cursorTo(s, stopped.id);
	s.keys("w");
	await until(() => entry(s, stopped.id).live, ready, "the stopped session awake");
	await Bun.sleep(3000);
	expect(prompted(stopped.id)).toBe(before.stopped);
	s.save("continued.txt", pane(s, cut.id));

	// The next turn clears an error.
	await cursorTo(s, failed.id);
	s.keys("w");
	await until(() => entry(s, failed.id).live, ready, "the errored session awake");
	const errored = prompted(failed.id);
	type(s, failed.id, "reply recovered");
	await until(() => prompted(failed.id) > errored && entry(s, failed.id).activity === "idle", ready, "a turn after the error");
	expect(entry(s, failed.id).errored).toBe(false);
}

/** A session's conversation as session_ask's reader reads it: from its first entry, or as `args` say. */
export function recalled(s: Scenario, id: string, args: Record<string, unknown> = {}): string {
	const run = Bun.spawnSync([`${s.bin}/swb`, "recall", "read", id], {
		env: s.env,
		cwd: s.project,
		stdin: Buffer.from(JSON.stringify(args)),
	});
	if (run.exitCode !== 0) throw new Error(`swb recall read ${id}: ${run.stderr.toString()}`);
	return (JSON.parse(run.stdout.toString()) as { text: string }).text;
}

/**
 * Waits for a Claude Code subagent to finish and its parent's turn after it to end. Claude Code runs an Agent call in
 * the background: the call returns at once, and the subagent's end starts a turn of its own in the parent.
 */
export async function subagentDone(s: Scenario, parent: string, description: string): Promise<void> {
	await until(
		() => new RegExp(`Agent "${description}" finished[\\s\\S]*✻[^\\n]*done`).test(pane(s, parent)),
		30_000,
		`subagent "${description}" finished, and its parent's turn after it`,
	);
}
