import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { host, launched, pane, ready, settled, type } from "./harness/agents.ts";
import { cursorTo, entry, waitState } from "./harness/deck.ts";
import { budgets, release, type Scenario, scenario, until } from "./harness/index.ts";

// A reload restarts a session's harness on the same conversation, so it reads what it reads only at startup afresh.

let s: Scenario;
afterEach(async () => {
	try {
		for (const { session_id, tmux_session } of s.query<{ session_id: string; tmux_session: string }>(
			"select session_id, tmux_session from runtimes",
		))
			s.save(`pane-${session_id}.txt`, s.tmux(s.servers.sessions, "capture-pane", "-p", "-J", "-S", "-200", "-t", `=${tmux_session}:`));
		s.save("ls.json", JSON.stringify(s.ls(), null, 2));
		for (const harness of ["claude", "codex"] as const) s.save(`${harness}-requests.json`, JSON.stringify(s.requests(harness), null, 1));
	} catch {}
	await s.cleanup();
});

const pid = (id: string) => s.query<{ pid: number }>("select pid from runtimes where session_id = ?", id)[0]?.pid;
const prompted = (id: string) =>
	(s.query<{ at: number }>("select last_prompt_at as at from sessions where session_id = ?", id)[0] as { at: number }).at;

/** Restarted: a new process hosts it, its turn over. */
async function restarted(id: string, before: number, what: string): Promise<void> {
	await until(() => entry(s, id).live && entry(s, id).activity === "idle" && pid(id) !== before, ready, what);
}

test("pi reloading itself restarts when its turn ends and carries on with the AGENTS.md written since; R does it at once, and a dormant one starts", async () => {
	s = scenario("reload", "pi", { packages: [], recorder: true });
	const pi = await launched(s, "pi", "reply up");
	const first = pid(pi.id) as number;
	writeFileSync(join(s.project, "AGENTS.md"), "SWB-RELOAD-PI\n");
	s.swb("drive", "start", "--size", "160x40");
	await waitState(s, "ready", (x) => x.ready);
	await cursorTo(s, pi.id);
	await waitState(s, "the Stage on pi", (x) => x.staged.id === pi.id && x.staged.kind === "live");

	type(s, pi.id, `call swb_update_session {"reload":"continue"}`);
	// The pi it replaced started before AGENTS.md was written.
	await until(() => s.signal("reloaded.system").includes("SWB-RELOAD-PI"), ready, "the reloaded pi carrying on, on the new AGENTS.md");
	await restarted(pi.id, first, "pi restarted on its own conversation");
	expect(pane(s, pi.id)).toContain("This session restarts when this turn ends, then carries on.");
	expect(entry(s, pi.id).reload).toBeNull();
	// The Stage watching it follows it back, rather than staying on the card it showed while pi was down.
	await waitState(s, "the Stage back on the self-reloaded pi", (x) => x.staged.id === pi.id && x.staged.kind === "live");
	s.save("self-reload.txt", pane(s, pi.id));

	// R in the Deck restarts it at once, and it carries on from idle too.
	const second = pid(pi.id) as number;
	rmSync(join(s.home, "e2e-signals", "reloaded.system"));
	s.keys("R");
	await until(() => s.signal("reloaded.system") !== "", ready, "R's reload carrying on");
	await restarted(pi.id, second, "pi restarted by R");
	await waitState(s, "the Stage back on the restarted pi", (x) => x.staged.id === pi.id && x.staged.kind === "live");

	// Dormant, idle has nothing to restart; continue starts it to carry on. Archived, it's refused.
	s.tmux(s.servers.sessions, "kill-session", "-t", `=${host(s, pi.id)}`);
	await until(() => !entry(s, pi.id).live, budgets.settle, "pi dormant");
	expect(s.swb("reload", pi.id, "--idle")).toContain("isn't running");
	rmSync(join(s.home, "e2e-signals", "reloaded.system"));
	// A pi just started records idle before its carry-on turn starts, so idle alone can come before that turn.
	const prompted = () =>
		(s.query<{ at: number }>("select last_prompt_at as at from sessions where session_id = ?", pi.id)[0] as { at: number }).at;
	const before = prompted();
	expect(s.swb("reload", pi.id)).toContain("Started");
	await until(
		() => s.signal("reloaded.system") !== "" && prompted() > before && entry(s, pi.id).activity === "idle",
		ready,
		"the dormant pi's carry-on turn done",
	);
	s.swb("archive", pi.id);
	expect(s.swbTry("reload", pi.id)).toMatchObject({ code: 1, err: expect.stringContaining("archived") });
});

test("Claude Code and Codex told to continue restart mid-turn and pick it back up; told to wait, they restart once the turn ends, idle", async () => {
	s = scenario("reload", "claude-codex", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const [claude, codex] = await Promise.all([launched(s, "claude", "reply claude up"), launched(s, "codex", "reply codex up")]);

	type(s, claude.id, "hold c1");
	type(s, codex.id, "hold x1");
	await until(() => s.signal("c1.entered") !== "" && s.signal("x1.entered") !== "", ready, "both turns holding");
	writeFileSync(join(s.project, "CLAUDE.md"), "SWB-RELOAD-CLAUDE\n");
	writeFileSync(join(s.project, "AGENTS.md"), "SWB-RELOAD-CODEX\n");

	const claudePid = pid(claude.id) as number;
	expect(s.swb("reload", claude.id)).toContain("it carries on where it left off");
	await until(
		() =>
			s
				.requests("claude")
				.some((r) => String(r.prompt).includes("Continue where you left off") && JSON.stringify(r).includes("SWB-RELOAD-CLAUDE")),
		ready,
		"Claude Code continuing its turn, on the new CLAUDE.md",
	);
	await restarted(claude.id, claudePid, "Claude Code restarted");

	// Codex's turn runs on until it ends, and only then does Codex restart, waiting for its next prompt.
	const codexPid = pid(codex.id) as number;
	const proc = Bun.spawn([`${s.bin}/swb`, "update", "--from", claude.id], {
		env: s.env,
		cwd: s.project,
		stdin: new Blob([JSON.stringify({ session: codex.id, reload: "idle" })]),
		stdout: "pipe",
	});
	expect((JSON.parse(await proc.stdout.text()) as { text: string }).text).toContain("restarts when its turn ends.");
	expect(entry(s, codex.id).reload).toBe("idle");
	await Bun.sleep(2000);
	expect(pid(codex.id)).toBe(codexPid);
	const turn = prompted(codex.id);
	release(s, "x1");
	await restarted(codex.id, codexPid, "Codex restarted after its turn");
	await Bun.sleep(3000);
	expect(prompted(codex.id)).toBe(turn);
	expect(entry(s, codex.id).reload).toBeNull();
	type(s, codex.id, "reply after reload");
	await until(
		() =>
			s.requests("codex").some((r) => JSON.stringify(r).includes("reply after reload") && JSON.stringify(r).includes("SWB-RELOAD-CODEX")),
		ready,
		"Codex's next turn on the new AGENTS.md",
	);
	release(s, "c1");

	// Told to continue mid-turn, Codex restarts at once and picks the cut-off turn up from its own history, with no prompt:
	// its model reads the held tool call as aborted and answers it, though the hold was never released.
	await settled(s, codex.id, "Codex's turn after the reload");
	type(s, codex.id, "hold x2");
	await until(() => s.signal("x2.entered") !== "", ready, "Codex holding");
	const heldPid = pid(codex.id) as number;
	expect(s.swb("reload", codex.id)).toContain("it carries on where it left off");
	await restarted(codex.id, heldPid, "Codex restarted");
	await until(() => pane(s, codex.id).includes("released x2"), ready, "the restarted Codex finishing its cut-off turn");

	// Claude Code reloading itself to come back idle waits for its turn to end, then starts no turn of its own.
	await settled(s, claude.id, "Claude Code idle");
	const selfPid = pid(claude.id) as number;
	type(s, claude.id, `call swb_update_session {"reload":"idle"}`);
	await restarted(claude.id, selfPid, "Claude Code restarted after its own turn");
	const reloaded = prompted(claude.id);
	await Bun.sleep(3000);
	expect(prompted(claude.id)).toBe(reloaded);
	expect(s.requests("claude").some((r) => String(r.toolOutput).includes("This session restarts when this turn ends."))).toBe(true);
});
