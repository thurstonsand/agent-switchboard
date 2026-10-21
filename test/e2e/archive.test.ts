import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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

test("a archives an idle live session and kills its pi; a on an Archived row leaves it dormant and open; the cursor stays put", async () => {
	s = scenario("phase3", "archive-toggle");
	const [a, b, , d] = (await seed(s, { turns: ["a"] }, { turns: ["b"] }, { turns: ["c"] }, { turns: ["d"] })) as [
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
	const at = rowIndex(up, b);
	s.keys("a");
	const after = await waitState(s, "b archived", (x) => rowIndex(x, b) === -1);
	expect(rowIndex(after, after.cursor as string)).toBe(at);
	expect(after.cursor).toBe(a);
	await until(() => !piSessions(s).includes(up.staged.host as string), budgets.settle, "b's pi killed");
	expect(entry(s, b)).toMatchObject({ open: false, live: false });
	s.save("archived-b.txt", s.screen());

	s.keys("G", "Enter");
	await waitState(s, "Archived expanded", (x) => x.rows.some((r) => r.kind === "section" && r.label === "Archived" && r.expanded));
	await cursorTo(s, d);
	const onD = await waitState(s, "archived d on the Stage", (x) => x.cursor === d && x.staged.kind === "dormant");
	await until(() => s.screen().includes("a unarchive"), budgets.settle, "the archived legend");
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

test("/archive archives and quits; before the first prompt it refuses", async () => {
	s = scenario("phase3", "pi-archive");
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the new pi live with the keyboard", (x) => x.staged.kind === "live" && x.focus === "stage");
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
