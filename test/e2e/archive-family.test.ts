import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cursorTo, entry, launched, launchTry, rowIndex, sessionRows, waitState } from "./harness/deck.ts";
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

test("a on a session that started others still open asks first: esc keeps them, a archives it alone, A all of them; M-a a asks from the Stage", async () => {
	s = scenario("phase8", "archive-family");
	const other = join(s.root, "other");
	mkdirSync(other);
	const root = await launched(s, "reply root", { cwd: s.project, title: "root" });
	const child = await launched(s, "reply child", { from: root, title: "child" });
	const grandchild = await launched(s, "reply grandchild", { from: child, title: "grandchild" });
	const away = await launched(s, "reply away", { from: root, cwd: other, title: "away" });
	const family = [root, child, grandchild, away];
	const open = () => family.map((id) => entry(s, id).open);
	s.swb("drive", "start");
	await waitState(s, "the family on the roster", (x) => x.ready && rowIndex(x, grandchild) !== -1);

	await cursorTo(s, root);
	s.keys("a");
	let st = await waitState(s, "the archive prompt", (x) => x.mode === "archive");
	// Everything it started, in any Project, and none of it seen yet.
	expect(st.archive).toEqual({ id: root, counts: "●3", all: 4 });
	await until(() => s.screen().includes("Archive  a this  A all 4  esc abort"), budgets.settle, "the prompt's choices");
	s.save("prompt.txt", s.screen());
	s.save("prompt.ansi", s.swb("drive", "capture", "--ansi"));
	s.keys("Escape");
	await waitState(s, "the prompt gone", (x) => x.mode === "roster" && x.archive === null);
	expect(open()).toEqual([true, true, true, true]);

	s.keys("a");
	await waitState(s, "asked again", (x) => x.mode === "archive");
	s.keys("a");
	await until(() => !entry(s, root).open, budgets.settle, "root archived alone");
	expect(open()).toEqual([false, true, true, true]);
	// Its child stands on its own while it's archived, once the cursor has left root's lingering row, and goes back
	// under it when it returns.
	s.keys("j");
	st = await waitState(s, "the child a root of its own", (x) => sessionRows(x).find((r) => r.id === child)?.origin === "session");
	expect(sessionRows(st).find((r) => r.id === child)).toMatchObject({ level: 0, origin: "session" });
	s.swb("unarchive", root);
	st = await waitState(s, "the child back under root", (x) => sessionRows(x).find((r) => r.id === child)?.level === 1);
	expect(sessionRows(st).find((r) => r.id === grandchild)).toMatchObject({ level: 2, origin: null });

	await cursorTo(s, root);
	s.keys("Enter");
	await waitState(s, "root's pi focused", (x) => x.focus === "stage" && x.staged.id === root && x.staged.kind === "live", budgets.piReady);
	s.keys("M-a", "a");
	await waitState(s, "the prompt, with the keyboard", (x) => x.mode === "archive" && x.focus === "roster");
	const lines = s.screen().split("\n");
	const y = lines.findIndex((line) => line.includes("A all 4"));
	s.swb("drive", "click", String((lines[y] as string).indexOf("A all 4") + 1), String(y));
	await until(() => open().every((o) => !o), budgets.settle, "the whole family archived by a click");
	await waitState(s, "the prompt gone", (x) => x.mode === "roster");
	s.save("archived-all.txt", s.screen());
});

test("a prefix key on the archive prompt leaves it unanswered: M-a S opens snooze in its place, and M-a n the picker", async () => {
	s = scenario("phase8", "archive-prompt-left");
	const root = await launched(s, "reply root", { cwd: s.project, title: "root" });
	const child = await launched(s, "reply child", { from: root, title: "child" });
	const snoozedAt = (id: string) =>
		s.query<{ at: number | null }>("SELECT snoozed_at AS at FROM marks WHERE session_id = ?", id)[0]?.at ?? null;
	const settled = () => [root, child].map((id) => ({ open: entry(s, id).open, snoozed: snoozedAt(id) !== null }));
	s.swb("drive", "start");
	await waitState(s, "the family on the roster", (x) => x.ready && rowIndex(x, child) !== -1);
	await cursorTo(s, root);

	s.keys("a");
	await waitState(s, "the archive prompt", (x) => x.mode === "archive");
	s.keys("M-a", "S");
	const snoozing = await waitState(s, "snooze in its place", (x) => x.mode === "snooze");
	expect(snoozing.archive).toBeNull();
	s.keys("Escape");
	await waitState(s, "back to the roster", (x) => x.mode === "roster" && x.archive === null);

	s.keys("a");
	await waitState(s, "the archive prompt again", (x) => x.mode === "archive");
	s.keys("M-a", "n");
	const picking = await waitState(s, "the picker in its place", (x) => x.mode === "picker" && (x.picker?.rows.length ?? 0) > 1);
	expect(picking.archive).toBeNull();
	s.keys("Down");
	await waitState(s, "the picker's keys reach it", (x) => x.picker?.choice === 1);
	s.keys("Escape");
	await waitState(s, "back to the roster, not the prompt", (x) => x.mode === "roster" && x.archive === null);
	await Bun.sleep(500);
	expect(settled()).toEqual([
		{ open: true, snoozed: false },
		{ open: true, snoozed: false },
	]);
});

test("swb_update_session archives a whole family; one member mid-turn refuses the whole call by name until cancel_turns cancels that turn", async () => {
	s = scenario("phase3", "archive-family");
	const root = await launched(s, "reply root", { cwd: s.project, title: "Root" });
	const one = await launched(s, "reply one", { from: root, title: "One" });
	const grand = await launched(s, "reply grand", { from: one, title: "Grand" });
	const held = launchTry(s, "reply child fam", { from: root, title: "Held" });
	await until(() => s.signal("child.fam.entered") !== "", budgets.piReady, "Held's turn running");
	const heldId = (JSON.parse((await held).out) as { details: { id: string } }).details.id;
	const family = [root, one, grand, heldId];
	const { id: caller } = await liveSession(s, "caller");

	s.keys("-l", `call swb_update_session {"session":"${root}","archived":true,"family":true,"title":"Never set"}`, "Enter");
	await until(() => s.screen().includes("Nothing changed"), budgets.settle, "the refusal");
	expect(s.screen()).toContain('"Held" is mid-turn');
	for (const id of family) expect(entry(s, id).open).toBe(true);
	expect(entry(s, root).title).toBe("Root");
	s.save("refused.txt", s.screen());

	s.keys("-l", `call swb_update_session {"session":"${root}","archived":true,"family":true,"cancel_turns":true}`, "Enter");
	await until(() => family.every((id) => !entry(s, id).open && !entry(s, id).live), budgets.settle, "the family archived and stopped");
	expect(entry(s, heldId).cutOff).toBeNull();
	expect(entry(s, caller)).toMatchObject({ open: true, live: true });
	expect(s.screen()).toContain("Cancelled the turns of");
	s.save("forced.txt", s.screen());
});
