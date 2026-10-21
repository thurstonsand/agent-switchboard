import { afterEach, expect, test } from "bun:test";
import { config, cursorTo, entry, reply, sessionRows, state, waitState } from "./harness/deck.ts";
import { budgets, release, type Scenario, scenario, until } from "./harness/index.ts";
import { host, launched, ready, scheduled, snoozeOf, swbIn, type } from "./harness/schedules.ts";

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

test("a timed snooze holds through a conversation and shows while blocked or cut off; next_message ends at the next message or prompt", async () => {
	s = scenario("schedules", "snooze-rules");
	const [pi, other] = await Promise.all([launched(s, "pi", "reply one"), launched(s, "pi", "reply other")]);

	s.swb("snooze", pi.id, "one_hour");
	expect(snoozeOf(s, pi.id)).toMatchObject({ snoozed: true, snoozedUntil: expect.any(Number) });
	expect((snoozeOf(s, pi.id).snoozedUntil as number) - Date.now()).toBeGreaterThan(3_500_000);

	// A message and its whole turn leave a timed snooze alone, and the finished turn isn't Unseen while it holds.
	expect((await swbIn(s, "reply talked", "send", "--from", other.id, "--to", pi.id)).code).toBe(0);
	await until(() => s.signal("replied.talked") !== "", budgets.settle, "the message answered");
	await until(() => entry(s, pi.id).activity === "idle", budgets.settle, "idle");
	expect(snoozeOf(s, pi.id)).toMatchObject({ snoozed: true, unseen: false });

	// Blocked on me, it shows; released, it's back in Snoozed.
	type(s, pi.id, "attention a1");
	await until(() => entry(s, pi.id).activity === "blocked", budgets.settle, "blocked");
	expect(snoozeOf(s, pi.id).snoozed).toBe(false);
	release(s, "a1");
	await until(() => entry(s, pi.id).activity === "idle", budgets.settle, "idle again");
	expect(snoozeOf(s, pi.id).snoozed).toBe(true);

	// Unsnoozed by hand, what it did meanwhile is Unseen.
	expect(s.swb("snooze", pi.id, "off").trim()).toBe(`Unsnoozed "${entry(s, pi.id).title ?? pi.id}".`);
	expect(snoozeOf(s, pi.id)).toMatchObject({ snoozed: false, unseen: true });

	s.swb("snooze", pi.id, "next_message");
	expect(snoozeOf(s, pi.id)).toMatchObject({ snoozed: true, snoozedUntil: null });
	// A message scheduled for later is no message yet.
	const later = await scheduled(s, "reply later", "--from", other.id, "--to", pi.id, "--at", "PT1H", "--label", "in an hour");
	expect(snoozeOf(s, pi.id).snoozed).toBe(true);
	expect((await swbIn(s, "reply two", "send", "--from", other.id, "--to", pi.id)).code).toBe(0);
	expect(snoozeOf(s, pi.id).snoozed).toBe(false);
	await until(() => s.signal("replied.two") !== "", budgets.settle, "the second message answered");
	expect(s.query("select next_at from schedules where id = ?", later.details.id)).toEqual([{ next_at: later.details.nextAt }]);

	// A prompt typed into it ends next_message's snooze too.
	s.swb("snooze", pi.id, "next_message");
	expect(snoozeOf(s, pi.id).snoozed).toBe(true);
	type(s, pi.id, "reply typed");
	await until(() => s.signal("replied.typed") !== "", budgets.settle, "the typed prompt answered");
	expect(snoozeOf(s, pi.id).snoozed).toBe(false);

	// Killed mid-turn, a snoozed session is Interrupted, and that shows.
	s.swb("snooze", other.id, "one_hour");
	type(s, other.id, "hold i1");
	await until(() => s.signal("i1.entered") !== "", budgets.settle, "the held turn");
	s.tmux(s.servers.sessions, "kill-session", "-t", `=${host(s, other.id)}`);
	await until(() => !entry(s, other.id).live, budgets.settle, "dormant");
	expect(snoozeOf(s, other.id).cutOff).not.toBeNull();
	expect(snoozeOf(s, other.id).snoozed).toBe(false);

	// Archiving cancels what was coming and the snooze with it; unarchiving brings neither back.
	// Monday is 9 AM on the next one, never today's.
	s.swb("snooze", pi.id, "monday");
	const monday = new Date(snoozeOf(s, pi.id).snoozedUntil as number);
	expect([monday.getDay(), monday.getHours(), monday.getMinutes()]).toEqual([1, 9, 0]);
	const today = new Date();
	const days = Math.round((new Date(monday).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 86_400_000);
	expect(days).toBe(today.getDay() === 1 ? 7 : (8 - today.getDay()) % 7);
	s.swb("archive", pi.id);
	s.swb("unarchive", pi.id);
	expect(
		s.query<{ cancelled: number }>("select cancelled_at is not null as cancelled from schedules where id = ?", later.details.id),
	).toEqual([{ cancelled: 1 }]);
	expect(snoozeOf(s, pi.id)).toMatchObject({ open: true, snoozed: false });

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
	expect(snoozeOf(s, id)).toMatchObject({ snoozed: true, unseen: false, inactive: false });
	await until(() => !snoozeOf(s, id).snoozed, budgets.settle, "the snooze run out");
	expect(snoozeOf(s, id)).toMatchObject({ unseen: true, inactive: false });
	await Bun.sleep(3500);
	expect(snoozeOf(s, id)).toMatchObject({ unseen: true, inactive: false });

	s.keys("M-a", "h");
	await waitState(s, "roster focus", (x) => x.focus === "roster");
	await cursorTo(s, id);
	s.keys("Enter");
	await waitState(s, "on the Stage", (x) => x.focus === "stage" && x.staged.id === id);
	s.swb("drive", "focus", "in");
	await until(() => !entry(s, id).unseen, 3000, "visited once focused");
	expect(snoozeOf(s, id)).toMatchObject({ snoozed: false, inactive: true });
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
	// The Deck reads the db on its own tick, and refuses to snooze a session it hasn't seen a prompt in yet.
	await waitState(s, "its row in the Deck", (x) => sessionRows(x).some((r) => r.id === id && !r.provisional));

	s.keys("M-a", "h");
	await waitState(s, "roster focus", (x) => x.focus === "roster");
	s.keys("s");
	await waitState(s, "the snooze menu", (x) => x.mode === "snooze");
	s.save("menu.txt", s.screen());
	expect(s.screen()).toContain("Until a message");
	s.keys("j", "j", "j", "Enter");
	await until(() => snoozeOf(s, id).snoozed && snoozeOf(s, id).snoozedUntil === null, budgets.settle, "snoozed until a message");
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
	await scheduled(s, "reply peeked", "--from", id, "--at", "PT2H", "--label", "SWB check later");
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
	expect(snoozeOf(s, id).snoozed).toBe(true);

	s.keys("M-a", "S");
	await until(() => !snoozeOf(s, id).snoozed, budgets.settle, "unsnoozed from the Stage");
	await waitState(s, "Snoozed gone", (x) => !x.rows.some((r) => r.kind === "section" && r.label === "Snoozed"));

	// A schedule that has run stays in the Peek, saying when.
	await scheduled(s, "reply ran", "--from", id, "--at", "PT1S", "--label", "SWB soon");
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
	const other = await launched(s, "pi", "reply other");
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
