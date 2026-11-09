import { afterEach, expect, test } from "bun:test";
import { answered, settled } from "./harness/agents.ts";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";
import { launched, snoozeOf, type } from "./harness/schedules.ts";

// Schedules and snooze: real sessions, swb's clock in the sessions server, and the Deck's Snoozed section.

let s: Scenario;
afterEach(async () => {
	try {
		for (const { session_id, tmux_session } of s.query<{ session_id: string; tmux_session: string }>(
			"select session_id, tmux_session from runtimes",
		))
			s.save(`pane-${session_id}.txt`, s.tmux(s.servers.sessions, "capture-pane", "-p", "-J", "-S", "-200", "-t", s.pane(tmux_session)));
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

	// The turn each schedule starts comes after the turn that set it up.
	const scheduled: Record<string, number> = {};
	for (const [id, marker] of [
		[claude.id, "SWB-claude-later"],
		[codex.id, "SWB-codex-later"],
	] as const) {
		const since = Date.now();
		type(s, id, `call session_schedule {"message":"${marker}","at":"PT6S","schedule_label":"in 6 seconds","snooze":true}`);
		await settled(s, id, `${marker} scheduled`, since);
		scheduled[id] = Date.now();
		await until(() => snoozeOf(s, id).snoozed, budgets.settle, `${marker} snoozed`);
	}
	await answered(s, claude.id, "got SWB-claude-later", "Claude answering its own schedule", scheduled[claude.id] as number);
	await answered(s, codex.id, "got SWB-codex-later", "Codex answering its own schedule", scheduled[codex.id] as number);
	expect(snoozeOf(s, claude.id).snoozed).toBe(false);
	expect(snoozeOf(s, codex.id).snoozed).toBe(false);
	expect(s.requests("claude").some((r) => String(r.context).includes("this session), scheduled for"))).toBe(true);

	const snoozing = Date.now();
	type(s, claude.id, `call swb_update_session {"snooze":"next_message"}`);
	await settled(s, claude.id, "Claude done snoozing", snoozing);
	await until(() => snoozeOf(s, claude.id).snoozed, budgets.settle, "Claude snoozed until a message");
	const sent = Date.now();
	type(s, codex.id, `call session_send_message {"session":"${claude.id}","message":"SWB-wake-claude","report_back":false}`);
	await answered(s, claude.id, "got SWB-wake-claude", "Claude woken by Codex's message", sent);
	expect(snoozeOf(s, claude.id).snoozed).toBe(false);

	await settled(s, codex.id, "Codex done messaging Claude", sent);
	for (const id of [claude.id, codex.id]) {
		const since = Date.now();
		type(s, id, `call session_schedule {"message":"SWB-never","at":"PT1H","schedule_label":"in an hour"}`);
		const pending = () =>
			s.query<{ id: string; cancelled: number }>(
				"select id, cancelled_at is not null as cancelled from schedules where source_id = ? and body = 'SWB-never'",
				id,
			)[0];
		const schedule = await until(() => pending()?.id, budgets.settle, "the schedule to unschedule");
		await settled(s, id, "the scheduling turn over", since);
		type(s, id, `call session_unschedule {"schedule":"${schedule}"}`);
		await until(() => pending()?.cancelled === 1, budgets.settle, "unscheduled through session_unschedule");
	}
});
