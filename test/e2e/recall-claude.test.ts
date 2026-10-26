import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { host, launched, pane, ready, recalled, type } from "./harness/agents.ts";
import { type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;

async function screenshot(id: string): Promise<void> {
	if (!process.env.SWB_RECALL_SCREENSHOT) return;
	const name = `recall-claude-${s.name}`;
	const cli = async (...args: string[]) => {
		const proc = Bun.spawn([process.execPath, "x", "--bun", "tuistory", "-s", name, ...args], { stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
		if (code !== 0) throw new Error(`tuistory: ${out}${err}`);
		return out;
	};
	await cli(
		"--cols",
		"110",
		"--rows",
		"34",
		"--env",
		`TMUX_TMPDIR=${s.env.TMUX_TMPDIR}`,
		"--",
		"env",
		"TERM=xterm-256color",
		join(s.bin, "tmux"),
		"-L",
		s.servers.sessions,
		"attach",
		"-t",
		host(s, id),
	);
	try {
		await cli("wait", "asked: reader found:", "--timeout", "10000");
		s.save("screenshot.txt", await cli("snapshot", "--trim"));
		await cli(
			"screenshot",
			"--pixel-ratio",
			"2",
			"--background",
			"#1d2021",
			"--foreground",
			"#ebdbb2",
			"--frame-color",
			"#1d2021",
			"--output",
			join(s.artifacts, "reader.png"),
		);
	} finally {
		await cli("close");
	}
}

afterEach(async () => {
	if (!s) return;
	try {
		s.save("requests.json", JSON.stringify(s.requests("claude"), null, 2));
		s.save("ls.json", JSON.stringify(s.ls(), null, 2));
		s.save("session-rows.json", JSON.stringify(s.query("select session_id from sessions")));
		for (const row of s.ls().filter((row) => row.live)) s.save(`pane-${row.id}.txt`, pane(s, row.id));
		const plugin = join(s.home, ".local/state/agent-switchboard/lines/claude");
		const types = join(plugin, ".claude-plugin/types/claude-code/index.d.ts");
		if (existsSync(types)) s.save("claude-code.d.ts", readFileSync(types, "utf8"));
		for (const path of new Bun.Glob("**/*.{jsonl,json}").scanSync({ cwd: join(s.home, ".claude/projects"), absolute: true })) {
			s.save(path.replace(`${s.home}/.claude/projects/`, "").replaceAll("/", "__"), readFileSync(path, "utf8"));
		}
		const result = Bun.spawnSync([join(s.bin, "claude"), "plugin", "validate", plugin], { env: s.env });
		s.save("validate.txt", `${result.stdout}${result.stderr}`);
		expect(result.exitCode).toBe(0);
	} finally {
		await s.cleanup();
	}
});

/** Every Claude transcript in the scenario: path under ~/.claude/projects, and its text. */
function transcripts(): { path: string; text: string }[] {
	const dir = join(s.home, ".claude/projects");
	return [...new Bun.Glob("**/*.{jsonl,json}").scanSync({ cwd: dir })].map((path) => ({
		path,
		text: readFileSync(join(dir, path), "utf8"),
	}));
}

const readerRequests = () => s.requests("claude").filter((r) => String(r.prompt).startsWith("Question about session"));

test("Claude's native reader answers about live, archived, and pi conversations without adding a Session", async () => {
	s = scenario("recall-claude", "answers", { packages: [], recorder: true, harnesses: ["claude"] });
	const { id: targetId } = await launched(s, "claude", "reply SWB-target-secret");
	// Claude Code titles a session with a request of its own, which can land after its first turn settles; the ask names it by title.
	const target = await until(() => s.ls().find((e) => e.id === targetId && e.title !== null), ready, "the target's title");
	const pi = await launched(s, "pi", "reply SWB-pi-target");
	const caller = await launched(s, "claude", "reply caller ready");
	// Claude flushes its transcript asynchronously.
	await until(() => recalled(s, target.id).includes("SWB-target-secret"), 15000, "target transcript on disk");
	const start = Date.now();
	type(s, caller.id, `ask ${target.title} :: What markers did it mention?`);
	await until(() => pane(s, caller.id).includes("asked: reader found: SWB-target-secret"), 30000, "reader answer in caller TUI");
	s.save("latency.json", JSON.stringify({ elapsedMs: Date.now() - start }));
	await until(() => s.ls().find((row) => row.id === caller.id)?.activity === "idle", 10000, "live answer settled");
	type(s, caller.id, `ask-id ${pi.id} :: What markers did the pi session mention?`);
	await until(() => pane(s, caller.id).includes("asked: reader found: SWB-pi-target"), 30000, "pi reader answer in caller TUI");
	await until(() => s.ls().find((row) => row.id === caller.id)?.activity === "idle", 10000, "pi answer settled");
	s.swb("archive", target.id);
	type(s, caller.id, `ask-id ${target.id} :: What markers were in the archived session?`);
	await until(
		() =>
			s
				.requests("claude")
				.some(
					(r) => String(r.prompt).startsWith(`ask-id ${target.id}`) && String(r.toolOutput).includes("reader found: SWB-target-secret"),
				),
		30000,
		"archived reader result",
	);
	await until(() => s.ls().find((row) => row.id === caller.id)?.activity === "idle", 10000, "archived answer settled");
	expect(
		s
			.ls()
			.map((row) => row.id)
			.sort(),
	).toEqual([caller.id, pi.id, target.id].sort());
	expect(s.query("select session_id from sessions")).toHaveLength(3);
	// Each reader searches, reads, then answers.
	expect(readerRequests()).toHaveLength(9);
	for (const r of readerRequests()) {
		expect(r.tools).toEqual(["mcp__plugin_swb_swb__recall_search", "mcp__plugin_swb_swb__recall_read", "Read", "Grep", "Glob"]);
		expect(r.model).toBe("claude-opus-5-5");
	}
	const main = s.requests("claude").find((r) => String(r.prompt).startsWith("ask "));
	for (const tool of ["mcp__plugin_swb_swb__recall_search", "mcp__plugin_swb_swb__recall_read"]) expect(main?.tools).not.toContain(tool);
	expect(main?.tools).toContain("DeferredToolPlaceholder");
	expect(JSON.stringify(main?.toolSpecs)).not.toContain("swb:reader");
	expect(String(main?.context)).not.toContain("swb:reader");
	// Readers are filed as the caller's subagents; the caller's own transcript holds only its answers.
	const files = transcripts();
	const metas = files.filter((f) => f.path.endsWith(".meta.json"));
	expect(metas.map((f) => f.path.split("/").slice(-3, -1).join("/"))).toEqual(Array(3).fill(`${caller.id}/subagents`));
	for (const meta of metas) expect(JSON.parse(meta.text).agentType).toBe("swb:reader");
	const own = files.find((f) => f.path.endsWith(`/${caller.id}.jsonl`))?.text ?? "";
	expect(own).toContain("reader found: SWB-pi-target");
	expect(own).not.toContain("Question about session");
	await screenshot(caller.id);
	type(s, caller.id, `call mcp__plugin_swb_swb__recall_read {"ref":"1"}`);
	await until(
		() =>
			s
				.requests("claude")
				.some(
					(r) =>
						String(r.prompt).startsWith("call mcp__plugin_swb_swb__recall_read") &&
						String(r.toolOutput).includes("only available to session_ask's reader"),
				),
		10000,
		"reader-only tool denied in main loop",
	);
	await until(() => s.ls().find((row) => row.id === caller.id)?.activity === "idle", 10000, "main-loop denial settled");
	const subagent = {
		description: "Read a session",
		subagent_type: "general-purpose",
		prompt: `call mcp__plugin_swb_swb__recall_read {"ref":"1"}`,
	};
	type(s, caller.id, `call Agent ${JSON.stringify(subagent)}`);
	await until(
		() =>
			s
				.requests("claude")
				.some(
					(r) => r.prompt === subagent.prompt && String(r.toolOutput).includes("recall_read is only available to session_ask's reader"),
				),
		30000,
		"reader-only tool denied to another subagent",
	);
});

test("a reader that takes twenty-five seconds returns its answer, past the hook's 10s budget", async () => {
	s = scenario("recall-claude", "slow", { packages: [], recorder: true, harnesses: ["claude"] });
	const target = await launched(s, "claude", "reply SWB-slow-target");
	const caller = await launched(s, "claude", "reply caller ready");
	type(s, caller.id, `ask-id ${target.id} :: reader-hold 25000 What markers?`);
	await until(() => pane(s, caller.id).includes("asked: reader found: SWB-slow-target"), 60000, "slow answer rendered");
	const requests = s.requests("claude");
	const start = requests.find((r) => String(r.prompt).startsWith("ask-id") && !r.toolResult);
	const end = requests.find((r) => String(r.prompt).startsWith("ask-id") && r.toolResult);
	const elapsedMs = Number(end?.at) - Number(start?.at);
	s.save("latency.json", JSON.stringify({ elapsedMs }));
	expect(elapsedMs).toBeGreaterThan(25000);
	expect(end?.toolOutput).toBe("reader found: SWB-slow-target");
	expect(pane(s, caller.id)).not.toContain("ran past its");
	expect(transcripts().find((f) => f.path.endsWith(`/${caller.id}.jsonl`))?.text).not.toContain("ran past its");
});

test("Esc during a reader stops it, leaves the caller usable, and adds no Session", async () => {
	s = scenario("recall-claude", "cancel", { packages: [], recorder: true, harnesses: ["claude"] });
	const target = await launched(s, "claude", "reply SWB-cancel-target");
	const caller = await launched(s, "claude", "reply caller ready");
	type(s, caller.id, `ask-id ${target.id} :: reader-hold 15000 Cancel this reader`);
	await until(() => readerRequests().length > 0, 10000, "reader started");
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(s, caller.id)}:`, "Escape");
	await until(() => s.ls().find((row) => row.id === caller.id)?.activity === "idle", 15000, "caller idle after Esc");
	type(s, caller.id, "reply after cancel");
	// Claude Code marks its reply ⏺ on macOS and ● elsewhere.
	await until(() => /[●⏺] after cancel/.test(pane(s, caller.id)), 10000, "caller usable");
	// Stay past the delayed response: a stopped reader makes no further request, so it neither recalls nor answers.
	await Bun.sleep(16000);
	expect(s.ls()).toHaveLength(2);
	expect(readerRequests()).toHaveLength(1);
	expect(pane(s, caller.id)).not.toContain("didn't stop");
	expect(pane(s, caller.id)).not.toContain("did not stop within 5s");
	expect(pane(s, caller.id)).not.toContain("Waiting for 1 background agent");
	s.save("reader-after-cancel.json", JSON.stringify(readerRequests()));
});

test("two session_asks in one response run their readers at once", async () => {
	s = scenario("recall-claude", "parallel", { packages: [], recorder: true, harnesses: ["claude"] });
	const a = await launched(s, "claude", "reply SWB-parallel-a");
	const b = await launched(s, "claude", "reply SWB-parallel-b");
	const caller = await launched(s, "claude", "reply caller ready");
	await until(
		() => recalled(s, a.id).includes("SWB-parallel-a") && recalled(s, b.id).includes("SWB-parallel-b"),
		15000,
		"target transcripts on disk",
	);
	type(s, caller.id, `ask-both ${a.id} ${b.id} :: reader-hold 4000 What markers?`);
	await until(() => /[●⏺] asked both/.test(pane(s, caller.id)), 30000, "both answers");
	const starts = readerRequests()
		.filter((r) => !r.toolResult)
		.map((r) => Number(r.at));
	s.save("latency.json", JSON.stringify({ starts }));
	expect(starts).toHaveLength(2);
	// Run one after the other, the second reader would start once the first's 4 s request returned.
	expect(Math.abs((starts[1] as number) - (starts[0] as number))).toBeLessThan(1000);
	const answers = s.requests("claude").find((r) => String(r.prompt).startsWith("ask-both") && r.toolResult)?.toolOutput;
	expect(answers).toContain("reader found: SWB-parallel-a");
	expect(answers).toContain("reader found: SWB-parallel-b");
});
