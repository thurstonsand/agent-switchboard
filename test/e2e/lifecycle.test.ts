import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, cursorTo, entry, piSessions, reply, rowIndex, seed, sessionRows, state, waitState } from "./harness/deck.ts";
import { budgets, release, type Scenario, scenario, until } from "./harness/index.ts";

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
const rowState = (id: string) => sessionRows(state(s)).find((r) => r.id === id)?.state;

/** A new session on the Stage, keyboard on pi, one turn in. */
async function liveSession(turn: string): Promise<{ id: string; host: string }> {
	s.swb("drive", "start", "--", "new");
	const st = await waitState(s, "the new pi live with the keyboard", (x) => x.staged.kind === "live" && x.focus === "stage");
	await reply(s, turn);
	const id = st.staged.id as string;
	await until(() => entry(s, id)?.activity === "idle", budgets.settle, "idle");
	return { id, host: st.staged.host as string };
}

test("a finished turn is Unseen while the Deck's terminal is unfocused, and a focused second on the Stage clears it", async () => {
	s = scenario("phase3", "unseen");
	const { id } = await liveSession("first");
	await until(() => !entry(s, id).unseen, 3000, "the first turn seen on the focused Stage");
	s.swb("drive", "focus", "out");
	await waitState(s, "terminal unfocused", (x) => !x.terminalFocused);
	await reply(s, "second");
	await until(() => entry(s, id).unseen, budgets.settle, "unseen");
	await Bun.sleep(2000);
	expect(entry(s, id).unseen).toBe(true);
	expect(rowState(id)).toBe("unseen");
	s.save("unfocused-unseen.txt", s.screen());
	s.swb("drive", "focus", "in");
	await until(() => !entry(s, id).unseen, 3000, "visited once focused");
	expect(rowState(id)).toBe("idle");
	s.save("focused-seen.txt", s.screen());
});

test("archive is refused mid-turn from the roster, the CLI, and pi; once idle, swb archive kills the pi", async () => {
	s = scenario("phase3", "archive-refused");
	const { id, host } = await liveSession("ready");
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

test("a first turn started by a custom message, as a handoff child's is, is tracked; killed mid-turn it is Interrupted", async () => {
	s = scenario("phase3", "custom-kickoff");
	s.swb("drive", "start", "--", "new");
	const st = await waitState(s, "the new pi live with the keyboard", (x) => x.staged.kind === "live" && x.focus === "stage");
	const id = st.staged.id as string;
	s.keys("-l", "/e2e-kick hold k1", "Enter");
	await until(() => s.signal("k1.entered") !== "", budgets.settle, "the kicked-off turn");
	await until(() => entry(s, id)?.activity === "working", budgets.settle, "a working row");
	s.save("kicked-off.txt", s.screen());
	const { pid } = s.query("SELECT pid FROM runtimes WHERE session_id = ?", id)[0] as { pid: number };
	process.kill(pid, "SIGKILL");
	await until(() => entry(s, id)?.interrupted, budgets.settle, "interrupted");
	expect(entry(s, id)).toMatchObject({ open: true, live: false, interrupted: true });
	s.save("kicked-off-killed.txt", `${s.screen()}\n${JSON.stringify(s.ls(), null, 2)}`);
});

test("swb_archive archives from inside a turn, and pi quits only once the turn's final message lands", async () => {
	s = scenario("phase3", "archive-tool");
	const { id, host } = await liveSession("ready");
	s.keys("-l", "archive now", "Enter");
	await until(() => !piSessions(s).includes(host), budgets.settle, "pi quit");
	expect(entry(s, id)).toMatchObject({ open: false, live: false, interrupted: false });
	const { transcript } = s.query("SELECT transcript FROM sessions WHERE session_id = ?", id)[0] as { transcript: string };
	expect(readFileSync(transcript, "utf8")).toContain("tool done now");
	expect(s.query("SELECT tmux_session FROM runtimes")).toHaveLength(0);
	s.save("archived-by-tool.txt", `${s.screen()}\n${JSON.stringify(s.ls(), null, 2)}`);
});

test("a provider retry inside the archiving turn does not reopen the session", async () => {
	s = scenario("phase3", "archive-retry");
	const { id, host } = await liveSession("ready");
	s.keys("-l", "archive flaky", "Enter");
	await until(() => !piSessions(s).includes(host), budgets.settle, "pi quit");
	expect(existsSync(join(s.env.HOME as string, "e2e-signals", "flaky.failed"))).toBe(true);
	expect(entry(s, id)).toMatchObject({ open: false, live: false, interrupted: false });
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
	await until(() => s.screen().includes("unarchive"), budgets.settle, "the archived card");
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

test("Inactive after inactive_after, never while blocked or unseen", async () => {
	s = scenario("phase3", "inactive");
	const [unseen] = (await seed(s, { turns: ["unseen"] })) as [string];
	config(s, 'inactive_after = "2s"\n');
	const { id: blocked } = await liveSession("ready");
	s.keys("-l", "attention b1", "Enter");
	await until(() => entry(s, blocked)?.activity === "blocked", budgets.settle, "blocked");
	await Bun.sleep(3000);
	expect(entry(s, blocked).inactive).toBe(false);
	expect(entry(s, unseen)).toMatchObject({ unseen: true, inactive: false });
	expect(state(s).rows.some((r) => r.kind === "section" && r.label === "Inactive")).toBe(false);
	s.save("blocked-and-unseen.txt", s.screen());

	release(s, "b1");
	await until(() => entry(s, blocked).inactive, 8000, "the released session goes inactive once seen and quiet");
	s.keys("M-a", "h");
	await waitState(s, "roster focus", (x) => x.focus === "roster");
	await cursorTo(s, unseen);
	s.keys("w");
	await waitState(s, "unseen live on view", (x) => x.staged.id === unseen && x.staged.kind === "live", budgets.piReady);
	await until(() => entry(s, unseen).inactive, 8000, "visited, then inactive");
	const st = await waitState(s, "Inactive section", (x) => x.rows.some((r) => r.kind === "section" && r.label === "Inactive"));
	s.save("inactive.txt", `${s.screen()}\n${JSON.stringify(st.rows, null, 2)}`);
});

test("y copies swb open <id> and Y copies @session:<id> through the clipboard command", async () => {
	s = scenario("phase3", "copy");
	const [id] = (await seed(s, { turns: ["copy me"] })) as [string];
	const file = join(s.root, "clipboard.txt");
	config(s, `clipboard = "cat > ${file}"\n`);
	s.swb("drive", "start");
	await cursorTo(s, id);
	s.keys("y");
	await until(() => existsSync(file) && readFileSync(file, "utf8") === `swb open ${id}`, budgets.settle, "y copied");
	await waitState(s, "copied toast", (x) => x.toasts.some((t) => t.text === `copied swb open ${id}`));
	s.save("copied-y.txt", s.screen());
	s.keys("Y");
	await until(() => readFileSync(file, "utf8") === `@session:${id}`, budgets.settle, "Y copied");
	s.save("copied-Y.txt", s.screen());
});

test("swb adopt tracks a session pi ran outside swb, wakes it managed, and refuses subagents and tracked sessions", async () => {
	s = scenario("phase3", "adopt");
	const outside = Bun.spawnSync([join(s.bin, "pi"), "-p", "reply outside"], { cwd: s.project, env: s.env, stdout: "pipe", stderr: "pipe" });
	expect(outside.exitCode).toBe(0);
	const sessions = join(s.env.PI_CODING_AGENT_DIR as string, "sessions");
	const [transcript] = [...new Bun.Glob("*/*.jsonl").scanSync({ cwd: sessions, absolute: true })];
	const id = (JSON.parse(readFileSync(transcript as string, "utf8").split("\n")[0] as string) as { id: string }).id;
	expect(s.ls()).toHaveLength(0);

	s.swb("drive", "start", "--", "adopt", id);
	await waitState(s, "the adopted session on the Stage", (x) => x.cursor === id && x.staged.kind === "dormant");
	expect(entry(s, id)).toMatchObject({ open: true, live: false, interrupted: false, unseen: false, cwd: s.project });
	s.save("adopted-dormant.txt", s.screen());
	s.keys("Enter");
	await waitState(
		s,
		"the adopted session live with the keyboard",
		(x) => x.staged.id === id && x.staged.kind === "live" && x.focus === "stage",
		budgets.piReady,
	);
	await reply(s, "inside");
	await until(() => entry(s, id).activity === "idle", budgets.settle, "idle");
	expect(entry(s, id)).toMatchObject({ open: true, live: true });
	const text = readFileSync(transcript as string, "utf8");
	expect(text).toContain("outside");
	expect(text).toContain("inside");
	s.save("adopted-live.txt", `${s.screen()}\n${JSON.stringify(s.ls(), null, 2)}`);

	expect(s.swbTry("adopt", id).err.trim()).toBe(`swb: adopt: ${id} is already tracked; swb open ${id}`);
	const child = join(s.root, "child_x.jsonl");
	writeFileSync(
		child,
		`${JSON.stringify({ type: "session", version: 3, id: "child-x", timestamp: new Date().toISOString(), cwd: s.project })}\n${JSON.stringify({ type: "custom", customType: "pi-sessions.handoff-bootstrap", data: { subagent: { depth: 1 } }, timestamp: new Date().toISOString() })}\n`,
	);
	expect(s.swbTry("adopt", child).err.trim()).toBe("swb: adopt: child-x is a pi-sessions subagent; its parent owns it");
	expect(s.swbTry("adopt", "no-such-id").code).toBe(1);
	const stray = join(s.root, "stray_y.jsonl");
	writeFileSync(
		stray,
		`${JSON.stringify({ type: "session", version: 3, id: "stray-y", timestamp: new Date().toISOString(), cwd: s.project })}\n${JSON.stringify({ type: "message", timestamp: new Date().toISOString() })}\n`,
	);
	expect(s.swbTry("adopt", stray).err.trim()).toBe(
		`swb: adopt: pi won't find stray-y from ${s.project}; move it to ${dirname(transcript as string)}`,
	);
});
