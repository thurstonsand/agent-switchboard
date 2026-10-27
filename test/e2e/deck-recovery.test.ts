import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DeckState } from "../../packages/cli/src/deck/protocol.ts";
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

test("closing the Deck's terminal destroys the Deck, its roster, its placeholder, and its socket", async () => {
	s = scenario("phase2", "close");
	s.swb("drive", "start");
	const { deck } = state(s);
	const sock = join(s.env.XDG_STATE_HOME as string, "agent-switchboard/decks", `${deck}.sock`);
	expect(existsSync(sock)).toBe(true);
	const rosterPid = Number(s.tmux(s.servers.ui, "display", "-p", "-t", `=${deck}:.0`, "#{pane_pid}"));
	s.swb("drive", "stop");
	await until(
		() => !s.tmux(s.servers.ui, "list-sessions", "-F", "#{session_name}").includes(deck),
		budgets.settle,
		"the Deck session gone",
	);
	// Flaky in CI only. Whether the roster outlived it tells a cleanup that never ran from one that died partway.
	await until(() => !existsSync(sock), budgets.settle, "the socket gone").catch((error: Error) => {
		throw new Error(`${error.message}; the roster ${alive(rosterPid) ? "is still running" : "has exited"}`);
	});
	await until(
		() => !s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name}").includes(deck),
		budgets.settle,
		"the placeholder gone",
	);
	await until(() => !alive(rosterPid), budgets.settle, "the roster process gone");
	expect(s.swbTry("deck", "state").err).toContain("no live deck");
});

test("two Decks waking one session start exactly one pi", async () => {
	s = scenario("phase2", "two-decks");
	const [a] = (await seed(s, { turns: ["a"] })) as [string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	const other = `swb-other-${s.instance}`;
	s.tmux(other, "new-session", "-d", "-s", "other", "-x", "140", "-y", "40", "-c", s.project, join(s.bin, "swb"));
	const decks = await until(
		() => {
			const err = s.swbTry("deck", "state").err;
			const m = /several live decks \(([^)]+)\)/.exec(err);
			return m ? (m[1] as string).split(", ") : false;
		},
		budgets.deckReady,
		"the second Deck",
	);
	const mine = state(s).deck;
	const theirs = decks.find((d) => d !== mine) as string;
	const theirState = () => JSON.parse(s.swb("deck", "state", "--deck", theirs, "--json")) as DeckState;
	await until(() => theirState().ready && theirState().cursor === a, budgets.deckReady, "the second Deck, its cursor on a");
	s.tmux(s.servers.drive, "send-keys", "-t", "=drive:", "w");
	s.tmux(other, "send-keys", "-t", "=other:", "w");
	await waitState(s, "live in mine", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	await until(() => theirState().staged.kind === "live", budgets.piReady, "live in theirs");
	expect(piSessions(s)).toHaveLength(1);
	expect(s.ls().filter((e) => e.live)).toHaveLength(1);
	s.save("mine.txt", s.screen());
	s.save("theirs.txt", s.tmux(other, "capture-pane", "-p", "-t", "=other:"));
});

test("a Deck killed while its wake waits on the launch lock doesn't wedge later wakes", async () => {
	s = scenario("phase2", "killed-waker");
	const [a] = (await seed(s, { turns: ["a"] })) as [string];
	// The close after the sleep keeps the connection reachable: one collected mid-sleep closes, and its lock goes with it.
	const holder = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const d = new (require("bun:sqlite").Database)(${JSON.stringify(s.dbFile)}); d.run("BEGIN IMMEDIATE"); console.log("held"); await Bun.sleep(60000); d.close();`,
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
		const rosterPid = Number(s.tmux(s.servers.ui, "display", "-p", "-t", `=${state(s).deck}:.0`, "#{pane_pid}"));
		process.kill(rosterPid, "SIGKILL");
		await until(() => !alive(rosterPid), budgets.settle, "the roster gone");
	} finally {
		holder.kill();
		await holder.exited;
	}
	s.swbTry("drive", "stop");
	expect(piSessions(s)).toHaveLength(0);
	s.swbTry("deck", "state");
	expect(s.tmux(s.servers.sessions, "list-sessions", "-F", "#{@swb_kind}").split("\n")).not.toContain("placeholder");
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
