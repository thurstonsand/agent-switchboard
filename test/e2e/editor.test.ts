import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, entry, state, waitState } from "./harness/deck.ts";
import { budgets, git, type Scenario, scenario, until, which } from "./harness/index.ts";
import { prefixKeys, savedView, started } from "./harness/views.ts";

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

function editors(s: Scenario): { name: string; dir: string }[] {
	return s
		.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name}\t#{@swb_kind}\t#{@swb_dir}")
		.split("\n")
		.map((line) => line.split("\t") as [string, string, string])
		.filter(([, kind]) => kind === "editor")
		.map(([name, , dir]) => ({ name, dir }));
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
	const back = await prefixKeys(s, "M-a", "e", "pi view", (x) => x.staged.view === "agent" && x.focus === "stage");
	expect(back.staged.savedView).toBe("agent");
	await until(() => s.screen().includes("hello") && !s.screen().includes("NVIM v"), budgets.settle, "pi back on the Stage");
	await until(() => savedView(s, id) === "agent", budgets.settle, "marks.view = agent");
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
	await waitState(s, "the pi tab clicked", (x) => x.staged.view === "agent");
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
		expect(st.staged).toMatchObject({ id: live.staged.id, view: "agent" });
		expect(st.toasts.find((t) => t.text.startsWith("editor"))?.level).toBe("error");
	}
	expect(editors(s)).toEqual([]);
	s.save("refused.txt", `${s.screen()}\n${JSON.stringify(state(s).toasts)}`);
});

test.skipIf(!NVIM)("ctrl-hjkl move between nvim's windows, and off its edge into the Deck's panes", async () => {
	s = scenario("phase7", "nvim-nav");
	// LazyVim maps ctrl-hjkl to wincmd at lazy.nvim's VeryLazy, which fires on the first UIEnter, after swb's -c.
	const init = join(s.root, "init.lua");
	writeFileSync(
		init,
		`vim.api.nvim_create_autocmd("User", { pattern = "VeryLazy", callback = function()
  for _, k in ipairs({ "h", "j", "k", "l" }) do vim.keymap.set("n", "<C-" .. k .. ">", "<C-w>" .. k) end
end })
vim.api.nvim_create_autocmd("UIEnter", { once = true, callback = function()
  vim.schedule(function() vim.api.nvim_exec_autocmds("User", { pattern = "VeryLazy" }) end)
end })
`,
	);
	// A directory opens in netrw, whose own ctrl-h and ctrl-l maps are in the way.
	config(s, `editor = "${NVIM} --clean -u ${init} ."`);
	await started(s, "--", "new");
	await prefixKeys(s, "M-a", "e", "the editor", (x) => x.staged.view === "editor" && x.focus === "editor");
	await until(() => s.screen().includes("~"), budgets.settle, "nvim drawn");
	// netrw on the right, an empty buffer with only the global maps on the left.
	s.keys("-l", ":vsplit", "Enter", "-l", ":enew", "Enter", "C-l");
	await Bun.sleep(500);
	expect(state(s).focus).toBe("editor");
	s.keys("C-h");
	await Bun.sleep(500);
	// One window over inside nvim, still at home.
	expect(state(s).focus).toBe("editor");
	s.save("nvim-split.txt", s.screen());
	// netrw's line highlight shows while nvim has the keyboard, goes while it hasn't, and comes back to netrw alone: the
	// empty buffer never had one. Unfocused windows' statuslines share its grey, so look only at the lines themselves.
	const editor = (editors(s)[0] as { name: string }).name;
	const rows = () => s.tmux(s.servers.sessions, "capture-pane", "-p", "-e", "-t", `=${editor}:`).split("\n");
	const netrwRow = () => {
		const right = rows()
			.find((row) => row.includes("../"))
			?.split("│")[1];
		if (right === undefined) throw new Error("netrw's ../ line isn't beside the empty buffer");
		return right;
	};
	const lit = netrwRow().match(/48;2;[0-9;]+m/)?.[0] as string;
	expect(lit).toBeDefined();
	s.keys("C-h");
	await waitState(s, "off nvim's left edge to the roster", (x) => x.focus === "roster");
	await until(() => !netrwRow().includes(lit), budgets.settle, "netrw's line unlit while nvim is out of focus");
	s.keys("C-l");
	await waitState(s, "back into nvim", (x) => x.focus === "editor");
	await until(() => netrwRow().includes(lit), budgets.settle, "netrw's line lit again");
	const top = rows()[0] as string;
	expect(top).toContain("│");
	expect(top.split("│")[0]).not.toContain(lit);
});
