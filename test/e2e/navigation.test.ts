import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DeckState, HeaderStateRow } from "../../packages/cli/src/deck/protocol.ts";
import { cursorTo, headerRows, pickNew, reply, seed, sessionRows, state, waitState } from "./harness/deck.ts";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
	} catch {}
	await s.cleanup();
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
