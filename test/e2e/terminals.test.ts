import { afterEach, expect, test } from "bun:test";
import type { DeckState } from "../../packages/cli/src/deck/protocol.ts";
import { cursorTo, seed, state, terminal, waitState } from "./harness/deck.ts";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
	} catch {}
	await s.cleanup();
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
	await until(() => !outer.attached(), budgets.settle, "the terminal off the Deck");
	await until(
		() => !(JSON.parse(s.swb("deck", "state", "--json")) as DeckState).terminalFocused,
		budgets.settle,
		"the Deck, still up, watched by nobody",
	);
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

test("every swb attaches its terminal to the one Deck: swb open in one moves it in all, keys from any reach it, and q leaves from the one that typed it", async () => {
	s = scenario("phase5", "one-deck");
	const [a, b] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	const two = terminal(s, "two", "swb");
	const three = terminal(s, "three", `swb open ${b}`);
	await two.ready();
	await three.ready();
	expect([two.attached(), three.attached()]).toEqual([true, true]);
	await waitState(s, "the Deck on b, from terminal three", (x) => x.cursor === b);

	two.keys("Enter");
	await waitState(
		s,
		"b live, from terminal two",
		(x) => x.staged.id === b && x.staged.kind === "live" && x.focus === "stage",
		budgets.piReady,
	);
	three.keys("-l", "reply typed from three", "Enter");
	await until(() => s.signal("replied.typed from three") !== "", budgets.settle, "the turn typed from terminal three");
	await until(
		() => {
			const one = s.screen().trimEnd();
			return two.screen().trimEnd() === one && three.screen().trimEnd() === one;
		},
		budgets.settle,
		"every terminal showing the Deck alike",
	);
	s.save("drive.txt", s.screen());

	// q takes the terminal that typed it off the Deck, though another typed a moment before.
	two.keys("M-a", "h");
	await waitState(s, "the roster focused", (x) => x.focus === "roster");
	three.keys("k");
	two.keys("q");
	await until(() => !two.attached(), budgets.settle, "terminal two off the Deck");
	expect(three.attached()).toBe(true);

	// The Deck is watched while any terminal on it is focused, and by nobody once the last focused one leaves.
	s.swb("drive", "focus", "out");
	await Bun.sleep(500);
	expect(state(s).terminalFocused).toBe(true);
	three.keys("M-a", "q");
	await until(() => !three.attached(), budgets.settle, "terminal three off the Deck");
	await waitState(s, "no focused terminal", (x) => !x.terminalFocused);
	s.swb("drive", "focus", "in");
	await waitState(s, "the drive terminal focused", (x) => x.terminalFocused);
});
