import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { config, cursorTo, entry, reply, sessionRows, state, waitState } from "./harness/deck.ts";
import { budgets, type LsEntry, release, type Scenario, scenario, until } from "./harness/index.ts";

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

const ready = 60_000;

async function launched(harness: "pi" | "claude" | "codex", goal: string): Promise<LsEntry> {
	const out = JSON.parse(
		await Bun.spawn([`${s.bin}/swb`, "launch", "--harness", harness, "--cwd", s.project], {
			env: s.env,
			cwd: s.project,
			stdin: new Blob([goal]),
			stdout: "pipe",
			stderr: "inherit",
		}).stdout.text(),
	) as { details: { id: string } };
	const id = out.details.id;
	return until(() => s.ls().find((e) => e.id === id && e.activity === "idle"), ready, `the ${harness} session's first turn to settle`);
}

/** Runs an swb line command with a body on stdin, as a line's tool does. */
async function swbIn(body: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn([`${s.bin}/swb`, ...args], {
		env: s.env,
		cwd: s.project,
		stdin: new Blob([body]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	return { code, out, err };
}

async function scheduled(body: string, ...args: string[]): Promise<{ text: string; details: { id: string; nextAt: number } }> {
	const result = await swbIn(body, "schedule", ...args);
	if (result.code !== 0) throw new Error(`swb schedule: ${result.err}`);
	return JSON.parse(result.out);
}

function host(id: string): string {
	return s.query<{ tmux_session: string }>("select tmux_session from runtimes where session_id = ?", id)[0]?.tmux_session as string;
}

/** The harness's screen, with its own wrapping undone: whitespace runs read as one space. */
function pane(id: string): string {
	return s.tmux(s.servers.sessions, "capture-pane", "-p", "-J", "-S", "-500", "-t", `=${host(id)}:`).replace(/\s+/g, " ");
}

/** What the model read: pi shows a message as its sender and body, and keeps the whole frame in its transcript. */
function transcript(id: string): string {
	const [row] = s.query<{ transcript: string }>("select transcript from sessions where session_id = ?", id);
	return readFileSync(row?.transcript as string, "utf8");
}

function type(id: string, text: string): void {
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(id)}:`, "-l", text);
	Bun.sleepSync(300);
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(id)}:`, "Enter");
}

type Snoozed = LsEntry & { snoozed: boolean; snoozedUntil: number | null };
const snoozeOf = (id: string) => entry(s, id) as Snoozed;

test("a session schedules itself a message and snoozes until then; the clock wakes it dormant, and it comes back Unseen", async () => {
	s = scenario("schedules", "self");
	const pi = await launched("pi", "reply up");
	type(pi.id, `call session_schedule {"message":"reply fired","at":"PT8S","label":"in 8 seconds","snooze":true}`);
	await until(() => snoozeOf(pi.id).snoozed && entry(s, pi.id).activity === "idle", budgets.settle, "snoozed, its turn done");
	const [row] = s.query<{ next_at: number }>("select next_at from schedules where source_id = ?", pi.id);
	expect(snoozeOf(pi.id)).toMatchObject({ snoozed: true, snoozedUntil: row?.next_at, unseen: false, inactive: false });
	await until(() => pane(pi.id).includes("Scheduled for"), budgets.settle, "the tool's result on screen");
	expect(pane(pi.id)).toContain("This session is snoozed until then.");

	// Dormant, with no Deck open: only the clock is left to deliver it.
	s.tmux(s.servers.sessions, "kill-session", "-t", `=${host(pi.id)}`);
	await until(() => !entry(s, pi.id).live, budgets.settle, "dormant");
	expect(snoozeOf(pi.id).snoozed).toBe(true);

	await until(() => s.signal("replied.fired") !== "", ready, "the scheduled message answered");
	const woke = await until(() => entry(s, pi.id).activity === "idle" && snoozeOf(pi.id), budgets.settle, "its turn settled");
	expect(woke).toMatchObject({ live: true, snoozed: false, unseen: true, inactive: false });
	expect(transcript(pi.id)).toMatch(/\(session: [^,]+, this session\), scheduled for \w{3} \w{3} \d+, \d\d:\d\d \(schedule: \w{8}\):/);
	expect(s.query("select next_at, last_fired_at is not null as fired from schedules")).toEqual([{ next_at: null, fired: 1 }]);
	expect(s.query("select count(*) as n from messages where schedule_id is not null")).toEqual([{ n: 1 }]);

	type(pi.id, "call session_schedules {}");
	await until(() => pane(pi.id).includes("ran "), budgets.settle, "the listing");
	expect(pane(pi.id)).toContain('· "in 8 seconds" · ran ');
});

test("a timed snooze holds through a conversation and shows while blocked or interrupted; next_message ends at the next message or prompt", async () => {
	s = scenario("schedules", "snooze-rules");
	const [pi, other] = await Promise.all([launched("pi", "reply one"), launched("pi", "reply other")]);

	s.swb("snooze", pi.id, "one_hour");
	expect(snoozeOf(pi.id)).toMatchObject({ snoozed: true, snoozedUntil: expect.any(Number) });
	expect((snoozeOf(pi.id).snoozedUntil as number) - Date.now()).toBeGreaterThan(3_500_000);

	// A message and its whole turn leave a timed snooze alone, and the finished turn isn't Unseen while it holds.
	expect((await swbIn("reply talked", "send", "--from", other.id, "--to", pi.id)).code).toBe(0);
	await until(() => s.signal("replied.talked") !== "", budgets.settle, "the message answered");
	await until(() => entry(s, pi.id).activity === "idle", budgets.settle, "idle");
	expect(snoozeOf(pi.id)).toMatchObject({ snoozed: true, unseen: false });

	// Blocked on me, it shows; released, it's back in Snoozed.
	type(pi.id, "attention a1");
	await until(() => entry(s, pi.id).activity === "blocked", budgets.settle, "blocked");
	expect(snoozeOf(pi.id).snoozed).toBe(false);
	release(s, "a1");
	await until(() => entry(s, pi.id).activity === "idle", budgets.settle, "idle again");
	expect(snoozeOf(pi.id).snoozed).toBe(true);

	// Unsnoozed by hand, what it did meanwhile is Unseen.
	expect(s.swb("snooze", pi.id, "off").trim()).toBe(`Unsnoozed "${entry(s, pi.id).title ?? pi.id}".`);
	expect(snoozeOf(pi.id)).toMatchObject({ snoozed: false, unseen: true });

	s.swb("snooze", pi.id, "next_message");
	expect(snoozeOf(pi.id)).toMatchObject({ snoozed: true, snoozedUntil: null });
	// A message scheduled for later is no message yet.
	const later = await scheduled("reply later", "--from", other.id, "--to", pi.id, "--at", "PT1H", "--label", "in an hour");
	expect(snoozeOf(pi.id).snoozed).toBe(true);
	expect((await swbIn("reply two", "send", "--from", other.id, "--to", pi.id)).code).toBe(0);
	expect(snoozeOf(pi.id).snoozed).toBe(false);
	await until(() => s.signal("replied.two") !== "", budgets.settle, "the second message answered");
	expect(s.query("select next_at from schedules where id = ?", later.details.id)).toEqual([{ next_at: later.details.nextAt }]);

	// A prompt typed into it ends next_message's snooze too.
	s.swb("snooze", pi.id, "next_message");
	expect(snoozeOf(pi.id).snoozed).toBe(true);
	type(pi.id, "reply typed");
	await until(() => s.signal("replied.typed") !== "", budgets.settle, "the typed prompt answered");
	expect(snoozeOf(pi.id).snoozed).toBe(false);

	// Killed mid-turn, a snoozed session is Interrupted, and that shows.
	s.swb("snooze", other.id, "one_hour");
	type(other.id, "hold i1");
	await until(() => s.signal("i1.entered") !== "", budgets.settle, "the held turn");
	s.tmux(s.servers.sessions, "kill-session", "-t", `=${host(other.id)}`);
	await until(() => !entry(s, other.id).live, budgets.settle, "dormant");
	expect(snoozeOf(other.id)).toMatchObject({ interrupted: true, snoozed: false });

	// Archiving cancels what was coming and the snooze with it; unarchiving brings neither back.
	// Monday is 9 AM on the next one, never today's.
	s.swb("snooze", pi.id, "monday");
	const monday = new Date(snoozeOf(pi.id).snoozedUntil as number);
	expect([monday.getDay(), monday.getHours(), monday.getMinutes()]).toEqual([1, 9, 0]);
	expect(monday.getTime() - Date.now()).toBeGreaterThan(0);
	expect(monday.getTime() - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
	s.swb("archive", pi.id);
	s.swb("unarchive", pi.id);
	expect(
		s.query<{ cancelled: number }>("select cancelled_at is not null as cancelled from schedules where id = ?", later.details.id),
	).toEqual([{ cancelled: 1 }]);
	expect(snoozeOf(pi.id)).toMatchObject({ open: true, snoozed: false });

	const refused = s.swbTry("snooze", pi.id, "2020-01-01T09:00:00-05:00");
	expect(refused.err.trim()).toBe("swb: snooze until: 2020-01-01T09:00:00-05:00 has passed");
});

test("a timed snooze that runs out with no turn comes back Unseen, and stays out of Inactive until I visit it", async () => {
	s = scenario("schedules", "snooze-ends");
	config(s, 'inactive_after = "3s"\n');
	s.swb("drive", "start", "--", "new");
	const st = await waitState(
		s,
		"the new pi live with the keyboard",
		(x) => x.staged.kind === "live" && x.focus === "stage",
		budgets.piReady,
	);
	await reply(s, "one");
	const id = st.staged.id as string;
	await until(() => entry(s, id)?.activity === "idle" && !entry(s, id).unseen, budgets.settle, "its turn seen on the focused Stage");
	s.swb("drive", "focus", "out");
	await waitState(s, "terminal unfocused", (x) => !x.terminalFocused);

	s.swb("snooze", id, "PT4S");
	// Snoozed past inactive_after, it's still only Snoozed.
	await Bun.sleep(3500);
	expect(snoozeOf(id)).toMatchObject({ snoozed: true, unseen: false, inactive: false });
	await until(() => !snoozeOf(id).snoozed, budgets.settle, "the snooze run out");
	expect(snoozeOf(id)).toMatchObject({ unseen: true, inactive: false });
	await Bun.sleep(3500);
	expect(snoozeOf(id)).toMatchObject({ unseen: true, inactive: false });

	s.keys("M-a", "h");
	await waitState(s, "roster focus", (x) => x.focus === "roster");
	await cursorTo(s, id);
	s.keys("Enter");
	await waitState(s, "on the Stage", (x) => x.focus === "stage" && x.staged.id === id);
	s.swb("drive", "focus", "in");
	await until(() => !entry(s, id).unseen, 3000, "visited once focused");
	expect(snoozeOf(id)).toMatchObject({ snoozed: false, inactive: true });
});

test("a recurring schedule that missed runs while the machine slept fires once, saying when it was due", async () => {
	s = scenario("schedules", "catch-up");
	const pi = await launched("pi", "reply up");
	const { details } = await scheduled("reply tick", "--from", pi.id, "--cron", "*/5 * * * *", "--label", "Every 5 minutes");
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
	const pi = await launched("pi", "reply up");
	await scheduled(
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

	const refusals: [string[], string][] = [
		[["--at", "PT1H", "--cron", "* * * * *"], "give at, to run once, or cron, to recur: one of them"],
		[["--at", "fri 3pm"], 'at: "fri 3pm" is neither an ISO 8601 time with offset nor a duration like "PT2H"'],
		[["--at", "2020-01-01T09:00:00Z"], "at: 2020-01-01T09:00:00Z has passed"],
		[["--cron", "0 9 * *"], 'cron: "0 9 * *" needs 5 fields, "M H DoM Mon DoW"'],
		[["--at", "PT1H", "--request-response"], "a message to this session can't request a response from it"],
		[
			["--at", "PT1H", "--snooze", "--launch-harness", "pi", "--launch-title", "x"],
			"snooze needs an existing session; a launch has none to snooze",
		],
	];
	for (const [args, error] of refusals) {
		const result = await swbIn("reply nope", "schedule", "--from", pi.id, "--label", "nope", ...args);
		expect({ args, err: result.err.trim() }).toEqual({ args, err: `swb: ${error}` });
	}

	const first = await scheduled("reply once", "--from", pi.id, "--at", "PT1H", "--label", "in an hour", "--request-id", "call-1");
	const again = await scheduled("reply once", "--from", pi.id, "--at", "PT1H", "--label", "in an hour", "--request-id", "call-1");
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
});

test("Claude Code and Codex schedule and snooze through swb's tools, and Claude Code's own scheduler is off", async () => {
	s = scenario("schedules", "harnesses", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const [claude, codex] = await Promise.all([launched("claude", "reply claude up"), launched("codex", "reply codex up")]);
	const tools = s.requests("claude").flatMap((r) => r.tools as string[]);
	expect(tools).toContain("mcp__swb__session_schedule");
	expect(tools.filter((name) => /^(CronCreate|CronList|CronDelete|ScheduleWakeup)$/.test(name))).toEqual([]);

	for (const [id, marker] of [
		[claude.id, "SWB-claude-later"],
		[codex.id, "SWB-codex-later"],
	] as const) {
		type(id, `call session_schedule {"message":"${marker}","at":"PT6S","label":"in 6 seconds","snooze":true}`);
		await until(() => snoozeOf(id).snoozed, budgets.settle, `${marker} snoozed`);
	}
	await until(() => pane(claude.id).includes("got SWB-claude-later"), ready, "Claude answering its own schedule");
	await until(() => pane(codex.id).includes("got SWB-codex-later"), ready, "Codex answering its own schedule");
	expect(snoozeOf(claude.id).snoozed).toBe(false);
	expect(snoozeOf(codex.id).snoozed).toBe(false);
	expect(s.requests("claude").some((r) => String(r.context).includes("this session), scheduled for"))).toBe(true);

	type(claude.id, `call swb_update_session {"snooze":"next_message"}`);
	await until(() => snoozeOf(claude.id).snoozed, budgets.settle, "Claude snoozed until a message");
	type(codex.id, `call session_send_message {"session":"${claude.id}","message":"SWB-wake-claude","requestResponse":false}`);
	await until(() => pane(claude.id).includes("got SWB-wake-claude"), ready, "Claude woken by Codex's message");
	expect(snoozeOf(claude.id).snoozed).toBe(false);
});

test("the Deck's Snoozed section: s snoozes from the roster, the row says when it wakes, Enter doesn't unsnooze it, M-a S does, and the next Deck doesn't start on it", async () => {
	s = scenario("schedules", "deck");
	config(s, 'inactive_after = "1h"\n');
	s.swb("drive", "start", "--", "new");
	const st = await waitState(
		s,
		"the new pi live with the keyboard",
		(x) => x.staged.kind === "live" && x.focus === "stage",
		budgets.piReady,
	);
	await reply(s, "one");
	const id = st.staged.id as string;
	await until(() => entry(s, id)?.activity === "idle", budgets.settle, "idle");

	s.keys("M-a", "h");
	await waitState(s, "roster focus", (x) => x.focus === "roster");
	s.keys("s");
	await waitState(s, "the snooze menu", (x) => x.mode === "snooze");
	s.save("menu.txt", s.screen());
	expect(s.screen()).toContain("Until a message");
	s.keys("j", "j", "j", "Enter");
	await until(() => snoozeOf(id).snoozed && snoozeOf(id).snoozedUntil === null, budgets.settle, "snoozed until a message");
	const folded = await waitState(s, "the Snoozed section, folded", (x) =>
		x.rows.some((r) => r.kind === "section" && r.label === "Snoozed"),
	);
	expect(folded.rows.find((r) => r.kind === "section" && r.label === "Snoozed")).toEqual({
		kind: "section",
		label: "Snoozed",
		count: 1,
		expanded: false,
	});
	expect(sessionRows(folded).map((r) => r.id)).not.toContain(id);

	// A schedule aimed at it shows in its Peek.
	await scheduled("reply peeked", "--from", id, "--at", "PT2H", "--label", "SWB check later");
	const section = folded.rows.findIndex((r) => r.kind === "section" && r.label === "Snoozed");
	while (state(s).cursorRow !== section) s.keys(state(s).cursorRow < section ? "j" : "k");
	s.keys("Enter");
	await waitState(s, "Snoozed open", (x) => sessionRows(x).some((r) => r.id === id));
	await cursorTo(s, id);
	const peeked = await waitState(s, "its Peek", (x) => x.peek?.id === id && x.peek.lines.some((l) => l.includes("SWB check later")));
	s.save("peek.txt", s.screen());
	expect(peeked.peek?.lines.some((l) => l.includes("snoozed until a message"))).toBe(true);
	expect(s.screen()).toContain("↘");

	// Enter focuses it without unsnoozing it.
	s.keys("Enter");
	await waitState(s, "on the Stage", (x) => x.focus === "stage" && x.staged.id === id);
	await Bun.sleep(1500);
	expect(snoozeOf(id).snoozed).toBe(true);

	s.keys("M-a", "S");
	await until(() => !snoozeOf(id).snoozed, budgets.settle, "unsnoozed from the Stage");
	await waitState(s, "Snoozed gone", (x) => !x.rows.some((r) => r.kind === "section" && r.label === "Snoozed"));

	// A schedule that has run stays in the Peek, saying when.
	await scheduled("reply ran", "--from", id, "--at", "PT1S", "--label", "SWB soon");
	await until(() => s.signal("replied.ran") !== "", ready, "the schedule run");
	s.keys("M-a", "h");
	await waitState(s, "roster focus", (x) => x.focus === "roster");
	s.keys("k");
	await cursorTo(s, id);
	const ran = await waitState(
		s,
		"the Peek's finished schedule",
		(x) => x.peek?.id === id && x.peek.lines.some((l) => l.includes("✓ SWB soon")),
	);
	expect(ran.peek?.lines.find((l) => l.includes("✓ SWB soon"))).toMatch(/✓ SWB soon · ran just now/);

	// Snoozed by its agent under the cursor, it isn't where the next Deck starts, though another session is.
	const other = await launched("pi", "reply other");
	s.swb("snooze", id, "one_hour");
	await waitState(
		s,
		"in Snoozed, the cursor still on it",
		(x) => x.cursor === id && x.rows.some((r) => r.kind === "section" && r.label === "Snoozed"),
	);
	await Bun.sleep(1500);
	s.swb("drive", "stop");
	s.swb("drive", "start");
	const reopened = await waitState(s, "the next Deck", (x) => x.ready && x.rows.some((r) => r.kind === "section" && r.label === "Snoozed"));
	expect(reopened.cursor).toBe(other.id);
});

test("swb quit refuses a running turn, then stops everything, leaving sessions open; any swb restarts a dead clock", async () => {
	s = scenario("schedules", "quit");
	const pi = await launched("pi", "reply up");
	s.swb("drive", "start");
	await waitState(s, "the Deck up", (x) => x.ready);
	const clockPid = () => s.tmux(s.servers.sessions, "display", "-p", "-t", "=swb-ctl:", "#{pane_dead} #{pane_pid}");
	const before = clockPid();
	expect(before).toMatch(/^0 \d+$/);
	s.tmux(s.servers.sessions, "run-shell", `kill ${before.split(" ")[1]}`);
	await until(() => clockPid().startsWith("1 "), budgets.settle, "the clock dead");
	s.swb("wake", pi.id);
	await until(() => clockPid().startsWith("0 ") && clockPid() !== before, budgets.settle, "the clock respawned");

	type(pi.id, "hold q1");
	await until(() => s.signal("q1.entered") !== "", budgets.settle, "the held turn");
	const refused = s.swbTry("quit");
	expect(refused.code).toBe(1);
	expect(refused.err.trim()).toBe(`swb: turn running in "${entry(s, pi.id).title ?? pi.id}": wait for it to complete, or swb quit --force`);
	release(s, "q1");
	await until(() => entry(s, pi.id).activity === "idle", budgets.settle, "idle");
	expect(s.swb("quit").trim()).toBe("Stopped 1 session, every Deck, and swb's clock. swb starts them again.");
	expect(() => s.tmux(s.servers.sessions, "has-session")).toThrow();
	expect(() => s.tmux(s.servers.ui, "has-session")).toThrow();
	expect(entry(s, pi.id)).toMatchObject({ open: true, live: false, interrupted: false });
});
