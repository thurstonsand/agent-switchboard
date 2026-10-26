import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { entry, waitState } from "./harness/deck.ts";
import { budgets, release, type Scenario, scenario, until } from "./harness/index.ts";
import { host, launched, pane, ready, scheduled, snoozeOf, swbIn, type } from "./harness/schedules.ts";

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

/** What the model read: pi shows a message as its sender and body, and keeps the whole frame in its transcript. */
function transcript(id: string): string {
	const [row] = s.query<{ transcript: string }>("select transcript from sessions where session_id = ?", id);
	return readFileSync(row?.transcript as string, "utf8");
}

test("a session schedules itself a message and snoozes until then; the clock wakes it dormant, and it comes back Unseen", async () => {
	s = scenario("schedules", "self");
	const pi = await launched(s, "pi", "reply up");
	type(s, pi.id, `call session_schedule {"message":"reply fired","at":"PT8S","label":"in 8 seconds","snooze":true}`);
	await until(() => snoozeOf(s, pi.id).snoozed && entry(s, pi.id).activity === "idle", budgets.settle, "snoozed, its turn done");
	const [row] = s.query<{ next_at: number }>("select next_at from schedules where source_id = ?", pi.id);
	expect(snoozeOf(s, pi.id)).toMatchObject({ snoozed: true, snoozedUntil: row?.next_at, unseen: false, inactive: false });
	await until(() => pane(s, pi.id).includes("Scheduled for"), budgets.settle, "the tool's result on screen");
	expect(pane(s, pi.id)).toContain("This session is snoozed until then.");

	// Dormant, with no Deck open: only the clock is left to deliver it.
	s.tmux(s.servers.sessions, "kill-session", "-t", `=${host(s, pi.id)}`);
	await until(() => !entry(s, pi.id).live, budgets.settle, "dormant");
	expect(snoozeOf(s, pi.id).snoozed).toBe(true);

	await until(() => s.signal("replied.fired") !== "", ready, "the scheduled message answered");
	const woke = await until(() => entry(s, pi.id).activity === "idle" && snoozeOf(s, pi.id), budgets.settle, "its turn settled");
	expect(woke).toMatchObject({ live: true, snoozed: false, unseen: true, inactive: false });
	expect(transcript(pi.id)).toMatch(/\(session: [^,]+, this session\), scheduled for \w{3} \w{3} \d+, \d\d:\d\d \(schedule: \w{8}\):/);
	expect(s.query("select next_at, last_fired_at is not null as fired from schedules")).toEqual([{ next_at: null, fired: 1 }]);
	expect(s.query("select count(*) as n from messages where schedule_id is not null")).toEqual([{ n: 1 }]);

	type(s, pi.id, "call session_schedules {}");
	await until(() => pane(s, pi.id).includes("ran "), budgets.settle, "the listing");
	expect(pane(s, pi.id)).toContain('· "in 8 seconds" · ran ');
});

test("a recurring schedule that missed runs while the machine slept fires once, saying when it was due", async () => {
	s = scenario("schedules", "catch-up");
	const pi = await launched(s, "pi", "reply up");
	const { details } = await scheduled(s, "reply tick", "--from", pi.id, "--cron", "*/5 * * * *", "--label", "Every 5 minutes");
	expect(details.nextAt).toBeGreaterThan(Date.now());
	// The machine slept through a dozen runs: the schedule was due an hour ago.
	const db = s.db();
	db.run("update schedules set next_at = ? where id = ?", [Date.now() - 3_600_000, details.id]);
	db.close();
	await until(() => s.signal("replied.tick") !== "", ready, "the missed run delivered");
	await Bun.sleep(2000);
	expect(s.query("select count(*) as n from messages where schedule_id = ?", details.id)).toEqual([{ n: 1 }]);
	const [row] = s.query<{ next_at: number }>("select next_at from schedules where id = ?", details.id);
	expect(row?.next_at).toBeGreaterThan(Date.now());
	expect(row?.next_at).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
	expect(transcript(pi.id)).toMatch(/scheduled for \w{3} \w{3} \d+, \d\d:\d\d, delivered \w{3} \w{3} \d+, \d\d:\d\d \(schedule: /);
});

test("a schedule launches a new session, refuses what can't work, unschedules, and a retried call schedules once", async () => {
	s = scenario("schedules", "launch");
	const pi = await launched(s, "pi", "reply up");
	await scheduled(
		s,
		"reply launched",
		"--from",
		pi.id,
		"--launch-harness",
		"pi",
		"--launch-title",
		"fresh one",
		"--at",
		"PT2S",
		"--label",
		"soon",
	);
	const child = await until(() => s.ls().find((e) => e.parentId === pi.id), ready, "the launched session");
	expect(child).toMatchObject({ harness: "pi", cwd: s.project });
	await until(() => s.signal("replied.launched") !== "", ready, "the launched session working on its goal");
	await until(() => entry(s, child.id).title === "fresh one", budgets.settle, "titled");

	const operatorDir = join(s.env.XDG_CONFIG_HOME as string, "agent-switchboard/operator");
	mkdirSync(operatorDir, { recursive: true });
	const refusals: [string[], string][] = [
		[["--at", "PT1H", "--cron", "* * * * *"], "give at, to run once, or cron, to recur: one of them"],
		[["--at", "fri 3pm"], 'at: "fri 3pm" is neither an ISO 8601 time nor a duration like "PT2H"'],
		[["--at", "2020-01-01T09:00:00Z"], "at: 2020-01-01T09:00:00Z has passed"],
		[["--cron", "0 9 * *"], 'cron: "0 9 * *" needs 5 fields, "M H DoM Mon DoW"'],
		[["--at", "PT1H", "--request-response"], "a message to this session can't request a response from it"],
		[
			["--at", "PT1H", "--snooze", "--launch-harness", "pi", "--launch-title", "x"],
			"snooze needs an existing session; a launch has none to snooze",
		],
		[["--at", "PT1H", "--launch-title", "x", "--launch-group", " "], "a Group needs a name; null means no Group"],
		[["--at", "PT1H", "--launch-title", "x", "--launch-group", "fix;"], "a Group's name takes only letters, digits, spaces, and - _ ."],
		[
			["--at", "PT1H", "--launch-title", "x", "--launch-cwd", operatorDir, "--launch-group", "lab"],
			"an Operator belongs to no Project, so it takes no Group",
		],
		[["--at", "PT1H", "--launch-no-group"], "schedule: --launch-no-group needs --launch-title"],
		[
			["--at", "PT1H", "--launch-title", "x", "--launch-group", "lab", "--launch-no-group"],
			"--launch-group and --launch-no-group conflict",
		],
	];
	for (const [args, error] of refusals) {
		const result = await swbIn(s, "reply nope", "schedule", "--from", pi.id, "--label", "nope", ...args);
		expect({ args, err: result.err.trim() }).toEqual({ args, err: `swb: ${error}` });
	}

	const first = await scheduled(s, "reply once", "--from", pi.id, "--at", "PT1H", "--label", "in an hour", "--request-id", "call-1");
	const again = await scheduled(s, "reply once", "--from", pi.id, "--at", "PT1H", "--label", "in an hour", "--request-id", "call-1");
	expect(again.details.id).toBe(first.details.id);
	expect(s.query("select count(*) as n from schedules where request_id = 'call-1'")).toEqual([{ n: 1 }]);
	expect(JSON.parse(s.swb("unschedule", first.details.id, "--from", pi.id)).text).toBe(
		`Unscheduled "in an hour" (schedule: ${first.details.id}).`,
	);
	expect(s.swbTry("unschedule", first.details.id, "--from", pi.id).err.trim()).toBe(
		`swb: schedule ${first.details.id} is already cancelled`,
	);
	const listed = JSON.parse(s.swb("schedules", "--from", pi.id)) as { details: { schedules: { label: string }[] } };
	expect(listed.details.schedules.map((x) => x.label)).toEqual(["soon"]);

	// A time without an offset is the machine's local time, as cron's are; one with an offset is that instant.
	const year = new Date().getFullYear() + 1;
	const inNewYork = async (at: string) => {
		const proc = Bun.spawn([`${s.bin}/swb`, "schedule", "--from", pi.id, "--at", at, "--label", "Dec 15, 9 AM"], {
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

	type(s, pi.id, "hold q1");
	await until(() => s.signal("q1.entered") !== "", budgets.settle, "the held turn");
	const refused = s.swbTry("quit");
	expect(refused.code).toBe(1);
	expect(refused.err.trim()).toBe(`swb: turn running in "${entry(s, pi.id).title ?? pi.id}": wait for it to complete, or swb quit --force`);
	release(s, "q1");
	await until(() => entry(s, pi.id).activity === "idle", budgets.settle, "idle");
	const quit = unlocalized("quit");
	expect(quit.stderr.toString()).toBe("");
	expect(quit.stdout.toString().trim()).toBe("Stopped 1 session, every Deck, and swb's clock. swb starts them again.");
	expect(() => s.tmux(s.servers.sessions, "has-session")).toThrow();
	expect(() => s.tmux(s.servers.ui, "has-session")).toThrow();
	expect(entry(s, pi.id)).toMatchObject({ open: true, live: false, cutOff: null });
});
