import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, cursorTo, entry, piSessions, seed, sessionRows, state, waitState } from "./harness/deck.ts";
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
