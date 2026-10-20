import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeckState, HeaderStateRow } from "../../packages/cli/src/deck/protocol.ts";
import { VERSION } from "../../packages/cli/src/version.ts";
import {
	cursorTo,
	entry,
	headerRows,
	pickNew,
	piSessions,
	reply,
	rowIndex,
	seed,
	sessionRows,
	state,
	terminal,
	waitState,
} from "./harness/deck.ts";
import { alive, budgets, release, repo, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
	} catch {}
	await s.cleanup();
});

test("a pi-sessions subagent never becomes a Session and runs on the default tmux server; swb's tools replace pi-sessions' peer tools", async () => {
	s = scenario("phase5", "subagents", { packages: ["pi-sessions"], recorder: true });
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the parent live", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await reply(s, "parent");
	const [parent] = s.ls().map((e) => e.id) as [string];

	s.keys("-l", "tools", "Enter");
	await until(() => s.signal("tools") !== "", budgets.settle, "the tool list");
	const tools = JSON.parse(s.signal("tools")) as string[];
	for (const name of ["session_reachable", "session_send_message", "session_cancel", "session_launch", "swb_update_session"])
		expect(tools).toContain(name);
	for (const name of ["subagent_list", "subagent_send", "subagent_cancel", "subagent_launch"]) expect(tools).toContain(name);
	expect(tools).not.toContain("session_handoff");

	s.keys("-l", "subagent s1", "Enter");
	await until(() => s.signal("child.s1.entered") !== "", budgets.piReady, "the subagent's turn");
	// The sessions server keeps the caller's TMUX_TMPDIR, so "default" here is the scenario's own default server.
	const defaultServer = s.tmux("default", "list-sessions", "-F", "#{session_name}");
	expect(defaultServer).toMatch(/^pi-[0-9a-f]+$/m);
	expect(piSessions(s)).toHaveLength(1);
	expect(s.ls().map((e) => e.id)).toEqual([parent]);
	expect(sessionRows(state(s)).map((r) => r.id)).toEqual([parent]);
	expect(s.query("select 1 from runtimes")).toHaveLength(1);
	s.save("subagent-running.txt", `${s.screen()}\n--- default tmux server\n${defaultServer}`);
	release(s, "child.s1");
});

test("session_launch starts a managed pi Session that records its parent, and messaging it while dormant wakes it", async () => {
	s = scenario("phase5", "swb-host", { packages: ["pi-sessions"], recorder: true });
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the parent live", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await reply(s, "parent");
	const [parent] = s.ls().map((e) => e.id) as [string];

	s.keys("-l", "handoff h1", "Enter");
	await until(() => s.signal("child.h1.entered") !== "", budgets.piReady, "the handoff child's first turn");
	const child = await until(() => s.ls().find((e) => e.id !== parent), budgets.settle, "the child tracked");
	expect(child).toMatchObject({ harness: "pi", parentId: parent, open: true, live: true, cwd: s.project });
	await until(() => entry(s, child.id).title === "child h1", budgets.settle, "the child titled");
	expect(piSessions(s)).toHaveLength(2);
	await waitState(s, "the child on the Roster", (x) => sessionRows(x).some((r) => r.id === child.id));
	s.save("handoff-running.txt", s.screen());
	// pi to pi, mid-turn: the message steers the child's held turn, which answers it once released.
	s.keys("-l", `message ${child.id} m1`, "Enter");
	await until(
		() => s.query("select 1 from messages where target_id = ? and delivered_at is not null", child.id).length === 1,
		budgets.settle,
		"the message delivered mid-turn",
	);
	expect(entry(s, child.id).activity).toBe("working");
	release(s, "child.h1");
	await until(() => s.signal("replied.m1") !== "", budgets.settle, "the child's answer to the steer");
	await until(() => entry(s, child.id).activity === "idle", budgets.settle, "the child idle");
	// And idle: the message starts the child's next turn.
	s.keys("-l", `message ${child.id} i1`, "Enter");
	await until(() => s.signal("replied.i1") !== "", budgets.settle, "the idle child's answer");
	await until(() => entry(s, child.id).activity === "idle", budgets.settle, "the child idle again");

	const host = s.query<{ tmux_session: string }>("select tmux_session from runtimes where session_id = ?", child.id)[0]?.tmux_session;
	s.tmux(s.servers.sessions, "kill-session", "-t", `=${host}`);
	await until(() => !entry(s, child.id).live, budgets.settle, "the child dormant");
	s.keys("-l", `message ${child.id} w1`, "Enter");
	await until(() => s.signal("replied.w1") !== "", budgets.piReady, "the woken child's reply");
	expect(entry(s, child.id)).toMatchObject({ open: true, live: true });
	expect(piSessions(s)).toHaveLength(2);
	s.save("woken.txt", `${s.screen()}\n${JSON.stringify(s.ls(), null, 2)}`);

	await until(() => entry(s, child.id).activity === "idle", budgets.settle, "the woken child idle");

	// A clean quit closes the pane of a child no Deck started, as it does one a Deck did.
	const woken = s.query<{ tmux_session: string }>("select tmux_session from runtimes where session_id = ?", child.id)[0]
		?.tmux_session as string;
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${woken}:`, "-l", "archive a1");
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${woken}:`, "Enter");
	await until(() => !entry(s, child.id).open && !entry(s, child.id).live, budgets.settle, "the child archived and quit");
	await until(
		() => !s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name}").split("\n").includes(woken),
		budgets.settle,
		"the child's pane closed",
	);
	s.swb("unarchive", child.id);
	s.keys("-l", `message ${child.id} w2`, "Enter");
	await until(() => s.signal("replied.w2") !== "", budgets.piReady, "the unarchived child woken");
	expect(entry(s, child.id)).toMatchObject({ open: true, live: true });
	await until(() => entry(s, child.id).activity === "idle", budgets.settle, "the rewoken child idle");
	s.swb("archive", child.id);
	expect(s.swbTry("wake", child.id).err.trim()).toBe(`swb: wake: ${child.id} is archived; swb unarchive ${child.id}`);
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
	await until(() => outer.state().layout.rosterHidden, budgets.settle, "the roster hidden");
	await until(() => outer.screen().includes("nested"), budgets.settle, "pi on screen");
	s.save("nested.txt", outer.screen());
	outer.keys("M-a", "z", "M-a", "h");
	await until(
		() => {
			const st = outer.state();
			return st.focus === "roster" && !st.layout.rosterHidden;
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
	await waitState(s, "pi zoomed and focused", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
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
	await waitState(s, "both panes again", (x) => !x.layout.rosterOnly && !x.layout.rosterHidden);
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
	s.keys("Enter");
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

	await pickNew(s, ["n"], two);
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

test("a pi that dies before it's ready says failed to start, and w retries once pi works again", async () => {
	s = scenario("phase5", "failed-start");
	const [a] = (await seed(s, { turns: ["fails"] })) as [string];
	const pi = join(s.bin, "pi");
	const script = readFileSync(pi, "utf8");
	writeFileSync(pi, "#!/bin/sh\necho 'pi: broken on purpose' >&2\nexit 1\n");
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("w");
	const failed = await waitState(s, "failed", (x) => x.staged.kind === "failed", budgets.piReady);
	expect(failed.toasts).toEqual([]);
	await until(() => s.screen().includes("pi quit before it was ready"), budgets.settle, "the failed card");
	expect(s.screen().split("pi: broken on purpose")).toHaveLength(2);
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
	// Keys landing between two renders share one frame, so wait for the count to settle rather than for exactly 200.
	let last = { n: -1, at: 0 };
	const st = await waitState(
		s,
		"frames to settle",
		(x) => {
			if (x.perf.keyToFrame.n !== last.n) last = { n: x.perf.keyToFrame.n, at: Date.now() };
			return Date.now() - last.at >= 500;
		},
		20_000,
	);
	s.save("perf.json", JSON.stringify({ frames: st.perf.keyToFrame.n - before, perf: st.perf }, null, 2));
	expect(st.perf.keyToFrame.n - before).toBeGreaterThanOrEqual(150);
	expect(st.perf.keyToFrame.medianMs).toBeLessThan(16);
});

test("roster navigation: h l space and a header click fold projects; g G jump; M-a Tab z ? and q", async () => {
	s = scenario("phase5", "navigation");
	const [here] = (await seed(s, { turns: ["here"] })) as [string];
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
	const top = await waitState(s, "cursor on the Operators section", (x) => x.cursorRow === 0);
	expect(top.rows[0]).toMatchObject({ kind: "section", label: "Operators", count: 0 });
	s.keys("j");
	const first = headerRows(top)[0] as HeaderStateRow;
	expect(top.rows[1]).toEqual(first);
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
	s.swb("drive", "click", "6", String(otherLine + 1));
	await waitState(s, "one click on b focuses its pi", (x) => x.focus === "stage" && x.staged.id === b);
	await Bun.sleep(500);
	s.keys("M-a", "h");
	await waitState(s, "back to the roster", (x) => x.focus === "roster");
	s.keys("M-a", "Tab");
	await waitState(s, "Tab to pi", (x) => x.focus === "stage");
	s.keys("M-a", "Tab");
	await waitState(s, "Tab back", (x) => x.focus === "roster");
	s.keys("M-a", "z");
	await waitState(s, "the roster hidden from the list, pi focused", (x) => x.layout.rosterHidden && x.focus === "stage");
	s.keys("M-a", "z");
	await waitState(s, "the roster back, pi still focused", (x) => !x.layout.rosterHidden && x.focus === "stage");
	s.keys("M-a", "J");
	await waitState(
		s,
		"M-a J stages here, below b, keys stay on pi",
		(x) => x.cursor === here && x.staged.id === here && x.focus === "stage",
	);
	s.keys("M-a", "K");
	await waitState(s, "M-a K stages b again", (x) => x.cursor === b && x.staged.id === b && x.focus === "stage");
	// The roster has no pane above or below it, so there M-a j and k move between sessions as J and K do.
	s.keys("M-a", "h");
	await waitState(s, "the roster", (x) => x.focus === "roster");
	s.keys("M-a", "j");
	await waitState(s, "M-a j in the roster stages here, below b", (x) => x.cursor === here && x.staged.id === here && x.focus === "roster");
	s.keys("M-a", "k");
	await waitState(s, "M-a k in the roster stages b again", (x) => x.cursor === b && x.staged.id === b && x.focus === "roster");
	s.keys("M-a", "l");
	await waitState(s, "pi again", (x) => x.focus === "stage");
	const lines = s.screen().split("\n");
	const hint = lines.findIndex((line) => line.includes("hide list"));
	expect(hint).toBeGreaterThan(-1);
	s.swb("drive", "click", String((lines[hint] as string).indexOf("hide list")), String(hint));
	await waitState(s, "the legend's hide list clicked", (x) => x.layout.rosterHidden);
	s.keys("M-a", "z");
	await waitState(s, "the roster back", (x) => !x.layout.rosterHidden);
	s.keys("M-a", "?");
	await until(() => s.screen().includes("any key or click closes"), budgets.settle, "the key help");
	s.save("help.txt", s.screen());
	s.keys("x");
	await until(() => !s.screen().includes("any key or click closes"), budgets.settle, "help closed");
	s.keys("M-a", "h");
	await waitState(s, "roster", (x) => x.focus === "roster");
	s.keys("q");
	await until(() => s.swbTry("drive", "state").code !== 0, budgets.settle, "the Deck closed");
	expect(s.ls().find((e) => e.id === b)?.live).toBe(true);
});

test("n and M-a n open the picker on the highlighted session's directory, before its first prompt too, and Enter starts there", async () => {
	s = scenario("phase6", "n-cursor");
	// The scenario's root is already its real path.
	const elsewhere = join(s.home, "elsewhere");
	mkdirSync(elsewhere);
	s.swb("drive", "start", "--", "new", "--cwd", elsewhere);
	const away = await waitState(s, "a pi elsewhere", (x) => x.staged.kind === "live" && x.staged.id !== null, budgets.piReady);
	await pickNew(s, ["M-a", "n"]);
	const beside = await waitState(
		s,
		"M-a n from pi starts a second",
		(x) => x.staged.kind === "live" && x.staged.id !== null && x.staged.id !== away.staged.id,
		budgets.piReady,
	);
	expect(beside.focus).toBe("stage");
	s.keys("M-a", "h");
	await waitState(s, "roster focus", (x) => x.focus === "roster");
	await cursorTo(s, away.staged.id as string);
	await pickNew(s);
	const third = await waitState(
		s,
		"n on the elsewhere row",
		(x) => x.staged.kind === "live" && x.staged.id !== null && x.staged.id !== away.staged.id && x.staged.id !== beside.staged.id,
		budgets.piReady,
	);
	s.save("n-cursor.txt", s.screen());
	const cwdOf = (id: string | null) => s.query<{ cwd: string }>("SELECT cwd FROM runtimes WHERE session_id = ?", id)[0]?.cwd;
	expect([away, beside, third].map((x) => cwdOf(x.staged.id))).toEqual([elsewhere, elsewhere, elsewhere]);
});

test("a newer swb takes over: idle pis stop, a working one keeps its turn, and empty servers restart; an older swb leaves a newer server alone and its Deck says so", async () => {
	s = scenario("phase5", "upgrade");
	const { sessions, ui } = s.servers;
	const [a, b] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	s.swb("wake", a);
	s.swb("wake", b);
	await until(() => entry(s, a).live && entry(s, b).live, budgets.piReady, "both live");
	const hostOf = (id: string) =>
		s.query<{ tmux_session: string }>("SELECT tmux_session FROM runtimes WHERE session_id = ?", id)[0]?.tmux_session;
	const [hostA, hostB] = [hostOf(a), hostOf(b)] as [string, string];
	const draft = join(s.env.XDG_STATE_HOME as string, "agent-switchboard", "drafts", a);
	s.tmux(sessions, "send-keys", "-t", `=${hostA}:`, "-l", "half a thought");
	await until(
		() => s.tmux(sessions, "capture-pane", "-p", "-t", `=${hostA}:`).includes("half a thought"),
		budgets.settle,
		"a's draft typed",
	);
	s.tmux(sessions, "send-keys", "-t", `=${hostB}:`, "-l", "hold u1");
	s.tmux(sessions, "send-keys", "-t", `=${hostB}:`, "Enter");
	await until(() => s.signal("u1.entered") !== "", budgets.piReady, "b mid-turn");
	const names = (server: string) => s.tmux(server, "list-sessions", "-F", "#{session_name}").split("\n");
	const pid = (server: string) => s.tmux(server, "display", "-p", "#{pid}");

	for (const server of [sessions, ui]) s.tmux(server, "set", "-gu", "@swb_version");
	const uiBefore = pid(ui);
	s.swb("drive", "start");
	await waitState(s, "the Deck up", (x) => sessionRows(x).length === 2);
	expect(names(sessions)).not.toContain(hostA);
	expect(names(sessions)).toContain(hostB);
	expect(entry(s, a).live).toBe(false);
	await until(() => existsSync(draft) && readFileSync(draft, "utf8") === "half a thought", budgets.settle, "a's draft saved");
	expect(entry(s, b).activity).toBe("working");
	expect(s.tmux(sessions, "show", "-gv", "@swb_version")).toBe(VERSION);
	expect(pid(ui)).not.toBe(uiBefore);
	release(s, "u1");
	await until(() => entry(s, b).activity === "idle", budgets.settle, "b's turn done");
	s.save("upgraded.txt", s.screen());

	s.tmux(sessions, "set", "-g", "@swb_version", "99.0.0");
	await until(() => s.screen().includes("swb 99.0.0 is in; reopen the Deck"), budgets.settle, "the outdated Deck warning");
	s.save("outdated.txt", s.screen());
	s.swb("wake", a);
	expect(s.tmux(sessions, "show", "-gv", "@swb_version")).toBe("99.0.0");
	await until(
		() => entry(s, a).live && s.tmux(sessions, "capture-pane", "-p", "-t", `=${hostOf(a)}:`).includes("half a thought"),
		budgets.piReady,
		"a's draft back",
	);
	s.save("draft-restored.txt", s.tmux(sessions, "capture-pane", "-p", "-t", `=${hostOf(a)}:`));
	expect(existsSync(draft)).toBe(false);

	s.swb("drive", "stop");
	// The Deck takes its placeholder down after drive stop returns; killing it here too would race that.
	await until(
		() => names(ui).every((name) => name === "swb-ctl") && !names(sessions).some((name) => name.startsWith("placeholder-")),
		budgets.settle,
		"the Deck and its placeholder gone",
	);
	for (const name of names(sessions)) if (name !== "swb-ctl") s.tmux(sessions, "kill-session", "-t", `=${name}`);
	for (const server of [sessions, ui]) s.tmux(server, "set", "-gu", "@swb_version");
	const before = [pid(sessions), pid(ui)];
	s.swb("drive", "start");
	await waitState(s, "the Deck up again", (x) => sessionRows(x).length === 2);
	expect([pid(sessions), pid(ui)]).not.toContain(before[0]);
	expect(pid(ui)).not.toBe(before[1]);
});

test("cleanup leaves nothing running: a Deck open on a live pi can't restart the sessions server, and a late gc can't recreate the db", async () => {
	s = scenario("phase6", "cleanup");
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the new pi live with the keyboard", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await reply(s, "one");
	const root = dirname(s.env.HOME as string);
	const server = Number(s.tmux(s.servers.sessions, "display", "-p", "#{pid}"));

	await s.cleanup();
	// Past a Deck worker's tick, which restarts a sessions server it finds down.
	await Bun.sleep(1000);
	expect(alive(server)).toBe(false);
	const flag = `-L ${s.servers.sessions}`;
	const procs = Bun.spawnSync(["ps", "-eo", "args="]).stdout.toString().split("\n");
	expect(procs.filter((args) => args.includes(`${flag} `) || args.endsWith(flag))).toEqual([]);
	expect(existsSync(root)).toBe(false);

	// The sessions server's session-closed hook, landing after its world is gone, fails instead of bringing it back.
	const gc = Bun.spawnSync([join(repo, "dist/swb"), "gc"], { env: s.env, cwd: "/", stderr: "pipe" });
	expect(gc.exitCode).not.toBe(0);
	expect(existsSync(root)).toBe(false);
});
