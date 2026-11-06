import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commands, host, launched, pane, ready, send, type } from "./harness/agents.ts";
import { config, cursorTo, entry, seed, state, waitState } from "./harness/deck.ts";
import { budgets, release, type Scenario, scenario, until } from "./harness/index.ts";

// Claude Code and Codex, as swb hosts them: the real TUIs in the sessions server, scripted by fake model servers.

let s: Scenario;
afterEach(async () => {
	try {
		for (const { session_id, tmux_session } of s.query<{ session_id: string; tmux_session: string }>(
			"select session_id, tmux_session from runtimes",
		))
			s.save(`pane-${session_id}.txt`, s.tmux(s.servers.sessions, "capture-pane", "-p", "-J", "-S", "-200", "-t", s.pane(tmux_session)));
		s.save("ls.json", JSON.stringify(s.ls(), null, 2));
		for (const harness of ["claude", "codex"] as const) s.save(`${harness}-requests.json`, JSON.stringify(s.requests(harness), null, 1));
	} catch {}
	await s.cleanup();
});

test("Codex's /new moves its host to the new thread: that one is recorded, and the old one goes dormant", async () => {
	s = scenario("harnesses", "codex-new", { packages: [], recorder: true, harnesses: ["codex"] });
	const first = await launched(s, "codex", "reply first thread");
	const hostName = host(s, first.id);
	expect(first).toMatchObject({ harness: "codex", open: true, live: true, cwd: s.project, activity: "idle" });
	expect(s.tmux(s.servers.sessions, "display", "-p", "-t", s.pane(hostName), "#{pane_title}")).toStartWith(first.id.slice(0, 29));
	await until(() => pane(s, first.id).includes("first thread"), budgets.settle, "the reply on screen");
	await until(() => entry(s, first.id).title === "First thread", budgets.settle, "titled by Codex's own title generator");
	type(s, first.id, "/new");
	await Bun.sleep(1000);
	s.tmux(s.servers.sessions, "send-keys", "-t", s.pane(hostName), "-l", "reply second thread");
	await Bun.sleep(300);
	s.tmux(s.servers.sessions, "send-keys", "-t", s.pane(hostName), "Enter");
	const second = await until(
		() => s.ls().find((e) => e.harness === "codex" && e.id !== first.id && e.activity === "idle" && e.title !== null),
		ready,
		"the new thread's first turn recorded and titled",
	);
	expect(second).toMatchObject({ live: true, open: true, title: "Second thread" });
	expect(entry(s, first.id)).toMatchObject({ live: false, open: true });
	expect(s.tmux(s.servers.sessions, "display", "-p", "-t", s.pane(hostName), "#{pane_title}")).toStartWith(second.id.slice(0, 29));
	// Messages follow the thread the pane shows now.
	expect((await send(s, first.id, second.id, "SWB-after-new please ack")).details.delivered).toBe(true);
	await until(
		() => s.tmux(s.servers.sessions, "capture-pane", "-p", "-t", s.pane(hostName)).includes("got SWB-after-new"),
		ready,
		"the new thread answering",
	);
});

test("Claude Code's /clear moves its host to the new session before its first prompt, and the old one goes dormant", async () => {
	s = scenario("harnesses", "claude-clear", { packages: [], recorder: true, harnesses: ["claude"] });
	const first = await launched(s, "claude", "reply first session");
	const hostName = host(s, first.id);
	expect(first).toMatchObject({ harness: "claude", open: true, live: true, cwd: s.project, parentId: null, activity: "idle" });
	const [row] = s.query<{ transcript: string }>("select transcript from sessions where session_id = ?", first.id);
	expect(existsSync(row?.transcript as string)).toBe(true);
	await until(() => pane(s, first.id).includes("first session"), budgets.settle, "the reply on screen");
	type(s, first.id, "/clear");
	await until(
		() =>
			s
				.query<{ session_id: string }>("select session_id from runtimes where tmux_session = ?", hostName)
				.find((r) => r.session_id !== first.id),
		budgets.settle,
		"the host's new session",
	);
	expect(entry(s, first.id)).toMatchObject({ live: false, open: true });
});

test("the Deck's n opens on the default preset, puts its real TUI on the Stage, and shows its dormant conversation", async () => {
	s = scenario("harnesses", "deck", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const [first] = (await seed(s, { turns: ["first"] })) as [string];
	s.swb("drive", "start", "--size", "160x40");
	await waitState(s, "ready", (x) => x.ready);
	await cursorTo(s, first);
	s.keys("n");
	// With no shortlist written, the automatic one starts with Claude Code's own default.
	const opened = await waitState(s, "the picker on the default", (x) => x.picker?.harness === "claude");
	expect(opened.picker?.presets[0]).toBe("opus");
	// The launch card on the Stage says what runs: the harness, then the model.
	const card = await waitState(s, "the launch card", (x) => (x.launch?.card ?? null) !== null);
	expect(card.launch?.card?.[1]).toMatch(/Claude Code {2}opus/);
	// Tab drops the menu, a harness at a time; a number moves the card to Codex, and Esc in a reopened menu keeps it.
	s.keys("Tab");
	const menu = await waitState(s, "the menu", (x) => x.launch?.menu?.some((l) => l.includes("Codex")) ?? false);
	// The automatic shortlist takes turns, Claude Code's then Codex's; the menu gathers each harness's together.
	const shown = menu.picker?.menu?.shown ?? [];
	const gpts = shown.filter((label) => label.startsWith("gpt"));
	const codex = shown.indexOf(gpts[0] as string);
	expect(codex).toBeGreaterThan(0);
	expect(shown.slice(codex, codex + gpts.length)).toEqual(gpts);
	s.keys(String(codex + 1));
	await waitState(s, "Codex chosen", (x) => x.picker?.harness === "codex" && x.picker.menu === null);
	s.keys("Tab");
	await waitState(s, "the menu again", (x) => x.picker?.menu !== null);
	s.keys("Escape");
	const kept = await waitState(s, "the menu closed", (x) => x.picker?.menu === null && x.launch?.card?.[1]?.includes("Codex") === true);
	expect(kept.picker?.harness).toBe("codex");
	s.keys("Tab");
	await waitState(s, "the menu once more", (x) => x.picker?.menu !== null);
	s.keys("1");
	await waitState(s, "back on the default", (x) => x.picker?.harness === "claude" && x.picker.menu === null);
	s.save("picker.txt", s.screen());
	s.keys("Enter");
	const st = await waitState(s, "Claude on the Stage", (x) => x.staged.kind === "live" && x.focus === "stage", ready);
	const id = st.staged.id as string;
	await until(() => s.screen().includes("Claude Code"), budgets.settle, "Claude's TUI in the Stage");
	s.keys("-l", "reply SWB-from-the-deck");
	await Bun.sleep(300);
	s.keys("Enter");
	await until(() => s.ls().find((e) => e.id === id && e.harness === "claude" && e.activity === "idle"), ready, "Claude's turn recorded");
	await until(() => s.screen().includes("SWB-from-the-deck"), budgets.settle, "the reply in the Stage");
	s.save("claude-stage.txt", s.screen());

	s.tmux(s.servers.sessions, "kill-pane", "-t", s.pane(host(s, id)));
	await until(() => !entry(s, id).live, budgets.settle, "Claude dormant");
	s.keys("M-a", "h");
	await waitState(s, "the roster focused", (x) => x.focus === "roster");
	// A session that ends while staged shows as exited until the cursor leaves it.
	await cursorTo(s, first);
	await cursorTo(s, id);
	await waitState(s, "the dormant card", (x) => x.staged.kind === "dormant" && x.staged.id === id);
	await until(() => /claude\s+SWB-from-the-deck/.test(s.screen()), budgets.settle, "Claude's reply on the card, labelled claude");
	expect(s.screen()).toMatch(/ claude +editor +split/);
	expect(state(s).rows.some((r) => r.kind === "session" && r.id === id)).toBe(true);
	s.save("claude-card.txt", s.screen());
});

test("a Codex session whose app-server dies mid-turn ends with it, cut off as killed", async () => {
	s = scenario("harnesses", "codex-server-dies", { packages: [], recorder: true, harnesses: ["codex"] });
	const codex = await launched(s, "codex", "reply up");
	type(
		s,
		codex.id,
		`run echo entered > ${s.home}/e2e-signals/d1.entered; until [ -e ${s.home}/e2e-signals/d1.release ]; do sleep 0.1; done`,
	);
	await until(() => s.signal("d1.entered") !== "", ready, "the tool call running");
	const socket = `${host(s, codex.id)}.sock`;
	const server = Bun.spawnSync(["ps", "-eo", "pid=,args="])
		.stdout.toString()
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.find(([, command, verb, ...rest]) => command === `${s.bin}/codex` && verb === "app-server" && rest.join(" ").includes(socket));
	process.kill(Number(server?.[0]), "SIGKILL");
	await until(() => !entry(s, codex.id).live, budgets.settle, "the session ended, not reconnecting forever");
	expect(entry(s, codex.id).cutOff).toBe("killed");
	expect(commands().some((args) => args.includes(socket))).toBe(false);
	release(s, "d1");
});

test("a title set through swb_update_session becomes Codex's own name at once, and Claude Code's with its next prompt", async () => {
	s = scenario("harnesses", "titles", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const claude = await launched(s, "claude", "reply claude up");
	const codex = await launched(s, "codex", "reply codex up");
	const retitle = async (id: string, title: string) => {
		const proc = Bun.spawn([`${s.bin}/swb`, "update", "--from", id], {
			env: s.env,
			stdin: new Blob([JSON.stringify({ title })]),
			stdout: "pipe",
			stderr: "pipe",
		});
		if ((await proc.exited) !== 0) throw new Error(`swb update: ${await proc.stderr.text()}`);
	};
	// What the harness itself calls the session, as its line records it.
	const own = (id: string) => s.query<{ title: string | null }>("select title from sessions where session_id = ?", id)[0]?.title;

	await retitle(codex.id, "Codex renamed");
	await until(() => own(codex.id) === "Codex renamed", budgets.settle, "Codex's thread renamed");
	expect(s.query("select title from marks where session_id = ?", codex.id)).toEqual([{ title: null }]);

	await retitle(claude.id, "Claude renamed");
	expect(s.ls().find((e) => e.id === claude.id)?.title).toBe("Claude renamed");
	expect(own(claude.id)).not.toBe("Claude renamed");
	type(s, claude.id, "reply again");
	await until(() => own(claude.id) === "Claude renamed", ready, "Claude Code's own title");
	const [{ transcript }] = s.query<{ transcript: string }>("select transcript from sessions where session_id = ?", claude.id) as [
		{ transcript: string },
	];
	expect(readFileSync(transcript, "utf8")).toContain('"customTitle":"Claude renamed"');
	expect(s.query("select title from marks where session_id = ?", claude.id)).toEqual([{ title: null }]);
});

test("the picker keeps the preset I chose when the shortlist is reordered beneath it", async () => {
	s = scenario("harnesses", "picker-reorder", { packages: [], recorder: true, harnesses: ["claude"] });
	const pi = '[[presets]]\nharness = "pi"\nprovider = "faux"\nmodel = "faux-1"\neffort = "off"\n';
	const shortlist = (models: string[]) =>
		models
			.map((model, i) => `[[presets]]\nharness = "claude"\nmodel = "${model}"\n${i === 0 ? "default = true\n" : ""}`)
			.concat(pi)
			.join("\n");
	config(s, shortlist(["sonnet", "opus", "haiku"]));
	const [first] = (await seed(s, { turns: ["first"] })) as [string];
	s.swb("drive", "start", "--size", "160x40");
	await waitState(s, "ready", (x) => x.ready);
	await cursorTo(s, first);
	s.keys("n");
	await waitState(s, "the picker on the default", (x) => x.picker?.preset === "sonnet");
	s.keys("Tab");
	await waitState(s, "the menu", (x) => x.picker?.menu !== null);
	s.keys("2");
	await waitState(s, "opus chosen", (x) => x.picker?.preset === "opus" && x.picker.menu === null);
	config(s, shortlist(["sonnet", "haiku", "opus"]));
	await waitState(s, "the new order in the picker", (x) => x.picker?.presets.slice(0, 3).join() === "sonnet,haiku,opus");
	const st = state(s);
	expect(st.picker?.preset).toBe("opus");
	expect(st.launch?.card?.[1]).toMatch(/Claude Code {2}opus/);
});

test("session_launch with no preset carries the caller's harness and model forward, not the default", async () => {
	s = scenario("harnesses", "carry-forward", { packages: [], recorder: true, harnesses: ["claude"] });
	config(
		s,
		[
			["claude", "sonnet", "default = true"],
			["claude", "opus", ""],
		]
			.map(
				([harness, model, extra]) =>
					`[[presets]]\nharness = "${harness}"\nmodel = "${model}"\neffort = "medium"\nuse = "${model}"\n${extra}\n`,
			)
			.concat('[[presets]]\nharness = "pi"\nprovider = "faux"\nmodel = "faux-1"\neffort = "off"\nuse = "scripted"\n')
			.join("\n"),
	);
	const call = (title: string) => `call session_launch {"briefing":"reply ${title}","title":"${title}","report_back":false}`;
	/** The model of a Claude Code session's latest request, as its line saw it go out. */
	const claudeModel = (id: string) => s.query<{ model: string }>("select model from sessions where session_id = ?", id)[0]?.model;
	const child = (parent: string, title: string) =>
		until(() => s.ls().find((e) => e.parentId === parent && e.title === title && e.activity === "idle"), ready, `${title} launched`);

	const pi = await launched(s, "pi", call("from pi"));
	expect(await child(pi.id, "from pi")).toMatchObject({ harness: "pi" });

	const opus = await launched(s, "claude", call("from opus"), undefined, ["--model", "opus"]);
	expect(claudeModel(opus.id)).toContain("opus");
	const carried = await child(opus.id, "from opus");
	expect(carried.harness).toBe("claude");
	expect(claudeModel(carried.id)).toContain("opus");
});

test("session_launch and a scheduled launch, from pi, Claude Code, or Codex, start their child in the launcher's Group, the Group named, or none", async () => {
	s = scenario("harnesses", "launch-group", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const parents = await Promise.all(
		(["pi", "claude", "codex"] as const).map((harness) => launched(s, harness, `reply ${harness} up`, undefined, ["--group", "base"])),
	);
	expect(parents.map((p) => p.group)).toEqual(["base", "base", "base"]);
	const cases = [
		["kept", undefined, "base"],
		["named", "ops", "ops"],
		["none", null, null],
	] as const;
	for (const parent of parents)
		for (const [name, group, expected] of cases) {
			const title = `${parent.harness} ${name}`;
			const asked = group === undefined ? "" : `,"group":${JSON.stringify(group)}`;
			type(s, parent.id, `call session_launch {"harness":"pi","briefing":"reply ${title}","title":"${title}"${asked},"report_back":false}`);
			const child = await until(
				() => s.ls().find((e) => e.parentId === parent.id && e.title === title && e.activity === "idle"),
				ready,
				`${title} launched`,
			);
			expect(child.group).toBe(expected);
			await until(() => entry(s, parent.id).activity === "idle", ready, `${parent.harness} done launching ${name}`);
			s.tmux(s.servers.sessions, "kill-pane", "-t", s.pane(host(s, child.id)));
		}
	for (const parent of parents) {
		const title = `${parent.harness} scheduled`;
		type(
			s,
			parent.id,
			`call session_launch {"harness":"pi","briefing":"reply ${title}","title":"${title}","group":"night shift","report_back":false,"at":"PT1S","schedule_label":"now"}`,
		);
		await until(() => entry(s, parent.id).activity === "idle", ready, `${parent.harness} done scheduling`);
	}
	const fired = await until(
		() => {
			const children = s.ls().filter((e) => e.title?.endsWith(" scheduled") && e.activity === "idle");
			return children.length === 3 && children;
		},
		ready,
		"the scheduled launches",
	);
	expect(fired.map((e) => [e.title, e.group]).sort()).toEqual([
		["claude scheduled", "night shift"],
		["codex scheduled", "night shift"],
		["pi scheduled", "night shift"],
	]);
});

test("on a code-mode-only model, Codex offers swb's tools directly, beside its own subagents, and session_launch starts a session", async () => {
	s = scenario("harnesses", "code-mode", { packages: [], recorder: true, harnesses: ["codex"] });
	const parent = await launched(s, "codex", "reply up", undefined, ["--model", "gpt-6-sol"]);
	const [first] = s.requests("codex") as { model: string; tools: string[] }[];
	expect(first?.model).toBe("gpt-6-sol");
	expect(first?.tools).toEqual(expect.arrayContaining(["exec", "spawn_agent", "session_launch", "session_send_message"]));
	type(s, parent.id, `call session_launch {"harness":"pi","briefing":"reply from code mode","title":"from code mode","report_back":false}`);
	const child = await until(
		() => s.ls().find((e) => e.parentId === parent.id && e.title === "from code mode" && e.activity === "idle"),
		ready,
		"the child launched",
	);
	expect(child.harness).toBe("pi");
});

test("swb declares its MCP server in Codex's config.toml once, switched off, and only swb's own Codex sessions offer its tools", async () => {
	s = scenario("harnesses", "codex-declared", { packages: [], recorder: true, harnesses: ["codex"] });
	const path = join(s.home, ".codex/config.toml");
	const mine = readFileSync(path, "utf8");
	// Finding Codex declares it, below what was there.
	s.swb("models");
	const declared = readFileSync(path, "utf8");
	expect(declared.startsWith(mine)).toBe(true);
	expect((Bun.TOML.parse(declared) as { mcp_servers: unknown }).mcp_servers).toEqual({
		swb: { command: "swb", args: ["mcp", "--harness", "codex"], enabled: false },
	});
	const session = await launched(s, "codex", "reply up");
	// Codex writes its own settings in as it runs; swb's declaration stays the one it added.
	expect(readFileSync(path, "utf8").split("[mcp_servers.swb]").length).toBe(2);
	const requests = s.requests("codex") as { texts: string[]; tools: string[] }[];
	expect(requests.find((r) => r.texts.at(-1) === "reply up")?.tools).toContain("session_launch");
	// Codex's title request, on the thread that switches every MCP server off, still goes out and names the session.
	expect(requests.some((r) => r.texts.at(-1)?.startsWith("Generate a concise"))).toBe(true);
	await until(() => entry(s, session.id).title === "Up", ready, "Codex's own title");
	const plain = Bun.spawnSync([join(s.bin, "codex"), "exec", "--skip-git-repo-check", "reply plain"], { env: s.env, cwd: s.project });
	expect(plain.exitCode).toBe(0);
	const outside = (s.requests("codex") as { texts: string[]; tools: string[] }[]).find((r) => r.texts.at(-1) === "reply plain");
	expect(outside?.tools).toContain("exec_command");
	expect(outside?.tools).not.toContain("session_launch");
});

test("on a fresh install, swb new starts the automatic shortlist's default, Claude Code, once its models are listed", async () => {
	s = scenario("harnesses", "first-new", { packages: [], recorder: true, harnesses: ["claude"] });
	expect(existsSync(join(s.env.XDG_STATE_HOME as string, "agent-switchboard", "catalog.json"))).toBe(false);
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the new session live", (x) => x.staged.kind === "live", budgets.piReady);
	const started = s.tmux(s.servers.sessions, "list-panes", "-a", "-F", "#{pane_start_command}");
	expect(started).toMatch(/-lic 'exec \S*claude/);
});

test("a Claude Code session's effort carries into what it launches, live or dormant, and survives a wake", async () => {
	s = scenario("harnesses", "claude-effort", { packages: [], recorder: true, harnesses: ["claude"] });
	config(
		s,
		[
			["sonnet", "medium", "default = true"],
			["opus", "medium", ""],
			["opus", "high", ""],
		]
			.map(([model, effort, extra]) => `[[presets]]\nharness = "claude"\nmodel = "${model}"\neffort = "${effort}"\n${extra}\n`)
			.join("\n"),
	);
	/** The model and effort of a session's latest request, as its line saw it go out. */
	const runs = (id: string) => s.query<{ model: string; effort: string }>("select model, effort from sessions where session_id = ?", id)[0];
	const call = (title: string) => `call session_launch {"briefing":"reply ${title}","title":"${title}","report_back":false}`;

	const opus = await launched(s, "claude", call("live"), undefined, ["--model", "opus", "--effort", "high"]);
	expect(runs(opus.id)).toEqual({ model: expect.stringContaining("opus"), effort: "high" });
	const live = await until(
		() => s.ls().find((e) => e.parentId === opus.id && e.title === "live" && e.activity === "idle"),
		ready,
		"the live caller's launch",
	);
	expect(runs(live.id)).toEqual({ model: expect.stringContaining("opus"), effort: "high" });

	s.swb("quit");
	await until(() => s.ls().every((e) => !e.live), 30_000, "every session to stop");
	const dormant = await launched(s, null, "reply dormant", opus.id);
	expect(runs(dormant.id)).toEqual({ model: expect.stringContaining("opus"), effort: "high" });

	expect((await send(s, dormant.id, opus.id, "reply woken")).text).toBeTruthy();
	await until(
		() =>
			s.requests("claude").some((r) => String(r.prompt).includes("reply woken")) &&
			s.ls().find((e) => e.id === opus.id && e.live && e.activity === "idle"),
		ready,
		"the woken caller's turn",
	);
	expect(runs(opus.id)).toEqual({ model: expect.stringContaining("opus"), effort: "high" });
});
