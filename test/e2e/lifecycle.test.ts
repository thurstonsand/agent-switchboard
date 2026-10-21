import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, cursorTo, entry, reply, seed, sessionRows, state, waitState } from "./harness/deck.ts";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";
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

const rowState = (id: string) => sessionRows(state(s)).find((r) => r.id === id)?.state;

test("a finished turn is Unseen while the Deck's terminal is unfocused, and a focused second on the Stage clears it", async () => {
	s = scenario("phase3", "unseen");
	const { id } = await liveSession(s, "first");
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
	await until(() => entry(s, id)?.cutOff, budgets.settle, "cut off");
	expect(entry(s, id)).toMatchObject({ open: true, live: false, cutOff: "killed" });
	s.save("kicked-off-killed.txt", `${s.screen()}\n${JSON.stringify(s.ls(), null, 2)}`);
	// The same process left behind by an earlier boot went with the machine.
	s.query("UPDATE runtimes SET boot_id = 'an-earlier-boot' WHERE session_id = ?", id);
	expect(entry(s, id).cutOff).toBe("restart");
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
	expect(entry(s, id)).toMatchObject({ open: true, live: false, cutOff: null, unseen: false, cwd: s.project });
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
