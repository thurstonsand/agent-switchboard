import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pane, ready, type } from "./harness/agents.ts";
import { entry, seed, waitState } from "./harness/deck.ts";
import { type Scenario, scenario, until } from "./harness/index.ts";

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
