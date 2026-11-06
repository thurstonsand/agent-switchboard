import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cursorTo, entry, launched, launchTry, rowIndex, sessionRows, waitState } from "./harness/deck.ts";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";
import { liveSession } from "./harness/lifecycle.ts";
import { scheduled, swbIn } from "./harness/schedules.ts";

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
	expect(st.archive).toEqual({ id: root, counts: "●3", all: 4, cancels: null });
	await until(
		() => s.screen().includes("A   Archive family (4)") && s.screen().includes("esc Cancel"),
		budgets.settle,
		"the prompt's choices",
	);
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
	const y = lines.findIndex((line) => line.includes("A   Archive family (4)"));
	s.swb("drive", "click", String((lines[y] as string).indexOf("A   Archive family (4)") + 1), String(y));
	await until(() => open().every((o) => !o), budgets.settle, "the whole family archived by a click");
	await waitState(s, "the prompt gone", (x) => x.mode === "roster");
	s.save("archived-all.txt", s.screen());
});

test("archiving cancels every schedule a session set or receives: a names them after the family prompt, and swb archive asks or needs --yes", async () => {
	s = scenario("phase8", "archive-schedules");
	const lead = await launched(s, "reply lead", { cwd: s.project, title: "lead" });
	const peer = await launched(s, "reply peer", { cwd: s.project, title: "peer" });
	const child = await launched(s, "reply child", { from: lead, title: "child" });
	await scheduled(s, "reply standup", "--from", lead, "--to", peer, "--cron", "0 9 * * *", "--schedule-label", "standup");
	const nightly = await swbIn(
		s,
		"reply nightly",
		"launch",
		"--from",
		lead,
		"--title",
		"nightly",
		"--cron",
		"0 2 * * *",
		"--schedule-label",
		"nightly build",
	);
	expect(nightly).toMatchObject({ code: 0, err: "" });
	await scheduled(s, "reply check", "--from", peer, "--to", lead, "--at", "PT1H", "--schedule-label", "check on lead");
	await scheduled(s, "reply own", "--from", child, "--at", "PT1H", "--schedule-label", "child's check-in");
	await scheduled(s, "reply own", "--from", peer, "--at", "PT1H", "--schedule-label", "peer's own");
	const pending = () =>
		s
			.query<{ label: string }>("SELECT schedule_label AS label FROM schedules WHERE next_at IS NOT NULL AND cancelled_at IS NULL")
			.map((r) => r.label)
			.sort();
	/** The docked archive prompt, with its Cancel action in the footer. */
	const prompt = () => {
		const lines = s
			.screen()
			.split("\n")
			.map((line) => line.slice(0, 42).trim());
		const top = lines.findIndex((line) => line.startsWith("─ Archive"));
		const bottom = lines.findIndex((line, i) => i > top && line.startsWith("──"));
		return top === -1 ? [] : [...lines.slice(top + 1, bottom), ...lines.filter((line) => line === "esc Cancel")];
	};
	s.swb("drive", "start");
	await waitState(s, "the sessions on the roster", (x) => x.ready && rowIndex(x, child) !== -1);

	// First whether its family goes too, then the schedules that go with what was chosen.
	await cursorTo(s, lead);
	s.keys("a");
	await waitState(s, "the family prompt", (x) => x.mode === "archive" && x.archive?.cancels === null);
	await until(() => prompt().at(-1) === "esc Cancel", budgets.settle, "the family prompt's answers");
	expect(prompt()).toEqual(["1 child session", "a   Archive this session", "A   Archive family (2)", "esc Cancel"]);
	s.keys("A");
	await waitState(s, "the schedules prompt", (x) => x.archive?.cancels != null);
	await until(() => prompt().includes("◷ child's check-in"), budgets.settle, "the schedules all 2 cancel");
	// Each session's, set or received, soonest first, under its title.
	const own = prompt().slice(2, 5);
	expect(own.toSorted()).toEqual(["↻ nightly build", "↻ standup", "◷ check on lead"]);
	expect(prompt()).toEqual([
		"Cancels schedules:",
		"lead",
		...own,
		"child",
		"◷ child's check-in",
		"a   Archive 2; cancel schedules",
		"esc Cancel",
	]);
	s.save("prompt-family.txt", s.screen());
	s.keys("Escape");
	await waitState(s, "the prompt gone", (x) => x.mode === "roster" && x.archive === null);
	expect([entry(s, lead).open, entry(s, child).open, pending().length]).toEqual([true, true, 5]);

	// The session alone: its own schedules, under no title.
	s.keys("a");
	await waitState(s, "the family prompt again", (x) => x.archive?.cancels === null);
	s.keys("a");
	await waitState(s, "its own schedules", (x) => x.archive?.cancels?.length === 3);
	await until(() => prompt()[1] === own[0], budgets.settle, "the schedules it alone cancels");
	expect(prompt()).toEqual(["Cancels schedules:", ...own, "a   Archive 1; cancel schedules", "esc Cancel"]);
	s.save("prompt.txt", s.screen());
	s.keys("a");
	await until(() => !entry(s, lead).open, budgets.settle, "lead archived alone");
	expect(entry(s, child).open).toBe(true);
	expect(pending()).toEqual(["child's check-in", "peer's own"]);

	// No family and no worktree: straight to its schedules.
	await cursorTo(s, peer);
	s.keys("a");
	await waitState(s, "the schedules prompt for peer", (x) => x.archive?.cancels != null);
	await until(() => prompt().includes("◷ peer's own"), budgets.settle, "the schedule it cancels");
	expect(prompt()).toEqual(["Cancels schedules:", "◷ peer's own", "a   Archive 1; cancel schedules", "esc Cancel"]);
	s.save("prompt-schedules-only.txt", s.screen());
	s.keys("Escape");
	await waitState(s, "the prompt gone", (x) => x.mode === "roster");
	expect(entry(s, peer).open).toBe(true);

	// swb archive from a script refuses, naming them; at a terminal it asks.
	const refused = s.swbTry("archive", peer);
	expect({ code: refused.code, err: refused.err.trim() }).toEqual({
		code: 1,
		err: `swb: archiving "peer" cancels 1 schedule: "peer's own"; swb archive --yes ${peer} to archive anyway`,
	});
	const shell = `swb-shell-${s.instance}`;
	const terminal = (answer: string) => {
		s.tmux(
			shell,
			"new-session",
			"-d",
			"-s",
			answer,
			"-x",
			"100",
			"-y",
			"10",
			"-c",
			s.project,
			`swb archive ${peer}; echo "exit $?"; sleep 600`,
		);
		return () => s.tmux(shell, "capture-pane", "-p", "-t", `=${answer}:`);
	};
	const no = terminal("n");
	await until(() => no().includes("Archive it? [y/N]"), budgets.settle, "the CLI's question");
	expect(no()).toMatch(/^Archiving "peer" cancels its schedules:\n {2}◷ peer's own · \w{3} \w{3} \d+, \d\d:\d\d\nArchive it\? \[y\/N\]/);
	s.tmux(shell, "send-keys", "-t", "=n:", "n", "Enter");
	await until(() => no().includes("exit 1"), budgets.settle, "no archives nothing");
	expect(no()).toContain("swb: not archived");
	expect(entry(s, peer).open).toBe(true);
	s.save("cli-prompt.txt", no());
	const yes = terminal("y");
	await until(() => yes().includes("Archive it? [y/N]"), budgets.settle, "the CLI's question again");
	s.tmux(shell, "send-keys", "-t", "=y:", "y", "Enter");
	await until(() => yes().includes("exit 0"), budgets.settle, "yes archives");
	expect(entry(s, peer).open).toBe(false);
	expect(pending()).toEqual(["child's check-in"]);
	// --yes needs no terminal.
	s.swb("archive", "--yes", child);
	expect([entry(s, child).open, pending()]).toEqual([false, []]);
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
