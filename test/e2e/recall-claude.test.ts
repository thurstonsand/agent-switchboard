import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answered, claudeAutoMode, host, launched, pane, ready, recalled, settled, type } from "./harness/agents.ts";
import { entry } from "./harness/deck.ts";
import { release, type Scenario, scenario, until } from "./harness/index.ts";

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
		await cli("wait", "recalled: reader found:", "--timeout", "10000");
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
	let since = type(s, caller.id, `ask ${target.title} :: What markers did it mention?`);
	// The pane alone first, for the latency, then the turn's end as answered waits for it.
	await until(() => pane(s, caller.id).includes("recalled: reader found: SWB-target-secret"), 30000, "reader answer in caller TUI");
	s.save("latency.json", JSON.stringify({ elapsedMs: Date.now() - start }));
	await settled(s, caller.id, "live answer settled", since);
	since = type(s, caller.id, `ask-id ${pi.id} :: What markers did the pi session mention?`);
	await answered(s, caller.id, "recalled: reader found: SWB-pi-target", "pi reader answer in caller TUI", since);
	s.swb("archive", target.id);
	since = type(s, caller.id, `ask-id ${target.id} :: What markers were in the archived session?`);
	await until(
		() =>
			s
				.requests("claude")
				.some(
					(r) =>
						String(r.prompt).includes('Its answer to "What markers were in the archived session?"') &&
						String(r.prompt).includes("reader found: SWB-target-secret"),
				),
		30000,
		"archived reader result",
	);
	await settled(s, caller.id, "archived answer settled", since);
	expect(
		s
			.ls()
			.map((row) => row.id)
			.sort(),
	).toEqual([caller.id, pi.id, target.id].sort());
	expect(s.query("select session_id from sessions")).toHaveLength(3);
	// Each reader searches, reads, then answers.
	expect(readerRequests()).toHaveLength(9);
	// Claude Code 2.1.312 adds a non-callable placeholder; check the reader's usable tools.
	for (const r of readerRequests()) {
		expect((r.tools as string[]).filter((name) => name !== "DeferredToolPlaceholder").toSorted()).toEqual([
			"Glob",
			"Grep",
			"Read",
			"mcp__plugin_swb_swb__recall_read",
			"mcp__plugin_swb_swb__recall_search",
		]);
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
	since = type(s, caller.id, `call mcp__plugin_swb_swb__recall_read {"ref":"1"}`);
	await until(
		() =>
			s
				.requests("claude")
				.some(
					(r) =>
						String(r.prompt).startsWith("call mcp__plugin_swb_swb__recall_read") &&
						String(r.toolOutput).includes("only available to session_recall's reader"),
				),
		10000,
		"reader-only tool denied in main loop",
	);
	await settled(s, caller.id, "main-loop denial settled", since);
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
					(r) => r.prompt === subagent.prompt && String(r.toolOutput).includes("recall_read is only available to session_recall's reader"),
				),
		30000,
		"reader-only tool denied to another subagent",
	);
});

/** The caller's last request to its model: its whole conversation as the model reads it. */
const callerContext = () =>
	String(
		s
			.requests("claude")
			.filter((r) => !String(r.prompt).startsWith("Question about session") && (r.tools as string[]).length > 0)
			.at(-1)?.context,
	);

const count = (text: string, part: string) => text.split(part).length - 1;

/**
 * Whether any request to Claude carried a task-notification for a reader. The Agent tool's background agents notify the
 * model when they finish; one a mod spawns, as session_recall's reader is, doesn't in Claude Code 2.1.316 or 2.1.318, so the line
 * delivers its answer instead.
 */
const readerNotified = () => s.requests("claude").some((r) => String(r.context).includes("<task-notification>"));

test("session_recall returns once its reader starts, and the answer reaches the caller mid-turn, once", async () => {
	s = scenario("recall-claude", "background", { packages: [], recorder: true, harnesses: ["claude"] });
	const [target, caller] = await Promise.all([launched(s, "pi", "reply SWB-slow-target"), launched(s, "claude", "reply caller ready")]);
	let since = type(s, caller.id, `ask-id ${target.id} :: reader-hold 6000 What markers?`);
	await until(() => /[●⏺] asked: The reader started/.test(pane(s, caller.id)), 10000, "the ask answered at once");
	await settled(s, caller.id, "caller idle while the reader works", since);
	expect(readerRequests().some((r) => r.toolResult)).toBe(false);
	// A turn the caller starts meanwhile gets the answer on its tool's result.
	since = type(s, caller.id, "hold meanwhile");
	await until(() => s.signal("meanwhile.entered"), 10000, "the caller's next turn running");
	await until(() => readerRequests().filter((r) => r.toolResult).length >= 2, 15000, "the reader done");
	await Bun.sleep(1000);
	release(s, "meanwhile");
	await answered(s, caller.id, "recalled: reader found: SWB-slow-target", "the answer delivered", since);
	const delivered = s.requests("claude").find((r) => String(r.lastText).includes("session_recall's reader (agent"));
	expect(delivered?.prompt).toBe("hold meanwhile");
	expect(delivered?.toolResult).toBe(true);
	expect(count(callerContext(), "session_recall's reader (agent")).toBe(1);
	const ask = s.requests("claude").find((r) => String(r.prompt).startsWith("ask-id") && r.toolResult);
	expect(String(ask?.toolOutput)).toStartWith("The reader started (agent ");
	// Pins Claude Code: a mod's agent finishing doesn't notify the model. Should this fail, Claude Code now delivers the
	// answer itself, and the model reads it twice: drop the line's own delivery in turn.complete, then this check.
	await Bun.sleep(2000);
	expect(readerNotified()).toBe(false);
});

test("in auto mode, Claude Code's handback delivers the reader's answer, and swb doesn't again", async () => {
	s = scenario("recall-claude", "auto", { packages: [], recorder: true, harnesses: ["claude"] });
	claudeAutoMode(s);
	const [target, caller] = await Promise.all([launched(s, "pi", "reply SWB-auto-target"), launched(s, "claude", "reply caller ready")]);
	let since = type(s, caller.id, `ask-id ${target.id} :: What markers?`);
	await answered(s, caller.id, "recalled: reader found: SWB-auto-target", "the answer delivered", since);
	since = type(s, caller.id, "reply after the ask");
	await until(() => /[●⏺] after the ask/.test(pane(s, caller.id)), 30000, "the next turn");
	await settled(s, caller.id, "the next turn over", since);
	await screenshot(caller.id);
	// Pins Claude Code: in auto mode a mod's agent, too, must report through SubagentHandback. Should this fail, the reader
	// answers in plain text and the line delivers it, as in default mode: the SubagentHandback hook and handedBack can go,
	// with this check.
	expect(readerRequests().some((r) => (r.tools as string[]).includes("SubagentHandback"))).toBe(true);
	// Pins Claude Code: the handback reaches the model as a message. Should this fail while the check above passes, the
	// handback no longer delivers, and the answer is lost: the line must deliver it even after a handback.
	expect(count(callerContext(), "[Subagent hand-back]")).toBe(1);
	expect(callerContext()).not.toContain("session_recall's reader (agent");
	expect(readerNotified()).toBe(false);
	expect(pane(s, caller.id)).not.toContain("Prompt dropped");
	expect(pane(s, caller.id)).not.toContain("Prompt not submitted");
});

test("an Operator's session_recall starts its reader, though its model can't start a subagent", async () => {
	s = scenario("recall-claude", "operator", { packages: [], recorder: true, harnesses: ["claude"] });
	const operator = join(s.env.XDG_CONFIG_HOME as string, "agent-switchboard", "operator");
	mkdirSync(operator, { recursive: true });
	const claudeJson = join(s.home, ".claude.json");
	const trusted = JSON.parse(readFileSync(claudeJson, "utf8")) as { projects: Record<string, unknown> };
	trusted.projects[operator] = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
	writeFileSync(claudeJson, JSON.stringify(trusted));
	const target = await launched(s, "claude", "reply SWB-operator-target");
	await until(() => recalled(s, target.id).includes("SWB-operator-target"), 15000, "target transcript on disk");
	let since = Date.now();
	const launch = Bun.spawnSync([join(s.bin, "swb"), "launch", "--harness", "claude", "--cwd", operator], {
		env: s.env,
		stdin: new Blob(["reply operator up"]),
	});
	const { id } = JSON.parse(launch.stdout.toString()).details as { id: string };
	await settled(s, id, "the Operator's first turn", since);
	expect(entry(s, id).operator).toBe(true);
	since = type(s, id, `ask-id ${target.id} :: What markers?`);
	await answered(s, id, "recalled: reader found: SWB-operator-target", "the reader's answer", since);
	const subagent = { description: "Read a session", subagent_type: "Explore", prompt: "reply SWB-operator-subagent" };
	type(s, id, `call Agent ${JSON.stringify(subagent)}`);
	await until(
		() =>
			s
				.requests("claude")
				.some((r) => String(r.prompt).startsWith("call Agent") && String(r.toolOutput).includes("Agent type 'Explore' not found")),
		30000,
		"the Operator's own subagent refused",
	);
	expect(s.requests("claude").some((r) => r.prompt === subagent.prompt)).toBe(false);
});

test("two session_recalls in one response run their readers at once", async () => {
	s = scenario("recall-claude", "parallel", { packages: [], recorder: true, harnesses: ["claude"] });
	const [a, b, caller] = await Promise.all([
		launched(s, "claude", "reply SWB-parallel-a"),
		launched(s, "claude", "reply SWB-parallel-b"),
		launched(s, "claude", "reply caller ready"),
	]);
	await until(
		() => recalled(s, a.id).includes("SWB-parallel-a") && recalled(s, b.id).includes("SWB-parallel-b"),
		15000,
		"target transcripts on disk",
	);
	const since = type(s, caller.id, `ask-both ${a.id} ${b.id} :: reader-hold 4000 What markers?`);
	await until(() => /[●⏺] asked both/.test(pane(s, caller.id)), 10000, "both readers started");
	await settled(s, caller.id, "both readers started, the ask's turn over", since);
	await until(
		() => ["SWB-parallel-a", "SWB-parallel-b"].every((marker) => callerContext().includes(`reader found: ${marker}`)),
		30000,
		"both answers delivered",
	);
	const starts = readerRequests()
		.filter((r) => !r.toolResult)
		.map((r) => Number(r.at));
	s.save("latency.json", JSON.stringify({ starts }));
	expect(starts).toHaveLength(2);
	// Run one after the other, the second reader would start once the first's 4 s request returned.
	expect(Math.abs((starts[1] as number) - (starts[0] as number))).toBeLessThan(1000);
	for (const id of [a.id, b.id]) expect(count(callerContext(), `about session ${id}:`)).toBe(1);
});
