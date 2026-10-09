import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { DeckState } from "../../packages/cli/src/deck/protocol.ts";
import { config, cursorTo, entry, piSessions, reply, seed, state, waitState } from "./harness/deck.ts";
import { budgets, git, type Scenario, scenario, until, which } from "./harness/index.ts";

const NVIM = which("nvim");

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

type Pane = { index: number; width: number; active: boolean };

function panes(s: Scenario, st: DeckState): Pane[] {
	return s
		.tmux(s.servers.ui, "list-panes", "-t", `=${st.deck}:`, "-F", "#{pane_index} #{pane_width} #{pane_active}")
		.split("\n")
		.map((line) => line.split(" ").map(Number) as [number, number, number])
		.map(([index, width, active]) => ({ index, width, active: active === 1 }));
}

function activePane(s: Scenario, st: DeckState): number {
	return (panes(s, st).find((p) => p.active) as Pane).index;
}

function editors(s: Scenario): { name: string; dir: string }[] {
	return s
		.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name}\t#{@swb_kind}\t#{@swb_dir}")
		.split("\n")
		.map((line) => line.split("\t") as [string, string, string])
		.filter(([, kind]) => kind === "editor")
		.map(([name, , dir]) => ({ name, dir }));
}

function savedView(s: Scenario, id: string): string | undefined {
	return s.query<{ view: string }>("SELECT view FROM marks WHERE session_id = ?", id)[0]?.view;
}

/** A new session started in a Deck, prompted once so it has a row to remember its view. */
async function started(s: Scenario, ...args: string[]): Promise<DeckState> {
	s.swb("drive", "start", ...args);
	const st = await waitState(
		s,
		"the new pi live with the keyboard",
		(x) => x.staged.kind === "live" && x.focus === "stage",
		budgets.piReady,
	);
	await reply(s, "hello");
	await until(() => entry(s, st.staged.id as string)?.activity === "idle", budgets.settle, "a session row");
	return st;
}

async function prefixKeys(s: Scenario, prefix: string, key: string, what: string, probe: (st: DeckState) => boolean): Promise<DeckState> {
	s.keys(prefix, key);
	return waitState(s, what, probe);
}

test("M-a e swaps the Stage to nvim in the session's directory, and back", async () => {
	s = scenario("phase4", "swap");
	config(s, `editor = "${NVIM} --clean"`);
	const live = await started(s, "--", "new");
	const id = live.staged.id as string;
	s.save("pi.txt", s.screen());

	// From the roster, M-a e takes the keyboard to the editor it brings up, and back to pi.
	await prefixKeys(s, "M-a", "h", "the roster focused", (x) => x.focus === "roster");
	const st = await prefixKeys(s, "M-a", "e", "editor view", (x) => x.staged.view === "editor" && x.focus === "editor");
	expect(st.staged).toMatchObject({ id, kind: "live", savedView: "editor" });
	expect(st.focus).toBe("editor");
	const [editor, ...more] = editors(s);
	expect(more).toEqual([]);
	expect(editor?.dir).toBe(entry(s, id).cwd);
	const where = () =>
		s.tmux(s.servers.sessions, "display", "-p", "-t", `=${editor?.name}:`, "#{pane_current_command}\t#{pane_current_path}");
	await until(() => where() === `nvim\t${entry(s, id).cwd}`, budgets.settle, `nvim in the session's cwd, not ${where()}`);
	await until(() => s.screen().includes("NVIM v"), budgets.settle, "nvim's intro on the Stage");
	await until(() => savedView(s, id) === "editor", budgets.settle, "marks.view = editor");
	s.save("editor.txt", s.screen());

	await prefixKeys(s, "M-a", "h", "the roster focused", (x) => x.focus === "roster");
	const back = await prefixKeys(s, "M-a", "e", "pi view", (x) => x.staged.view === "pi" && x.focus === "stage");
	expect(back.staged.savedView).toBe("pi");
	await until(() => s.screen().includes("hello") && !s.screen().includes("NVIM v"), budgets.settle, "pi back on the Stage");
	await until(() => savedView(s, id) === "pi", budgets.settle, "marks.view = pi");
	expect(editors(s).length).toBe(1);
	s.save("pi-again.txt", s.screen());

	const tab = (label: string): [string, string] => {
		const lines = s.screen().split("\n");
		const y = lines.findIndex((line) => line.includes(" pi  editor  split "));
		expect(y).toBeGreaterThan(-1);
		return [String((lines[y] as string).indexOf(` ${label} `) + 1), String(y)];
	};
	s.swb("drive", "click", ...tab("editor"));
	await waitState(s, "the editor tab clicked", (x) => x.staged.view === "editor");
	s.save("editor-tab.txt", s.screen());
	await Bun.sleep(500);
	s.swb("drive", "click", ...tab("pi"));
	await waitState(s, "the pi tab clicked", (x) => x.staged.view === "pi");
});

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
	// From pi view with the keyboard on the Stage, the keyboard stays on pi.
	expect(activePane(s, st)).toBe(2);
	await until(() => s.screen().includes("hello"), budgets.settle, "pi redrawn at its new width");
	s.save("split.txt", s.screen());

	const walk: [string, number][] = [
		["h", 1],
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
	expect(away.staged).toMatchObject({ view: "pi", savedView: "pi" });
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
	const toPi = await waitState(s, "split left for pi", (x) => !x.layout.split && x.staged.view === "pi");
	expect(toPi).toMatchObject({ focus: "stage", staged: { savedView: "pi" } });
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
	expect(narrowed.staged).toMatchObject({ view: "pi", savedView: "split" });
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
	expect(dormant.staged).toMatchObject({ view: "pi", savedView: "split" });
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
	const told = await waitState(s, "a split refusal", (x) => x.toasts.some((t) => t.text === "split needs 160 columns; showing pi"));
	expect(told.staged).toMatchObject({ view: "pi", savedView: "split" });
	expect(told.focus).toBe("stage");
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

test("the roster holds roster_width through resizes; clicking a sleeping session's Stage or splitting it wakes pi", async () => {
	s = scenario("phase4", "roster-width-wake");
	config(s, 'editor = "cat -v"\nroster_width = "25%"');
	const live = await started(s, "--size", "200x50", "--", "new");
	const id = live.staged.id as string;
	expect(panes(s, live)[0]?.width).toBe(50);
	s.swb("drive", "resize", "240x50");
	const wide = await waitState(s, "240 columns", (x) => x.layout.width === 240);
	await until(() => panes(s, wide)[0]?.width === 60, budgets.settle, `a 60-column roster, not ${panes(s, wide)[0]?.width}`);
	s.save("240-cols.txt", s.screen());

	await prefixKeys(s, "M-a", "h", "the roster focused", (x) => x.focus === "roster");
	s.tmux(s.servers.sessions, "kill-session", "-t", `=${live.staged.host}`);
	await waitState(s, "pi exited", (x) => x.staged.kind === "exited");
	s.save("exited.txt", s.screen());
	s.swb("drive", "click", "120", "20");
	await waitState(s, "woken by the click", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	s.save("clicked-awake.txt", s.screen());

	await prefixKeys(s, "M-a", "h", "the roster focused", (x) => x.focus === "roster");
	const again = state(s);
	s.tmux(s.servers.sessions, "kill-session", "-t", `=${again.staged.host}`);
	await waitState(s, "exited again", (x) => x.staged.kind === "exited" && x.staged.id === id);
	s.keys("M-a", "v");
	await waitState(s, "split and woken", (x) => x.staged.kind === "live" && x.layout.split, budgets.piReady);
	s.save("split-awake.txt", s.screen());
});

test("sessions in one directory share an editor, a worktree gets its own, and archiving the last one reaps it", async () => {
	s = scenario("phase4", "editors");
	config(s, 'editor = "cat -v"');
	const worktree = join(s.root, "project-wt");
	git(s, s.project, "init", "-q", "-b", "main");
	git(s, s.project, "commit", "-q", "--allow-empty", "-m", "init");
	git(s, s.project, "worktree", "add", "-q", "-b", "wt", worktree);

	const ids: string[] = [];
	for (const args of [["new"], ["new"], ["new", "--cwd", worktree]]) {
		const st = await started(s, "--", ...args);
		ids.push(st.staged.id as string);
		await prefixKeys(s, "M-a", "e", "editor view", (x) => x.staged.view === "editor");
		s.swb("drive", "stop");
	}
	const [a, b, w] = ids as [string, string, string];
	expect(entry(s, a).cwd).toBe(entry(s, b).cwd);
	expect(entry(s, w).cwd).toBe(worktree);
	expect(
		editors(s)
			.map((e) => e.dir)
			.sort(),
	).toEqual([entry(s, a).cwd, worktree].sort());
	s.save("editors.txt", s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name} #{@swb_kind} #{@swb_dir}"));

	s.swb("archive", a);
	expect(
		editors(s)
			.map((e) => e.dir)
			.sort(),
	).toEqual([entry(s, a).cwd, worktree].sort());
	s.swb("archive", b);
	await until(() => editors(s).length === 1, budgets.settle, "the project's editor reaped");
	expect(editors(s).map((e) => e.dir)).toEqual([worktree]);
	s.save("after-archive.txt", s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name} #{@swb_kind} #{@swb_dir}"));
});

test("an editor that won't start says so, keeps pi on the Stage, and the key still answers", async () => {
	s = scenario("phase4", "editor-fails");
	config(s, 'editor = "/nonexistent/editor"');
	const live = await started(s, "--", "new");
	for (const attempt of [1, 2]) {
		s.keys("M-a", "e");
		const st = await waitState(s, `refusal ${attempt}`, (x) => x.toasts.filter((t) => t.text.startsWith("editor")).length >= attempt);
		expect(st.staged).toMatchObject({ id: live.staged.id, view: "pi" });
		expect(st.toasts.find((t) => t.text.startsWith("editor"))?.level).toBe("error");
	}
	expect(editors(s)).toEqual([]);
	s.save("refused.txt", `${s.screen()}\n${JSON.stringify(state(s).toasts)}`);
});

test("lazy hover starts nothing; eager hover starts pi 500 ms after the cursor lands", async () => {
	s = scenario("phase4", "hover");
	const [a, b] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	await cursorTo(s, b);
	await Bun.sleep(1500);
	expect(state(s)).toMatchObject({ waking: [], staged: { id: b, kind: "dormant" } });
	expect(piSessions(s)).toEqual([]);
	s.swb("drive", "stop");

	config(s, 'hover = "eager"');
	s.swb("drive", "start");
	await cursorTo(s, a);
	await waitState(s, "a live", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	const t0 = Date.now();
	await cursorTo(s, b);
	const at = Date.now();
	await waitState(s, "b waking", (x) => x.waking.some((w) => w.id === b) || (x.staged.id === b && x.staged.kind === "live"), 3000);
	const waited = Date.now() - t0;
	expect(waited).toBeGreaterThanOrEqual(450 - (at - t0));
	expect(waited).toBeLessThan(1500);
	await waitState(s, "b live", (x) => x.staged.id === b && x.staged.kind === "live", budgets.piReady);
	expect(entry(s, b).live).toBe(true);
	s.save("eager.txt", s.screen());
});

test("M-a M-a sends a literal M-a through to the Stage, and a rebound prefix takes over", async () => {
	s = scenario("phase4", "prefix");
	config(s, 'editor = "cat -v"');
	await started(s, "--", "new");
	await prefixKeys(s, "M-a", "e", "editor view", (x) => x.staged.view === "editor");
	s.keys("-l", "m1:", "M-a", "M-a", "Enter");
	await until(() => s.screen().includes("m1:^[a"), budgets.settle, "a literal M-a in cat -v");
	s.save("literal-m-a.txt", s.screen());
	s.swb("drive", "stop");

	config(s, 'editor = "cat -v"\n[keys]\nprefix = "C-b"\n');
	s.swb("drive", "start");
	await waitState(s, "the editor on the Stage", (x) => x.staged.view === "editor");
	s.keys("Enter");
	await waitState(s, "editor focus", (x) => x.focus === "editor");
	s.keys("-l", "m2:", "C-b", "C-b", "M-a", "Enter");
	await until(() => s.screen().includes("m2:^B^[a"), budgets.settle, "a literal C-b, and M-a passing straight through");
	await prefixKeys(s, "C-b", "e", "pi view through C-b", (x) => x.staged.view === "pi");
	await prefixKeys(s, "C-b", "h", "roster through C-b", (x) => x.focus === "roster");
	s.save("rebound.txt", s.screen());
});

test("a bad config key fails loudly, naming the key", async () => {
	s = scenario("phase4", "bad-config");
	const cases: [string, string][] = [
		['colour = "dark"', "unknown key colour"],
		['[keys]\nbogus = "C-b"', "unknown key keys.bogus"],
		['hover = "sometimes"', 'hover must be "lazy" or "eager"'],
		['reap_after = "soon"', "reap_after must be a duration"],
	];
	const out: string[] = [];
	for (const [toml, message] of cases) {
		config(s, toml);
		const result = s.swbTry("ls");
		expect(result.code).not.toBe(0);
		expect(result.err).toContain(message);
		out.push(`$ cat config.toml\n${toml}\n$ swb ls\n${result.err}`);
	}
	s.save("errors.txt", out.join("\n"));
});
