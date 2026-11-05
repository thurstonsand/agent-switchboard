import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DeckState, HeaderStateRow } from "../../packages/cli/src/deck/protocol.ts";
import { cursorTo, entry, headerRows, pickNew, reply, seed, sessionRows, state, waitState } from "./harness/deck.ts";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
	} catch {}
	await s.cleanup();
});

test("M-a z inside Settings leaves the roster shown, and Tab afterwards still takes the keyboard to the Stage", async () => {
	s = scenario("phase5", "hide-in-settings");
	await seed(s, { turns: ["here"] });
	s.swb("drive", "start");
	await waitState(s, "the Deck up", (x) => x.ready && x.focus === "roster" && x.staged.id !== null);
	s.keys(",");
	await waitState(s, "Settings open", (x) => x.mode === "settings");
	// Settings holds the roster beside the Stage: hiding it there does nothing, and says nothing to tmux either.
	s.keys("M-a", "z");
	await Bun.sleep(500);
	s.keys("Escape");
	await waitState(s, "Settings closed", (x) => x.mode === "roster");
	const after = state(s);
	expect(after.layout.rosterHidden).toBe(false);
	expect(s.tmux(s.servers.ui, "show", "-qv", "-t", after.deck, "@swb_hidden")).toBe("");
	s.keys("M-a", "Tab");
	await waitState(s, "the keyboard on the Stage", (x) => x.focus === "stage");
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
	await until(() => s.screen().includes("key or click closes"), budgets.settle, "the key help");
	s.save("help.txt", s.screen());
	s.keys("x");
	await until(() => !s.screen().includes("key or click closes"), budgets.settle, "help closed");
	s.keys("M-a", "h");
	await waitState(s, "roster", (x) => x.focus === "roster");
	s.keys("q");
	await until(() => s.swbTry("drive", "state").code !== 0, budgets.settle, "the Deck closed");
	expect(s.ls().find((e) => e.id === b)?.live).toBe(true);
});

test("? fits every key in a tall Deck, and in a short one scrolls them by wheel and keys", async () => {
	s = scenario("phase5", "help-scroll");
	await seed(s, { turns: ["here"] });
	s.swb("drive", "start", "--size", "140x50");
	await waitState(s, "the Deck", (x) => x.ready);
	const first = "j k ↑ ↓      move";
	const last = "a literal M-a";
	s.keys("?");
	await until(() => s.screen().includes("key or click closes"), budgets.settle, "the key help");
	expect(s.screen()).toContain(first);
	expect(s.screen()).toContain(last);
	s.keys("x");
	await until(() => !s.screen().includes("key or click closes"), budgets.settle, "help closed");

	s.swb("drive", "resize", "140x24");
	await Bun.sleep(500);
	const cursor = state(s).cursor;
	s.keys("M-a", "?");
	await until(() => s.screen().includes("↓ 19 · j k, wheel scroll"), budgets.settle, "the short help, its end below");
	expect(s.screen()).toContain(first);
	expect(s.screen()).not.toContain(last);
	for (let i = 0; i < 3; i++) s.swb("drive", "wheel", "down", "70", "12");
	await until(() => s.screen().includes("↑ 3 ↓ 16"), budgets.settle, "three wheel turns down");
	expect(s.screen()).not.toContain(first);
	s.swb("drive", "wheel", "up", "70", "12");
	await until(() => s.screen().includes("↑ 2 ↓ 17"), budgets.settle, "one back up");
	s.keys(" ", " ");
	await until(() => s.screen().includes(last) && s.screen().includes("↑ 19 ·"), budgets.settle, "space pages to the end");
	s.keys("k", "k", "Up");
	await until(() => s.screen().includes("↑ 16 ↓ 3"), budgets.settle, "k and ↑ back up");
	s.keys("j");
	await until(() => s.screen().includes("↑ 17 ↓ 2"), budgets.settle, "j down");
	expect(state(s).cursor).toBe(cursor);
	s.keys("q");
	await until(() => !s.screen().includes("wheel scroll"), budgets.settle, "q closes it");
	expect(state(s).ready).toBe(true);
});

test("[ and ] step back and forward through the sessions I visited, from the roster, the Stage, and the legend's arrows", async () => {
	s = scenario("phase6", "history");
	const [a, b, c, d] = (await seed(s, { turns: ["a"] }, { turns: ["b"] }, { turns: ["c"] }, { turns: ["d"] })) as [
		string,
		string,
		string,
		string,
	];
	// Visits an earlier Deck made, d the latest, archived since.
	for (const [id, at] of [
		[a, 1000],
		[b, 2000],
		[d, 3000],
	] as const)
		s.query(
			"INSERT INTO marks (session_id, visited_at) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET visited_at = excluded.visited_at",
			id,
			at,
		);
	s.swb("archive", d);
	s.swb("drive", "start");
	await waitState(s, "the Deck opens on b, the latest open Visit", (x) => x.cursor === b && x.staged.id === b);
	const noLater = (x: DeckState) => x.toasts.some((t) => t.text === "no later visit");

	s.keys("[");
	await waitState(s, "[ back past this Deck to a", (x) => x.cursor === a && x.staged.id === a && x.focus === "roster");
	s.keys("]");
	await waitState(s, "] forward to b", (x) => x.cursor === b && x.staged.id === b);
	s.keys("]");
	await waitState(s, "nothing after b: archived d is passed over", (x) => noLater(x) && x.cursor === b);

	// Resting on c from the roster isn't a Visit; focusing its pi for a second is.
	await cursorTo(s, c);
	await Bun.sleep(1500);
	s.keys("[");
	await waitState(s, "[ off c, never visited, lands on b", (x) => x.cursor === b);
	await cursorTo(s, c);
	s.keys("Enter");
	await waitState(
		s,
		"c live with the keyboard",
		(x) => x.staged.id === c && x.staged.kind === "live" && x.focus === "stage",
		budgets.piReady,
	);
	await until(() => !entry(s, c).unseen, 3000, "c visited");

	s.keys("M-a", "[");
	await waitState(
		s,
		"M-a [ from the Stage wakes b and keeps the keyboard",
		(x) => x.staged.id === b && x.staged.kind === "live" && x.focus === "stage",
		budgets.piReady,
	);
	expect(state(s).cursor).toBe(b);
	const screen = s.screen().split("\n");
	const legendY = screen.findLastIndex((line) => line.includes("‹ ›"));
	s.save("history-legend.txt", screen[legendY] as string);
	s.swb("drive", "click", String((screen[legendY] as string).indexOf("›")), String(legendY));
	await waitState(s, "the legend's › forward to c", (x) => x.staged.id === c && x.cursor === c);

	// A snoozed session is still somewhere I've been.
	s.swb("snooze", a, "one_hour");
	await waitState(s, "a snoozed", (x) => x.rows.some((r) => r.kind === "section" && r.label === "Snoozed"));
	s.keys("M-a", "h");
	await waitState(s, "the roster", (x) => x.focus === "roster");
	s.keys("[");
	await waitState(s, "[ to b", (x) => x.cursor === b);
	s.keys("[");
	await waitState(s, "[ to a, in Snoozed", (x) => x.cursor === a && x.staged.id === a);

	// Visiting somewhere new drops what lay ahead: b, after a, leaves c behind.
	await cursorTo(s, b);
	s.keys("Enter");
	await waitState(s, "b with the keyboard", (x) => x.staged.id === b && x.focus === "stage");
	await Bun.sleep(1500);
	s.keys("M-a", "]");
	await waitState(s, "nothing after b now", (x) => noLater(x) && x.staged.id === b);
	s.keys("M-a", "[");
	await waitState(s, "M-a [ back to a", (x) => x.staged.id === a && x.focus === "stage", budgets.piReady);
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
