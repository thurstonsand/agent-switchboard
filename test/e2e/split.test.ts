import { afterEach, expect, test } from "bun:test";
import type { DeckState } from "../../packages/cli/src/deck/protocol.ts";
import { config, cursorTo, entry, seed, state, waitState } from "./harness/deck.ts";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";
import { type Pane, panes, prefixKeys, savedView, started } from "./harness/views.ts";

let s: Scenario;

afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
		s.save(
			"final-tmux.txt",
			s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name} #{session_attached} #{@swb_kind} #{@swb_dir}"),
		);
	} catch {}
	await s.cleanup();
});

function activePane(s: Scenario, st: DeckState): number {
	return (panes(s, st).find((p) => p.active) as Pane).index;
}

type Box = { id: string; left: number; top: number; width: number; height: number };

function boxes(s: Scenario, st: DeckState): Box[] {
	return s
		.tmux(s.servers.ui, "list-panes", "-t", `=${st.deck}:`, "-F", "#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}")
		.split("\n")
		.map((line) => line.split(" "))
		.map(([id, ...n]) => {
			const [left, top, width, height] = n.map(Number) as [number, number, number, number];
			return { id: id as string, left, top, width, height };
		});
}

function shells(s: Scenario): string[] {
	return s
		.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name}\t#{@swb_kind}")
		.split("\n")
		.filter((line) => line.endsWith("\tshell"));
}

test("M-a v splits the editor at 65% beside pi; M-a h and l walk all three panes; the split follows the session", async () => {
	s = scenario("phase4", "split");
	config(s, 'editor = "cat -v"');
	const [other] = (await seed(s, { turns: ["other"] })) as [string];
	const live = await started(s, "--size", "200x50", "--", "new");
	const id = live.staged.id as string;

	const st = await prefixKeys(s, "M-a", "v", "split", (x) => x.layout.split && x.staged.view === "split");
	expect(st.staged.savedView).toBe("split");
	const [roster, editor, pi] = panes(s, st) as [Pane, Pane, Pane];
	expect(panes(s, st).length).toBe(3);
	expect(roster.width).toBe(42);
	expect(Math.abs(editor.width / (editor.width + pi.width + 1) - 0.65)).toBeLessThan(0.02);
	// Even from pi view with the keyboard on pi, splitting means I want to look at the editor.
	await until(() => activePane(s, st) === 1, budgets.settle, "the keyboard on the editor");
	await waitState(s, "focus on the editor", (x) => x.focus === "editor");
	await until(() => s.screen().includes("hello"), budgets.settle, "pi redrawn at its new width");
	s.save("split.txt", s.screen());

	const walk: [string, number][] = [
		["h", 0],
		["h", 0],
		["l", 1],
		["l", 2],
		["l", 2],
	];
	for (const [key, want] of walk) {
		s.keys("M-a", key);
		await until(() => activePane(s, st) === want, budgets.settle, `M-a ${key} to pane ${want}`);
		await waitState(s, `focus on ${want}`, (x) => x.focus === ["roster", "editor", "stage"][want]);
	}

	s.keys("M-a", "Tab");
	await until(() => activePane(s, st) === 0, budgets.settle, "M-a Tab to the roster");
	s.keys("M-a", "Tab");
	await until(() => activePane(s, st) === 2, budgets.settle, "M-a Tab back to pi, not the editor");
	s.keys("M-a", "h", "M-a", "h");
	await waitState(s, "roster", (x) => x.focus === "roster");
	const hidden = await prefixKeys(s, "M-a", "z", "M-a z hides the roster", (x) => x.layout.rosterHidden && x.focus === "stage");
	const [shownEditor, shownPi] = panes(s, hidden) as [Pane, Pane];
	expect(panes(s, hidden).length).toBe(2);
	expect(shownEditor.width + shownPi.width + 1).toBe(200);
	expect(activePane(s, hidden)).toBe(1);
	expect(hidden.layout.split).toBe(true);
	s.save("split-hidden.txt", s.screen());
	await prefixKeys(s, "M-a", "h", "M-a h to the editor", (x) => x.focus === "editor");
	const shown = await prefixKeys(
		s,
		"M-a",
		"h",
		"M-a h past the editor shows the roster",
		(x) => !x.layout.rosterHidden && x.focus === "roster",
	);
	expect(panes(s, shown).map((p) => p.index)).toEqual([0, 1, 2]);
	expect((panes(s, shown)[0] as Pane).width).toBe(42);
	expect(activePane(s, shown)).toBe(0);
	await cursorTo(s, other);
	const away = await waitState(s, "the other session alone", (x) => x.staged.id === other && !x.layout.split);
	expect(away.staged).toMatchObject({ view: "agent", savedView: "agent" });
	expect(panes(s, away).length).toBe(2);
	await cursorTo(s, id);
	await waitState(s, "split again", (x) => x.staged.id === id && x.layout.split && x.staged.view === "split");
	expect(panes(s, state(s)).length).toBe(3);
	s.save("split-restored.txt", s.screen());

	s.keys("Enter", "M-a", "h");
	await waitState(s, "keyboard on the editor", (x) => x.focus === "editor");
	s.keys("M-a", "v");
	const toEditor = await waitState(s, "split left for the editor", (x) => !x.layout.split && x.staged.view === "editor");
	expect(toEditor).toMatchObject({ focus: "editor", staged: { savedView: "editor" } });
	expect(panes(s, toEditor).length).toBe(2);
	s.save("left-for-editor.txt", s.screen());
	s.keys("M-a", "v");
	await waitState(s, "split from the editor, keyboard on the editor", (x) => x.layout.split && x.focus === "editor");
	s.keys("M-a", "l", "M-a", "v");
	const toPi = await waitState(s, "split left for pi", (x) => !x.layout.split && x.staged.view === "agent");
	expect(toPi).toMatchObject({ focus: "stage", staged: { savedView: "agent" } });
	await until(() => s.screen().includes("hello"), budgets.settle, "pi full width");
	s.save("left-for-pi.txt", s.screen());
});

test("split shows pi below 160 columns and returns on widening, survives reopening the Deck, and waits for pi to be live", async () => {
	s = scenario("phase4", "split-layout");
	config(s, 'editor = "cat -v"');
	const live = await started(s, "--size", "200x50", "--", "new");
	const id = live.staged.id as string;
	await prefixKeys(s, "M-a", "v", "split", (x) => x.layout.split);

	s.swb("drive", "resize", "150x50");
	const narrowed = await waitState(s, "pi alone at 150", (x) => !x.layout.split && x.layout.width === 150);
	expect(narrowed.staged).toMatchObject({ view: "agent", savedView: "split" });
	expect(panes(s, narrowed).length).toBe(2);
	s.save("150-cols.txt", s.screen());
	s.swb("drive", "resize", "200x50");
	await waitState(s, "split at 200", (x) => x.layout.split && x.staged.view === "split");

	s.swb("drive", "stop");
	s.tmux(s.servers.sessions, "kill-session", "-t", `=${live.staged.host}`);
	await until(() => !entry(s, id).live, budgets.settle, "dormant");
	expect(savedView(s, id)).toBe("split");

	s.swb("drive", "start", "--size", "200x50");
	await cursorTo(s, id);
	const dormant = await waitState(s, "a dormant card in one pane", (x) => x.staged.kind === "dormant");
	expect(dormant.staged).toMatchObject({ view: "agent", savedView: "split" });
	expect(dormant.layout.split).toBe(false);
	expect(panes(s, dormant).length).toBe(2);
	s.save("dormant-split.txt", s.screen());
	s.keys("w");
	await waitState(s, "split once live", (x) => x.staged.kind === "live" && x.layout.split, budgets.piReady);
	s.save("woke-split.txt", s.screen());

	s.keys("M-a", "h");
	await waitState(s, "roster", (x) => x.focus === "roster");
	s.swb("drive", "resize", "150x50");
	await waitState(s, "pi alone at 150", (x) => !x.layout.split && x.layout.width === 150);
	s.keys("M-a", "v", "M-a", "v");
	const told = await waitState(
		s,
		"a split refusal, the keyboard on pi",
		(x) => x.toasts.some((t) => t.text === "split needs 160 columns; showing pi") && x.focus === "stage",
	);
	expect(told.staged).toMatchObject({ view: "agent", savedView: "split" });
	await prefixKeys(s, "M-a", "h", "the roster focused", (x) => x.focus === "roster");

	s.swb("drive", "resize", "90x40");
	const tiny = await waitState(s, "the roster alone at 90", (x) => x.layout.rosterOnly && !x.layout.split);
	expect(panes(s, tiny).length).toBe(2);
	await until(() => activePane(s, tiny) === 0 && !s.screen().includes("hello"), budgets.settle, "only the roster on screen");
	expect(s.tmux(s.servers.ui, "display", "-p", "-t", `=${tiny.deck}:`, "#{window_zoomed_flag}")).toBe("1");
	s.save("90-cols.txt", s.screen());

	s.swb("drive", "resize", "200x50");
	await waitState(s, "wide again", (x) => !x.layout.rosterOnly && x.layout.width === 200);
	await prefixKeys(s, "M-a", "z", "the roster hidden", (x) => x.layout.rosterHidden);
	s.swb("drive", "resize", "40x15");
	const squeezed = await waitState(s, "the roster back at 40", (x) => x.layout.rosterOnly && !x.layout.rosterHidden);
	expect(panes(s, squeezed)[0]?.index).toBe(0);
	await prefixKeys(s, "M-a", "h", "the roster reachable at 40", (x) => x.focus === "roster");
	s.save("hidden-then-40-cols.txt", s.screen());
});

test("M-a s puts the directory's shell under pi, right of the split editor; ctrl-hjkl walk the panes; M-a s and ctrl-d close it", async () => {
	s = scenario("phase7", "shell");
	config(s, 'editor = "cat -v"');
	await started(s, "--size", "200x50", "--", "new");
	await prefixKeys(s, "M-a", "v", "split", (x) => x.layout.split && x.focus === "editor");
	let st = await prefixKeys(s, "M-a", "s", "the shell, with the keyboard", (x) => x.layout.shell && x.focus === "shell");
	const [roster, editor, pi, shell] = boxes(s, st) as [Box, Box, Box, Box];
	expect(boxes(s, st).length).toBe(4);
	expect(shell.left).toBe(pi.left);
	expect(shell.width).toBe(pi.width);
	expect(shell.top).toBe(pi.top + pi.height + 1);
	expect(editor.height).toBe(pi.height + shell.height + 1);
	expect(Math.abs(pi.height - shell.height)).toBeLessThanOrEqual(1);
	expect(roster.left).toBe(0);
	s.keys("-l", "echo shell-$((6*7)) in $PWD", "Enter");
	await until(() => s.screen().includes(`shell-42 in ${s.project}`), budgets.settle, "the shell in the session's directory");
	s.save("shell.txt", s.screen());
	s.save("shell.ansi", s.swb("drive", "capture", "--ansi"));

	// Every pane names itself on its top edge; with the prefix down, the others show the key that reaches them.
	const [top] = s.screen().split("\n");
	expect(top).toMatch(/swb.*editor.*pi/);
	s.keys("M-a");
	await until(() => /Tab +swb.*h +editor.*k +pi/.test(s.screen().split("\n")[0] ?? ""), budgets.settle, "the keys from the shell");
	s.save("shell-prefix.txt", s.screen());
	s.keys("k");
	await waitState(s, "M-a k up to pi", (x) => x.focus === "stage");
	await until(
		() => /swb.*editor.*pi/.test(s.screen().split("\n")[0] ?? "") && !/h +editor/.test(s.screen()),
		budgets.settle,
		"the keys gone once the prefix is spent, the names kept",
	);
	await prefixKeys(s, "M-a", "j", "M-a j down to the shell", (x) => x.focus === "shell");

	for (const [key, want] of [
		["C-k", "stage"],
		["C-j", "shell"],
		["C-h", "editor"],
		["C-h", "roster"],
		["C-h", "roster"],
		["C-l", "editor"],
	] as const) {
		s.keys(key);
		await waitState(s, `${key} to ${want}`, (x) => x.focus === want);
	}
	// From the roster, Tab and l go back to the pane I left, not the first one.
	s.keys("C-l", "C-j");
	await waitState(s, "shell", (x) => x.focus === "shell");
	await prefixKeys(s, "M-a", "Tab", "M-a Tab to the roster", (x) => x.focus === "roster");
	await prefixKeys(s, "M-a", "Tab", "M-a Tab back to the shell", (x) => x.focus === "shell");
	await prefixKeys(s, "M-a", "h", "M-a h", (x) => x.focus === "editor");
	await prefixKeys(s, "M-a", "h", "M-a h", (x) => x.focus === "roster");
	await prefixKeys(s, "M-a", "l", "M-a l back to the editor", (x) => x.focus === "editor");
	// Hidden and shown again, the roster still knows the pane it was left from, and says so; pi and the shell are two
	// moves away from it, so they show no key.
	await prefixKeys(s, "M-a", "z", "the roster hidden, the editor still focused", (x) => x.layout.rosterHidden && x.focus === "editor");
	await prefixKeys(s, "M-a", "h", "M-a h shows the roster and focuses it", (x) => !x.layout.rosterHidden && x.focus === "roster");
	s.keys("M-a");
	await until(() => /l +editor/.test(s.screen().split("\n")[0] ?? ""), budgets.settle, "l on the editor, the pane it was left from");
	expect(s.screen()).not.toMatch(/(h|j|k|l|Tab) +(pi|shell)\b/);
	s.save("rejoined-prefix.txt", s.screen());
	s.keys("l");
	await waitState(s, "M-a l back to the editor after the roster rejoins", (x) => x.focus === "editor");

	s.keys("C-l", "C-j");
	await waitState(s, "shell", (x) => x.focus === "shell");
	st = await prefixKeys(s, "M-a", "s", "the shell hidden, the keyboard on pi", (x) => !x.layout.shell && x.focus === "stage");
	expect(boxes(s, st).length).toBe(3);
	expect(shells(s).length).toBe(1);
	await prefixKeys(s, "M-a", "s", "the same shell back", (x) => x.layout.shell && x.focus === "shell");
	await until(() => s.screen().includes("shell-42"), budgets.settle, "its scrollback kept");

	s.keys("C-d");
	st = await waitState(s, "ctrl-d closes it", (x) => !x.layout.shell && x.layout.split);
	expect(boxes(s, st).length).toBe(3);
	await until(() => shells(s).length === 0, budgets.settle, "the shell's session gone");
	await prefixKeys(s, "M-a", "s", "a fresh shell", (x) => x.layout.shell && x.focus === "shell");
	expect(s.screen()).not.toContain("shell-42");
});
