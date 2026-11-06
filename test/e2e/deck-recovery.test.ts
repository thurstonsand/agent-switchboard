import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cursorTo, entry, piSessions, seed, state, waitState } from "./harness/deck.ts";
import { alive, budgets, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;

afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
		s.save("final-tmux.txt", s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name} #{session_attached} #{@swb_kind}"));
	} catch {}
	await s.cleanup();
});

test("closing the Deck's terminal leaves the Deck and its roster for the next swb, which starts a dead or outdated roster afresh in its pane", async () => {
	s = scenario("phase2", "close");
	s.swb("drive", "start");
	const sock = join(s.env.XDG_STATE_HOME as string, "agent-switchboard/deck.sock");
	expect(existsSync(sock)).toBe(true);
	const roster = () => s.tmux(s.servers.ui, "show", "-qv", "-t", "deck", "@swb_roster");
	const rosterPid = () => Number(s.tmux(s.servers.ui, "display", "-p", "-t", roster(), "#{pane_pid}"));
	const first = rosterPid();
	s.swb("drive", "stop");
	await Bun.sleep(500);
	expect(alive(first)).toBe(true);
	expect(existsSync(sock)).toBe(true);
	expect(s.tmux(s.servers.sessions, "list-sessions", "-F", "#{@swb_kind}").split("\n")).toContain("placeholder");
	s.swb("drive", "start");
	expect(rosterPid()).toBe(first);
	// Hiding and showing the roster moves the Stage into the roster's window; the next roster still finds it.
	s.keys("M-a", "z");
	await waitState(s, "the roster hidden", (x) => x.layout.rosterHidden);
	s.keys("M-a", "z");
	await waitState(s, "the roster shown", (x) => !x.layout.rosterHidden);

	s.swb("drive", "stop");
	process.kill(first, "SIGKILL");
	await until(
		() => s.tmux(s.servers.ui, "display", "-p", "-t", roster(), "#{pane_dead}") === "1",
		budgets.settle,
		"the roster's pane dead",
	);
	s.swb("drive", "start");
	const second = rosterPid();
	expect(second).not.toBe(first);
	expect(alive(second)).toBe(true);

	s.swb("drive", "stop");
	const [version] = s.tmux(s.servers.ui, "show", "-qv", "-t", "deck", "@swb_roster_build").split(":");
	s.tmux(s.servers.ui, "set", "-t", "deck", "@swb_roster_build", `${version}:0`);
	s.swb("drive", "start");
	expect(rosterPid()).not.toBe(second);
	await until(() => !alive(second), budgets.settle, "the outdated roster gone");
	expect(existsSync(sock)).toBe(true);
	expect(state(s).ready).toBe(true);
});

test("a roster killed while its wake waits on the launch lock doesn't wedge later wakes", async () => {
	s = scenario("phase2", "killed-waker");
	const [a] = (await seed(s, { turns: ["a"] })) as [string];
	s.swb("drive", "start");
	s.swb("drive", "stop");
	// The close after the sleep keeps the connection reachable: one collected mid-sleep closes, and its lock goes with it.
	const holder = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const d = new (require("bun:sqlite").Database)(${JSON.stringify(s.dbFile)}); d.run("PRAGMA busy_timeout = 5000"); d.run("BEGIN IMMEDIATE"); console.log("held"); await Bun.sleep(60000); d.close();`,
		],
		{ stdout: "pipe" },
	);
	try {
		const { value } = await holder.stdout.getReader().read();
		expect(new TextDecoder().decode(value)).toContain("held");
		s.swb("drive", "start");
		await cursorTo(s, a);
		s.keys("w");
		await waitState(s, "loading", (x) => x.staged.kind === "loading", 2000);
		const rosterPid = Number(s.tmux(s.servers.ui, "display", "-p", "-t", "=deck:.0", "#{pane_pid}"));
		process.kill(rosterPid, "SIGKILL");
		await until(() => !alive(rosterPid), budgets.settle, "the roster gone");
	} finally {
		holder.kill();
		await holder.exited;
	}
	s.swbTry("drive", "stop");
	expect(piSessions(s)).toHaveLength(0);
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("w");
	await waitState(s, "a live", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	expect(piSessions(s)).toHaveLength(1);
	s.save("woke-after-kill.txt", s.screen());
});

test("the sessions server killed under an open Deck recovers on the next w", async () => {
	s = scenario("phase2", "server-killed");
	const [a] = (await seed(s, { turns: ["a"] })) as [string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.tmux(s.servers.sessions, "kill-server");
	await until(() => s.screen().includes("⏎ wake"), budgets.settle, "the dormant card back on the Stage");
	s.save("killed.txt", s.screen());
	s.keys("w");
	await waitState(s, "a live again", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	expect(entry(s, a).live).toBe(true);
	s.save("recovered.txt", s.screen());
});
