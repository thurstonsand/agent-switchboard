import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DeckState, PickerState } from "../../packages/cli/src/deck/protocol.ts";
import { config, reply, seed, waitState } from "./harness/deck.ts";
import { budgets, gitRepo, gitWorktree, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
	} catch {}
	await s.cleanup();
});

/** Repositories and worktrees under ~/code, by path relative to it. */
function codeTree(s: Scenario) {
	const code = join(s.home, "code");
	return {
		code,
		repo: (path: string) => gitRepo(s, join(code, path)),
		worktree: (main: string, branch: string, path?: string) => gitWorktree(s, main, branch, path),
	};
}

type Listed = { path: string; repo: string | null; branch: string | null };
const dirs = (s: Scenario): Listed[] => JSON.parse(s.swb("dirs", "--json"));

test("swb dirs: checkouts down to dirs.depth with their worktrees, include, and used directories; not excluded, hidden, node_modules, or deleted", async () => {
	s = scenario("dirs", "discovery");
	const { code, repo, worktree } = codeTree(s);
	const alpha = repo("alpha");
	worktree(alpha, "feature");
	worktree(alpha, "inner", join(alpha, ".worktrees/inner"));
	// Deleted without `git worktree remove`: git still lists it.
	rmSync(worktree(alpha, "gone"), { recursive: true });
	repo("org/team/gamma");
	repo("org/a/b/too-deep");
	repo("org/x/legacy");
	repo("dotfiles");
	repo("node_modules/pad");
	repo(".hidden/delta");
	mkdirSync(join(code, "notes"));
	mkdirSync(join(code, "plain"));
	config(s, '[dirs]\nscan = ["~/code"]\ndepth = 3\ninclude = ["~/code/notes"]\nexclude = ["dotfiles", "org/*/legacy"]\n');
	// A directory a session has used, outside the scan.
	await seed(s, { turns: ["one"] });

	const expected: Listed[] = [
		{ path: alpha, repo: null, branch: "main" },
		{ path: `${alpha}-feature`, repo: alpha, branch: "feature" },
		{ path: join(alpha, ".worktrees/inner"), repo: alpha, branch: "inner" },
		{ path: join(code, "org/team/gamma"), repo: null, branch: "main" },
		{ path: join(code, "notes"), repo: null, branch: null },
		{ path: s.project, repo: null, branch: null },
	];
	expect(dirs(s)).toEqual(expected);

	// Most recently used first; the rest stay alphabetical.
	config(s, '[dirs]\nscan = ["~/code"]\ndepth = 3\ninclude = ["~/code/notes"]\nexclude = ["dotfiles", "org/*/legacy"]\nsort = "recent"\n');
	expect(dirs(s).map((d) => d.path)).toEqual([s.project, ...expected.slice(0, 5).map((d) => d.path)]);
});

test("n picks a directory, ranked as typed; M-a d removes a repository with its worktrees; N adds one; a deleted one is forgotten", async () => {
	s = scenario("dirs", "picker");
	const { code, repo, worktree } = codeTree(s);
	const alpha = repo("alpha");
	const feature = worktree(alpha, "feature");
	for (const name of ["kino", "notes", "pin-notes", "plain"]) mkdirSync(join(code, name));
	config(s, '[dirs]\nscan = ["~/code"]\ninclude = ["~/code/kino", "~/code/notes", "~/code/pin-notes"]\n');
	const picker = (st: DeckState) => st.picker as PickerState;
	const names = (st: DeckState) => picker(st).rows.map((r) => `${r.dim ? "~" : ""}${r.name}`);
	const highlighted = (st: DeckState) => picker(st).rows[picker(st).choice]?.name;

	s.swb("drive", "start", "--", "new", "--cwd", feature);
	await waitState(s, "pi live in the worktree", (x) => x.staged.kind === "live", budgets.piReady);
	await reply(s, "in the worktree");
	s.keys("M-a", "n");
	let st = await waitState(s, "the picker on the worktree, keyboard in it", (x) => x.picker?.rows.length === 6 && x.focus === "roster");
	expect(names(st)).toEqual(["alpha", "feature", "kino", "notes", "pin-notes", "+ add a directory…"]);
	expect(highlighted(st)).toBe("feature");

	// The name's start, then a word's, then anywhere: not alphabetical, and the best is highlighted.
	s.keys("-l", "no");
	st = await waitState(s, "ranked", (x) => picker(x).input === "no");
	expect(names(st)).toEqual(["notes", "pin-notes", "kino", "+ add a directory…"]);
	expect(highlighted(st)).toBe("notes");
	// A matching worktree keeps its repository, dimmed.
	s.keys("C-u");
	s.keys("-l", "feat");
	st = await waitState(s, "a worktree match", (x) => picker(x).input === "feat");
	expect(names(st)).toEqual(["~alpha", "feature", "+ add a directory…"]);
	expect(highlighted(st)).toBe("feature");

	s.keys("C-u");
	await waitState(s, "the whole list back", (x) => picker(x).input === "" && highlighted(x) === "alpha");
	s.keys("M-a", "d");
	await waitState(s, "asked", (x) => picker(x).confirm === "alpha");
	s.keys("y");
	st = await waitState(s, "alpha gone", (x) => picker(x).confirm === null && !names(x).includes("alpha"));
	expect(names(st)).toEqual(["kino", "notes", "pin-notes", "+ add a directory…"]);
	// A session in its worktree doesn't bring it back. The worker writes the removal just behind the roster.
	const kept = ["kino", "notes", "pin-notes"].map((n) => join(code, n));
	await until(
		() =>
			Bun.deepEquals(
				dirs(s).map((d) => d.path),
				kept,
			),
		budgets.settle,
		"alpha gone from swb dirs",
	);

	// Adding: listed directories are dimmed; Enter on one that isn't adds it and starts a session there.
	s.keys("Escape");
	s.keys("N");
	st = await waitState(s, "add mode, nothing highlighted", (x) => x.picker?.mode === "add" && x.picker.choice === -1);
	expect(names(st)).toEqual(["alpha/", "alpha-feature/", "~kino/", "~notes/", "~pin-notes/", "plain/"]);
	// Every completion on screen, from the top.
	expect(s.screen()).toMatch(/alpha\/[\s\S]*plain\//);
	s.keys("-l", "p");
	st = await waitState(s, "add mode", (x) => x.picker?.mode === "add" && x.picker.input === "p");
	expect(names(st)).toEqual(["~pin-notes/", "plain/"]);
	s.keys("Down", "Enter");
	st = await waitState(s, "pi up in plain", (x) => x.mode === "roster" && x.staged.kind === "live", budgets.piReady);
	expect(dirs(s).map((d) => d.path)).toContain(join(code, "plain"));
	// Quit before a prompt: no Session, so only the add remembers plain, and a deleted directory is forgotten.
	s.tmux(s.servers.sessions, "kill-session", "-t", `=${st.staged.host}`);
	rmSync(join(code, "plain"), { recursive: true });
	expect(dirs(s).map((d) => d.path)).not.toContain(join(code, "plain"));
	mkdirSync(join(code, "plain"));
	expect(dirs(s).map((d) => d.path)).not.toContain(join(code, "plain"));

	// Adding a removed repository brings it back, worktrees and all.
	s.keys("M-a", "h");
	await waitState(s, "roster", (x) => x.focus === "roster");
	s.keys("N");
	s.keys("-l", "alpha");
	await waitState(s, "alpha offered", (x) => x.picker?.mode === "add" && names(x).join() === "alpha/,alpha-feature/");
	s.keys("Enter");
	await until(() => dirs(s).some((d) => d.path === feature), budgets.settle, "alpha and its worktree back");
});

test("in the picker the highlight, and its ✕, follow the pointer", async () => {
	s = scenario("dirs", "hover");
	const { code } = codeTree(s);
	for (const name of ["kino", "notes"]) mkdirSync(join(code, name), { recursive: true });
	config(s, '[dirs]\ninclude = ["~/code/kino", "~/code/notes"]\n');
	s.swb("drive", "start");
	await waitState(s, "ready", (x) => x.ready);
	s.keys("n");
	await waitState(s, "the picker", (x) => x.picker?.rows.length === 3 && x.picker.choice === 0);
	// Through the drive terminal and the Deck's tmux, which passes plain motion on only to a pane that asks for it. The list
	// starts on row 4, under the pane's label, the title, the search, and a rule.
	s.swb("drive", "move", "6", "5");
	const st = await waitState(s, "notes under the pointer", (x) => x.picker?.choice === 1);
	expect(st.picker?.rows[1]?.name).toBe("notes");
	expect(s.screen()).toMatch(/notes\s+✕/);
	s.keys("Escape");
	await waitState(s, "closed", (x) => x.picker === null && x.mode === "roster");
});
