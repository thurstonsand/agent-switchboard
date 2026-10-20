import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeckState, SessionStateRow } from "../../packages/cli/src/deck/protocol.ts";
import {
	config,
	cursorTo,
	entry,
	launched,
	launchTry,
	pickNew,
	piSessions,
	reply,
	rowIndex,
	seed,
	sessionRows,
	state,
	waitState,
} from "./harness/deck.ts";
import { alive, budgets, release, type Scenario, scenario, until } from "./harness/index.ts";

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
	expect(entry(s, id)).toMatchObject({ open: true, interrupted: false });
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

test("swb open selects an Inactive session, opening its section", async () => {
	s = scenario("phase2", "open-inactive");
	const [a] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	config(s, 'inactive_after = "2s"');
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("Enter");
	const up = await waitState(s, "a live", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	await until(() => entry(s, a).unseen === false, budgets.settle, "a visited");
	s.tmux(s.servers.sessions, "kill-session", "-t", `=${up.staged.host}`);
	await until(() => !entry(s, a).live, budgets.settle, "a dormant");
	s.swb("drive", "stop");
	await until(() => entry(s, a).inactive, budgets.settle, "a inactive");
	s.swb("drive", "start", "--", "open", a);
	const st = await waitState(s, "a selected", (x) => x.cursor === a && x.staged.id === a);
	expect(st.rows).toContainEqual({ kind: "section", label: "Inactive", count: 1, expanded: true });
	s.save("open-inactive.txt", s.screen());
});

/** Each session row as its family places it: indented by level, marked by who started it when not nested, and what a fold hides. */
function lineage(st: DeckState): string[] {
	return sessionRows(st).map(
		(r) =>
			`${"  ".repeat(r.level)}${r.origin === "operator" ? "⌁ " : r.origin === "session" ? "↳ " : ""}${r.title}${r.folded ? ` +${r.hidden}` : ""}`,
	);
}

/** The roster's line that shows `text`, the Stage beside it cut off. */
function rosterLine(text: string): string | undefined {
	return s
		.screen()
		.split("\n")
		.map((line) => line.slice(0, 42))
		.find((line) => line.includes(text));
}

test("a session an agent started nests under it; its Peek's started-by line and p go to the parent; h folds a family; a child starts in its parent's Group, then keeps its own; an Operator can't start another", async () => {
	s = scenario("phase8", "lineage");
	const other = join(s.root, "other");
	const operatorDir = join(s.env.XDG_CONFIG_HOME as string, "agent-switchboard/operator");
	mkdirSync(other);
	mkdirSync(operatorDir, { recursive: true });
	const root = await launched(s, "reply root", { cwd: s.project, title: "root" });
	const c1 = await launched(s, "reply c1", { from: root, title: "c1" });
	const g1 = await launched(s, "reply g1", { from: c1, title: "g1" });
	await launched(s, "reply c2", { from: root, title: "c2" });
	const port = await launched(s, "reply port", { from: c1, cwd: other, title: "port" });
	const op = await launched(s, "reply op", { cwd: operatorDir, title: "op" });
	// An Operator that names no directory would start another Operator in its own folder.
	const refused = await launchTry(s, "reply op2", { from: op });
	expect(refused.code).not.toBe(0);
	expect(refused.err).toContain("an Operator can't start another Operator; name a project's directory as cwd");
	const bump = await launched(s, "reply bump", { from: op, cwd: s.project, title: "bump" });
	expect(s.ls()).toHaveLength(7);

	s.swb("drive", "start");
	// Families go by their newest member; within one, so do siblings. Another Project, or an Operator, marks the row instead.
	let st = await waitState(s, "the families on the roster", (x) => x.ready && sessionRows(x).length === 7);
	expect(lineage(st)).toEqual(["op", "↳ port", "⌁ bump", "root", "  c2", "  c1", "    g1"]);
	expect(rosterLine(" root")).toContain("▾● root");
	expect(rosterLine(" c2")).toContain("  ├─ ● c2");
	expect(rosterLine(" c1")).toContain("  └▾ ● c1");
	expect(rosterLine(" g1")).toContain("     └─ ● g1");
	expect(rosterLine(" port")).toContain("↳ ● port");
	expect(rosterLine(" bump")).toContain("⌁ ● bump");
	s.save("families.txt", s.screen());
	s.save("families.ansi", s.swb("drive", "capture", "--ansi"));

	const peekOf = async (id: string) => {
		await cursorTo(s, id);
		return (await waitState(s, `${id}'s Peek`, (x) => x.peek?.id === id && x.peek.lines.some((l) => l.includes("pi ·")))).peek
			?.lines as string[];
	};
	expect((await peekOf(g1)).some((l) => /started by ↳ c1\s+p/.test(l))).toBe(true);
	const portPeek = await peekOf(port);
	expect(portPeek.some((l) => /started by ↳ c1\s+p/.test(l))).toBe(true);
	expect(portPeek.some((l) => l.includes("in project"))).toBe(true);
	expect((await peekOf(bump)).some((l) => /started by ⌁ op\s+p/.test(l))).toBe(true);
	s.save("peek-bump.txt", s.screen());

	await cursorTo(s, port);
	s.keys("p");
	await waitState(s, "p to c1, in another Project", (x) => x.cursor === c1);
	s.keys("p");
	await waitState(s, "p again to root", (x) => x.cursor === root);
	s.keys("p");
	await waitState(s, "root has no parent", (x) => x.toasts.some((t) => t.text === "you started this one"));

	s.keys("h");
	st = await waitState(s, "root folded", (x) => sessionRows(x).find((r) => r.id === root)?.folded === true);
	expect(lineage(st)).toEqual(["op", "↳ port", "⌁ bump", "root +3"]);
	// The fold counts what it hides, and of those, what needs me: all three are Unseen.
	expect(rosterLine(" root")).toMatch(/▸● root\s+\+3 ●3/);
	s.keys("j", "k");
	const folded = (await waitState(s, "the folded Peek", (x) => x.peek?.id === root && x.peek.lines.some((l) => l.includes("folded")))).peek
		?.lines as string[];
	expect(folded.filter((l) => /[├└]─ ● /.test(l)).map((l) => l.replace(/│\s*$/, "").trim())).toEqual(["├─ ● c2", "└─ ● c1", "└─ ● g1"]);
	s.save("folded.txt", s.screen());

	// p from a row elsewhere opens the fold hiding its parent.
	await cursorTo(s, port);
	s.keys("p");
	st = await waitState(s, "c1 revealed", (x) => x.cursor === c1 && sessionRows(x).length === 7);
	expect(lineage(st)).toEqual(["op", "↳ port", "⌁ bump", "root", "  c2", "  c1", "    g1"]);

	// A click on the fold folds c1's family, and the next opens it.
	const c1Line = 1 + st.rows.findIndex((r) => r.kind === "session" && r.id === c1);
	s.swb("drive", "click", "4", String(c1Line));
	st = await waitState(s, "c1 folded by a click", (x) => sessionRows(x).find((r) => r.id === c1)?.folded === true);
	expect(lineage(st)).toEqual(["op", "↳ port", "⌁ bump", "root", "  c2", "  c1 +1"]);
	s.swb("drive", "click", "4", String(c1Line));
	await waitState(s, "c1 open again", (x) => sessionRows(x).length === 7);

	// A fold is part of the Deck's layout, kept for the next one.
	await cursorTo(s, root);
	s.keys("h");
	await waitState(s, "root folded", (x) => sessionRows(x).find((r) => r.id === root)?.folded === true);
	await Bun.sleep(1000);
	s.swb("drive", "stop");
	s.swb("drive", "start");
	st = await waitState(s, "root still folded", (x) => x.ready && sessionRows(x).length === 4);
	expect(lineage(st)).toEqual(["op", "↳ port", "⌁ bump", "root +3"]);
	s.keys("l");
	await waitState(s, "l opens it", (x) => sessionRows(x).length === 7);

	// A new turn in the grandchild brings its whole line up: c1 above c2, and root's family above bump.
	const sent = Bun.spawn([`${s.bin}/swb`, "send", "--from", c1, "--to", g1], { env: s.env, stdin: new Blob(["reply again"]) });
	expect(await sent.exited).toBe(0);
	const resorted = ["op", "↳ port", "root", "  c1", "    g1", "  c2", "⌁ bump"];
	await waitState(s, "g1's line first", (x) => Bun.deepEquals(lineage(x), resorted), budgets.piReady);
	s.save("resorted.txt", s.screen());

	// A Group is a session's own: root's children stay under the Project, marked, until one is dragged after it.
	await cursorTo(s, root);
	s.keys("m");
	await waitState(s, "naming", (x) => x.mode === "name");
	s.keys("-l", "lab", "Enter");
	st = await waitState(
		s,
		"root alone in lab",
		(x) => x.mode === "roster" && Bun.deepEquals(lineage(x), ["op", "↳ port", "root", "↳ c1", "  g1", "⌁ bump", "↳ c2"]),
	);
	expect(
		sessionRows(st)
			.filter((r) => r.group === "lab")
			.map((r) => r.title),
	).toEqual(["root"]);
	const c2Line = 1 + st.rows.findIndex((r) => r.kind === "session" && r.title === "c2");
	const lab = 1 + st.rows.findIndex((r) => r.kind === "header" && r.group === "lab");
	s.swb("drive", "drag", "8", `${c2Line}`, "8", `${lab}`);
	st = await waitState(s, "c2 back under root, in lab", (x) =>
		Bun.deepEquals(lineage(x), ["op", "↳ port", "root", "  c2", "↳ c1", "  g1", "⌁ bump"]),
	);
	expect(
		sessionRows(st)
			.filter((r) => r.group === "lab")
			.map((r) => r.title),
	).toEqual(["root", "c2"]);
	s.save("grouped.txt", s.screen());

	// A child started now begins in its parent's Group; one in another Project, where that Group isn't, takes none.
	// Held before their first turns, both are still provisional, and already sit where those turns will put them.
	mkdirSync(join(s.home, "e2e-signals"), { recursive: true });
	writeFileSync(join(s.home, "e2e-signals", "turn.hold"), "");
	const pending = [
		launchTry(s, "reply c3", { from: root, title: "c3" }),
		launchTry(s, "reply far", { from: root, cwd: other, title: "far" }),
	];
	st = await waitState(s, "both children provisional", (x) => sessionRows(x).filter((r) => r.provisional).length === 2, budgets.piReady);
	const held = sessionRows(st).filter((r) => r.provisional);
	const near = held.find((r) => r.group === "lab");
	const away = held.find((r) => r.group === null);
	expect(near).toMatchObject({ level: 1, origin: null });
	expect(away).toMatchObject({ level: 0, origin: "session" });
	s.save("provisional.txt", s.screen());
	release(s, "turn");
	const [c3, far] = (await Promise.all(
		pending.map(async (launch) => {
			const { code, out, err } = await launch;
			if (code !== 0) throw new Error(`swb launch exited ${code}: ${err}`);
			return (JSON.parse(out) as { details: { id: string } }).details.id;
		}),
	)) as [string, string];
	expect(near?.id).toBe(c3);
	expect(away?.id).toBe(far);
	st = await waitState(
		s,
		"c3 under root, in lab, and far on the roster",
		(x) => sessionRows(x).some((r) => r.id === c3 && r.group === "lab") && sessionRows(x).some((r) => r.id === far && !r.provisional),
	);
	const lines = lineage(st);
	expect(lines.slice(lines.indexOf("root"), lines.indexOf("root") + 3)).toEqual(["root", "  c3", "  c2"]);
	expect(sessionRows(st).find((r) => r.id === far)).toMatchObject({ origin: "session", group: null });
	expect(entry(s, c3).group).toBe("lab");
	expect(entry(s, far).group).toBeNull();
});

test("a dormant card shows the whole conversation, newest at the bottom, cropped from the top", async () => {
	s = scenario("phase2", "dormant-card");
	const turns = Array.from({ length: 12 }, (_, i) => `turn-${i}-${"lorem ipsum dolor sit amet ".repeat(4).trim().replaceAll(" ", "_")}`);
	const [id] = (await seed(s, { turns })) as [string];
	s.swb("drive", "start");
	await cursorTo(s, id);
	await until(() => s.screen().includes("turn-11"), budgets.settle, "the newest turn on the card");
	const screen = s.screen();
	s.save("dormant-card.txt", screen);
	expect(screen).toContain("you");
	expect(screen).not.toContain("turn-0-");
	expect(screen.indexOf("reply turn-10")).toBeLessThan(screen.lastIndexOf("turn-11"));
	expect(screen).toContain("…");
	// Its state is the Peek's to say, and the card doesn't say it again.
	expect(screen).not.toContain("not running");
	const y = screen.split("\n").findIndex((line) => line.includes(id.slice(0, 8)));
	s.swb("drive", "move", "10", String(y));
	await waitState(s, "its Peek", (x) => x.peek?.id === id);
	await until(() => s.screen().includes("not running"), budgets.settle, "the Peek drawn");
	expect(s.screen().match(/not running/g)).toHaveLength(1);
	s.save("dormant-card-peek.txt", s.screen());
});

test("an idle, unviewed pi is reaped after reap_after; the one on view is not", async () => {
	s = scenario("phase2", "reap");
	const [a, b] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	config(s, 'reap_after = "2s"\n');
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("w");
	await waitState(s, "a live", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	await cursorTo(s, b);
	s.keys("w");
	await waitState(s, "b live", (x) => x.staged.id === b && x.staged.kind === "live", budgets.piReady);
	await until(() => !entry(s, a).live, 8000, "a reaped");
	await Bun.sleep(3000);
	expect(entry(s, b).live).toBe(true);
	s.save("reaped.txt", `${s.screen()}\n${JSON.stringify(s.ls(), null, 2)}`);
});

test("a session is Visited by a focused second on its pi, not by the cursor passing over it", async () => {
	s = scenario("phase2", "visit");
	const [a, b] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	s.swb("drive", "start");
	await cursorTo(s, b);
	await Bun.sleep(1500);
	expect(entry(s, b).unseen).toBe(true);
	await cursorTo(s, a);
	s.keys("w");
	await waitState(s, "a live", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	await Bun.sleep(2000);
	expect(entry(s, a).unseen).toBe(true);
	expect(state(s).rows.find((r) => r.kind === "session" && r.id === a)).toMatchObject({ state: "unseen" });
	s.save("on-view-unseen.txt", s.screen());
	s.keys("Enter");
	await waitState(s, "pi focused", (x) => x.focus === "stage");
	await until(() => !entry(s, a).unseen, 3000, "a visited");
	expect(entry(s, b).unseen).toBe(true);
	s.save("visited.txt", `${s.screen()}\n${JSON.stringify(s.ls(), null, 2)}`);
});

test("closing the Deck's terminal destroys the Deck, its roster, its placeholder, and its socket", async () => {
	s = scenario("phase2", "close");
	s.swb("drive", "start");
	const { deck } = state(s);
	const sock = join(s.env.XDG_STATE_HOME as string, "agent-switchboard/decks", `${deck}.sock`);
	expect(existsSync(sock)).toBe(true);
	const rosterPid = Number(s.tmux(s.servers.ui, "display", "-p", "-t", `=${deck}:.0`, "#{pane_pid}"));
	s.swb("drive", "stop");
	await until(
		() => !s.tmux(s.servers.ui, "list-sessions", "-F", "#{session_name}").includes(deck),
		budgets.settle,
		"the Deck session gone",
	);
	await until(() => !existsSync(sock), budgets.settle, "the socket gone");
	await until(
		() => !s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name}").includes(deck),
		budgets.settle,
		"the placeholder gone",
	);
	await until(() => !alive(rosterPid), budgets.settle, "the roster process gone");
	expect(s.swbTry("deck", "state").err).toContain("no live deck");
});

test("n and swb new show the new pi as a provisional row before any prompt; /new inside it moves the selection", async () => {
	s = scenario("phase2", "provisional");
	s.swb("drive", "start", "--", "new");
	const first = await waitState(s, "the new pi live", (x) => x.staged.kind === "live");
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

/** Wall time from a key reaching the Deck's terminal to the roster reporting a moved cursor, read straight off the Deck socket. */
async function cursorLatency(key: "j" | "k"): Promise<number> {
	const { deck, cursor } = state(s);
	const sock = join(s.env.XDG_STATE_HOME as string, "agent-switchboard/decks", `${deck}.sock`);
	const t0 = performance.now();
	s.tmux(s.servers.drive, "send-keys", "-t", "=drive:", key);
	for (;;) {
		const st = (await (await fetch("http://deck/state", { unix: sock })).json()) as DeckState;
		const ms = performance.now() - t0;
		if (st.cursor !== cursor) return ms;
		if (ms > 2000) throw new Error(`cursor did not move on ${key} in 2 s`);
	}
}

async function latencies(n: number): Promise<number[]> {
	const out: number[] = [];
	for (let i = 0; i < n; i++) out.push(await cursorLatency(i % 2 === 0 ? "k" : "j"));
	return out;
}

/** The OSC 11 or OSC 4 reply a pi gets from its terminal, asked by `/e2e-bg` typed into its tmux session on the sessions server. */
async function piColor(host: string, osc: "11" | "4;9"): Promise<string> {
	const log = join(s.home, "e2e-signals/input.log");
	writeFileSync(log, "");
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host}:`, "-l", "/e2e-bg");
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host}:`, "Enter");
	return until(
		() => {
			const lines = readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as string);
			return lines.find((line) => line.startsWith(`\x1b]${osc};`)) ?? false;
		},
		budgets.settle,
		`${host}'s OSC ${osc} reply`,
	);
}

const LIGHT_BG = "\x1b]11;rgb:f9f9/f5f5/d7d7\x1b\\";
const DARK_BG = "\x1b]11;rgb:1d1d/2020/2121\x1b\\";
const LIGHT_RED = "\x1b]4;9;rgb:9d9d/0000/0606\x1b\\";
const DARK_RED = "\x1b]4;9;rgb:fbfb/4949/3434\x1b\\";

/** The background pi paints its last user message on, read from its pane rather than asked of the terminal. */
function userMessageBg(host: string): string {
	const ansi = s.tmux(s.servers.sessions, "capture-pane", "-p", "-e", "-t", `=${host}:`);
	return [...ansi.slice(0, ansi.lastIndexOf("reply ")).matchAll(/48;2;(\d+;\d+;\d+)/g)].at(-1)?.[1] ?? "none";
}

test("a pi on the Stage repaints when the terminal flips, in copy mode too, while the shell beside it gets no report", async () => {
	s = scenario("phase2", "theme-repaint");
	s.swb("drive", "start", "--", "new");
	const st = await waitState(
		s,
		"the new pi live with the keyboard",
		(x) => x.staged.kind === "live" && x.focus === "stage",
		budgets.piReady,
	);
	const host = st.staged.host as string;
	await reply(s, "one");
	await until(() => userMessageBg(host) === "219;229;229", budgets.settle, "pi's light user message");
	s.keys("M-a", "s");
	await waitState(s, "the shell, with the keyboard", (x) => x.layout.shell && x.focus === "shell");

	// tmux 3.8 tells pi before the sessions server mirrors the terminal, so pi's own query would see the old colors.
	s.swb("drive", "theme", "dark");
	await until(() => userMessageBg(host) === "35;54;54", budgets.settle, "pi's dark user message");
	s.save("dark.ansi", s.swb("drive", "capture", "--ansi"));

	// tmux 3.7c tells pi only once copy mode ends; swb, on 3.8, while it's still up.
	s.tmux(s.servers.sessions, "copy-mode", "-t", `=${host}:`);
	s.swb("drive", "theme", "light");
	await waitState(s, "the roster's light background", (x) => x.colors.background === "#f9f5d7");
	await Bun.sleep(500);
	expect(s.tmux(s.servers.sessions, "display", "-p", "-t", `=${host}:`, "#{pane_in_mode}")).toBe("1");
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host}:`, "-X", "cancel");
	await until(() => userMessageBg(host) === "219;229;229", budgets.settle, "pi's light user message, after copy mode");
	s.save("light.ansi", s.swb("drive", "capture", "--ansi"));
	expect(s.screen()).not.toContain("997");
});

test("with the db writer lock held and a 50 MB transcript being parsed, the cursor still moves within 100 ms", async () => {
	s = scenario("phase2", "slow-worker");
	const [a, b] = (await seed(s, { turns: ["small"] }, { turns: ["huge"] })) as [string, string];
	const [{ transcript }] = s.query<{ transcript: string }>("SELECT transcript FROM sessions WHERE session_id = ?", b) as [
		{ transcript: string },
	];
	const lines = readFileSync(transcript, "utf8").split("\n").filter(Boolean);
	let parent = (JSON.parse(lines.at(-1) as string) as { id: string }).id;
	const blob = "x".repeat(50_000);
	const extra: string[] = [];
	for (let i = 0; i < 1000; i++) {
		const id = `bulk${i}`;
		extra.push(
			JSON.stringify({ type: "message", id, parentId: parent, message: { role: "toolResult", content: [{ type: "text", text: blob }] } }),
		);
		parent = id;
	}
	extra.push(
		JSON.stringify({
			type: "message",
			id: "bulk-end",
			parentId: parent,
			message: { role: "assistant", content: [{ type: "text", text: "after-the-bulk" }] },
		}),
	);
	appendFileSync(transcript, `${extra.join("\n")}\n`);
	expect(statSync(transcript).size).toBeGreaterThan(50_000_000);

	const db = s.dbFile;
	const holder = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const d = new (require("bun:sqlite").Database)(${JSON.stringify(db)}); d.run("BEGIN IMMEDIATE"); console.log("held"); await Bun.sleep(60000);`,
		],
		{
			stdout: "pipe",
		},
	);
	try {
		const { value } = await holder.stdout.getReader().read();
		expect(new TextDecoder().decode(value)).toContain("held");
		s.swb("drive", "start");
		await cursorTo(s, a);
		// Its wake blocks the worker on the held write lock for the whole busy timeout.
		s.keys("w");
		await waitState(s, "loading", (x) => x.staged.kind === "loading", 2000);
		const t0 = performance.now();
		await cursorTo(s, b);
		const during = await latencies(8);
		const measuredMs = performance.now() - t0;
		await cursorTo(s, b);
		await until(() => s.screen().includes("after-the-bulk"), 30_000, "the huge card");
		const cardMs = performance.now() - t0;
		s.save("latencies.json", JSON.stringify({ during, measuredMs, cardMs }, null, 2));
		expect(Math.max(...during)).toBeLessThan(100);
		expect(cardMs).toBeGreaterThan(measuredMs);
		s.save("huge-card.txt", s.screen());
	} finally {
		holder.kill();
	}
});

test("the cursor keeps moving within 100 ms while a pi is loading", async () => {
	s = scenario("phase2", "loading-latency");
	const [a, b] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	s.swb("drive", "start");
	await cursorTo(s, b);
	await cursorTo(s, a);
	s.keys("w");
	await waitState(s, "a loading", (x) => x.staged.kind === "loading", 2000);
	const during = await latencies(6);
	s.save("latencies.json", JSON.stringify({ during, stillLoading: state(s).waking }, null, 2));
	expect(Math.max(...during)).toBeLessThan(100);
	await until(() => entry(s, a).live, budgets.piReady, "a live");
});

test("switching between two live sessions takes at most 150 ms", async () => {
	s = scenario("phase2", "switch");
	const [a, b] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	s.swb("drive", "start");
	for (const id of [a, b]) {
		await cursorTo(s, id);
		s.keys("w");
		await waitState(s, `${id} live`, (x) => x.staged.id === id && x.staged.kind === "live", budgets.piReady);
	}
	const switches: number[] = [];
	for (const id of [a, b, a, b, a, b]) {
		const n = state(s).perf.keyToSwitch.n;
		await cursorTo(s, id);
		const st = await waitState(s, `switched to ${id}`, (x) => x.perf.keyToSwitch.n > n && x.staged.id === id);
		switches.push(st.perf.keyToSwitch.lastMs);
	}
	s.save("switches.json", JSON.stringify({ switches, perf: state(s).perf }, null, 2));
	expect(Math.max(...switches)).toBeLessThanOrEqual(150);
});

test("the roster and a live pi report the harness terminal's background, and both follow drive theme dark", async () => {
	s = scenario("phase2", "theme");
	s.swb("drive", "start", "--", "new");
	const st = await waitState(s, "the new pi live", (x) => x.staged.kind === "live");
	await waitState(s, "the roster's light background", (x) => x.colors.background === "#f9f5d7");
	expect(await piColor(st.staged.host as string, "11")).toBe(LIGHT_BG);
	s.save("light.ansi", s.swb("drive", "capture", "--ansi"));
	s.swb("drive", "theme", "dark");
	await waitState(s, "the roster's dark background", (x) => x.colors.background === "#1d2021");
	await until(async () => (await piColor(st.staged.host as string, "11")) === DARK_BG, budgets.settle, "pi's dark background");
	s.save("dark.ansi", s.swb("drive", "capture", "--ansi"));
});

test("a pi woken with w and never viewed reports the terminal's background and palette, and re-themes while still unviewed", async () => {
	s = scenario("phase2", "unviewed-theme");
	const [a, b] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("w");
	await until(() => entry(s, a).live, budgets.piReady, "a live");
	await cursorTo(s, b);
	await waitState(s, "b on view, dormant", (x) => x.staged.id === b && x.staged.kind === "dormant");
	const [{ tmux_session: host }] = s.query<{ tmux_session: string }>("SELECT tmux_session FROM runtimes WHERE session_id = ?", a) as [
		{ tmux_session: string },
	];
	expect(s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name} #{session_attached}")).toContain(`${host} 0`);
	expect(await piColor(host, "11")).toBe(LIGHT_BG);
	expect(await piColor(host, "4;9")).toBe(LIGHT_RED);
	s.swb("drive", "theme", "dark");
	await waitState(s, "the roster's dark background", (x) => x.colors.background === "#1d2021");
	await until(async () => (await piColor(host, "11")) === DARK_BG, budgets.settle, "the unviewed pi's dark background");
	await until(async () => (await piColor(host, "4;9")) === DARK_RED, budgets.settle, "the unviewed pi's dark palette");
});

test("Enter, then a prompt typed in the Stage, shows working then idle in the roster", async () => {
	s = scenario("phase2", "working");
	const [a] = (await seed(s, { turns: ["a"] })) as [string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("Enter");
	await waitState(s, "a live with the keyboard", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	s.keys("-l", "hold w1", "Enter");
	await until(() => s.signal("w1.entered") !== "", budgets.settle, "the held turn");
	await waitState(s, "working", (x) => sessionRows(x).find((r) => r.id === a)?.state === "working");
	s.save("working.txt", s.screen());
	release(s, "w1");
	await waitState(s, "idle", (x) => sessionRows(x).find((r) => r.id === a)?.state === "idle");
	s.save("idle.txt", s.screen());
});

test("a working session's frames reach the terminal synchronized through both tmux layers, the cursor shown only inside one", async () => {
	s = scenario("phase2", "synchronized");
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the new pi live with the keyboard", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	// What the Deck writes to the terminal, while pi's spinner redraws through both tmux servers.
	const stream = join(s.root, "terminal.bin");
	s.tmux(s.servers.drive, "pipe-pane", "-O", "-t", "=drive:", `cat > ${stream}`);
	s.keys("-l", "hold sync", "Enter");
	await until(() => s.signal("sync.entered") !== "", budgets.settle, "the held turn");
	await Bun.sleep(1500);
	release(s, "sync");
	await until(() => s.screen().includes("released sync"), budgets.settle, "the turn's end");
	s.tmux(s.servers.drive, "pipe-pane", "-t", "=drive:");
	const bytes = readFileSync(stream, "latin1");
	let frames = 0;
	let open = false;
	const outside: number[] = [];
	const esc = String.fromCharCode(27);
	for (const m of bytes.matchAll(new RegExp(`${esc}\\[\\?(2026|25)([hl])`, "g"))) {
		if (m[1] === "2026") {
			open = m[2] === "h";
			if (open) frames++;
		} else if (m[2] === "h" && !open) outside.push(m.index);
	}
	expect(frames).toBeGreaterThan(5);
	expect(outside).toEqual([]);
});

test("two Decks waking one session start exactly one pi", async () => {
	s = scenario("phase2", "two-decks");
	const [a] = (await seed(s, { turns: ["a"] })) as [string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	const other = `swb-other-${s.instance}`;
	s.tmux(other, "new-session", "-d", "-s", "other", "-x", "140", "-y", "40", "-c", s.project, join(s.bin, "swb"));
	const decks = await until(
		() => {
			const err = s.swbTry("deck", "state").err;
			const m = /several live decks \(([^)]+)\)/.exec(err);
			return m ? (m[1] as string).split(", ") : false;
		},
		budgets.deckReady,
		"the second Deck",
	);
	const mine = state(s).deck;
	const theirs = decks.find((d) => d !== mine) as string;
	const theirState = () => JSON.parse(s.swb("deck", "state", "--deck", theirs, "--json")) as DeckState;
	await until(() => theirState().ready && theirState().cursor === a, budgets.deckReady, "the second Deck, its cursor on a");
	s.tmux(s.servers.drive, "send-keys", "-t", "=drive:", "w");
	s.tmux(other, "send-keys", "-t", "=other:", "w");
	await waitState(s, "live in mine", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	await until(() => theirState().staged.kind === "live", budgets.piReady, "live in theirs");
	expect(piSessions(s)).toHaveLength(1);
	expect(s.ls().filter((e) => e.live)).toHaveLength(1);
	s.save("mine.txt", s.screen());
	s.save("theirs.txt", s.tmux(other, "capture-pane", "-p", "-t", "=other:"));
});

test("a Deck killed while its wake waits on the launch lock doesn't wedge later wakes", async () => {
	s = scenario("phase2", "killed-waker");
	const [a] = (await seed(s, { turns: ["a"] })) as [string];
	const holder = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const d = new (require("bun:sqlite").Database)(${JSON.stringify(s.dbFile)}); d.run("BEGIN IMMEDIATE"); console.log("held"); await Bun.sleep(60000);`,
		],
		{ stdout: "pipe" },
	);
	try {
		const { value } = await holder.stdout.getReader().read();
		expect(new TextDecoder().decode(value)).toContain("held");
		s.swb("drive", "start");
		await cursorTo(s, a);
		s.keys("w");
		await waitState(s, "loading", (x) => x.staged.kind === "loading", 2000);
		const rosterPid = Number(s.tmux(s.servers.ui, "display", "-p", "-t", `=${state(s).deck}:.0`, "#{pane_pid}"));
		process.kill(rosterPid, "SIGKILL");
		await until(() => !alive(rosterPid), budgets.settle, "the roster gone");
	} finally {
		holder.kill();
		await holder.exited;
	}
	s.swbTry("drive", "stop");
	expect(piSessions(s)).toHaveLength(0);
	s.swbTry("deck", "state");
	expect(s.tmux(s.servers.sessions, "list-sessions", "-F", "#{@swb_kind}").split("\n")).not.toContain("placeholder");
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("w");
	await waitState(s, "a live", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	expect(piSessions(s)).toHaveLength(1);
	s.save("woke-after-kill.txt", s.screen());
});

test("the sessions server killed under an open Deck recovers on the next w", async () => {
	s = scenario("phase2", "server-killed");
	const [a] = (await seed(s, { turns: ["a"] })) as [string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.tmux(s.servers.sessions, "kill-server");
	await until(() => s.screen().includes("⏎ wake"), budgets.settle, "the dormant card back on the Stage");
	s.save("killed.txt", s.screen());
	s.keys("w");
	await waitState(s, "a live again", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	expect(entry(s, a).live).toBe(true);
	s.save("recovered.txt", s.screen());
});

test("a drag in regular-mode pi reaches drive clipboard through both tmux layers", async () => {
	s = scenario("phase2", "clipboard");
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the new pi live", (x) => x.staged.kind === "live");
	await reply(s, "copy-me-please");
	// The reply signals when pi asks for it, and pi draws a turn typed during startup only once startup ends.
	const rows = await until(
		() => {
			const screen = s.screen().split("\n");
			return screen.some((line) => line.includes("copy-me-please")) && screen;
		},
		budgets.settle,
		"the reply on screen",
	);
	const row = rows.findLastIndex((line) => line.includes("copy-me-please"));
	const col = (rows[row] as string).lastIndexOf("copy-me-please");
	s.swb("drive", "drag", String(col), String(row), String(col + "copy-me-please".length - 1), String(row));
	const copied = await until(() => s.swbTry("drive", "clipboard").out || false, budgets.settle, "the clipboard");
	s.save("clipboard.txt", `${copied}\n---\n${s.screen()}`);
	expect(copied).toContain("copy-me-please");
});
