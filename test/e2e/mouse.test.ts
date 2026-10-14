import { afterEach, expect, test } from "bun:test";
import { cursorTo, entry, rowIndex, seed, state, waitState } from "./harness/deck.ts";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
	} catch {}
	await s.cleanup();
});

/** The column and row of `text` on screen, looking only in its first `cols` columns: the roster's, unless told otherwise. */
function find(text: string, cols = 42): [string, string] {
	const lines = s.screen().split("\n");
	const y = lines.findIndex((line) => line.slice(0, cols).includes(text));
	if (y === -1) throw new Error(`${text} not on screen:\n${lines.join("\n")}`);
	return [String((lines[y] as string).indexOf(text) + 1), String(y)];
}

/** The column and row of `text` right of the roster: on the Stage, or a Peek over it. */
function findRight(text: string): [string, string] {
	const lines = s.screen().split("\n");
	const y = lines.findIndex((line) => line.indexOf(text, 43) !== -1);
	if (y === -1) throw new Error(`${text} not right of the roster:\n${lines.join("\n")}`);
	return [String((lines[y] as string).indexOf(text, 43) + 1), String(y)];
}

/** Clicks `text` once tmux's double-click time has passed: two clicks inside it, anywhere, are a double click. */
async function click(text: string, cols = 42): Promise<void> {
	await Bun.sleep(350);
	s.swb("drive", "click", ...find(text, cols));
}

/** Rests the pointer on a session's row until its Peek is up, then clicks the Peek's button for `key`. */
async function peekButton(row: string, id: string, button: string): Promise<void> {
	s.swb("drive", "move", ...find(row));
	await waitState(s, `${row}'s Peek`, (x) => x.peek?.id === id && x.peek.lines.some((line) => line.includes(button)));
	await Bun.sleep(350);
	s.swb("drive", "move", ...findRight(button));
	s.swb("drive", "click", ...findRight(button));
}

/** Whether `text` on line `y` sits on a background fill: the last background code before it isn't a reset. */
function filled(y: number, text: string): boolean {
	const before = (s.swb("drive", "capture", "--ansi").split("\n")[y] as string).split(text)[0] as string;
	return [...before.matchAll(/\[(48;2;[\d;]+|49)m/g)].at(-1)?.[1] !== "49";
}

async function onScreen(text: string, what: string): Promise<void> {
	await until(() => s.screen().includes(text), budgets.settle, what);
}

test("the mouse reaches everything the keys do: a row's Peek, the hidden or narrow roster, the shell, the Group picker, the filter, and help", async () => {
	s = scenario("phase6", "mouse");
	const [a, b] = (await seed(s, { turns: ["alpha"], title: "alpha" }, { turns: ["bravo"], title: "bravo" })) as [string, string];
	s.swb("drive", "start");
	await waitState(s, "the Deck up", (x) => x.ready);
	await cursorTo(s, a);

	// A Peek's buttons act on its own row, wherever the cursor is.
	await peekButton("bravo", b, "Wake w");
	await until(() => entry(s, b).live, budgets.piReady, "bravo woken from its Peek");
	expect(state(s)).toMatchObject({ cursor: a, focus: "roster" });
	s.save("peek-woke.txt", s.screen());
	await peekButton("bravo", b, "Stop x");
	await until(() => !entry(s, b).live, budgets.settle, "bravo stopped from its Peek");
	expect(state(s).cursor).toBe(a);

	await peekButton("alpha", a, "Group… m");
	await waitState(s, "the Group picker", (x) => x.mode === "name");
	s.save("group-picker.txt", s.screen());
	await click(" ✕ ");
	await waitState(s, "the Group picker closed by its ✕", (x) => x.mode === "roster");

	await click("alpha");
	await waitState(s, "alpha's pi focused", (x) => x.staged.id === a && x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await click("hide list");
	await waitState(s, "the roster hidden", (x) => x.layout.rosterHidden);
	await onScreen("show list", "the way back on the status line");
	s.save("hidden.txt", s.screen());
	await click("show list");
	await waitState(s, "the roster back and focused", (x) => !x.layout.rosterHidden && x.focus === "roster");
	await until(() => !s.screen().includes("show list"), budgets.settle, "the status line gone with it");

	await click(" shell ");
	await waitState(s, "the shell shown", (x) => x.layout.shell && x.focus === "shell");
	s.save("shell.txt", s.screen());
	await click(" shell ");
	await waitState(s, "the shell hidden", (x) => !x.layout.shell);

	await click("? keys");
	await onScreen("any key or click closes", "the key help");
	s.save("help.txt", s.screen());
	await click("any key or click closes", 140);
	await until(() => !s.screen().includes("any key or click closes"), budgets.settle, "help closed by a click");

	s.keys("M-a", "/");
	await waitState(s, "filtering", (x) => x.mode === "filter");
	s.keys("-l", "brav", "Enter");
	await waitState(s, "filtered to bravo", (x) => x.filter === "brav" && x.mode === "roster");
	await click("/brav ✕");
	await waitState(s, "the filter cleared by its tag", (x) => x.filter === "");

	s.swb("drive", "resize", "60x20");
	await waitState(s, "the roster alone", (x) => x.layout.rosterOnly && x.focus === "roster");
	// No Stage beside the roster: the roster draws the Peek itself, over its own right edge, and it works the same.
	await onScreen("alpha", "the narrow roster drawn");
	s.swb("drive", "move", ...find("alpha", 60));
	const narrowPeek = await waitState(s, "alpha's Peek in the narrow roster", (x) => x.peek?.id === a);
	expect(narrowPeek.peek?.lines[0]?.startsWith("╭")).toBe(true);
	const [stopX, stopY] = find("Stop x", 60);
	// Right-aligned, leaving each row's glyph and the start of its title showing.
	expect(Number(stopX)).toBeGreaterThan(16);
	expect(s.screen().split("\n")[Number(find("alpha", 16)[1])]?.slice(0, 16)).toContain("alpha");
	expect(s.screen().split("\n")[Number(stopY)]?.length).toBeLessThanOrEqual(60);
	s.save("narrow-peek.txt", s.screen());
	s.swb("drive", "move", stopX, stopY);
	s.swb("drive", "click", stopX, stopY);
	await until(() => !entry(s, a).live, budgets.settle, "alpha stopped from the narrow Peek");
	await click("alpha", 20);
	await waitState(s, "alpha's pi filling the Deck", (x) => x.staged.id === a && x.focus === "stage", budgets.piReady);
	await onScreen("show list", "the way back on the status line");
	s.save("narrow-pi.txt", s.screen());
	await click("show list");
	await waitState(s, "the roster again", (x) => x.focus === "roster" && x.layout.rosterOnly);
	await until(() => !s.screen().includes("show list"), budgets.settle, "the status line gone");
	expect(state(s).cursor).toBe(a);
});

test("a Peek follows the pointer and the cursor keys, leaves with the pointer, and never takes pi's keys", async () => {
	s = scenario("phase6", "peek");
	const [a, b] = (await seed(s, { turns: ["alpha"], title: "alpha" }, { turns: ["bravo"], title: "bravo" })) as [string, string];
	s.swb("drive", "start");
	await waitState(s, "the Deck up", (x) => x.ready);
	await cursorTo(s, a);
	// Seeded a moment apart, both "now": either can be on top.
	const toB = rowIndex(state(s), b) < rowIndex(state(s), a) ? "k" : "j";
	const toA = toB === "k" ? "j" : "k";
	const staged = state(s).staged.id;

	// The row under the pointer gets its Peek beside it; the cursor and the Stage stay where they were.
	s.swb("drive", "move", ...find("bravo"));
	const hovered = await waitState(s, "bravo's Peek", (x) => x.hover === b && x.peek?.id === b && x.peek.source === "pointer");
	expect(hovered).toMatchObject({ cursor: a, staged: { id: staged } });
	expect(hovered.peek?.lines.join("\n")).toContain("pi  bravo");
	await until(() => findRight("bravo")[1] === find("bravo")[1], budgets.settle, "the Peek's title level with bravo's row");
	s.save("peek-hover.txt", s.screen());

	// On the Peek itself it stays; onto pi it goes, and the row's hover with it.
	s.swb("drive", "move", ...findRight("Archive a"));
	await Bun.sleep(400);
	expect(state(s).peek?.id).toBe(b);
	s.swb("drive", "move", "100", "35");
	await waitState(s, "the Peek gone with the pointer", (x) => x.peek === null && x.hover === null);
	expect(s.screen()).not.toContain("Archive a");

	// A control lights only while the pointer is on it: leaving the roster for pi puts it out.
	const [tabX, tabY] = find(" editor ");
	s.swb("drive", "move", tabX, tabY);
	await until(() => filled(Number(tabY), " editor "), budgets.settle, "the editor tab lit under the pointer");
	s.swb("drive", "move", "100", "35");
	await until(() => !filled(Number(tabY), " editor "), budgets.settle, "the editor tab out once the pointer is on pi");

	// The cursor's keys bring its Peek.
	s.keys(toB);
	await waitState(s, "the cursor's Peek", (x) => x.cursor === b && x.peek?.id === b && x.peek.source === "cursor");
	s.keys(toA);
	await waitState(s, "the Peek following the cursor", (x) => x.cursor === a && x.peek?.id === a);

	// Clicking a row focuses its pi and puts its Peek away, though the pointer still rests on the row.
	await click("bravo");
	await waitState(s, "bravo's pi focused", (x) => x.focus === "stage" && x.staged.id === b && x.staged.kind === "live", budgets.piReady);
	await waitState(s, "no Peek over the session just opened", (x) => x.peek === null);

	// A Peek opened while pi has the keyboard closes on the first key, and every key still reaches pi.
	s.swb("drive", "move", ...find("alpha"));
	await waitState(s, "alpha's Peek over bravo's pi", (x) => x.peek?.id === a && x.focus === "stage");
	s.keys("-l", "typed past the peek");
	await waitState(s, "the Peek closed by the first key", (x) => x.peek === null);
	await onScreen("typed past the peek", "every key in pi");
});
