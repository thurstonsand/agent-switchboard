import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { commands, host, launched, pane, ready, send, type } from "./harness/agents.ts";
import { cursorTo, entry, seed, state, waitState } from "./harness/deck.ts";
import { budgets, release, type Scenario, scenario, until } from "./harness/index.ts";

// Claude Code and Codex, as swb hosts them: the real TUIs in the sessions server, scripted by fake model servers.

let s: Scenario;
afterEach(async () => {
	try {
		for (const { session_id, tmux_session } of s.query<{ session_id: string; tmux_session: string }>(
			"select session_id, tmux_session from runtimes",
		))
			s.save(`pane-${session_id}.txt`, s.tmux(s.servers.sessions, "capture-pane", "-p", "-J", "-S", "-200", "-t", `=${tmux_session}:`));
		s.save("ls.json", JSON.stringify(s.ls(), null, 2));
		for (const harness of ["claude", "codex"] as const) s.save(`${harness}-requests.json`, JSON.stringify(s.requests(harness), null, 1));
	} catch {}
	await s.cleanup();
});

test("a Claude Code session is recorded from its first turn to idle, with its transcript, title, and pid", async () => {
	s = scenario("harnesses", "claude-lifecycle", { packages: [], recorder: true, harnesses: ["claude"] });
	const claude = await launched(s, "claude", "reply hello from claude");
	expect(claude).toMatchObject({ harness: "claude", open: true, live: true, cwd: s.project, parentId: null });
	const [row] = s.query<{ transcript: string; phase: string }>("select transcript, phase from sessions where session_id = ?", claude.id);
	expect(row?.phase).toBe("idle");
	expect(existsSync(row?.transcript as string)).toBe(true);
	await until(() => pane(s, claude.id).includes("hello from claude"), budgets.settle, "the reply on screen");
	s.save("claude.txt", pane(s, claude.id));
});

test("a Codex session binds to the thread its TUI shows, and is recorded from its first turn to idle", async () => {
	s = scenario("harnesses", "codex-lifecycle", { packages: [], recorder: true, harnesses: ["codex"] });
	const codex = await launched(s, "codex", "reply hello from codex");
	expect(codex).toMatchObject({ harness: "codex", open: true, live: true, cwd: s.project });
	expect(s.tmux(s.servers.sessions, "display", "-p", "-t", `=${host(s, codex.id)}:`, "#{pane_title}")).toStartWith(codex.id.slice(0, 29));
	await until(() => pane(s, codex.id).includes("hello from codex"), budgets.settle, "the reply on screen");
	await until(
		() => s.ls().find((x) => x.id === codex.id)?.title === "Hello from codex",
		budgets.settle,
		"titled by Codex's own title generator",
	);
	s.save("codex.txt", pane(s, codex.id));
});

test("Codex's /new moves its host to the new thread: that one is recorded, and the old one goes dormant", async () => {
	s = scenario("harnesses", "codex-new", { packages: [], recorder: true, harnesses: ["codex"] });
	const first = await launched(s, "codex", "reply first thread");
	const hostName = host(s, first.id);
	type(s, first.id, "/new");
	await Bun.sleep(1000);
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${hostName}:`, "-l", "reply second thread");
	await Bun.sleep(300);
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${hostName}:`, "Enter");
	const second = await until(
		() => s.ls().find((e) => e.harness === "codex" && e.id !== first.id && e.activity === "idle" && e.title !== null),
		ready,
		"the new thread's first turn recorded and titled",
	);
	expect(second).toMatchObject({ live: true, open: true, title: "Second thread" });
	expect(entry(s, first.id)).toMatchObject({ live: false, open: true });
	expect(s.tmux(s.servers.sessions, "display", "-p", "-t", `=${hostName}:`, "#{pane_title}")).toStartWith(second.id.slice(0, 29));
	// Messages follow the thread the pane shows now.
	expect((await send(s, first.id, second.id, "SWB-after-new please ack")).details.delivered).toBe(true);
	await until(
		() => s.tmux(s.servers.sessions, "capture-pane", "-p", "-t", `=${hostName}:`).includes("got SWB-after-new"),
		ready,
		"the new thread answering",
	);
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

	s.tmux(s.servers.sessions, "kill-session", "-t", `=${host(s, id)}`);
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
