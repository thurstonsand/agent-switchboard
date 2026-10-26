import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { host, launched, pane, ready, type } from "./harness/agents.ts";
import { entry } from "./harness/deck.ts";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("recall.jsonl", s.signal("recall.jsonl"));
		s.save("ask-timing.jsonl", s.signal("ask-timing.jsonl"));
		console.log(`${s.name} tool execution timing: ${s.signal("ask-timing.jsonl").trim()}`);
		s.save("ls.json", JSON.stringify(s.ls(), null, 2));
		for (const session of s.ls().filter((session) => session.live))
			s.save(`pane-${session.harness}-${session.id}.txt`, pane(s, session.id));
	} finally {
		await s.cleanup();
	}
});

type Request = { at: number; pid: number; prompt: string; role: string; tools: string[]; model: string; thinking?: string; text: string };
const requests = (): Request[] =>
	s
		.signal("recall.jsonl")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
const snapshot = () => ({
	ids: s
		.ls()
		.map(({ id }) => id)
		.sort(),
	sessions: s.query("select session_id from sessions order by session_id"),
	runtimes: s.query("select session_id, pid from runtimes order by session_id"),
	files: [...new Bun.Glob("**/*.jsonl").scanSync({ cwd: s.home, dot: true })]
		.filter((file) => file.startsWith(".pi/agent/sessions/") || file.startsWith(".claude/projects/"))
		.sort(),
});

async function ask(caller: string, prompt: string, answer: string): Promise<void> {
	type(s, caller, prompt);
	await until(
		() => requests().some((request) => request.prompt === prompt && request.role === "toolResult" && request.text === answer),
		ready,
		"this question's session_ask result",
	);
	await until(() => pane(s, caller).includes(`asked: ${answer}`), ready, `answer: ${answer}`);
	await until(() => entry(s, caller).activity === "idle", budgets.settle, "caller idle");
	expect(pane(s, caller)).toContain(`asked: ${answer}`);
}

test("pi session_ask reads a live and archived pi conversation in an isolated reader on the caller's model", async () => {
	s = scenario("recall", "pi", { packages: [], recorder: true });
	writeFileSync(join(s.home, "e2e-signals", "recall.reasoning"), "");
	const target = await launched(s, "pi", "reply SWB-pi-history", undefined, ["--title", "Pi history"]);
	const caller = await launched(s, "pi", "reply caller");
	type(s, caller.id, "/thinking high");
	await until(() => pane(s, caller.id).includes("Thinking level: high"), ready, "caller thinking high");
	const before = snapshot();
	await ask(caller.id, "ask Pi history :: What marker did the session record?", "reader found: SWB-pi-history");
	expect(snapshot()).toEqual(before);
	expect(s.swb("recall", "read", caller.id)).not.toContain("reply SWB-pi-history");
	const log = requests();
	const parent = log[0];
	if (!parent) throw new Error("No faux requests recorded");
	const reader = log.filter((request) => request.prompt.startsWith("Question about session "));
	expect(reader).toHaveLength(2);
	for (const request of reader) {
		expect(request.tools.sort()).toEqual(["find", "grep", "ls", "read", "recall_read"]);
		expect(request.model).toBe("faux/faux-1");
		expect(request.thinking).toBe("high");
		expect(request.pid).toBe(parent.pid);
	}
	const call = log.find((request) => request.role === "toolResult" && request.text.startsWith("Open sessions"));
	const result = log.find((request) => request.role === "toolResult" && request.text === "reader found: SWB-pi-history");
	expect(call).toBeDefined();
	expect(result).toBeDefined();
	console.log(
		`pi reader: tools=${reader[0]?.tools.join(",")} model=${reader[0]?.model} thinking=${reader[0]?.thinking} same-pid=${reader[0]?.pid === log[0]?.pid}; call-to-result=${(result?.at ?? 0) - (call?.at ?? 0)}ms`,
	);
	console.log(`isolation before/after: ${JSON.stringify(before)}`);
	s.swb("archive", target.id);
	await until(() => !entry(s, target.id).live, ready, "archived target quit");
	expect(entry(s, target.id).open).toBe(false);
	const archivedBefore = snapshot();
	await ask(caller.id, `ask-id ${target.id} :: Read the archived marker`, "reader found: SWB-pi-history");
	expect(snapshot()).toEqual(archivedBefore);
	expect(entry(s, target.id)).toMatchObject({ open: false, live: false });
});

test("pi session_ask reads a Claude Code conversation across harnesses", async () => {
	s = scenario("recall", "pi-claude", { packages: [], recorder: true, harnesses: ["claude"] });
	const target = await launched(s, "claude", "reply SWB-claude-history", undefined, ["--title", "Claude history"]);
	const caller = await launched(s, "pi", "reply caller");
	// Claude flushes its transcript behind the idle event.
	await until(() => s.swb("recall", "read", target.id).includes("SWB-claude-history"), ready, "Claude transcript flushed");
	const before = snapshot();
	await ask(caller.id, "ask Claude history :: What marker did Claude record?", "reader found: SWB-claude-history");
	expect(snapshot()).toEqual(before);
	console.log("cross-harness: asked: reader found: SWB-claude-history");
});

test("Esc aborts pi's in-process reader and leaves a stopped caller with no new session or transcript", async () => {
	s = scenario("recall", "pi-abort", { packages: [], recorder: true });
	const target = await launched(s, "pi", "reply SWB-cancel-target");
	const caller = await launched(s, "pi", "reply caller");
	const before = snapshot();
	type(s, caller.id, `ask-id ${target.id} :: hold-reader`);
	await until(() => s.signal("reader.entered") !== "", ready, "nested faux provider holding");
	expect(entry(s, caller.id).activity).toBe("working");
	expect(snapshot()).toEqual(before);
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(s, caller.id)}:`, "Escape");
	await until(() => s.signal("reader.aborted") !== "" && s.signal("reader.exited") !== "", ready, "reader's abort signal and exit");
	await until(() => entry(s, caller.id).activity === "idle", budgets.settle, "caller stopped");
	expect(entry(s, caller.id)).toMatchObject({ live: true, cutOff: null, errored: false });
	expect(s.swb("recall", "read", caller.id)).toContain("[the last turn was stopped]");
	expect(snapshot()).toEqual(before);
	console.log(
		`Esc: entered=${s.signal("reader.entered")} aborted=${s.signal("reader.aborted")} exited=${s.signal("reader.exited")}; caller live=true idle cutOff=null errored=false; transcript: [the last turn was stopped]`,
	);
	type(s, caller.id, "reply SWB-after-abort");
	await until(
		() => s.signal("replied.SWB-after-abort") !== "" && entry(s, caller.id).activity === "idle",
		ready,
		"caller usable after abort",
	);
	expect(pane(s, caller.id)).toContain("SWB-after-abort");
});
