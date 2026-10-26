import { afterEach, expect, test } from "bun:test";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";
import { launched, pane, ready, snoozeOf, type } from "./harness/schedules.ts";

// Schedules and snooze: real sessions, swb's clock in the sessions server, and the Deck's Snoozed section.

let s: Scenario;
afterEach(async () => {
	try {
		for (const { session_id, tmux_session } of s.query<{ session_id: string; tmux_session: string }>(
			"select session_id, tmux_session from runtimes",
		))
			s.save(`pane-${session_id}.txt`, s.tmux(s.servers.sessions, "capture-pane", "-p", "-J", "-S", "-200", "-t", `=${tmux_session}:`));
		s.save("clock.txt", s.tmux(s.servers.sessions, "capture-pane", "-p", "-J", "-S", "-200", "-t", "=swb-ctl:"));
		s.save("schedules.json", JSON.stringify(s.query("select * from schedules"), null, 2));
		s.save("ls.json", JSON.stringify(s.ls(), null, 2));
	} catch {}
	await s.cleanup();
});

test("Claude Code and Codex schedule and snooze through swb's tools, and Claude Code's own scheduler is off", async () => {
	s = scenario("schedules", "harnesses", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const [claude, codex] = await Promise.all([launched(s, "claude", "reply claude up"), launched(s, "codex", "reply codex up")]);
	const tools = s.requests("claude").flatMap((r) => r.tools as string[]);
	expect(tools).toContain("mcp__plugin_swb_swb__session_schedule");
	expect(tools.filter((name) => /^(CronCreate|CronList|CronDelete|ScheduleWakeup)$/.test(name))).toEqual([]);

	for (const [id, marker] of [
		[claude.id, "SWB-claude-later"],
		[codex.id, "SWB-codex-later"],
	] as const) {
		type(s, id, `call session_schedule {"message":"${marker}","at":"PT6S","label":"in 6 seconds","snooze":true}`);
		await until(() => snoozeOf(s, id).snoozed, budgets.settle, `${marker} snoozed`);
	}
	await until(() => pane(s, claude.id).includes("got SWB-claude-later"), ready, "Claude answering its own schedule");
	await until(() => pane(s, codex.id).includes("got SWB-codex-later"), ready, "Codex answering its own schedule");
	expect(snoozeOf(s, claude.id).snoozed).toBe(false);
	expect(snoozeOf(s, codex.id).snoozed).toBe(false);
	expect(s.requests("claude").some((r) => String(r.context).includes("this session), scheduled for"))).toBe(true);

	type(s, claude.id, `call swb_update_session {"snooze":"next_message"}`);
	await until(() => snoozeOf(s, claude.id).snoozed, budgets.settle, "Claude snoozed until a message");
	type(s, codex.id, `call session_send_message {"session":"${claude.id}","message":"SWB-wake-claude","requestResponse":false}`);
	await until(() => pane(s, claude.id).includes("got SWB-wake-claude"), ready, "Claude woken by Codex's message");
	expect(snoozeOf(s, claude.id).snoozed).toBe(false);
});
