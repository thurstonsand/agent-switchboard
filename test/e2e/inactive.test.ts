import { afterEach, expect, test } from "bun:test";
import type { DeckState } from "../../packages/cli/src/deck/protocol.ts";
import { config, cursorTo, entry, launched, rowIndex, seed, sessionRows, state, title, waitState } from "./harness/deck.ts";
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

test("Inactive after inactive_after, never while blocked or unseen", async () => {
	s = scenario("phase3", "inactive");
	const [unseen] = (await seed(s, { turns: ["unseen"] })) as [string];
	config(s, 'inactive_after = "2s"\n');
	const { id: blocked } = await liveSession(s, "ready");
	s.keys("-l", "attention b1", "Enter");
	await until(() => entry(s, blocked)?.activity === "blocked", budgets.settle, "blocked");
	await Bun.sleep(3000);
	expect(entry(s, blocked).inactive).toBe(false);
	expect(entry(s, unseen)).toMatchObject({ unseen: true, inactive: false });
	expect(state(s).rows.some((r) => r.kind === "section" && r.label === "Inactive")).toBe(false);
	await until(() => title(s) === "swb ◆1 ●1", budgets.settle, "the title counting both");
	s.save("blocked-and-unseen.txt", s.screen());

	release(s, "b1");
	await until(() => entry(s, blocked).inactive, 8000, "the released session goes inactive once seen and quiet");
	await until(() => title(s) === "swb ●1", budgets.settle, "the title counting only the unseen");
	s.keys("M-a", "h");
	await waitState(s, "roster focus", (x) => x.focus === "roster");
	await cursorTo(s, unseen);
	s.keys("Enter");
	await waitState(s, "unseen live on view", (x) => x.staged.id === unseen && x.staged.kind === "live", budgets.piReady);
	await until(() => entry(s, unseen).inactive, 8000, "visited, then inactive");
	await until(() => title(s) === "swb", budgets.settle, "the title counting nothing");
	const st = await waitState(s, "Inactive section", (x) => x.rows.some((r) => r.kind === "section" && r.label === "Inactive"));
	s.save("inactive.txt", `${s.screen()}\n${JSON.stringify(st.rows, null, 2)}`);

	// Waking a session isn't activity: it stays in Inactive while it loads, and after.
	const sectionOf = (x: DeckState) => x.rows.slice(0, rowIndex(x, unseen)).findLast((r) => r.kind === "section")?.label;
	s.tmux(s.servers.sessions, "kill-session", "-t", `=${st.staged.host}`);
	await until(() => !entry(s, unseen).live, budgets.settle, "dormant");
	s.keys("M-a", "h");
	await waitState(s, "roster focus", (x) => x.focus === "roster");
	const inactiveRow = (x: DeckState) => x.rows.findIndex((r) => r.kind === "section" && r.label === "Inactive");
	const at = state(s);
	s.keys(...Array<string>(Math.abs(inactiveRow(at) - at.cursorRow)).fill(inactiveRow(at) > at.cursorRow ? "j" : "k"));
	await waitState(s, "cursor on Inactive", (x) => x.cursorRow === inactiveRow(x));
	s.keys("Enter");
	await waitState(s, "Inactive expanded", (x) => rowIndex(x, unseen) !== -1);
	await cursorTo(s, unseen);
	s.keys("Enter");
	const waking = await waitState(s, "waking", (x) => x.waking.some((w) => w.id === unseen));
	expect(sectionOf(waking)).toBe("Inactive");
	const woke = await waitState(s, "woken", (x) => x.staged.id === unseen && x.staged.kind === "live", budgets.piReady);
	expect(sectionOf(woke)).toBe("Inactive");
});

test("a family goes Inactive only as a whole: while one member is active, so are the rest", async () => {
	s = scenario("phase8", "inactive-family");
	config(s, 'inactive_after = "5s"\n');
	const root = await launched(s, "reply root", { cwd: s.project, title: "root" });
	const child = await launched(s, "reply child", { from: root, title: "child" });
	const alone = await launched(s, "reply alone", { cwd: s.project, title: "alone" });
	const visit = async (id: string) => {
		await cursorTo(s, id);
		s.keys("Enter");
		await until(() => !entry(s, id).unseen, budgets.settle, `${id} visited`);
		s.keys("M-a", "h");
		await waitState(s, "the roster focused", (x) => x.focus === "roster");
	};
	s.swb("drive", "start");
	// The child is visited last, so the next Deck opens on it, leaving Inactive folded away.
	for (const id of [alone, root, child]) await visit(id);
	s.swb("drive", "stop");
	await until(() => [root, child, alone].every((id) => entry(s, id).inactive), 15_000, "all three quiet and seen");

	// A new turn in the child makes it active again, and its parent with it; the unrelated session stays Inactive.
	const sent = Bun.spawn([`${s.bin}/swb`, "send", "--from", root, "--to", child], { env: s.env, stdin: new Blob(["reply again"]) });
	expect(await sent.exited).toBe(0);
	await until(() => !entry(s, child).inactive, budgets.settle, "the child active");
	expect(entry(s, root).inactive).toBe(false);
	expect(entry(s, alone).inactive).toBe(true);
	s.swb("drive", "start");
	const st = await waitState(
		s,
		"the family open, alone Inactive",
		(x) => x.ready && x.rows.some((r) => r.kind === "section" && r.label === "Inactive"),
	);
	expect(sessionRows(st).map((r) => [r.title, r.level])).toEqual([
		["root", 0],
		["child", 1],
	]);
	s.save("inactive-family.txt", `${s.screen()}\n${JSON.stringify(st.rows, null, 2)}`);
	await visit(child);
	await until(
		() => entry(s, root).inactive && entry(s, child).inactive,
		20_000,
		"the family Inactive together once all of it is seen and quiet",
	);
});
