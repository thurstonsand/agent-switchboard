import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, cursorTo, entry, piSessions, reply, seed, sessionRows, state, waitState } from "./harness/deck.ts";
import { alive, budgets, release, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;

afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
		s.save("final-tmux.txt", s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name} #{session_attached} #{@swb_kind}"));
	} catch {}
	await s.cleanup();
});

test("an idle, unviewed pi is reaped after reap_after with one SIGTERM, then SIGKILL when its shutdown hangs; the one on view is not", async () => {
	s = scenario("phase2", "reap");
	const [a, b] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	config(s, 'reap_after = "2s"\n');
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("w");
	await waitState(s, "a live", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	const pid = Number(s.tmux(s.servers.sessions, "display", "-p", "-t", `=${piSessions(s)[0]}:`, "#{pane_pid}"));
	writeFileSync(join(s.home, "e2e-signals", "shutdown.hold"), "");
	await cursorTo(s, b);
	s.keys("w");
	await waitState(s, "b live", (x) => x.staged.id === b && x.staged.kind === "live", budgets.piReady);
	await until(() => s.signal("shutdown.entered") !== "", 8000, "a's shutdown hung");
	await Bun.sleep(3000);
	expect(alive(pid)).toBe(true);
	await until(() => !alive(pid), 12_000, "a's pi killed");
	await until(() => !entry(s, a).live, budgets.settle, "a reaped");
	expect(s.signal("sigterm")).toBe(`${pid}\n`);
	expect(entry(s, b).live).toBe(true);
	expect(s.tmux(s.servers.sessions, "display", "-p", "-t", `=${piSessions(s)[0]}:`, "#{pane_in_mode}")).toBe("0");
	release(s, "shutdown");
	s.save("reaped.txt", `${s.screen()}\n${JSON.stringify(s.ls(), null, 2)}`);
});

test("a session is Visited by a focused second on its pi, not by the cursor passing over it", async () => {
	s = scenario("phase2", "visit");
	const [a, b] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	s.swb("drive", "start");
	await cursorTo(s, b);
	await Bun.sleep(1500);
	expect(entry(s, b).unseen).toBe(true);
	await cursorTo(s, a);
	s.keys("w");
	await waitState(s, "a live", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	await Bun.sleep(2000);
	expect(entry(s, a).unseen).toBe(true);
	expect(state(s).rows.find((r) => r.kind === "session" && r.id === a)).toMatchObject({ state: "unseen" });
	s.save("on-view-unseen.txt", s.screen());
	s.keys("Enter");
	await waitState(s, "pi focused", (x) => x.focus === "stage");
	await until(() => !entry(s, a).unseen, 3000, "a visited");
	expect(entry(s, b).unseen).toBe(true);
	s.save("visited.txt", `${s.screen()}\n${JSON.stringify(s.ls(), null, 2)}`);
});

test("u marks the session on view Unseen at once, through a turn and a move away, until a Visit comes back to it", async () => {
	s = scenario("phase2", "mark-unseen");
	const [a, b] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	const row = (st: ReturnType<typeof state>, id: string) => sessionRows(st).find((r) => r.id === id);
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("Enter");
	await waitState(s, "a focused", (x) => x.staged.id === a && x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await until(() => !entry(s, a).unseen, 3000, "a visited");
	s.keys("M-a", "u");
	await waitState(s, "a marked while on view", (x) => row(x, a)?.state === "unseen" && x.focus === "stage", 1000);
	s.save("marked-on-view.txt", s.screen());
	await reply(s, "meanwhile");
	await Bun.sleep(2500);
	expect(entry(s, a)).toMatchObject({ unseen: true, markedUnseen: true });
	expect(row(state(s), a)?.state).toBe("unseen");
	s.keys("M-a", "h");
	await waitState(s, "the roster", (x) => x.focus === "roster");
	await cursorTo(s, b);
	await waitState(s, "b staged", (x) => x.staged.id === b);
	expect(entry(s, a).unseen).toBe(true);
	await cursorTo(s, a);
	s.keys("Enter");
	await waitState(s, "a focused again", (x) => x.staged.id === a && x.focus === "stage");
	await until(() => !entry(s, a).unseen, 3000, "coming back visits a");
	s.keys("M-a", "u");
	await until(() => entry(s, a).markedUnseen, 1000, "a marked again");
	// From the roster, where no Visit can clear it instead.
	s.keys("M-a", "h");
	await waitState(s, "the roster", (x) => x.focus === "roster");
	s.keys("u");
	await until(() => !entry(s, a).unseen, 1000, "the mark taken off");
});

test("Enter, then a prompt typed in the Stage, shows working then idle in the roster", async () => {
	s = scenario("phase2", "working");
	const [a] = (await seed(s, { turns: ["a"] })) as [string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("Enter");
	await waitState(s, "a live with the keyboard", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	s.keys("-l", "hold w1", "Enter");
	await until(() => s.signal("w1.entered") !== "", budgets.settle, "the held turn");
	await waitState(s, "working", (x) => sessionRows(x).find((r) => r.id === a)?.state === "working");
	s.save("working.txt", s.screen());
	release(s, "w1");
	await waitState(s, "idle", (x) => sessionRows(x).find((r) => r.id === a)?.state === "idle");
	s.save("idle.txt", s.screen());
});
