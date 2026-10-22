import { afterEach, expect, test } from "bun:test";
import { host, launched, pane, ready, send, type } from "./harness/agents.ts";
import { entry } from "./harness/deck.ts";
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

const sawMarker = (harness: "claude" | "codex", marker: string) => s.requests(harness).some((r) => JSON.stringify(r).includes(marker));

test("pi, Claude Code, and Codex message each other: idle sessions start a turn, working ones take it mid-turn", async () => {
	s = scenario("harnesses", "matrix", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const [pi, claude, codex] = await Promise.all([
		launched(s, "pi", "reply pi-up"),
		launched(s, "claude", "reply claude up"),
		launched(s, "codex", "reply codex up"),
	]);

	// Idle: the message is the next turn, in every direction.
	expect((await send(s, claude.id, pi.id, "reply SWB-c2p")).details.delivered).toBe(true);
	await until(() => s.signal("replied.SWB-c2p") !== "", budgets.settle, "pi's answer to Claude");
	expect((await send(s, codex.id, claude.id, "SWB-x2c please ack")).details.delivered).toBe(true);
	await until(() => pane(s, claude.id).includes("got SWB-x2c please ack"), budgets.settle, "Claude's answer to Codex");
	expect((await send(s, pi.id, codex.id, "SWB-p2x please ack")).details.delivered).toBe(true);
	await until(() => pane(s, codex.id).includes("got SWB-p2x please ack"), budgets.settle, "Codex's answer to pi");
	s.save("idle.txt", [pane(s, pi.id), pane(s, claude.id), pane(s, codex.id)].join("\n=====\n"));

	// Working: each is held in a tool call when the message lands.
	type(s, claude.id, "hold c1");
	await until(() => s.signal("c1.entered") !== "", ready, "Claude holding");
	const toClaude = send(s, pi.id, claude.id, "SWB-mid-claude change course");
	await Bun.sleep(1000);
	release(s, "c1");
	expect((await toClaude).details.delivered).toBe(true);
	// Read in the same turn, right after the held tool's result.
	await until(
		() => s.requests("claude").find((r) => r.prompt === "hold c1" && String(r.lastText).includes("SWB-mid-claude")),
		budgets.settle,
		"Claude's next request in that turn to carry the message",
	);
	await until(() => pane(s, claude.id).includes("swb:"), budgets.settle, "Claude's visible receipt");

	type(s, codex.id, "hold x1");
	await until(() => s.signal("x1.entered") !== "", ready, "Codex holding");
	expect((await send(s, claude.id, codex.id, "SWB-mid-codex change course")).details.delivered).toBe(true);
	release(s, "x1");
	await until(() => sawMarker("codex", "SWB-mid-codex"), budgets.settle, "the steer in Codex's next request");
	await until(() => entry(s, codex.id).activity === "idle", budgets.settle, "Codex idle");

	type(s, pi.id, "hold p1");
	await until(() => s.signal("p1.entered") !== "", ready, "pi holding");
	expect((await send(s, codex.id, pi.id, "reply SWB-mid-pi")).details.delivered).toBe(true);
	release(s, "p1");
	await until(() => s.signal("replied.SWB-mid-pi") !== "", budgets.settle, "pi answering the steer");
	s.save("mid-turn.txt", [pane(s, pi.id), pane(s, claude.id), pane(s, codex.id)].join("\n=====\n"));
});

test("a message Codex refuses mid-compaction is delivered once the compaction ends, with nothing else written", async () => {
	s = scenario("harnesses", "codex-compact", { packages: [], recorder: true, harnesses: ["codex"] });
	const [pi, codex] = await Promise.all([launched(s, "pi", "reply pi-up"), launched(s, "codex", "hold-compact k1")]);
	type(s, codex.id, "/compact");
	await until(() => s.signal("k1.entered") !== "", ready, "Codex compacting");
	// A compact turn can't be steered, so this turn/start fails; the next poll has no new db write to wake it.
	const sent = send(s, pi.id, codex.id, "SWB-after-compact please ack");
	await Bun.sleep(2000);
	release(s, "k1");
	expect((await sent).details.delivered).toBe(true);
	await until(() => pane(s, codex.id).includes("got SWB-after-compact please ack"), budgets.settle, "Codex answering after the compaction");
	s.save("compact.txt", pane(s, codex.id));
});

test("agents use swb's tools across harnesses: list, message, launch, and cancel, with the caller as the sender", async () => {
	s = scenario("harnesses", "agents", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const [pi, claude, codex] = await Promise.all([
		launched(s, "pi", "reply pi-up"),
		launched(s, "claude", "reply claude up"),
		launched(s, "codex", "reply codex up"),
	]);

	type(s, claude.id, `call session_reachable {}`);
	const listed = await until(
		() => s.requests("claude").find((r) => String(r.toolOutput).includes("Open sessions")),
		budgets.settle,
		"Claude's listing",
	);
	expect(String(listed.toolOutput)).toContain(`${codex.id} · Codex`);
	expect(String(listed.toolOutput)).toContain(`${pi.id} · pi`);
	expect(String(listed.toolOutput)).not.toContain(`${claude.id} ·`);

	type(s, claude.id, `call session_send_message {"session":"${codex.id}","message":"SWB-claude-asks codex","requestResponse":false}`);
	await until(() => pane(s, codex.id).includes("got SWB-claude-asks codex"), ready, "Codex answering Claude's tool call");
	const sent = s.query<{ source_id: string; delivered_at: number | null }>(
		"select source_id, delivered_at from messages where body like '%SWB-claude-asks%'",
	);
	expect(sent).toEqual([{ source_id: claude.id, delivered_at: expect.any(Number) }]);

	// Codex runs swb's MCP server with only the variables it forwards; it must still see the others as live.
	type(s, codex.id, `call session_reachable {}`);
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

	type(s, codex.id, `call session_send_message {"session":"${pi.id}","message":"reply SWB-codex-asks-pi","requestResponse":false}`);
	await until(() => s.signal("replied.SWB-codex-asks-pi") !== "", ready, "pi answering Codex's tool call");
	expect(s.query("select source_id from messages where body = 'reply SWB-codex-asks-pi'")).toEqual([{ source_id: codex.id }]);

	type(s, pi.id, `call session_send_message {"session":"${claude.id}","message":"SWB-pi-asks claude","requestResponse":false}`);
	await until(() => pane(s, claude.id).includes("got SWB-pi-asks claude"), ready, "Claude answering pi's tool call");

	// A launch from Claude starts a Codex session whose parent is Claude.
	type(
		s,
		claude.id,
		`call session_launch {"harness":"codex","goal":"SWB-launched do the thing","title":"launched by claude","requestResponse":false}`,
	);
	const child = await until(() => s.ls().find((e) => e.parentId === claude.id), ready, "the launched Codex session");
	expect(child).toMatchObject({ harness: "codex", cwd: s.project });
	await until(() => pane(s, child.id).includes("got SWB-launched do the thing"), ready, "the launched session working on its goal");

	// Cancel from pi stops Codex's held turn.
	type(s, codex.id, "hold x2");
	await until(() => s.signal("x2.entered") !== "", ready, "Codex holding");
	type(s, pi.id, `call session_cancel {"session":"${codex.id}"}`);
	await until(() => entry(s, codex.id).activity === "idle", budgets.settle, "Codex's turn stopped");
	release(s, "x2");
	s.save("agents.txt", [pane(s, pi.id), pane(s, claude.id), pane(s, codex.id), pane(s, child.id)].join("\n=====\n"));
});

test("a message over 100,000 characters is refused in every harness, and one at the limit is delivered", async () => {
	s = scenario("harnesses", "limit", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const [pi, claude, codex] = await Promise.all([
		launched(s, "pi", "reply pi-up"),
		launched(s, "claude", "reply claude up"),
		launched(s, "codex", "reply codex up"),
	]);
	const refusal = "the message is 100,001 characters, over the 100,000 limit";
	type(s, pi.id, "flood claude 100001");
	type(s, codex.id, "flood pi 100001");
	type(s, claude.id, "flood codex 100000");
	await until(() => pane(s, pi.id).includes(refusal), budgets.settle, "pi told its message is too long");
	await until(() => s.requests("codex").some((r) => String(r.toolOutput).includes(refusal)), budgets.settle, "Codex told the same");
	await until(
		() => s.query("select 1 from messages where length(body) = 100000 and delivered_at is not null").length === 1,
		ready,
		"Claude's message at the limit delivered to Codex",
	);
	expect(s.query("select source_id, target_id from messages where length(body) >= 100000")).toEqual([
		{ source_id: claude.id, target_id: codex.id },
	]);
});

test("a message to a dormant Claude Code or Codex session wakes it on its own conversation and delivers", async () => {
	s = scenario("harnesses", "wake", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const [pi, claude, codex] = await Promise.all([
		launched(s, "pi", "reply pi-up"),
		launched(s, "claude", "reply SWB-first-claude"),
		launched(s, "codex", "reply SWB-first-codex"),
	]);
	for (const target of [claude, codex]) {
		const harness = target.harness as "claude" | "codex";
		s.tmux(s.servers.sessions, "kill-session", "-t", `=${host(s, target.id)}`);
		await until(() => !entry(s, target.id).live, budgets.settle, `${harness} dormant`);
		const receipt = await send(s, pi.id, target.id, `SWB-wake-${harness} are you there`);
		expect(receipt.details).toMatchObject({ delivered: true, woke: true });
		await until(() => pane(s, target.id).includes(`got SWB-wake-${harness} are you there`), ready, `${harness} answering`);
		// The request that answered the wake still carries the session's first turn: it resumed, not started over.
		const answering = s.requests(harness).filter((r) => JSON.stringify(r).includes(`SWB-wake-${harness}`));
		expect(answering.length).toBeGreaterThan(0);
		expect(JSON.stringify(answering[0])).toContain(`SWB-first-${harness}`);
		expect(s.ls().filter((e) => e.harness === harness)).toHaveLength(1);
		s.save(`woken-${harness}.txt`, pane(s, target.id));
	}
});
