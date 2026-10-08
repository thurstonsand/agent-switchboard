import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeckState, HeaderStateRow } from "../../packages/cli/src/deck/protocol.ts";
import { cursorTo, entry, headerRows, piSessions, reply, rowIndex, seed, sessionRows, state, terminal, waitState } from "./harness/deck.ts";
import { budgets, release, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
	} catch {}
	await s.cleanup();
});

test("a pi-sessions subagent and a deferred handoff never become Sessions, and the subagent runs on the default tmux server", async () => {
	s = scenario("phase5", "subagents", { packages: ["pi-sessions"], recorder: true });
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the parent live", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await reply(s, "parent");
	const [parent] = s.ls().map((e) => e.id) as [string];

	s.keys("-l", "subagent s1", "Enter");
	await until(() => s.signal("child.s1.entered") !== "", budgets.piReady, "the subagent's turn");
	// The sessions server keeps the caller's TMUX_TMPDIR, so "default" here is the scenario's own default server.
	const defaultServer = s.tmux("default", "list-sessions", "-F", "#{session_name}");
	expect(defaultServer).toMatch(/^pi-[0-9a-f]+$/m);
	expect(piSessions(s)).toHaveLength(1);
	expect(s.ls().map((e) => e.id)).toEqual([parent]);
	expect(sessionRows(state(s)).map((r) => r.id)).toEqual([parent]);
	s.save("subagent-running.txt", `${s.screen()}\n--- default tmux server\n${defaultServer}`);
	release(s, "child.s1");

	s.keys("-l", "deferred d1", "Enter");
	await until(() => s.screen().includes("tool done d1"), budgets.piReady, "the deferred handoff");
	const handoff = /--session-id '([^']+)'/.exec(s.screen())?.[1] as string;
	expect(s.screen()).toContain("session_handoff [deferred]");
	expect(handoff).toMatch(/^[0-9a-f-]{36}$/);
	// Time for the recorder to wrongly record the handoff's session, if it were going to.
	await Bun.sleep(1000);
	expect(s.query<{ id: string }>("select session_id as id from sessions").map((r) => r.id)).toEqual([parent]);
	expect(s.query("select 1 from runtimes where session_id = ?", handoff)).toHaveLength(0);
	expect(s.query("select 1 from runtimes")).toHaveLength(1);
	expect(sessionRows(state(s)).map((r) => r.id)).toEqual([parent]);
	s.save("deferred.txt", s.screen());
});

test("a Deck started inside another tmux works as in a bare terminal, M-a passing through it", async () => {
	s = scenario("phase5", "nested");
	const outer = terminal(s, "outer", "swb new");
	await outer.ready();
	await until(
		() => {
			const st = outer.state();
			return st.staged.kind === "live" && st.focus === "stage";
		},
		budgets.piReady,
		"pi live in the nested Deck",
	);
	outer.keys("-l", "reply nested", "Enter");
	await until(() => s.signal("replied.nested") !== "", budgets.settle, "the nested reply");
	outer.keys("M-a", "h");
	await until(() => outer.state().focus === "roster", budgets.settle, "the roster focused through the outer tmux");
	outer.keys("M-a", "z");
	await until(() => outer.state().layout.zoomed, budgets.settle, "pi zoomed");
	await until(() => outer.screen().includes("nested"), budgets.settle, "pi on screen");
	s.save("nested.txt", outer.screen());
	outer.keys("M-a", "z", "M-a", "h");
	await until(
		() => {
			const st = outer.state();
			return st.focus === "roster" && !st.layout.zoomed;
		},
		budgets.settle,
		"back in the roster",
	);
	outer.keys("q");
	await until(() => s.swbTry("deck", "state").code !== 0, budgets.settle, "the Deck closed");
	expect(s.ls()[0]?.live).toBe(true);
});

test("a narrow terminal shows one pane at a time: Enter shows pi, M-a h returns to the roster", async () => {
	s = scenario("phase5", "narrow");
	const [a] = (await seed(s, { turns: ["narrow-one"] })) as [string];
	s.swb("drive", "start", "--size", "60x20");
	await waitState(s, "roster alone", (x) => x.layout.rosterOnly);
	await cursorTo(s, a);
	s.save("roster.txt", s.screen());
	s.keys("Enter");
	await waitState(s, "pi zoomed and focused", (x) => x.staged.kind === "live" && x.focus === "stage" && x.layout.zoomed, budgets.piReady);
	await until(() => s.screen().includes("narrow-one"), budgets.settle, "pi filling the terminal");
	s.save("pi.txt", s.screen());
	s.keys("M-a", "h");
	await waitState(s, "roster again", (x) => x.focus === "roster");
	await until(() => !s.screen().includes("narrow-one"), budgets.settle, "only the roster");
	s.save("back.txt", s.screen());
	s.keys("Enter");
	await waitState(s, "pi again", (x) => x.focus === "stage");
	s.keys("M-a", "z");
	await waitState(s, "M-a z back to the roster", (x) => x.focus === "roster");
	await until(() => !s.screen().includes("narrow-one"), budgets.settle, "only the roster after M-a z");
	s.swb("drive", "resize", "40x15");
	await waitState(s, "still roster-only", (x) => x.layout.width === 40 && x.layout.rosterOnly);
	await until(() => s.screen().includes("▸ Archived"), budgets.settle, "the roster repainted at 40 columns");
	s.save("40-cols.txt", s.screen());
	s.swb("drive", "resize", "140x40");
	await waitState(s, "both panes again", (x) => !x.layout.rosterOnly && !x.layout.zoomed);
	await until(() => s.screen().includes("narrow-one") && s.screen().includes(" swb "), budgets.settle, "roster and pi side by side");
	s.save("widened.txt", s.screen());
});

test("three Decks stay in sync: a wake, an archive, and a new session in one show in the others", async () => {
	s = scenario("phase5", "three-decks");
	const [a, b] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	s.swb("drive", "start");
	const two = terminal(s, "two", "swb");
	const three = terminal(s, "three", `swb open ${b}`);
	await two.ready();
	await three.ready();
	await until(() => three.state().cursor === b, budgets.settle, "Deck three on b");
	const rowState = (st: DeckState, id: string) => sessionRows(st).find((r) => r.id === id)?.state;

	await cursorTo(s, a);
	s.keys("w");
	await waitState(s, "a live", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	await until(
		() => rowState(two.state(), a) === "idle" && rowState(three.state(), a) === "idle",
		budgets.settle,
		"a live and seen everywhere",
	);

	three.keys("a");
	await waitState(s, "b gone from the drive Deck", (x) => rowIndex(x, b) === -1);
	await until(() => rowIndex(two.state(), b) === -1, budgets.settle, "b gone from Deck two");
	const archived = (st: DeckState) => st.rows.find((r) => r.kind === "section" && r.label === "Archived");
	for (const st of [state(s), two.state(), three.state()]) expect(archived(st)).toMatchObject({ count: 1 });

	two.keys("n");
	await until(() => sessionRows(two.state()).some((r) => r.provisional), budgets.piReady, "a new pi in Deck two");
	await waitState(s, "the new pi in the drive Deck", (x) => sessionRows(x).some((r) => r.provisional));
	await until(() => sessionRows(three.state()).some((r) => r.provisional), budgets.settle, "the new pi in Deck three");
	s.save("drive.txt", s.screen());
	s.save("two.txt", two.screen());
	s.save("three.txt", three.screen());
	expect(new Set([state(s).deck, two.deck(), three.deck()]).size).toBe(3);
});

test("a plain tmux attach shares a session with the Deck staging it, and detaching leaves it live", async () => {
	s = scenario("phase5", "shared-viewer");
	const [a] = (await seed(s, { turns: ["shared"] })) as [string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("w");
	const up = await waitState(s, "a live", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	const host = up.staged.host as string;
	const viewer = terminal(s, "viewer", `env -u TMUX tmux -L ${s.servers.sessions} attach -t =${host}`, "120x35");
	await until(() => viewer.screen().includes("shared"), budgets.settle, "the conversation in the viewer");
	expect(s.tmux(s.servers.sessions, "display", "-p", "-t", `=${host}:`, "#{session_attached}")).toBe("2");
	viewer.keys("-l", "reply from-the-viewer", "Enter");
	await until(() => s.signal("replied.from-the-viewer") !== "", budgets.settle, "the viewer's turn");
	await until(() => s.screen().includes("from-the-viewer"), budgets.settle, "the turn on the Deck's Stage");
	s.save("viewer.txt", viewer.screen());
	s.save("deck.txt", s.screen());

	s.tmux(viewer.server, "kill-server");
	await until(
		() => s.tmux(s.servers.sessions, "display", "-p", "-t", `=${host}:`, "#{session_attached}") === "1",
		budgets.settle,
		"one viewer left",
	);
	expect(entry(s, a).live).toBe(true);
	expect(state(s).staged).toMatchObject({ id: a, kind: "live", host });
	await until(() => !s.screen().includes("····"), budgets.settle, "the Stage back to its full size");
	s.save("deck-after.txt", s.screen());
});

test("a pi that dies before it's ready shows Failed to start, and w retries once pi works again", async () => {
	s = scenario("phase5", "failed-start");
	const [a] = (await seed(s, { turns: ["fails"] })) as [string];
	const pi = join(s.bin, "pi");
	const script = readFileSync(pi, "utf8");
	writeFileSync(pi, "#!/bin/sh\necho 'pi: broken on purpose' >&2\nexit 1\n");
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("w");
	const failed = await waitState(s, "failed", (x) => x.staged.kind === "failed", budgets.piReady);
	expect(failed.toasts).toContainEqual({ text: "pi failed to start: pi: broken on purpose", level: "error" });
	await until(() => s.screen().includes("Failed to start"), budgets.settle, "the failed card");
	expect(s.screen()).toContain("pi: broken on purpose");
	expect(entry(s, a).live).toBe(false);
	expect(piSessions(s)).toHaveLength(0);
	s.save("failed.txt", s.screen());

	writeFileSync(pi, script);
	s.keys("w");
	const retried = await waitState(s, "a live after the retry", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	const remain = () => s.tmux(s.servers.sessions, "show", "-p", "-v", "-t", `=${retried.staged.host}:`, "remain-on-exit");
	await until(() => remain() === "", budgets.settle, "remain-on-exit cleared once pi registered");
	s.save("retried.txt", s.screen());
});

test("200 cursor moves render at a median under 16 ms from key to frame", async () => {
	s = scenario("phase5", "perf");
	await seed(s, { turns: ["p1"] }, { turns: ["p2"] }, { turns: ["p3"] });
	s.swb("drive", "start");
	const before = state(s).perf.keyToFrame.n;
	s.swb("drive", "keys", "--delay", "50", ...Array.from({ length: 200 }, (_, i) => (i % 4 < 2 ? "j" : "k")));
	const st = await waitState(s, "200 frames", (x) => x.perf.keyToFrame.n - before >= 200);
	s.save("perf.json", JSON.stringify(st.perf, null, 2));
	expect(st.perf.keyToFrame.medianMs).toBeLessThan(16);
});

test("roster navigation: h l space and a header click fold projects; g G jump; M-a Tab z ? and q", async () => {
	s = scenario("phase5", "navigation");
	await seed(s, { turns: ["here"] });
	const other = join(s.root, "other");
	mkdirSync(other);
	s.swb("drive", "start", "--", "new", "--cwd", other);
	await waitState(s, "other live", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await reply(s, "there");
	s.keys("M-a", "h");
	await waitState(s, "roster focus", (x) => x.focus === "roster");
	const b = s.ls().find((e) => e.cwd === other)?.id as string;

	const header = (project: string) => (x: DeckState) => headerRows(x).find((r) => r.project.endsWith(project));
	s.keys("g");
	const top = await waitState(s, "cursor on the first header", (x) => x.cursor === null);
	const first = headerRows(top)[0] as HeaderStateRow;
	expect(top.rows[0]).toEqual(first);
	s.keys("h");
	await waitState(s, "first project folded", (x) => header(first.project)(x)?.expanded === false);
	s.keys("l");
	await waitState(s, "first project open", (x) => header(first.project)(x)?.expanded === true);
	s.keys("Space");
	await waitState(s, "folded by space", (x) => header(first.project)(x)?.expanded === false);
	s.keys("Space");
	await waitState(s, "open by space", (x) => header(first.project)(x)?.expanded === true);

	s.keys("G");
	const bottom = await waitState(s, "cursor on the Archived section", (x) => x.cursor === null && x.rows.at(-1)?.kind === "section");
	s.keys("k");
	await waitState(s, "cursor on the last session", (x) => x.cursor === sessionRows(bottom).at(-1)?.id);

	const otherLine = s
		.screen()
		.split("\n")
		.findIndex((line) => line.includes("▾ other"));
	expect(otherLine).toBeGreaterThan(-1);
	s.swb("drive", "click", "3", String(otherLine));
	await waitState(s, "other folded by a click", (x) => header("other")(x)?.expanded === false);
	s.save("folded.txt", s.screen());
	s.swb("drive", "click", "3", String(otherLine));
	await waitState(s, "other open by a click", (x) => header("other")(x)?.expanded === true);
	// Two clicks on one cell are a double click, which tmux holds back to rule out a triple; firing late, it resets a
	// prefix pressed in the meantime.
	await Bun.sleep(500);

	await cursorTo(s, b);
	await waitState(s, "b live on the Stage", (x) => x.staged.id === b && x.staged.kind === "live");
	s.keys("M-a", "Tab");
	await waitState(s, "Tab to pi", (x) => x.focus === "stage");
	s.keys("M-a", "Tab");
	await waitState(s, "Tab back", (x) => x.focus === "roster");
	s.keys("M-a", "z");
	await waitState(s, "pi zoomed from the list", (x) => x.layout.zoomed && x.focus === "stage");
	s.keys("M-a", "z");
	await waitState(s, "unzoomed", (x) => !x.layout.zoomed);
	s.keys("M-a", "?");
	await until(() => s.screen().includes("any key closes"), budgets.settle, "the key help");
	s.save("help.txt", s.screen());
	s.keys("x");
	await until(() => !s.screen().includes("any key closes"), budgets.settle, "help closed");
	s.keys("M-a", "h");
	await waitState(s, "roster", (x) => x.focus === "roster");
	s.keys("q");
	await until(() => s.swbTry("drive", "state").code !== 0, budgets.settle, "the Deck closed");
	expect(s.ls().find((e) => e.id === b)?.live).toBe(true);
});

test("n in an empty Deck, and on a section row, starts a session where swb was run", async () => {
	s = scenario("phase6", "n-here");
	s.swb("drive", "start");
	await waitState(s, "an empty roster", (x) => x.ready && x.cursor === null);
	s.keys("n");
	const first = await waitState(s, "n's pi live", (x) => x.staged.kind === "live" && x.staged.id !== null, budgets.piReady);
	s.keys("M-a", "h");
	await waitState(s, "roster focus", (x) => x.focus === "roster");
	s.keys("G");
	await waitState(s, "cursor on the Archived section", (x) => x.rows[x.cursorRow]?.kind === "section");
	s.keys("n");
	const second = await waitState(
		s,
		"a second pi live",
		(x) => x.staged.kind === "live" && x.staged.id !== null && x.staged.id !== first.staged.id,
		budgets.piReady,
	);
	s.save("n-here.txt", s.screen());
	const cwds = () => s.query<{ cwd: string }>("select cwd from runtimes order by started_at").map((r) => r.cwd);
	await until(() => cwds().length === 2, budgets.settle, "both pis registered");
	expect(cwds()).toEqual([s.project, s.project]);
	expect(second.focus).toBe("stage");
});
