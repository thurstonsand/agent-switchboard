import { afterEach, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settled, type } from "./harness/agents.ts";
import { config, state, waitState } from "./harness/deck.ts";
import { budgets, type Scenario, scenario, until, which } from "./harness/index.ts";
import { host, launched } from "./harness/schedules.ts";
import { prefixKeys, started } from "./harness/views.ts";

const NVIM = which("nvim");

let s: Scenario;

afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
	} catch {}
	await s.cleanup();
});

function numbered(s: Scenario, name: string): void {
	const stem = name.split(".")[0];
	writeFileSync(join(s.project, name), Array.from({ length: 200 }, (_, i) => `const ${stem}_${i + 1} = ${i + 1};`).join("\n"));
}

/** What the Editor's nvim says it shows: the file, the cursor's line, the tab among its tabs, and its mode. */
function nvimShows(s: Scenario): string {
	const dir = join(s.env.XDG_STATE_HOME as string, "agent-switchboard/editors");
	const [socket] = readdirSync(dir).filter((f) => f.endsWith(".sock"));
	const expr = `expand('%:t') . ':' . line('.') . ' tab ' . tabpagenr() . '/' . tabpagenr('$') . ' ' . mode()`;
	const out = Bun.spawnSync([NVIM, "--server", join(dir, socket as string), "--remote-expr", expr], { stdout: "pipe" });
	return out.stdout.toString().trim();
}

/** The harness's own screen as it draws it, colors and all, for rendering the call's row. */
function saveAgent(s: Scenario, id: string, file: string): void {
	s.save(file, s.tmux(s.servers.sessions, "capture-pane", "-e", "-p", "-t", s.pane(host(s, id))));
}

/** A tool call typed into the agent on the Stage, as a person would prompt it. */
function call(s: Scenario, args: Record<string, unknown>): void {
	s.keys("-l", `call swb_show_file ${JSON.stringify(args)}`, "Enter");
}

const banner = (s: Scenario, where: string) => s.screen().split(`pi opened ${where}`).length - 1;

test("swb_show_file opens the file at its line in nvim, splits the Stage onto it with the keyboard there, and leaves a diff tab alone", async () => {
	s = scenario("show-file", "nvim");
	config(s, `editor = "${NVIM} --clean"`);
	numbered(s, "a.ts");
	numbered(s, "b.ts");
	const live = await started(s, "--size", "200x50", "--", "new");
	const id = live.staged.id as string;

	// From the agent's view, wide enough to split: split, with the keyboard on the Editor, and word of who moved it.
	call(s, { path: "a.ts", line: 120 });
	const shown = await waitState(s, "split onto the Editor", (x) => x.staged.view === "split" && x.focus === "editor");
	expect(shown.staged).toMatchObject({ id, savedView: "split" });
	await until(() => nvimShows(s) === "a.ts:120 tab 1/1 n", budgets.settle, `a.ts:120 in nvim, not ${nvimShows(s)}`);
	await until(() => s.screen().includes("const a_120 = 120;"), budgets.settle, "line 120 on screen");
	await until(() => banner(s, "a.ts:120") === 1, budgets.settle, "the banner, once");
	await until(() => s.ls().find((e) => e.id === id)?.activity === "idle", budgets.settle, "the call's turn over");
	s.save("opened.txt", s.screen());
	saveAgent(s, id, "pi.ansi");

	// I open a diff in a tab of its own and leave nvim mid-insert there.
	s.keys("-l", ":tabedit b.ts", "Enter");
	s.keys("-l", ":vert diffsplit a.ts", "Enter");
	await until(() => nvimShows(s).startsWith("a.ts:") && nvimShows(s).includes("tab 2/2"), budgets.settle, "the diff tab");
	s.keys("i");
	await until(() => nvimShows(s).endsWith(" i"), budgets.settle, "nvim in insert mode");
	await prefixKeys(s, "M-a", "l", "the keyboard back on pi", (x) => x.focus === "stage");

	// a.ts is in the diff too, but its own tab gets it; the view stays split and the keyboard goes back to the Editor.
	call(s, { path: "a.ts", line: 30 });
	await waitState(s, "the keyboard on the Editor", (x) => x.staged.view === "split" && x.focus === "editor");
	await until(() => nvimShows(s) === "a.ts:30 tab 1/2 n", budgets.settle, `a.ts:30 in tab 1, not ${nvimShows(s)}`);
	await until(() => banner(s, "a.ts:30") === 1, budgets.settle, "the new banner");

	// b.ts is open only in the diff, so it gets a tab of its own beside the one it came from, and the diff stays as it was.
	await prefixKeys(s, "M-a", "l", "the keyboard back on pi", (x) => x.focus === "stage");
	call(s, { path: `${s.project}/b.ts`, line: 7 });
	await until(() => nvimShows(s) === "b.ts:7 tab 2/3 n", budgets.settle, `b.ts:7 in a new tab, not ${nvimShows(s)}`);
	s.save("new-tab.txt", s.screen());

	// A file that isn't there is the agent's to hear about; the view stays where it is.
	await prefixKeys(s, "M-a", "l", "the keyboard back on pi", (x) => x.focus === "stage");
	call(s, { path: "missing.ts" });
	await until(() => s.screen().includes(`no file ${s.project}/missing.ts`), budgets.settle, "the refusal in pi");
	await until(() => s.ls().find((e) => e.id === id)?.activity === "idle", budgets.settle, "the refused turn over");
	saveAgent(s, id, "pi-refused.ansi");
	expect(state(s).staged.view).toBe("split");
	expect(nvimShows(s)).toBe("b.ts:7 tab 2/3 n");
});

test("an Editor not yet running starts on the Stage first, so its startup prompt is mine to answer, then takes the file", async () => {
	s = scenario("show-file", "cold");
	numbered(s, "a.ts");
	// A config that stops nvim at "Press ENTER" as it starts, as a noisy plugin would.
	const init = join(s.root, "init.lua");
	writeFileSync(init, 'vim.api.nvim_echo({ { "SWB-STARTUP-NOTICE one" }, { "\\ntwo" }, { "\\nthree" } }, true, {})\n');
	config(s, `editor = "${NVIM} -i NONE -u ${init}"`);
	const live = await started(s, "--size", "120x40", "--", "new");
	const id = live.staged.id as string;
	expect(readdirSync(join(s.env.XDG_STATE_HOME as string, "agent-switchboard")).includes("editors")).toBe(false);

	call(s, { path: "a.ts", line: 3 });
	// Too narrow to split, the Editor takes the Stage, with the keyboard, while the call waits on it.
	await waitState(s, "the Editor on the Stage", (x) => x.staged.view === "editor" && x.focus === "editor");
	await until(() => s.screen().includes("Press ENTER"), budgets.settle, "nvim's startup prompt on the Stage");
	await until(() => banner(s, "a.ts:3") === 1, budgets.settle, "the banner");
	s.save("prompt.txt", s.screen());
	await Bun.sleep(1000);
	expect(s.ls().find((e) => e.id === id)?.activity).toBe("working");

	s.keys("Enter");
	await until(() => nvimShows(s) === "a.ts:3 tab 1/1 n", budgets.settle, `a.ts:3 in nvim, not ${nvimShows(s)}`);
	await until(() => s.screen().includes("const a_3 = 3;"), budgets.settle, "line 3 on screen");
	await until(() => s.ls().find((e) => e.id === id)?.activity === "idle", budgets.settle, "the call's turn over");
	s.save("opened.txt", s.screen());

	// With only the Editor on the Stage, the agent's pane is off the Deck, but the Deck still shows its session.
	s.swb("show-file", "a.ts", "--from", id, "--line", "9");
	expect(nvimShows(s)).toBe("a.ts:9 tab 1/1 n");
	await until(() => banner(s, "a.ts:9") === 1, budgets.settle, "the banner for the second call");
	expect(state(s).staged.view).toBe("editor");

	// An Editor running without a socket, which `editor` once set to another program, or an older swb, started: the
	// agent hears why at once, rather than waiting on a socket that never comes.
	const [pane] = s
		.tmux(s.servers.sessions, "list-panes", "-a", "-F", "#{pane_id}\t#{@swb_role}")
		.split("\n")
		.filter((line) => line.endsWith("\teditor"))
		.map((line) => line.split("\t")[0] as string);
	s.tmux(s.servers.sessions, "set", "-pu", "-t", pane as string, "@swb_socket");
	const old = s.swbTry("show-file", "a.ts", "--from", id, "--line", "20");
	expect(old.code).not.toBe(0);
	expect(old.err).toContain("isn't one swb can open files in; ask the user to quit it");
	expect(nvimShows(s)).toBe("a.ts:9 tab 1/1 n");
});

test("only an nvim Editor gives agents swb_show_file, and one still running as another program refuses at once", async () => {
	s = scenario("show-file", "not-nvim");
	numbered(s, "a.ts");
	config(s, 'editor = "cat -v"');
	await started(s, "--", "new");
	s.keys("-l", "tools cat", "Enter");
	await until(() => s.signal("tools.cat") !== "", budgets.settle, "the tool list");
	const tools = JSON.parse(s.signal("tools.cat")) as string[];
	expect(tools).toContain("swb_show_session");
	expect(tools).not.toContain("swb_show_file");
	await prefixKeys(s, "M-a", "e", "the cat Editor", (x) => x.staged.view === "editor");

	// editor changes to nvim while the directory's cat Editor runs on: a session started now gets the tool.
	s.swb("drive", "stop");
	config(s, `editor = "${NVIM} --clean"`);
	const live = await started(s, "--", "new");
	const since = Date.now();
	call(s, { path: "a.ts", line: 3 });
	await until(() => s.screen().includes("isn't one swb can open files in"), budgets.settle, "the refusal in pi");
	expect(Date.now() - since).toBeLessThan(5_000);
	expect(state(s).staged).toMatchObject({ id: live.staged.id, view: "agent" });
});

test("Claude Code and Codex open a file through swb's MCP server, which refuses while no Deck shows them", async () => {
	s = scenario("show-file", "harnesses", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	config(s, `editor = "${NVIM} --clean"`);
	numbered(s, "a.ts");
	const sessions = await Promise.all([launched(s, "claude", "reply claude up"), launched(s, "codex", "reply codex up")]);
	for (const [i, { id, harness }] of sessions.entries()) {
		const requests = () => s.requests(harness as "claude" | "codex");
		// No Deck is open yet for the first; the second's Deck shows the first.
		let since = Date.now();
		type(s, id, `call swb_show_file {"path":"a.ts","line":5}`);
		await settled(s, id, `${harness}'s refused call`, since);
		saveAgent(s, id, `${harness}-refused.ansi`);
		expect(requests().some((r) => (r.tools as string[]).some((name) => name.endsWith("swb_show_file")))).toBe(true);
		expect(requests().some((r) => String(r.toolOutput).includes("the Deck isn't showing this session"))).toBe(true);

		if (i > 0) s.swb("drive", "stop");
		s.swb("drive", "start", "--", "open", id);
		await waitState(s, `${harness} on the Stage`, (x) => x.staged.id === id && x.staged.kind === "live");
		since = Date.now();
		const line = 40 + i * 10;
		type(s, id, `call swb_show_file {"path":"a.ts","line":${line}}`);
		await waitState(s, `${harness}'s file on the Editor`, (x) => x.staged.id === id && x.staged.view === "editor" && x.focus === "editor");
		await until(() => nvimShows(s) === `a.ts:${line} tab 1/1 n`, budgets.settle, `a.ts:${line} in nvim, not ${nvimShows(s)}`);
		await settled(s, id, `${harness}'s call`, since);
		s.save(`${harness}.txt`, s.screen());
		saveAgent(s, id, `${harness}.ansi`);
	}
});
