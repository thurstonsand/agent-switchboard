import { afterEach, expect, test } from "bun:test";
import type { DeckState } from "../../packages/cli/src/deck/protocol.ts";
import { cursorTo, entry, pickNew, rowIndex, seed, sessionRows, state, terminal, waitState } from "./harness/deck.ts";
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
