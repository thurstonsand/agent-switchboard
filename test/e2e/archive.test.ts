import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cursorTo, entry, piSessions, reply, rowIndex, seed, sessionRows, state, waitState } from "./harness/deck.ts";
import { budgets, release, type Scenario, scenario, until } from "./harness/index.ts";
import { liveSession } from "./harness/lifecycle.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
		s.save("final-marks.json", JSON.stringify(s.query("SELECT * FROM marks"), null, 2));
		s.save("final-ls.json", JSON.stringify(s.ls(), null, 2));
	} catch {}
	await s.cleanup();
});

const TURN_RUNNING = "turn running: wait for it to complete";

test("archive is refused mid-turn from the roster, the CLI, and pi; once idle, swb archive kills the pi", async () => {
	s = scenario("phase3", "archive-refused");
	const { id, host } = await liveSession(s, "ready");
	s.keys("-l", "hold h1", "Enter");
	await until(() => s.signal("h1.entered") !== "", budgets.settle, "the held turn");
	await until(() => entry(s, id).activity === "working", budgets.settle, "working");

	const cli = s.swbTry("archive", id);
	expect(cli.code).toBe(1);
	expect(cli.err.trim()).toBe(`swb: ${TURN_RUNNING}`);

	s.keys("-l", "/archive", "Enter");
	await until(() => s.screen().includes(TURN_RUNNING), budgets.settle, "pi's refusal");
	s.save("pi-refused.txt", s.screen());

	s.keys("M-a", "h");
	await waitState(s, "roster focus", (x) => x.focus === "roster");
	s.keys("a");
	const refused = await waitState(s, "the roster's refusal", (x) => x.toasts.some((t) => t.text === TURN_RUNNING));
	expect(refused.toasts).toContainEqual({ text: TURN_RUNNING, level: "error" });
	s.save("roster-refused.txt", s.screen());
	expect(entry(s, id)).toMatchObject({ open: true, live: true, activity: "working" });

	release(s, "h1");
	await until(() => entry(s, id).activity === "idle", budgets.settle, "idle");
	s.swb("archive", id);
	expect(entry(s, id)).toMatchObject({ open: false, live: false });
	await until(() => !piSessions(s).includes(host), budgets.settle, "pi killed");
	s.save("archived.txt", `${s.screen()}\n${JSON.stringify(s.ls(), null, 2)}`);
});

test("swb_update_session archives from inside a turn, and pi quits only once the turn's final message lands", async () => {
	s = scenario("phase3", "archive-tool");
	const { id, host } = await liveSession(s, "ready");
	s.keys("-l", "archive now", "Enter");
	await until(() => !piSessions(s).includes(host), budgets.settle, "pi quit");
	expect(entry(s, id)).toMatchObject({ open: false, live: false, cutOff: null });
	const { transcript } = s.query("SELECT transcript FROM sessions WHERE session_id = ?", id)[0] as { transcript: string };
	expect(readFileSync(transcript, "utf8")).toContain("tool done now");
	expect(s.query("SELECT tmux_session FROM runtimes")).toHaveLength(0);
	s.save("archived-by-tool.txt", `${s.screen()}\n${JSON.stringify(s.ls(), null, 2)}`);
});

test("a provider retry inside the archiving turn does not reopen the session", async () => {
	s = scenario("phase3", "archive-retry");
	const { id, host } = await liveSession(s, "ready");
	s.keys("-l", "archive flaky", "Enter");
	await until(() => !piSessions(s).includes(host), budgets.settle, "pi quit");
	expect(existsSync(join(s.env.HOME as string, "e2e-signals", "flaky.failed"))).toBe(true);
	expect(entry(s, id)).toMatchObject({ open: false, live: false, cutOff: null });
	const { transcript } = s.query("SELECT transcript FROM sessions WHERE session_id = ?", id)[0] as { transcript: string };
	expect(readFileSync(transcript, "utf8")).toContain("tool done flaky");
	s.save("archived-through-retry.txt", `${s.screen()}\n${JSON.stringify(s.ls(), null, 2)}`);
});

test("a archives an idle live session at once: it lingers on view, dormant, until the cursor leaves, and a pi that won't quit is closed and said so; a on an Archived row leaves it dormant and open", async () => {
	s = scenario("phase3", "archive-toggle");
	const [a, b, , d] = (await seed(s, { turns: ["a"] }, { turns: ["b"], title: "bravo" }, { turns: ["c"] }, { turns: ["d"] })) as [
		string,
		string,
		string,
		string,
	];
	s.swb("archive", d);
	s.swb("drive", "start");
	await cursorTo(s, b);
	s.keys("w");
	const up = await waitState(s, "b live", (x) => x.staged.id === b && x.staged.kind === "live", budgets.piReady);
	const host = up.staged.host as string;
	const at = rowIndex(up, b);
	writeFileSync(join(s.home, "e2e-signals", "shutdown.hold"), "");
	s.keys("a");
	// Its row stays put, marked archived, and the Stage shows its card while its pi is still in its shutdown, which
	// holds past swb's 10s grace.
	const after = await waitState(
		s,
		"b archived in place",
		(x) => sessionRows(x).find((r) => r.id === b)?.state === "archived" && x.staged.kind === "dormant",
	);
	expect(piSessions(s)).toContain(host);
	expect(rowIndex(after, b)).toBe(at);
	expect(after).toMatchObject({ cursor: b, focus: "roster", staged: { id: b } });
	await until(() => s.signal("shutdown.entered") !== "", budgets.settle, "b's shutdown held");
	s.save("archived-b-lingering.txt", s.screen());
	const told = await waitState(s, "the stop's failure", (x) => x.toasts.length > 0, 10_000 + budgets.settle);
	expect(told.toasts).toContainEqual({ text: `didn't quit in 10s; swb closed it: "bravo"`, level: "error" });
	// Too long for the message line, it wraps over the roster rather than losing its end.
	await until(() => s.screen().includes(`"bravo"`), budgets.settle, "the whole toast on screen");
	expect(piSessions(s)).not.toContain(host);
	expect(entry(s, b)).toMatchObject({ open: false, live: false });
	release(s, "shutdown");

	// j steps to the row below as if b were gone already, and b goes to Archived.
	s.keys("j");
	const left = await waitState(s, "the cursor off b", (x) => x.cursor !== b);
	expect(left.cursor).toBe(a);
	expect(rowIndex(left, a)).toBe(at);
	expect(rowIndex(left, b)).toBe(-1);
	s.save("archived-b.txt", s.screen());

	s.keys("G", "Enter");
	await waitState(s, "Archived expanded", (x) => x.rows.some((r) => r.kind === "section" && r.label === "Archived" && r.expanded));
	await cursorTo(s, d);
	const onD = await waitState(s, "archived d on the Stage", (x) => x.cursor === d && x.staged.kind === "dormant");
	await until(() => /a [Uu]narchive/.test(s.screen()), budgets.settle, "the archived legend");
	s.save("archived-card.txt", s.screen());
	const archivedAt = rowIndex(onD, d);
	s.keys("a");
	await until(() => entry(s, d).open, budgets.settle, "d open again");
	const reopened = await waitState(s, "d back among the open", (x) => rowIndex(x, d) < archivedAt && x.cursor === b);
	expect(rowIndex(reopened, b)).toBe(archivedAt);
	expect(entry(s, d)).toMatchObject({ open: true, live: false });
	expect(piSessions(s)).toHaveLength(0);
	s.save("unarchived-d.txt", s.screen());
});

test("M-a a archives from the Stage and hands the roster the keyboard; a wake or an unarchive while its pi is still quitting waits for it, then goes ahead", async () => {
	s = scenario("phase3", "archive-wake-stopping");
	const { id, host } = await liveSession(s, "ready");
	const signals = join(s.home, "e2e-signals");
	await waitState(s, "its first prompt recorded", (x) => sessionRows(x).some((r) => r.id === id && !r.provisional));
	writeFileSync(join(signals, "shutdown.hold"), "");
	s.keys("M-a", "a");
	await waitState(
		s,
		"archived in place, the roster focused",
		(x) => x.cursor === id && x.focus === "roster" && x.staged.kind === "dormant",
	);
	await until(() => s.signal("shutdown.entered") !== "", budgets.settle, "its shutdown held");

	// Enter wakes it once the old pi is gone, never onto that pi's pane.
	s.keys("Enter");
	await Bun.sleep(1500);
	expect(piSessions(s)).toEqual([host]);
	expect(state(s).staged.kind).not.toBe("live");
	release(s, "shutdown");
	const woke = await waitState(s, "woken afresh", (x) => x.staged.kind === "live" && x.staged.host !== host, budgets.piReady);
	expect(piSessions(s)).toEqual([woke.staged.host as string]);
	expect(entry(s, id)).toMatchObject({ open: false, live: true });

	// Unarchiving waits the same way, and leaves it open and dormant. A prompt opens it first, so M-a a archives again.
	await waitState(s, "the keyboard on it", (x) => x.focus === "stage");
	await reply(s, "again");
	await until(() => entry(s, id).open && entry(s, id).activity === "idle", budgets.settle, "open and idle");
	await waitState(s, "its row open", (x) => sessionRows(x).find((r) => r.id === id)?.state !== "archived");
	rmSync(join(signals, "shutdown.release"));
	rmSync(join(signals, "shutdown.entered"));
	s.keys("M-a", "a");
	await waitState(s, "archived again", (x) => x.focus === "roster" && x.staged.kind === "dormant");
	await until(() => s.signal("shutdown.entered") !== "", budgets.settle, "its shutdown held again");
	s.keys("a");
	await Bun.sleep(1500);
	expect(entry(s, id).open).toBe(false);
	release(s, "shutdown");
	await until(() => entry(s, id).open, budgets.settle, "open again");
	expect(entry(s, id)).toMatchObject({ open: true, live: false });
	expect(piSessions(s)).toHaveLength(0);
	expect(state(s).cursor).toBe(id);
	s.save("unarchived-after-stop.txt", s.screen());
});

test("swb wake from a shell waits out a harness a Deck is stopping, then starts it afresh", async () => {
	s = scenario("phase3", "archive-cli-wake-stopping");
	const { id, host } = await liveSession(s, "ready");
	await waitState(s, "its first prompt recorded", (x) => sessionRows(x).some((r) => r.id === id && !r.provisional));
	writeFileSync(join(s.home, "e2e-signals", "shutdown.hold"), "");
	s.keys("M-a", "a");
	await until(() => s.signal("shutdown.entered") !== "", budgets.settle, "its shutdown held");
	s.swb("unarchive", id);
	const t0 = Date.now();
	const woken = Bun.spawn([`${s.bin}/swb`, "wake", id], { env: s.env, stdout: "pipe" });
	await Bun.sleep(1500);
	expect(woken.exitCode).toBeNull();
	release(s, "shutdown");
	expect(await woken.exited).toBe(0);
	const fresh = (await new Response(woken.stdout).text()).trim();
	expect(Date.now() - t0).toBeGreaterThan(1500);
	expect(fresh).not.toBe(host);
	await waitState(s, "the Deck on the fresh pi", (x) => x.staged.kind === "live" && x.staged.host === fresh, budgets.piReady);
	expect(piSessions(s)).toEqual([fresh]);
	expect(entry(s, id)).toMatchObject({ open: true, live: true });
});

test("/archive archives and quits; before the first prompt it refuses", async () => {
	s = scenario("phase3", "pi-archive");
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the new pi live with the keyboard", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	s.keys("-l", "/archive", "Enter");
	await until(() => s.screen().includes("nothing to archive before the first prompt"), budgets.settle, "the provisional refusal");
	s.save("provisional-refused.txt", s.screen());
	await reply(s, "done");
	const id = state(s).staged.id as string;
	const host = state(s).staged.host as string;
	s.keys("-l", "/archive", "Enter");
	await until(() => entry(s, id)?.open === false && !entry(s, id).live, budgets.settle, "archived and quit");
	await until(() => !piSessions(s).includes(host), budgets.settle, "tmux session gone");
	expect(s.query("SELECT tmux_session FROM runtimes")).toHaveLength(0);
	s.save("pi-archived.txt", `${s.screen()}\n${JSON.stringify(s.ls(), null, 2)}`);
});

test("swb_update_session refused for an archived session changes none of what it was given", async () => {
	s = scenario("phase3", "update-refused");
	const [id, from] = (await seed(s, { turns: ["before"] }, { turns: ["other"] })) as [string, string];
	s.swb("archive", id);
	const update = (args: Record<string, unknown>) =>
		Bun.spawnSync([`${s.bin}/swb`, "update", "--from", from], { env: s.env, stdin: Buffer.from(JSON.stringify({ session: id, ...args })) });
	const marks = () => s.query("SELECT title, group_name, snoozed_at FROM marks WHERE session_id = ?", id);
	const before = marks();

	const refused = update({ title: "retitled", group: "elsewhere", snooze: "one_hour" });
	expect(refused.exitCode).toBe(1);
	expect(refused.stderr.toString()).toContain("is archived; unarchive it first");
	expect(marks()).toEqual(before);

	// Unarchived in the same call, it all goes through.
	expect(update({ archived: false, title: "retitled", snooze: "one_hour" }).exitCode).toBe(0);
	expect(entry(s, id)).toMatchObject({ open: true, title: "retitled", snoozed: true });
});

test("a new prompt in an archived session unarchives it", async () => {
	s = scenario("phase3", "prompt-unarchives");
	const [id] = (await seed(s, { turns: ["before"] })) as [string];
	s.swb("archive", id);
	expect(entry(s, id).open).toBe(false);
	s.swb("drive", "start", "--", "open", id);
	await waitState(s, "archived row selected", (x) => x.cursor === id && x.staged.kind === "dormant");
	s.keys("Enter");
	await waitState(s, "live with the keyboard", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	expect(entry(s, id).open).toBe(false);
	await reply(s, "after");
	await until(() => entry(s, id).open, budgets.settle, "open again");
	await waitState(s, "the row open again", (x) => sessionRows(x).find((r) => r.id === id)?.state !== "archived");
	s.save("unarchived-by-prompt.txt", `${s.screen()}\n${JSON.stringify(s.ls(), null, 2)}`);
});
