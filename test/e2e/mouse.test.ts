import { afterEach, expect, test } from "bun:test";
import { entry, seed, state, waitState } from "./harness/deck.ts";
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

/** Clicks `text` once tmux's double-click time has passed: two clicks inside it, anywhere, are a double click. */
async function click(text: string, button: "left" | "right" = "left", cols = 42): Promise<void> {
	await Bun.sleep(350);
	s.swb("drive", "click", ...(button === "right" ? ["--right"] : []), ...find(text, cols));
}

async function onScreen(text: string, what: string): Promise<void> {
	await until(() => s.screen().includes(text), budgets.settle, what);
}

test("the mouse reaches everything the keys do: a row's menu, the hidden or narrow roster, the shell, the Group picker, the filter, and help", async () => {
	s = scenario("phase6", "mouse");
	const [a] = (await seed(s, { turns: ["alpha"], title: "alpha" }, { turns: ["bravo"], title: "bravo" })) as [string, string];
	s.swb("drive", "start");

	await click("alpha", "right");
	await onScreen("Copy @session", "alpha's menu");
	s.save("menu-dormant.txt", s.screen());
	expect(s.screen()).toContain("Wake");
	await click("Wake");
	await waitState(s, "alpha woken from its menu, the keyboard still on the roster", (x) => x.cursor === a && x.focus === "roster");
	await waitState(s, "alpha live on the Stage", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	await click("alpha", "right");
	await onScreen("Stop", "the menu offering Stop");
	s.save("menu-live.txt", s.screen());
	await click("Stop");
	await until(() => !entry(s, a).live, budgets.settle, "alpha stopped from its menu");

	await click("alpha", "right");
	await onScreen("Group…", "the menu again");
	await click("Group…");
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
	await click("any key or click closes", "left", 140);
	await until(() => !s.screen().includes("any key or click closes"), budgets.settle, "help closed by a click");

	s.keys("M-a", "/");
	await waitState(s, "filtering", (x) => x.mode === "filter");
	s.keys("-l", "brav", "Enter");
	await waitState(s, "filtered to bravo", (x) => x.filter === "brav" && x.mode === "roster");
	await click("/brav ✕");
	await waitState(s, "the filter cleared by its tag", (x) => x.filter === "");

	s.swb("drive", "resize", "60x20");
	await waitState(s, "the roster alone", (x) => x.layout.rosterOnly && x.focus === "roster");
	await click("alpha");
	await waitState(s, "alpha's pi filling the Deck", (x) => x.staged.id === a && x.focus === "stage", budgets.piReady);
	await onScreen("show list", "the way back on the status line");
	s.save("narrow-pi.txt", s.screen());
	await click("show list");
	await waitState(s, "the roster again", (x) => x.focus === "roster" && x.layout.rosterOnly);
	await until(() => !s.screen().includes("show list"), budgets.settle, "the status line gone");
	expect(state(s).cursor).toBe(a);
});
