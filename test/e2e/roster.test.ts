import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { DeckState } from "../../packages/cli/src/deck/protocol.ts";
import { config, cursorTo, entry, pickNew, piSessions, reply, seed, sessionRows, state, waitState } from "./harness/deck.ts";
import { budgets, git, type Scenario, scenario, until } from "./harness/index.ts";
import { panes, prefixKeys, started } from "./harness/views.ts";

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

test("the roster holds roster_width, or a dragged width, through resizes; clicking a sleeping session's Stage or splitting it wakes pi", async () => {
	s = scenario("phase4", "roster-width-wake");
	config(s, 'editor = "cat -v"\nroster_width = "25%"');
	const live = await started(s, "--size", "200x50", "--", "new");
	const id = live.staged.id as string;
	expect(panes(s, live)[0]?.width).toBe(50);
	s.swb("drive", "resize", "240x50");
	const wide = await waitState(s, "240 columns", (x) => x.layout.width === 240);
	await until(() => panes(s, wide)[0]?.width === 60, budgets.settle, `a 60-column roster, not ${panes(s, wide)[0]?.width}`);
	s.save("240-cols.txt", s.screen());
	s.tmux(s.servers.ui, "resize-pane", "-t", `=${wide.deck}:.0`, "-x", "80");
	await Bun.sleep(300);
	s.swb("drive", "resize", "200x50");
	await waitState(s, "200 columns", (x) => x.layout.width === 200);
	await until(() => panes(s, wide)[0]?.width === 80, budgets.settle, `the dragged 80 columns kept, not ${panes(s, wide)[0]?.width}`);
	s.save("dragged-200-cols.txt", s.screen());

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

test("by default a highlighted row starts nothing; wake_on_highlight starts pi 500 ms after the cursor lands", async () => {
	s = scenario("phase4", "wake-on-highlight");
	const [a, b] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	await cursorTo(s, b);
	await Bun.sleep(1500);
	expect(state(s)).toMatchObject({ waking: [], staged: { id: b, kind: "dormant" } });
	expect(piSessions(s)).toEqual([]);
	s.swb("drive", "stop");

	config(s, "wake_on_highlight = true");
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
	await prefixKeys(s, "C-b", "e", "pi view through C-b", (x) => x.staged.view === "agent");
	await prefixKeys(s, "C-b", "h", "roster through C-b", (x) => x.focus === "roster");
	s.save("rebound.txt", s.screen());
});

test("a bad config key fails loudly, naming the key", async () => {
	s = scenario("phase4", "bad-config");
	const cases: [string, string][] = [
		['colour = "dark"', "unknown key colour"],
		['[keys]\nbogus = "C-b"', "unknown key keys.bogus"],
		['wake_on_highlight = "eager"', "wake_on_highlight must be true or false"],
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

/** Each Group, or `(project)` for sessions directly under it, with its open sessions. */
function groups(st: DeckState): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const row of sessionRows(st)) {
		const label = row.group ?? "(project)";
		out[label] = [...(out[label] ?? []), row.id].sort();
	}
	return out;
}

/** The screen line a row of the open roster renders on: the list starts under the roster's label. */
function lineOf(st: DeckState, probe: (row: DeckState["rows"][number]) => boolean): number {
	return 1 + st.rows.findIndex(probe);
}

test("m names a session's Group, n joins it; dragging moves it between Groups, and a Group lives only as long as its sessions", async () => {
	s = scenario("phase4", "groups");
	const worktree = join(s.root, "project-wt");
	git(s, s.project, "init", "-q", "-b", "main");
	git(s, s.project, "commit", "-q", "--allow-empty", "-m", "init");
	git(s, s.project, "worktree", "add", "-q", "-b", "wt", worktree);
	const [a, b] = (await seed(s, { turns: ["one"], title: "alpha" }, { turns: ["two"], title: "bravo" })) as [string, string];
	const w = (await started(s, "--", "new", "--cwd", worktree)).staged.id as string;
	s.swb("drive", "stop");
	s.swb("drive", "start");
	const sorted = (...ids: string[]) => ids.sort();
	// A worktree's session sits with the rest of its Project.
	await waitState(s, "one Project", (x) => x.ready && Bun.deepEquals(groups(x), { "(project)": sorted(a, b, w) }));
	s.save("project.txt", s.screen());
	s.save("project.ansi", s.swb("drive", "capture", "--ansi"));

	await cursorTo(s, a);
	s.keys("m");
	await waitState(s, "naming", (x) => x.mode === "name");
	// The name's cursor is the terminal's, which tmux shows only while the roster's pane is the active one.
	s.keys("-l", "review");
	const nameLine = () =>
		s
			.tmux(s.servers.ui, "capture-pane", "-p", "-e", "-t", `=${state(s).deck}:.0`)
			.split("\n")
			.find((line) => line.includes("> review"));
	await until(() => nameLine() !== undefined, budgets.settle, "the name typed");
	expect(nameLine()).not.toContain("\x1b[7m");
	expect(s.tmux(s.servers.drive, "display", "-p", "#{cursor_flag}")).toBe("1");
	s.keys("Enter");
	let st = await waitState(s, "alpha in review", (x) => groups(x).review?.join() === a && x.mode === "roster");
	expect(groups(st)).toEqual({ review: [a], "(project)": sorted(b, w) });
	await until(() => entry(s, a).group === "review", budgets.settle, "a's Group review in the db");
	s.save("named.ansi", s.swb("drive", "capture", "--ansi"));

	const bravo = lineOf(st, (r) => r.kind === "session" && r.id === b);
	const alpha = lineOf(st, (r) => r.kind === "session" && r.id === a);
	expect(s.screen().split("\n")[bravo]?.slice(0, 30)).toContain("bravo");
	s.swb("drive", "drag", "8", `${bravo}`, "8", `${alpha}`, "--hold");
	await waitState(s, "review lit as the drop", (x) => x.drop?.group === "review");
	await until(() => s.screen().includes("⇢ into review"), budgets.settle, "the drop hint");
	// The carried session stays where it was, hollowed out.
	expect(s.screen().split("\n")[bravo]).toMatch(/┆\s+◌ bravo/);
	s.save("dragging.ansi", s.swb("drive", "capture", "--ansi"));
	s.swb("drive", "release", "8", `${alpha}`);
	st = await waitState(s, "bravo dropped into review", (x) => groups(x).review?.length === 2 && x.drop === null);
	expect(groups(st)).toEqual({ review: sorted(a, b), "(project)": [w] });
	await until(() => entry(s, b).group === "review", budgets.settle, "b's Group review in the db");
	s.save("dropped.ansi", s.swb("drive", "capture", "--ansi"));

	const operators = lineOf(st, (r) => r.kind === "section" && r.label === "Operators");
	const from = lineOf(st, (r) => r.kind === "session" && r.id === b);
	s.swb("drive", "drag", "8", `${from}`, "8", `${operators}`, "--hold");
	await until(() => s.screen().includes("✗ not here"), budgets.settle, "the refusal hint");
	expect(state(s).drop).toBeNull();
	s.save("refused.ansi", s.swb("drive", "capture", "--ansi"));
	s.swb("drive", "release", "8", `${operators}`);
	st = await waitState(s, "the refusal toast", (x) => x.toasts.some((t) => t.text.includes("nothing moved")));
	expect(groups(st)).toEqual({ review: sorted(a, b), "(project)": [w] });

	const project = lineOf(st, (r) => r.kind === "header" && r.group === null);
	s.swb("drive", "drag", "8", `${from}`, "8", `${project}`);
	st = await waitState(s, "bravo back under its Project", (x) => groups(x)["(project)"]?.includes(b) === true);
	expect(groups(st)).toEqual({ review: [a], "(project)": sorted(b, w) });
	await until(() => entry(s, b).group === null, budgets.settle, "b out of its Group in the db");

	// The picker narrows to the Project's Groups as I type, offering a new one until a name matches exactly.
	await cursorTo(s, b);
	s.keys("m");
	await waitState(s, "picking", (x) => x.mode === "name");
	await until(() => s.screen().includes("(no Group)"), budgets.settle, "the picker, no Group first");
	s.keys("-l", "rev");
	await until(() => s.screen().includes('+ new "rev"'), budgets.settle, "a new Group offered");
	s.save("picker.ansi", s.swb("drive", "capture", "--ansi"));
	s.keys("Enter");
	st = await waitState(s, "bravo picked into review", (x) => groups(x).review?.length === 2 && x.mode === "roster");
	await until(() => entry(s, b).group === "review", budgets.settle, "b's Group review in the db");
	await cursorTo(s, b);
	s.keys("m");
	await waitState(s, "picking again", (x) => x.mode === "name");
	const none = s
		.screen()
		.split("\n")
		.findIndex((line) => line.includes("(no Group)"));
	s.swb("drive", "click", "6", `${none}`);
	st = await waitState(
		s,
		"bravo clicked back under its Project",
		(x) => groups(x)["(project)"]?.includes(b) === true && x.mode === "roster",
	);
	await until(() => entry(s, b).group === null, budgets.settle, "b out of its Group in the db");

	s.swb("archive", a);
	await waitState(s, "review gone with its last session", (x) => !x.rows.some((r) => r.kind === "header" && r.group === "review"));
	s.swb("unarchive", a);
	await waitState(s, "review back with it", (x) => groups(x).review?.join() === a);

	await cursorTo(s, a);
	s.keys("k");
	await waitState(s, "on the review header", (x) => x.rows[x.cursorRow]?.kind === "header");
	s.keys("m");
	await waitState(s, "renaming", (x) => x.mode === "name");
	s.keys("C-u", "-l", "triage", "Enter");
	st = await waitState(s, "review renamed triage", (x) => groups(x).triage?.join() === a);
	const at = st.rows[st.cursorRow];
	expect(at?.kind === "header" && at.group).toBe("triage");
	await until(() => entry(s, a).group === "triage", budgets.settle, "a's Group triage in the db");
	s.save("renamed.ansi", s.swb("drive", "capture", "--ansi"));

	await pickNew(s);
	const joined = await waitState(
		s,
		"a new pi from the triage header",
		(x) => x.staged.kind === "live" && x.focus === "stage",
		budgets.piReady,
	);
	const n = joined.staged.id as string;
	await waitState(s, "the provisional row in triage", (x) => groups(x).triage?.includes(n) === true);
	await reply(s, "joined");
	await until(() => entry(s, n)?.group === "triage", budgets.settle, "the new session's Group written once it has a row");
	expect(entry(s, n).cwd).toBe(entry(s, a).cwd);
	s.save("joined.ansi", s.swb("drive", "capture", "--ansi"));
});
