import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config, cursorTo, entry, seed, state, waitState } from "./harness/deck.ts";
import { budgets, type LsEntry, release, type Scenario, scenario, until } from "./harness/index.ts";

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

const ready = 60_000;

/** Starts a session in a harness the way session_launch does, and returns its row once its first turn has settled. */
async function launched(harness: "pi" | "claude" | "codex", goal: string, from?: string): Promise<LsEntry> {
	const out = JSON.parse(
		await Bun.spawn([`${s.bin}/swb`, "launch", "--harness", harness, "--cwd", s.project, ...(from ? ["--from", from] : [])], {
			env: s.env,
			cwd: s.project,
			stdin: new Blob([goal]),
			stdout: "pipe",
			stderr: "inherit",
		}).stdout.text(),
	) as { details: { id: string } };
	const id = out.details.id;
	return until(() => s.ls().find((e) => e.id === id && e.activity === "idle"), ready, `the ${harness} session's first turn to settle`);
}

/** Sends a message the way session_send_message does, from a session, and returns swb's receipt. */
async function send(from: string, to: string, body: string): Promise<{ text: string; details: { delivered: boolean } }> {
	const proc = Bun.spawn([`${s.bin}/swb`, "send", "--from", from, "--to", to], {
		env: s.env,
		cwd: s.project,
		stdin: new Blob([body]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	if (code !== 0) throw new Error(`swb send: ${err}`);
	return JSON.parse(out);
}

function host(id: string): string {
	return s.query<{ tmux_session: string }>("select tmux_session from runtimes where session_id = ?", id)[0]?.tmux_session as string;
}

/** Every running process's command line. */
function commands(): string[] {
	return Bun.spawnSync(["ps", "-eo", "args="]).stdout.toString().split("\n");
}

function pane(id: string): string {
	return s.tmux(s.servers.sessions, "capture-pane", "-p", "-J", "-S", "-500", "-t", `=${host(id)}:`);
}

test("a Claude Code session is recorded from its first turn to idle, with its transcript, title, and pid", async () => {
	s = scenario("harnesses", "claude-lifecycle", { packages: [], recorder: true, harnesses: ["claude"] });
	const claude = await launched("claude", "reply hello from claude");
	expect(claude).toMatchObject({ harness: "claude", open: true, live: true, cwd: s.project, parentId: null });
	const [row] = s.query<{ transcript: string; phase: string }>("select transcript, phase from sessions where session_id = ?", claude.id);
	expect(row?.phase).toBe("idle");
	expect(existsSync(row?.transcript as string)).toBe(true);
	await until(() => pane(claude.id).includes("hello from claude"), budgets.settle, "the reply on screen");
	s.save("claude.txt", pane(claude.id));
});

test("a Codex session binds to the thread its TUI shows, and is recorded from its first turn to idle", async () => {
	s = scenario("harnesses", "codex-lifecycle", { packages: [], recorder: true, harnesses: ["codex"] });
	const codex = await launched("codex", "reply hello from codex");
	expect(codex).toMatchObject({ harness: "codex", open: true, live: true, cwd: s.project });
	expect(s.tmux(s.servers.sessions, "display", "-p", "-t", `=${host(codex.id)}:`, "#{pane_title}")).toStartWith(codex.id.slice(0, 29));
	await until(() => pane(codex.id).includes("hello from codex"), budgets.settle, "the reply on screen");
	await until(
		() => s.ls().find((x) => x.id === codex.id)?.title === "Hello from codex",
		budgets.settle,
		"titled by Codex's own title generator",
	);
	s.save("codex.txt", pane(codex.id));
});

test("Claude Code waiting on a permission prompt reads as blocked, and an upgrade's stop keeps its unsent draft", async () => {
	s = scenario("harnesses", "claude-blocked", { packages: [], recorder: true, harnesses: ["claude"] });
	const claude = await launched("claude", "reply claude up");
	const note = `${s.project}/note.txt`;
	type(claude.id, `call Write {"file_path":"${note}","content":"hi"}`);
	await until(() => entry(s, claude.id).activity === "blocked", budgets.settle, "Claude blocked on the prompt");
	// Blocked is recorded before the dialog shows, and Claude Code drops a key sent the moment it does.
	await until(() => pane(claude.id).includes("Do you want to create note.txt?"), budgets.settle, "the permission dialog");
	Bun.sleepSync(1000);
	s.save("blocked.txt", pane(claude.id));
	// The first choice allows it.
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(claude.id)}:`, "Enter");
	await until(() => entry(s, claude.id).activity === "idle", budgets.settle, "Claude's turn done");
	expect(existsSync(note)).toBe(true);

	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(claude.id)}:`, "-l", "half a thought");
	await until(() => pane(claude.id).includes("half a thought"), budgets.settle, "the draft typed");
	// A newer swb stops idle sessions, as an upgrade does.
	s.tmux(s.servers.sessions, "set", "-gu", "@swb_version");
	s.swb("drive", "start");
	await until(() => !entry(s, claude.id).live, budgets.settle, "Claude stopped");
	s.swb("wake", claude.id);
	await until(() => entry(s, claude.id).live && pane(claude.id).includes("half a thought"), ready, "the draft back");
	s.save("draft-restored.txt", pane(claude.id));

	// A prompt cleared, or sent, is no draft for the next stop to keep.
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(claude.id)}:`, "-l", ", finished");
	await until(() => pane(claude.id).includes("half a thought, finished"), budgets.settle, "the draft edited");
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(claude.id)}:`, "Escape");
	Bun.sleepSync(300);
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(claude.id)}:`, "Escape");
	await until(() => !pane(claude.id).includes("half a thought"), budgets.settle, "the draft cleared");
	s.tmux(s.servers.sessions, "set", "-gu", "@swb_version");
	s.swb("drive", "start");
	await until(() => !entry(s, claude.id).live, budgets.settle, "Claude stopped again");
	expect(readFileSync(`${s.env.XDG_STATE_HOME}/agent-switchboard/drafts/${claude.id}`, "utf8")).toBe("");
});

test("Codex's /new moves its host to the new thread: that one is recorded, and the old one goes dormant", async () => {
	s = scenario("harnesses", "codex-new", { packages: [], recorder: true, harnesses: ["codex"] });
	const first = await launched("codex", "reply first thread");
	const hostName = host(first.id);
	type(first.id, "/new");
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
	expect((await send(first.id, second.id, "SWB-after-new please ack")).details.delivered).toBe(true);
	await until(
		() => s.tmux(s.servers.sessions, "capture-pane", "-p", "-t", `=${hostName}:`).includes("got SWB-after-new"),
		ready,
		"the new thread answering",
	);
});

test("an idle Codex session nobody is viewing is reaped after reap_after, as pi and Claude Code are", async () => {
	s = scenario("harnesses", "codex-reap", { packages: [], recorder: true, harnesses: ["codex"] });
	const [other] = (await seed(s, { turns: ["first"] })) as [string];
	const codex = await launched("codex", "reply codex up");
	const hostName = host(codex.id);
	config(s, 'reap_after = "2s"\n');
	s.swb("drive", "start");
	await waitState(s, "ready", (x) => x.ready);
	await cursorTo(s, other);
	await until(() => !entry(s, codex.id).live, 15_000, "Codex reaped");
	expect(entry(s, codex.id)).toMatchObject({ open: true, cutOff: null });
	// Launched outside this Deck, its pane stays on exit until the Deck's orphan sweep, ten seconds on, closes it.
	await until(
		() => !s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name}").split("\n").includes(hostName),
		10_000 + budgets.settle,
		"its pane closed",
	);
});

test("an Operator in Claude Code or Codex reads the Operator AGENTS.md, not the ones above it, and has no subagents", async () => {
	s = scenario("harnesses", "operators", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const operator = join(s.env.XDG_CONFIG_HOME as string, "agent-switchboard", "operator");
	mkdirSync(operator, { recursive: true });
	writeFileSync(join(s.home, ".claude", "CLAUDE.md"), "SWB-USER-CLAUDE-MD\n");
	writeFileSync(join(s.env.XDG_CONFIG_HOME as string, "AGENTS.md"), "SWB-ANCESTOR-AGENTS-MD\n");
	// Claude Code asks once whether to trust a folder, as for any project. Codex's trust comes from swb.
	const claudeJson = join(s.home, ".claude.json");
	const trusted = JSON.parse(readFileSync(claudeJson, "utf8")) as { projects: Record<string, unknown> };
	trusted.projects[operator] = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
	writeFileSync(claudeJson, JSON.stringify(trusted));
	// Subagents on in the user's Codex config, which the Operator turns off.
	appendFileSync(join(s.home, ".codex", "config.toml"), "\n[features]\nmulti_agent_v2 = true\n");
	await seed(s, { turns: ["work"] });
	s.swb("drive", "start", "--size", "160x40");
	await waitState(s, "ready", (x) => x.ready);

	// n opens on the default preset, Claude Code's; Tab steps to Codex's.
	for (const [harness, tabs] of [
		["claude", 0],
		["codex", 1],
	] as const) {
		s.keys("M-a", "h");
		await waitState(s, "the roster focused", (x) => x.focus === "roster");
		s.keys("g");
		await waitState(s, "cursor on the Operators section", (x) => x.cursorRow === 0);
		s.keys("n");
		await waitState(s, "the picker", (x) => x.picker !== null);
		for (let i = 0; i < tabs; i++) s.keys("Tab");
		await waitState(s, `${harness} picked`, (x) => x.picker?.harness === harness);
		s.keys("Enter");
		const st = await waitState(s, `the ${harness} Operator live`, (x) => x.staged.kind === "live" && x.focus === "stage", ready);
		const id = st.staged.id as string;
		await Bun.sleep(1500);
		s.keys("-l", `reply ${harness} operator up`);
		await Bun.sleep(300);
		s.keys("Enter");
		await until(() => s.ls().find((e) => e.id === id && e.activity === "idle"), ready, `the ${harness} Operator's first turn`);
		expect(entry(s, id)).toMatchObject({ harness, operator: true, cwd: operator });

		const turn = s
			.requests(harness)
			.find((r) => (r.tools as unknown[]).length > 0 && String(r.context).includes(`${harness} operator up`)) as {
			context: string;
			tools: unknown[];
		};
		expect(turn.context).toContain("You are an Operator");
		expect(turn.context).not.toContain("SWB-ANCESTOR-AGENTS-MD");
		const tools = turn.tools.map(String);
		expect(tools.some((name) => name.endsWith("session_launch"))).toBe(true);
		if (harness === "claude") {
			expect(turn.context).not.toContain("SWB-USER-CLAUDE-MD");
			expect(tools).not.toContain("Agent");
		} else {
			expect(tools.filter((name) => /_agent/.test(name))).toEqual([]);
		}
	}
	s.save("operators.txt", s.screen());
});

/** Types a prompt into a session's own TUI, as a person would. */
function type(id: string, text: string): void {
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(id)}:`, "-l", text);
	Bun.sleepSync(300);
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(id)}:`, "Enter");
}

const sawMarker = (harness: "claude" | "codex", marker: string) => s.requests(harness).some((r) => JSON.stringify(r).includes(marker));

test("pi, Claude Code, and Codex message each other: idle sessions start a turn, working ones take it mid-turn", async () => {
	s = scenario("harnesses", "matrix", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const [pi, claude, codex] = await Promise.all([
		launched("pi", "reply pi-up"),
		launched("claude", "reply claude up"),
		launched("codex", "reply codex up"),
	]);

	// Idle: the message is the next turn, in every direction.
	expect((await send(claude.id, pi.id, "reply SWB-c2p")).details.delivered).toBe(true);
	await until(() => s.signal("replied.SWB-c2p") !== "", budgets.settle, "pi's answer to Claude");
	expect((await send(codex.id, claude.id, "SWB-x2c please ack")).details.delivered).toBe(true);
	await until(() => pane(claude.id).includes("got SWB-x2c please ack"), budgets.settle, "Claude's answer to Codex");
	expect((await send(pi.id, codex.id, "SWB-p2x please ack")).details.delivered).toBe(true);
	await until(() => pane(codex.id).includes("got SWB-p2x please ack"), budgets.settle, "Codex's answer to pi");
	s.save("idle.txt", [pane(pi.id), pane(claude.id), pane(codex.id)].join("\n=====\n"));

	// Working: each is held in a tool call when the message lands.
	type(claude.id, "hold c1");
	await until(() => s.signal("c1.entered") !== "", ready, "Claude holding");
	const toClaude = send(pi.id, claude.id, "SWB-mid-claude change course");
	await Bun.sleep(1000);
	release(s, "c1");
	expect((await toClaude).details.delivered).toBe(true);
	// Read in the same turn, right after the held tool's result.
	await until(
		() => s.requests("claude").find((r) => r.prompt === "hold c1" && String(r.lastText).includes("SWB-mid-claude")),
		budgets.settle,
		"Claude's next request in that turn to carry the message",
	);
	await until(() => pane(claude.id).includes("swb:"), budgets.settle, "Claude's visible receipt");

	type(codex.id, "hold x1");
	await until(() => s.signal("x1.entered") !== "", ready, "Codex holding");
	expect((await send(claude.id, codex.id, "SWB-mid-codex change course")).details.delivered).toBe(true);
	release(s, "x1");
	await until(() => sawMarker("codex", "SWB-mid-codex"), budgets.settle, "the steer in Codex's next request");
	await until(() => entry(s, codex.id).activity === "idle", budgets.settle, "Codex idle");

	type(pi.id, "hold p1");
	await until(() => s.signal("p1.entered") !== "", ready, "pi holding");
	expect((await send(codex.id, pi.id, "reply SWB-mid-pi")).details.delivered).toBe(true);
	release(s, "p1");
	await until(() => s.signal("replied.SWB-mid-pi") !== "", budgets.settle, "pi answering the steer");
	s.save("mid-turn.txt", [pane(pi.id), pane(claude.id), pane(codex.id)].join("\n=====\n"));
});

test("a message Codex refuses mid-compaction is delivered once the compaction ends, with nothing else written", async () => {
	s = scenario("harnesses", "codex-compact", { packages: [], recorder: true, harnesses: ["codex"] });
	const [pi, codex] = await Promise.all([launched("pi", "reply pi-up"), launched("codex", "hold-compact k1")]);
	type(codex.id, "/compact");
	await until(() => s.signal("k1.entered") !== "", ready, "Codex compacting");
	// A compact turn can't be steered, so this turn/start fails; the next poll has no new db write to wake it.
	const sent = send(pi.id, codex.id, "SWB-after-compact please ack");
	await Bun.sleep(2000);
	release(s, "k1");
	expect((await sent).details.delivered).toBe(true);
	await until(() => pane(codex.id).includes("got SWB-after-compact please ack"), budgets.settle, "Codex answering after the compaction");
	s.save("compact.txt", pane(codex.id));
});

test("swb adopt tracks Claude Code and Codex sessions run outside swb, and wakes each on its own conversation", async () => {
	s = scenario("harnesses", "adopt", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const outside = (argv: string[]) => {
		const proc = Bun.spawnSync(argv, { cwd: s.project, env: s.env, stdout: "pipe", stderr: "pipe" });
		if (proc.exitCode !== 0)
			throw new Error(`${argv[0]} exited ${proc.exitCode}: ${proc.stderr.toString().slice(-1500)}${proc.stdout.toString().slice(-1500)}`);
	};
	outside([join(s.bin, "claude"), "-p", "reply claude outside"]);
	outside([join(s.bin, "codex"), "exec", "--skip-git-repo-check", "reply codex outside"]);
	const [claudeFile] = [...new Bun.Glob("*/*.jsonl").scanSync({ cwd: join(s.home, ".claude/projects"), absolute: true })];
	const [codexFile] = [...new Bun.Glob("sessions/*/*/*/rollout-*.jsonl").scanSync({ cwd: join(s.home, ".codex"), absolute: true })];
	const ids = {
		claude: basename(claudeFile as string, ".jsonl"),
		codex: /([0-9a-f-]{36})\.jsonl$/.exec(codexFile as string)?.[1] as string,
	};
	expect(s.ls()).toHaveLength(0);

	for (const harness of ["claude", "codex"] as const) {
		const id = ids[harness];
		s.swb("drive", "start", "--", "adopt", id);
		await waitState(s, `the adopted ${harness} session on the Stage`, (x) => x.cursor === id && x.staged.kind === "dormant");
		expect(entry(s, id)).toMatchObject({ harness, open: true, live: false, cutOff: null, cwd: s.project });
		s.keys("Enter");
		await waitState(s, `${harness} live`, (x) => x.staged.id === id && x.staged.kind === "live", ready);
		await until(() => pane(id).includes(`${harness} outside`), ready, `${harness}'s outside conversation on screen`);
		type(id, `reply ${harness} inside`);
		// The model is asked inside swb with the conversation from outside it.
		await until(
			() =>
				s
					.requests(harness)
					.some(
						(r) =>
							String(r.prompt ?? (r.texts as string[]).at(-1)) === `reply ${harness} inside` &&
							String(r.context).includes(`${harness} outside`),
					),
			ready,
			`${harness}'s turn inside swb, on its outside conversation`,
		);
		await until(() => entry(s, id).activity === "idle", ready, `${harness} idle`);
		s.save(`adopted-${harness}.txt`, pane(id));
		s.swb("drive", "stop");
	}
	expect(s.swbTry("adopt", ids.claude).err.trim()).toBe(`swb: adopt: ${ids.claude} is already tracked; swb open ${ids.claude}`);
});

test("agents use swb's tools across harnesses: list, message, launch, and cancel, with the caller as the sender", async () => {
	s = scenario("harnesses", "agents", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const [pi, claude, codex] = await Promise.all([
		launched("pi", "reply pi-up"),
		launched("claude", "reply claude up"),
		launched("codex", "reply codex up"),
	]);

	type(claude.id, `call session_reachable {}`);
	const listed = await until(
		() => s.requests("claude").find((r) => String(r.toolOutput).includes("Open sessions")),
		budgets.settle,
		"Claude's listing",
	);
	expect(String(listed.toolOutput)).toContain(`${codex.id} · Codex`);
	expect(String(listed.toolOutput)).toContain(`${pi.id} · pi`);
	expect(String(listed.toolOutput)).not.toContain(`${claude.id} ·`);

	type(claude.id, `call session_send_message {"session":"${codex.id}","message":"SWB-claude-asks codex","requestResponse":false}`);
	await until(() => pane(codex.id).includes("got SWB-claude-asks codex"), ready, "Codex answering Claude's tool call");
	const sent = s.query<{ source_id: string; delivered_at: number | null }>(
		"select source_id, delivered_at from messages where body like '%SWB-claude-asks%'",
	);
	expect(sent).toEqual([{ source_id: claude.id, delivered_at: expect.any(Number) }]);

	// Codex runs swb's MCP server with only the variables it forwards; it must still see the others as live.
	type(codex.id, `call session_reachable {}`);
	const fromCodex = await until(
		() => s.requests("codex").find((r) => String(r.toolOutput).includes('{"sessions":')),
		budgets.settle,
		"Codex's listing",
	);
	const seen = JSON.parse(/\{"sessions":.*\}/.exec(String(fromCodex.toolOutput))?.[0] ?? "{}") as {
		sessions: { id: string; live: boolean }[];
	};
	expect(seen.sessions.map(({ id, live }) => ({ id, live })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
		[pi.id, claude.id].sort().map((id) => ({ id, live: true })),
	);

	type(codex.id, `call session_send_message {"session":"${pi.id}","message":"reply SWB-codex-asks-pi","requestResponse":false}`);
	await until(() => s.signal("replied.SWB-codex-asks-pi") !== "", ready, "pi answering Codex's tool call");
	expect(s.query("select source_id from messages where body = 'reply SWB-codex-asks-pi'")).toEqual([{ source_id: codex.id }]);

	type(pi.id, `call session_send_message {"session":"${claude.id}","message":"SWB-pi-asks claude","requestResponse":false}`);
	await until(() => pane(claude.id).includes("got SWB-pi-asks claude"), ready, "Claude answering pi's tool call");

	// A launch from Claude starts a Codex session whose parent is Claude.
	type(
		claude.id,
		`call session_launch {"harness":"codex","goal":"SWB-launched do the thing","title":"launched by claude","requestResponse":false}`,
	);
	const child = await until(() => s.ls().find((e) => e.parentId === claude.id), ready, "the launched Codex session");
	expect(child).toMatchObject({ harness: "codex", cwd: s.project });
	await until(() => pane(child.id).includes("got SWB-launched do the thing"), ready, "the launched session working on its goal");

	// Cancel from pi stops Codex's held turn.
	type(codex.id, "hold x2");
	await until(() => s.signal("x2.entered") !== "", ready, "Codex holding");
	type(pi.id, `call session_cancel {"session":"${codex.id}"}`);
	await until(() => entry(s, codex.id).activity === "idle", budgets.settle, "Codex's turn stopped");
	release(s, "x2");
	s.save("agents.txt", [pane(pi.id), pane(claude.id), pane(codex.id), pane(child.id)].join("\n=====\n"));
});

test("a message to a dormant Claude Code or Codex session wakes it on its own conversation and delivers", async () => {
	s = scenario("harnesses", "wake", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const [pi, claude, codex] = await Promise.all([
		launched("pi", "reply pi-up"),
		launched("claude", "reply SWB-first-claude"),
		launched("codex", "reply SWB-first-codex"),
	]);
	for (const target of [claude, codex]) {
		const harness = target.harness as "claude" | "codex";
		s.tmux(s.servers.sessions, "kill-session", "-t", `=${host(target.id)}`);
		await until(() => !entry(s, target.id).live, budgets.settle, `${harness} dormant`);
		const receipt = await send(pi.id, target.id, `SWB-wake-${harness} are you there`);
		expect(receipt.details).toMatchObject({ delivered: true, woke: true });
		await until(() => pane(target.id).includes(`got SWB-wake-${harness} are you there`), ready, `${harness} answering`);
		// The request that answered the wake still carries the session's first turn: it resumed, not started over.
		const answering = s.requests(harness).filter((r) => JSON.stringify(r).includes(`SWB-wake-${harness}`));
		expect(answering.length).toBeGreaterThan(0);
		expect(JSON.stringify(answering[0])).toContain(`SWB-first-${harness}`);
		expect(s.ls().filter((e) => e.harness === harness)).toHaveLength(1);
		s.save(`woken-${harness}.txt`, pane(target.id));
	}
});

test("Codex's own /archive archives in swb, and a Claude session archiving itself quits when its turn ends", async () => {
	s = scenario("harnesses", "archive", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const [claude, codex] = await Promise.all([launched("claude", "reply claude up"), launched("codex", "reply codex up")]);

	type(codex.id, "/archive");
	await until(() => pane(codex.id).includes("Archive this session"), budgets.settle, "Codex asking to confirm");
	// The digit picks "Yes, archive" at once.
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(codex.id)}:`, "2");
	await until(() => !entry(s, codex.id).open && !entry(s, codex.id).live, budgets.settle, "Codex archived in swb and stopped");
	// Codex moved its rollout to archived_sessions/; the card still reads it.
	s.swb("drive", "start", "--size", "160x40");
	await waitState(s, "ready", (x) => x.ready);
	s.keys("G", "l", "j");
	await waitState(s, "the archived card", (x) => x.staged.id === codex.id && x.staged.kind === "dormant");
	await until(() => /codex\s+codex up/.test(s.screen()), budgets.settle, "Codex's reply on the archived card");
	s.save("codex-archived-card.txt", s.screen());
	// swb's unarchive unarchives in Codex too: the rollout is back where Codex resumes it from.
	const [{ transcript }] = s.query<{ transcript: string }>("select transcript from sessions where session_id = ?", codex.id) as [
		{ transcript: string },
	];
	expect(existsSync(transcript)).toBe(false);
	s.swb("unarchive", codex.id);
	expect(entry(s, codex.id).open).toBe(true);
	expect(existsSync(transcript)).toBe(true);

	type(claude.id, `call swb_update_session {"archived":true}`);
	await until(() => !entry(s, claude.id).open && !entry(s, claude.id).live, ready, "Claude archived and quit");
	expect(entry(s, claude.id).cutOff).toBeNull();

	// pi archiving itself from its shell, not its tool, quits when the turn ends too.
	const pi = await launched("pi", "reply pi up");
	type(pi.id, `call bash {"command":"${s.bin}/swb archive ${pi.id} --from ${pi.id}"}`);
	await until(() => !entry(s, pi.id).open && !entry(s, pi.id).live, ready, "pi archived and quit");
	expect(entry(s, pi.id).cutOff).toBeNull();
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

	s.tmux(s.servers.sessions, "kill-session", "-t", `=${host(id)}`);
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

for (const harness of ["pi", "claude", "codex"] as const)
	test(`a dormant ${harness} session's card ends where its last turn stopped: cut off, stopped, or errored; waking it continues only a cut-off turn`, async () => {
		s = scenario("harnesses", `endings-${harness}`, { packages: [], recorder: true, harnesses: harness === "pi" ? [] : [harness] });
		const [cut, quit, stopped, failed] = (await Promise.all(
			["cut", "quit", "stopped", "failed"].map((name) => launched(harness, `reply ${name}`)),
		)) as [LsEntry, LsEntry, LsEntry, LsEntry];
		const held = (name: string) =>
			`run echo entered > ${s.home}/e2e-signals/${name}.entered; until [ -e ${s.home}/e2e-signals/${name}.release ]; do sleep 0.1; done`;
		type(cut.id, held("k1"));
		type(quit.id, held("q1"));
		type(stopped.id, held("e1"));
		type(failed.id, "fail boom");
		await until(() => ["k1", "q1", "e1"].every((name) => s.signal(`${name}.entered`) !== ""), ready, "the tool calls running");
		// Claude Code writes its transcript a few seconds behind.
		await Bun.sleep(5000);
		const pid = (id: string) => (s.query<{ pid: number }>("select pid from runtimes where session_id = ?", id)[0] as { pid: number }).pid;
		const socket = `${host(cut.id)}.sock`;
		process.kill(pid(cut.id), "SIGKILL");
		if (harness === "codex")
			await until(
				() =>
					!commands().some(
						(args) => (args.includes(socket) && args.includes("app-server")) || args.includes(`${s.home}/e2e-signals/k1.release`),
					),
				budgets.settle,
				"the app-server and its tool gone with their host",
			);
		// What swb quit --force sends.
		process.kill(pid(quit.id), "SIGTERM");
		s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(stopped.id)}:`, "Escape");
		await until(
			() =>
				!entry(s, cut.id).live &&
				!entry(s, quit.id).live &&
				entry(s, stopped.id).activity === "idle" &&
				entry(s, failed.id).activity === "idle",
			ready,
			"one killed, one shut down, one stopped, one failed",
		);
		expect([entry(s, cut.id).cutOff, entry(s, quit.id).cutOff]).toEqual(["killed", "shutdown"]);
		// Errored, live or not, marks its row as a cut-off one does; stopped doesn't.
		expect([cut, quit, stopped, failed].map(({ id }) => entry(s, id).errored)).toEqual([false, false, false, true]);
		for (const { id } of [stopped, failed]) s.tmux(s.servers.sessions, "kill-session", "-t", `=${host(id)}`);
		await until(() => !entry(s, stopped.id).live && !entry(s, failed.id).live, budgets.settle, "both dormant");
		expect([entry(s, stopped.id).cutOff, entry(s, failed.id).cutOff]).toEqual([null, null]);

		s.swb("drive", "start");
		const glyphs = await waitState(s, "every row", (x) => x.rows.filter((r) => r.kind === "session").length === 4);
		const glyphOf = (id: string) => glyphs.rows.flatMap((r) => (r.kind === "session" && r.id === id ? [r.glyph] : []))[0];
		expect([cut, quit, stopped, failed].map(({ id }) => glyphOf(id))).toEqual(["⚠", "⚠", "●", "⚠"]);
		const card = async (id: string, ...want: string[]) => {
			await cursorTo(s, id);
			await until(() => want.every((text) => s.screen().includes(text)), budgets.settle, want.join(", "));
			return s.screen();
		};
		const cutCard = await card(cut.id, "─ cut off ─", "$ echo entered", "cut off · killed · waking continues it");
		s.save("cut.txt", cutCard);
		s.save("quit.txt", await card(quit.id, "─ cut off ─", "$ echo entered", "cut off · shut down"));
		const stoppedCard = await card(stopped.id, "─ stopped ─", "$ echo entered");
		s.save("stopped.txt", stoppedCard);
		const failedCard = await card(failed.id, "─ errored ─", "invalid request: boom");
		s.save("failed.txt", failedCard);
		expect(stoppedCard).not.toContain("─ cut off ─");
		expect(failedCard).not.toContain("$ echo entered");
		for (const name of ["k1", "q1", "e1"]) release(s, name);

		// Waking the cut-off session starts a turn that picks its last one back up; waking the stopped one doesn't.
		const prompted = (id: string) =>
			(s.query<{ at: number }>("select last_prompt_at as at from sessions where session_id = ?", id)[0] as { at: number }).at;
		const before = { cut: prompted(cut.id), stopped: prompted(stopped.id) };
		await cursorTo(s, cut.id);
		s.keys("w");
		await until(
			() => entry(s, cut.id).live && entry(s, cut.id).activity === "idle" && prompted(cut.id) > before.cut,
			ready,
			"the cut-off turn continued and settled",
		);
		expect(entry(s, cut.id).cutOff).toBeNull();
		await cursorTo(s, stopped.id);
		s.keys("w");
		await until(() => entry(s, stopped.id).live, ready, "the stopped session awake");
		await Bun.sleep(3000);
		expect(prompted(stopped.id)).toBe(before.stopped);
		s.save("continued.txt", pane(cut.id));

		// The next turn clears an error.
		await cursorTo(s, failed.id);
		s.keys("w");
		await until(() => entry(s, failed.id).live, ready, "the errored session awake");
		const errored = prompted(failed.id);
		type(failed.id, "reply recovered");
		await until(() => prompted(failed.id) > errored && entry(s, failed.id).activity === "idle", ready, "a turn after the error");
		expect(entry(s, failed.id).errored).toBe(false);
	});

test("a Codex session whose app-server dies mid-turn ends with it, cut off as killed", async () => {
	s = scenario("harnesses", "codex-server-dies", { packages: [], recorder: true, harnesses: ["codex"] });
	const codex = await launched("codex", "reply up");
	type(codex.id, `run echo entered > ${s.home}/e2e-signals/d1.entered; until [ -e ${s.home}/e2e-signals/d1.release ]; do sleep 0.1; done`);
	await until(() => s.signal("d1.entered") !== "", ready, "the tool call running");
	const socket = `${host(codex.id)}.sock`;
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
	const claude = await launched("claude", "reply claude up");
	const codex = await launched("codex", "reply codex up");
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
	type(claude.id, "reply again");
	await until(() => own(claude.id) === "Claude renamed", ready, "Claude Code's own title");
	const [{ transcript }] = s.query<{ transcript: string }>("select transcript from sessions where session_id = ?", claude.id) as [
		{ transcript: string },
	];
	expect(readFileSync(transcript, "utf8")).toContain('"customTitle":"Claude renamed"');
	expect(s.query("select title from marks where session_id = ?", claude.id)).toEqual([{ title: null }]);
});
