import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeckState, SessionStateRow } from "../../packages/cli/src/deck/protocol.ts";
import { type } from "./harness/agents.ts";
import { cursorTo, entry, launched, pickNew, reply, rowIndex, seed, sessionRows, state, waitState } from "./harness/deck.ts";
import { budgets, release, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;

afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
		s.save("final-tmux.txt", s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name} #{session_attached} #{@swb_kind}"));
	} catch {}
	await s.cleanup();
});

test("w wakes a dormant session to live while the keyboard stays in the roster", async () => {
	s = scenario("phase2", "wake");
	const [id] = (await seed(s, { turns: ["one"] })) as [string];
	s.swb("drive", "start");
	await cursorTo(s, id);
	expect(state(s).staged).toMatchObject({ id, kind: "dormant" });
	s.keys("w");
	const loading = await waitState(s, "loading", (x) => x.staged.kind === "loading", 2000);
	expect(loading.focus).toBe("roster");
	expect(loading.waking).toEqual([{ id, keyboardWaiting: false }]);
	s.save("loading.txt", s.screen());
	const up = await waitState(s, "live", (x) => x.staged.kind === "live", budgets.piReady);
	expect(up.focus).toBe("roster");
	expect(entry(s, id).live).toBe(true);
	expect(s.signal("login-shell")).not.toBe("");
	s.save("live.txt", s.screen());

	s.keys("x");
	await waitState(s, "x stops it", (x) => x.staged.kind === "exited");
	await until(() => !entry(s, id).live, budgets.settle, "its pi gone");
	expect(entry(s, id)).toMatchObject({ open: true, cutOff: null });
});

test("Enter on a dormant row puts the keyboard on its pi as it comes up; Enter then M-a h backs out while pi still starts", async () => {
	s = scenario("phase2", "enter-wake");
	const [a, b] = (await seed(s, { turns: ["alpha"] }, { turns: ["beta"] })) as [string, string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("Enter");
	const loading = await waitState(s, "loading with the keyboard", (x) => x.staged.kind === "loading" && x.focus === "stage");
	expect(loading.waking).toEqual([{ id: a, keyboardWaiting: true }]);
	s.save("enter-loading.txt", s.screen());
	await waitState(s, "live", (x) => x.staged.kind === "live", budgets.piReady);
	expect(state(s).focus).toBe("stage");
	await reply(s, "typed-after-wake");
	s.save("enter-live.txt", s.screen());

	s.keys("M-a", "h");
	await waitState(s, "roster focus", (x) => x.focus === "roster");
	await cursorTo(s, b);
	s.keys("Enter");
	await waitState(s, "keyboard on b's starting pi", (x) => x.staged.id === b && x.focus === "stage");
	await Bun.sleep(100);
	s.keys("M-a", "h");
	const back = await waitState(s, "back in the roster", (x) => x.focus === "roster");
	expect(back.waking.every((w) => !w.keyboardWaiting)).toBe(true);
	await until(() => entry(s, b).live, budgets.piReady, "b live after backing out");
	await waitState(s, "b live on the Stage", (x) => x.staged.id === b && x.staged.kind === "live", budgets.piReady);
	expect(state(s).focus).toBe("roster");
	s.save("esc-live.txt", s.screen());

	s.keys("Enter");
	await waitState(s, "keyboard in b's pi", (x) => x.focus === "stage");
	s.keys("M-a", "q");
	const decks = () => s.tmux(s.servers.ui, "list-sessions", "-F", "#{session_name}").split("\n");
	await until(() => !decks().some((name) => name.startsWith("deck-")), 5000, "M-a q closes the Deck from pi");
	s.save("prefix-q.txt", s.screen());
	expect(entry(s, a).live && entry(s, b).live).toBe(true);
});

test("M-a J from pi onto a dormant session leaves it asleep, and a key on its card wakes it into pi", async () => {
	s = scenario("phase2", "stage-key-wake");
	const [a, b] = (await seed(s, { turns: ["alpha"] }, { turns: ["beta"] })) as [string, string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("Enter");
	const live = await waitState(s, "a live with the keyboard", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	expect(live.focus).toBe("stage");

	s.keys("M-a", rowIndex(live, b) > rowIndex(live, a) ? "J" : "K");
	const asleep = await waitState(s, "b's card on the Stage", (x) => x.staged.id === b);
	await Bun.sleep(1000);
	expect(state(s)).toMatchObject({ focus: "stage", staged: { id: b, kind: "dormant" } });
	expect(asleep.waking).toEqual([]);
	s.save("asleep.txt", s.screen());

	s.keys("Enter");
	await waitState(s, "b live", (x) => x.staged.id === b && x.staged.kind === "live", budgets.piReady);
	expect(state(s).focus).toBe("stage");
	await reply(s, "typed-after-key-wake");
	s.save("woken.txt", s.screen());
});

test("moving the cursor while n's pi starts stages that row, and the pi landing doesn't take it back", async () => {
	s = scenario("phase2", "new-then-move");
	const [a, b] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	const below = rowIndex(state(s), b) > rowIndex(state(s), a) ? "j" : "k";
	mkdirSync(join(s.home, "e2e-signals"), { recursive: true });
	writeFileSync(join(s.home, "e2e-signals", "start.hold"), "");
	await pickNew(s);
	await until(() => s.signal("start.entered"), budgets.piReady, "the new pi held mid-start");
	await waitState(s, "stage focus", (x) => x.focus === "stage");
	s.keys("M-a", "h");
	await waitState(s, "roster focus", (x) => x.focus === "roster");
	s.keys(below);
	const moved = await waitState(s, "b staged", (x) => x.cursor === b && x.staged.id === b);
	expect(moved.waking.map((w) => w.id)).toEqual([null]);
	release(s, "start");
	const landed = await waitState(
		s,
		"the new pi's row",
		(x) => x.waking.length === 0 && sessionRows(x).some((r) => r.provisional),
		budgets.piReady,
	);
	expect(landed).toMatchObject({ cursor: b, staged: { id: b } });
	s.save("landed.txt", s.screen());
});

test("n and swb new show the new pi as a provisional row before any prompt; /new inside it moves the selection", async () => {
	s = scenario("phase2", "provisional");
	s.swb("drive", "start", "--", "new");
	const first = await waitState(s, "the new pi live", (x) => x.staged.kind === "live", budgets.piReady);
	const row = sessionRows(first).find((r) => r.id === first.staged.id) as SessionStateRow;
	expect(row).toMatchObject({ provisional: true, title: first.staged.id });
	expect(first.cursor).toBe(first.staged.id);
	expect(s.ls()).toEqual([]);
	await Bun.sleep(1500);
	expect(state(s).toasts).toEqual([]);
	s.save("swb-new.txt", s.screen());

	s.keys("-l", "/new", "Enter");
	const moved = await waitState(s, "the selection on the /new pi", (x) => x.staged.kind === "live" && x.staged.id !== first.staged.id);
	expect(moved.cursor).toBe(moved.staged.id);
	expect(sessionRows(moved).find((r) => r.id === moved.staged.id)).toMatchObject({ provisional: true });
	s.save("slash-new.txt", s.screen());

	s.keys("M-a", "h");
	await waitState(s, "roster focus", (x) => x.focus === "roster");
	await pickNew(s);
	const third = await waitState(s, "n's pi live", (x) => x.staged.kind === "live" && x.staged.id !== moved.staged.id, budgets.piReady);
	expect(third.focus).toBe("stage");
	expect(
		sessionRows(third)
			.filter((r) => r.provisional)
			.map((r) => r.id),
	).toContain(third.staged.id as string);
	s.save("n.txt", s.screen());
});

test("what a launch gives, its parent and Group, goes to the first session its process records, even after a /new, and not to one after", async () => {
	s = scenario("phase2", "group-new");
	const base = await launched(s, "reply base", { cwd: s.project, title: "base", group: "lab" });
	s.swb("drive", "start");
	await waitState(s, "the roster", (x) => x.ready && sessionRows(x).length === 1);
	await cursorTo(s, base);
	await pickNew(s);
	const groupOfStaged = (x: DeckState) => sessionRows(x).find((r) => r.id === x.staged.id && r.provisional)?.group;
	const first = await waitState(
		s,
		"n's pi in lab",
		(x) => x.staged.kind === "live" && x.staged.id !== base && groupOfStaged(x) === "lab",
		budgets.piReady,
	);

	// Nothing recorded yet, so the Group is still the launch's to give: the /new session takes it.
	s.keys("-l", "/new", "Enter");
	const second = await waitState(s, "the /new pi in lab", (x) => x.staged.id !== first.staged.id && groupOfStaged(x) === "lab");
	await reply(s, "second");
	await until(() => entry(s, second.staged.id as string)?.group === "lab", budgets.settle, "the second recorded in lab");
	expect(s.query("SELECT 1 FROM sessions WHERE session_id = ?", first.staged.id)).toEqual([]);

	// Once one has, a /new after it starts in no Group, and the roster shows it there before its first prompt.
	s.keys("-l", "/new", "Enter");
	await waitState(s, "the next /new pi in no Group", (x) => x.staged.id !== second.staged.id && groupOfStaged(x) === null);
	s.save("group-new.txt", s.screen());

	// Likewise a parent: a launched child's /new, after its first turn, is no one's child, in no Group.
	const child = await launched(s, "reply child", { from: base, title: "child" });
	expect(entry(s, child)).toMatchObject({ parentId: base, group: "lab" });
	await waitState(s, "child nested under base", (x) => sessionRows(x).some((r) => r.id === child && r.level === 1));
	type(s, child, "/new");
	const fresh = await waitState(s, "the child's /new on the roster", (x) =>
		sessionRows(x).some((r) => r.provisional && r.id !== x.staged.id && r.id !== child),
	);
	expect(sessionRows(fresh).find((r) => r.provisional && r.id !== fresh.staged.id)).toMatchObject({ group: null, level: 0, origin: null });
	s.save("parent-new.txt", s.screen());
});
