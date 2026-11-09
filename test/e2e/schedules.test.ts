import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { replied, settled } from "./harness/agents.ts";
import { config, entry, waitState } from "./harness/deck.ts";
import { budgets, release, type Scenario, scenario, until } from "./harness/index.ts";
import { host, launched, pane, ready, scheduled, snoozeOf, swbIn, type } from "./harness/schedules.ts";

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

/** What the model read: pi shows a message as its sender and body, and keeps the whole frame in its transcript. */
function transcript(id: string): string {
	const [row] = s.query<{ transcript: string }>("select transcript from sessions where session_id = ?", id);
	return readFileSync(row?.transcript as string, "utf8");
}

test("a session schedules itself a message and snoozes until then; the clock wakes it dormant, and it comes back Unseen", async () => {
	s = scenario("schedules", "self");
	const pi = await launched(s, "pi", "reply up");
	let since = Date.now();
	type(s, pi.id, `call session_schedule {"message":"reply fired","at":"PT8S","schedule_label":"in 8 seconds","snooze":true}`);
	await settled(s, pi.id, "its turn done", since);
	await until(() => snoozeOf(s, pi.id).snoozed, budgets.settle, "snoozed");
	const [row] = s.query<{ next_at: number }>("select next_at from schedules where source_id = ?", pi.id);
	expect(snoozeOf(s, pi.id)).toMatchObject({ snoozed: true, snoozedUntil: row?.next_at, unseen: false, inactive: false });
	await until(() => pane(s, pi.id).includes("Scheduled for"), budgets.settle, "the tool's result on screen");
	expect(pane(s, pi.id)).toContain("This session is snoozed until then.");

	// Dormant, with no Deck open: only the clock is left to deliver it.
	s.tmux(s.servers.sessions, "kill-pane", "-t", s.pane(host(s, pi.id)));
	await until(() => !entry(s, pi.id).live, budgets.settle, "dormant");
	expect(snoozeOf(s, pi.id).snoozed).toBe(true);
	since = Date.now();

	await replied(s, pi.id, "fired", "the scheduled message answered", since);
	const woke = snoozeOf(s, pi.id);
	expect(woke).toMatchObject({ live: true, snoozed: false, unseen: true, inactive: false });
	expect(transcript(pi.id)).toMatch(/\(session: [^,]+, this session\), scheduled for \w{3} \w{3} \d+, \d\d:\d\d \(schedule: \w{8}\):/);
	expect(s.query("select next_at, last_fired_at is not null as fired from schedules")).toEqual([{ next_at: null, fired: 1 }]);
	expect(s.query("select count(*) as n from messages where schedule_id is not null")).toEqual([{ n: 1 }]);

	since = Date.now();
	type(s, pi.id, "call session_list_schedules {}");
	// Collapsed, the row names the schedule; expanded, it reads as the model's listing.
	await until(() => pane(s, pi.id).includes("Schedules in 8 seconds ("), budgets.settle, "the listing's row");
	await settled(s, pi.id, "the listing's turn over", since);
	s.tmux(s.servers.sessions, "send-keys", "-t", s.pane(host(s, pi.id)), "C-o");
	await until(() => pane(s, pi.id).includes("ran "), budgets.settle, "the listing");
	expect(pane(s, pi.id)).toContain('· "in 8 seconds" · ran ');
});

test("a recurring schedule that missed runs while the machine slept fires once, saying when it was due", async () => {
	s = scenario("schedules", "catch-up");
	const pi = await launched(s, "pi", "reply up");
	const since = Date.now();
	const { details } = await scheduled(s, "reply tick", "--from", pi.id, "--cron", "*/5 * * * *", "--schedule-label", "Every 5 minutes");
	expect(details.nextAt).toBeGreaterThan(Date.now());
	// The machine slept through a dozen runs: the schedule was due an hour ago.
	const asleep = Date.now();
	const db = s.db();
	db.run("update schedules set next_at = ? where id = ?", [asleep - 3_600_000, details.id]);
	db.close();
	await replied(s, pi.id, "tick", "the missed run delivered", since);
	await Bun.sleep(2000);
	// Only the runs missed while asleep: across a five-minute mark, the next real run fires during the wait too.
	const missed = s.query("select count(*) as n from messages where schedule_id = ? and scheduled_for < ?", details.id, asleep);
	expect(missed).toEqual([{ n: 1 }]);
	const [row] = s.query<{ next_at: number }>("select next_at from schedules where id = ?", details.id);
	expect(row?.next_at).toBeGreaterThan(Date.now());
	expect(row?.next_at).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
	expect(transcript(pi.id)).toMatch(/scheduled for \w{3} \w{3} \d+, \d\d:\d\d, delivered \w{3} \w{3} \d+, \d\d:\d\d \(schedule: /);
});

test("a schedule launches a new session, refuses what can't work, unschedules, and a retried call schedules once", async () => {
	s = scenario("schedules", "launch");
	const pi = await launched(s, "pi", "reply up");
	let since = Date.now();
	const launching = await swbIn(
		s,
		"reply launched",
		"launch",
		"--from",
		pi.id,
		"--harness",
		"pi",
		"--title",
		"fresh one",
		"--at",
		"PT2S",
		"--schedule-label",
		"soon",
	);
	expect(launching.code).toBe(0);
	const child = await until(() => s.ls().find((e) => e.parentId === pi.id), ready, "the launched session");
	expect(child).toMatchObject({ harness: "pi", cwd: s.project });
	await replied(s, child.id, "launched", "the launched session working on its briefing", since);
	await until(() => entry(s, child.id).title === "fresh one", budgets.settle, "titled");

	const operatorDir = join(s.env.XDG_CONFIG_HOME as string, "agent-switchboard/operator");
	mkdirSync(operatorDir, { recursive: true });
	const refusals: [string[], string][] = [
		[["--at", "PT1H", "--cron", "* * * * *"], "give at, to run once, or cron, to recur: one of them"],
		[["--at", "fri 3pm"], 'at: "fri 3pm" is neither an ISO 8601 time nor a duration like "PT2H"'],
		[["--at", "2020-01-01T09:00:00Z"], "at: 2020-01-01T09:00:00Z has passed"],
		[["--cron", "0 9 * *"], 'cron: "0 9 * *" needs 5 fields, "M H DoM Mon DoW"'],
		[["--at", "PT1H", "--report-back"], "a message to this session can't ask it to report back to itself"],
	];
	for (const [args, error] of refusals) {
		const result = await swbIn(s, "reply nope", "schedule", "--from", pi.id, "--schedule-label", "nope", ...args);
		expect({ args, err: result.err.trim() }).toEqual({ args, err: `swb: ${error}` });
	}
	const launchRefusals: [string[], string][] = [
		[["--at", "PT1H"], "the schedule_label is empty: say when it runs, in plain words"],
		[["--at", "PT1H", "--schedule-label", "nope", "--group", " "], "a Group needs a name; null means no Group"],
		[["--at", "PT1H", "--schedule-label", "nope", "--group", "fix;"], "a Group's name takes only letters, digits, spaces, and - _ ."],
		[
			["--at", "PT1H", "--schedule-label", "nope", "--cwd", operatorDir, "--group", "lab"],
			"an Operator belongs to no Project, so it takes no Group",
		],
		[["--at", "PT1H", "--schedule-label", "nope", "--group", "lab", "--no-group"], "--group and --no-group conflict"],
	];
	for (const [args, error] of launchRefusals) {
		const result = await swbIn(s, "reply nope", "launch", "--from", pi.id, "--title", "x", ...args);
		expect({ args, err: result.err.trim() }).toEqual({ args, err: `swb: ${error}` });
	}
	expect((await swbIn(s, "reply nope", "launch", "--from", pi.id, "--at", "PT1H", "--schedule-label", "nope")).err.trim()).toBe(
		"swb: launch: --at, --cron, and --schedule-label need --from and --title",
	);

	const first = await scheduled(
		s,
		"reply once",
		"--from",
		pi.id,
		"--at",
		"PT1H",
		"--schedule-label",
		"in an hour",
		"--request-id",
		"call-1",
	);
	const again = await scheduled(
		s,
		"reply once",
		"--from",
		pi.id,
		"--at",
		"PT1H",
		"--schedule-label",
		"in an hour",
		"--request-id",
		"call-1",
	);
	expect(again.details.id).toBe(first.details.id);
	expect(s.query("select count(*) as n from schedules where request_id = 'call-1'")).toEqual([{ n: 1 }]);
	since = Date.now();
	type(s, pi.id, `call session_unschedule {"schedule":"${first.details.id}"}`);
	const unscheduled = `Unscheduled "in an hour" (schedule: ${first.details.id}).`;
	await until(() => pane(s, pi.id).includes(unscheduled), budgets.settle, "unscheduled through session_unschedule");
	await settled(s, pi.id, "session_unschedule's turn over", since);
	expect(s.swbTry("unschedule", first.details.id, "--from", pi.id).err.trim()).toBe(
		`swb: schedule ${first.details.id} is already cancelled`,
	);
	const listed = JSON.parse(s.swb("list-schedules", "--from", pi.id)) as { details: { schedules: { scheduleLabel: string }[] } };
	expect(listed.details.schedules.map((x) => x.scheduleLabel)).toEqual(["soon"]);

	// A time without an offset is the machine's local time, as cron's are; one with an offset is that instant.
	const year = new Date().getFullYear() + 1;
	const inNewYork = async (at: string) => {
		const proc = Bun.spawn([`${s.bin}/swb`, "schedule", "--from", pi.id, "--at", at, "--schedule-label", "Dec 15, 9 AM"], {
			env: { ...s.env, TZ: "America/New_York" },
			cwd: s.project,
			stdin: new Blob(["reply local"]),
			stdout: "pipe",
			stderr: "inherit",
		});
		return (JSON.parse(await proc.stdout.text()) as { details: { nextAt: number } }).details.nextAt;
	};
	expect(await inNewYork(`${year}-12-15T09:00`)).toBe(Date.parse(`${year}-12-15T09:00:00-05:00`));
	expect(await inNewYork(`${year}-12-15T09:00Z`)).toBe(Date.parse(`${year}-12-15T09:00:00Z`));
});

test("an invalid config.toml doesn't stop the clock: it says why, and wakes the session with mail once the file is fixed", async () => {
	s = scenario("schedules", "bad-config");
	const pi = await launched(s, "pi", "reply up");
	s.tmux(s.servers.sessions, "kill-pane", "-t", s.pane(host(s, pi.id)));
	await until(() => !entry(s, pi.id).live, budgets.settle, "dormant");
	const since = Date.now();
	const { details } = await scheduled(s, "reply mail", "--from", pi.id, "--at", "PT3S", "--schedule-label", "in 3 seconds");
	config(s, "bogus = 1\n");
	await until(
		() => s.query("select 1 from messages where schedule_id = ?", details.id).length === 1,
		ready,
		"the schedule fired into an invalid config",
	);
	const clock = () => s.tmux(s.servers.sessions, "capture-pane", "-p", "-J", "-t", "=swb-ctl:");
	await until(() => clock().includes("config.toml"), budgets.settle, "the clock saying why it can't wake the session");
	expect(s.tmux(s.servers.sessions, "display", "-p", "-t", "=swb-ctl:", "#{pane_dead}")).toBe("0");
	expect(s.signal("replied.mail")).toBe("");

	rmSync(join(s.env.XDG_CONFIG_HOME as string, "agent-switchboard/config.toml"));
	await replied(s, pi.id, "mail", "the mail answered once the config is fixed", since);
});

test("swb quit refuses a running turn, then stops everything, leaving sessions open; any swb restarts a dead clock, with or without a locale", async () => {
	s = scenario("schedules", "quit");
	const pi = await launched(s, "pi", "reply up");
	s.swb("drive", "start");
	await waitState(s, "the Deck up", (x) => x.ready);
	const clockPid = () => s.tmux(s.servers.sessions, "display", "-p", "-t", "=swb-ctl:", "#{pane_dead} #{pane_pid}");
	const before = clockPid();
	expect(before).toMatch(/^0 \d+$/);
	s.tmux(s.servers.sessions, "run-shell", `kill ${before.split(" ")[1]}`);
	// A dead pane has no pid since tmux 3.8.
	await until(() => clockPid().startsWith("1"), budgets.settle, "the clock dead");
	s.swb("wake", pi.id);
	await until(() => clockPid().startsWith("0 ") && clockPid() !== before, budgets.settle, "the clock respawned");
	// A swb started with no locale, as launchd, cron, or a bare shell start one, reads tmux's tab-separated answers: the
	// clock is current, not respawned, and quit finds the servers to stop.
	const { LANG: _, ...bare } = s.env;
	const unlocalized = (...args: string[]) =>
		Bun.spawnSync([`${s.bin}/swb`, ...args], { env: bare, cwd: s.project, stdout: "pipe", stderr: "pipe" });
	const respawned = clockPid();
	expect(unlocalized("wake", pi.id).exitCode).toBe(0);
	expect(clockPid()).toBe(respawned);

	const since = Date.now();
	type(s, pi.id, "hold q1");
	await until(() => s.signal("q1.entered") !== "", budgets.settle, "the held turn");
	const refused = s.swbTry("quit");
	expect(refused.code).toBe(1);
	expect(refused.err.trim()).toBe(`swb: turn running in "${entry(s, pi.id).title ?? pi.id}": wait for it to complete, or swb quit --force`);
	release(s, "q1");
	await settled(s, pi.id, "idle", since);
	const quit = unlocalized("quit");
	expect(quit.stderr.toString()).toBe("");
	expect(quit.stdout.toString().trim()).toBe("Stopped 1 session, the Deck, and swb's clock. swb starts them again.");
	expect(() => s.tmux(s.servers.sessions, "has-session")).toThrow();
	expect(entry(s, pi.id)).toMatchObject({ open: true, live: false, cutOff: null });
});
