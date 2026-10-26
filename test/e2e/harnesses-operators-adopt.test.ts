import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { launched, pane, ready, type } from "./harness/agents.ts";
import { entry, seed, waitState } from "./harness/deck.ts";
import { git, gitRepo, type Scenario, scenario, until } from "./harness/index.ts";

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

	// n opens on the default preset, Claude Code's; Tab opens the menu, and typing codex narrows it to Codex's.
	for (const [harness, query] of [
		["claude", null],
		["codex", "codex"],
	] as const) {
		s.keys("M-a", "h");
		await waitState(s, "the roster focused", (x) => x.focus === "roster");
		s.keys("g");
		await waitState(s, "cursor on the Operators section", (x) => x.cursorRow === 0);
		s.keys("n");
		await waitState(s, "the picker", (x) => x.picker !== null);
		if (query !== null) {
			s.keys("Tab");
			await waitState(s, "the menu open", (x) => x.picker?.menu !== null);
			s.keys("-l", query);
			const st = await waitState(s, "the menu narrowed", (x) => x.picker?.menu?.query === query);
			expect(st.picker?.menu?.shown.length).toBeGreaterThan(0);
			expect(st.picker?.menu?.shown.length).toBeLessThan(st.picker?.presets.length ?? 0);
			s.keys("Enter");
			await waitState(s, "the menu closed", (x) => x.picker?.menu === null);
		}
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
		await until(() => pane(s, id).includes(`${harness} outside`), ready, `${harness}'s outside conversation on screen`);
		type(s, id, `reply ${harness} inside`);
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
		s.save(`adopted-${harness}.txt`, pane(s, id));
		s.swb("drive", "stop");
	}
	expect(s.swbTry("adopt", ids.claude).err.trim()).toBe(`swb: adopt: ${ids.claude} is already tracked; swb open ${ids.claude}`);
});

test("swb adopt --all tracks every session pi, Claude Code, and Codex ran outside swb, archived and searchable, and skips what isn't one", async () => {
	s = scenario("harnesses", "adopt-all", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const codexConfig = join(s.home, ".codex/config.toml");
	writeFileSync(codexConfig, `${readFileSync(codexConfig, "utf8")}\n[features]\nmulti_agent_v2 = true\n`);
	const outside = (argv: string[], cwd = s.project) => {
		const proc = Bun.spawnSync(argv, { cwd, env: s.env, stdout: "pipe", stderr: "pipe" });
		if (proc.exitCode !== 0)
			throw new Error(`${argv[0]} exited ${proc.exitCode}: ${proc.stderr.toString().slice(-1500)}${proc.stdout.toString().slice(-1500)}`);
	};
	// Each session ran on main; the project has moved on since.
	gitRepo(s, s.project);
	const tracked = await launched(s, "pi", "reply SWB-import-tracked");
	outside([join(s.bin, "pi"), "-p", "reply SWB-import-pi"]);
	// A worktree since deleted: its session is still worth finding.
	const gone = join(s.root, "old-worktree");
	mkdirSync(gone);
	outside([join(s.bin, "pi"), "-p", "reply SWB-import-gone"], gone);
	rmSync(gone, { recursive: true });
	outside([join(s.bin, "claude"), "-p", "reply SWB-import-claude"]);
	const task = `gAAAAA${Buffer.from("reply SWB-import-child").toString("base64url")}`;
	outside([
		join(s.bin, "codex"),
		"exec",
		"--skip-git-repo-check",
		`call spawn_agent ${JSON.stringify({ message: task, task_name: "imported" })}`,
	]);
	git(s, s.project, "checkout", "-q", "-b", "later");
	// pi-sessions subagents, today's and July 2026's, and sessions that never had a turn: none is one to track. A
	// handoff's child is.
	const piDir = join(s.env.PI_CODING_AGENT_DIR as string, "sessions", `--${s.project.slice(1).replaceAll("/", "-")}--`);
	const now = new Date().toISOString();
	const pi = (id: string, ...entries: object[]) =>
		writeFileSync(
			join(piDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
			`${[{ type: "session", version: 3, id, timestamp: now, cwd: s.project }, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`,
		);
	const bootstrap = (data: object) => ({ type: "custom", customType: "pi-sessions.handoff-bootstrap", data, timestamp: now });
	const typed = (id: string, text: string) => ({
		type: "message",
		id,
		parentId: null,
		timestamp: now,
		message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
	});
	pi("child-x", bootstrap({ subagent: { depth: 1 } }));
	pi("july-x", bootstrap({ mode: "generate", bootstrapMode: "automatic", requestResponse: true }), typed("j1", "investigate"));
	pi("handoff-x", bootstrap({ mode: "generate", bootstrapMode: "review", launch: "down" }), typed("h1", "SWB-import-handoff"));
	// An extension's last entry can lead back to the start, leaving the turns on a branch.
	pi("review-x", typed("r1", "SWB-import-review"), {
		type: "custom",
		customType: "review-session",
		id: "r2",
		parentId: null,
		timestamp: now,
		data: { active: false },
	});
	pi("empty-y");
	pi(
		"settled-y",
		{ type: "session_info", name: "named, never asked" },
		{ type: "model_change", id: "m1", parentId: null, timestamp: now, provider: "faux", modelId: "faux" },
	);
	// Claude Code leaves files with no conversation in them; and Codex wrote no session_meta before late 2025.
	const claudeDir = join(s.home, ".claude/projects", s.project.replaceAll(/[^A-Za-z0-9]/g, "-"));
	writeFileSync(join(claudeDir, "00000000-0000-4000-8000-000000000001.jsonl"), "");
	writeFileSync(
		join(claudeDir, "00000000-0000-4000-8000-000000000002.jsonl"),
		`${JSON.stringify({ type: "summary", summary: "Earlier work", leafUuid: "x" })}\n`,
	);
	mkdirSync(join(s.home, ".codex/sessions/2025/08/30"), { recursive: true });
	writeFileSync(
		join(s.home, ".codex/sessions/2025/08/30/rollout-2025-08-30T19-04-54-01ce8a5e-024f-4bfb-ac6f-df0e74b92739.jsonl"),
		`${JSON.stringify({ id: "01ce8a5e-024f-4bfb-ac6f-df0e74b92739", timestamp: "2025-08-30T23:04:54.000Z", instructions: null, git: {} })}\n${JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] })}\n`,
	);
	// A subagent from a Codex before `thread_source`, which says so only in `source`.
	const elder = "019dfb10-b4ef-73a3-83de-e5ec372365e5";
	const at = new Date().toISOString();
	const line = (type: string, payload: object) => JSON.stringify({ timestamp: at, type, payload });
	const said = (role: string, kind: string, text: string) =>
		line("response_item", { type: "message", role, content: [{ type: kind, text }] });
	mkdirSync(join(s.home, ".codex/archived_sessions"), { recursive: true });
	writeFileSync(
		join(s.home, `.codex/archived_sessions/rollout-2026-05-05T22-14-29-${elder}.jsonl`),
		`${[
			line("session_meta", {
				id: elder,
				timestamp: at,
				cwd: s.project,
				cli_version: "0.128.0-alpha.1",
				source: { subagent: { thread_spawn: { parent_thread_id: "019dfb0c-3559-74f3-896b-e121ec2f6f15", depth: 1 } } },
			}),
			said("user", "input_text", "check the tests"),
			said("assistant", "output_text", "they pass"),
		].join("\n")}\n`,
	);

	const run = s.swbTry("adopt", "--all");
	s.save("adopt-all.txt", `${run.out}\n${run.err}`);
	console.log(run.out, run.err);
	expect(run.code).toBe(0);
	expect(run.out).toContain("Adopted 6 sessions, archived and indexed: 4 pi, 1 Claude Code, 1 Codex.");
	expect(run.out).toContain(
		"Skipped 4 with no turns, 4 subagents and threads another session ran, 1 from a Codex too old for swb to read.",
	);
	expect(run.out).not.toContain("Couldn't read");

	const adopted = s.ls().filter((e) => e.id !== tracked.id);
	expect(adopted.map((e) => [e.harness, e.archivedAt !== null]).sort()).toEqual([
		["claude", true],
		["codex", true],
		["pi", true],
		["pi", true],
		["pi", true],
		["pi", true],
	]);
	// Claude Code and Codex say which branch they ran on; pi doesn't, so it's the one checked out now.
	expect(Object.fromEntries(adopted.filter((e) => e.cwd === s.project).map((e) => [e.harness, e.branch]))).toEqual({
		pi: "later",
		claude: "main",
		codex: "main",
	});
	expect(adopted.find((e) => e.cwd === gone)).toMatchObject({ harness: "pi" });
	expect(entry(s, tracked.id).archivedAt).toBeNull();

	// Every one is in the index, the Codex subagent's reply under its parent.
	const found = (query: string) => {
		const out = Bun.spawnSync([`${s.bin}/swb`, "search", "--from", "nobody"], { env: s.env, stdin: Buffer.from(query) });
		return out.stdout.toString();
	};
	for (const marker of ["pi", "gone", "claude", "handoff", "review"])
		expect(found(`SWB-import-${marker}`)).toContain(`SWB-import-${marker}`);
	expect(found("SWB-import-child")).toContain('in subagent \\"imported\\"');

	// Again: nothing new.
	expect(s.swbTry("adopt", "--all").out.trim()).toBe(
		"No new sessions to adopt.\nSkipped 4 with no turns, 4 subagents and threads another session ran, 1 from a Codex too old for swb to read.",
	);
	expect(s.ls()).toHaveLength(7);
});
