import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeckState } from "../../packages/cli/src/deck/protocol.ts";
import { config, cursorTo, entry, launched, launchTry, reply, seed, sessionRows, state, waitState } from "./harness/deck.ts";
import { budgets, release, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;

afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
		s.save("final-tmux.txt", s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name} #{session_attached} #{@swb_kind}"));
	} catch {}
	await s.cleanup();
});

test("swb_update_session groups and retitles in one call, pi takes the title as its own name, a rename in pi wins, and swb_show_session opens the view asked for", async () => {
	s = scenario("phase2", "update-show");
	config(s, 'editor = "cat -v"');
	const [a] = (await seed(s, { turns: ["alpha"], title: "alpha" })) as [string];
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the caller live", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await reply(s, "caller");
	const caller = state(s).staged.id as string;
	const row = (st: DeckState, id: string) => sessionRows(st).find((r) => r.id === id);
	// What pi itself calls the session, as its line records it.
	const own = (id: string) => s.query<{ title: string | null }>("SELECT title FROM sessions WHERE session_id = ?", id)[0]?.title;

	s.keys("-l", `call swb_update_session {"session":"${a}","group":"auth","title":"Auth rewrite"}`, "Enter");
	const updated = await waitState(s, "alpha in auth, retitled", (x) => row(x, a)?.group === "auth" && row(x, a)?.title === "Auth rewrite");
	expect(updated.rows).toContainEqual({ kind: "header", project: "project", group: "auth", expanded: true });
	// Dormant, alpha's pi hasn't taken the title yet.
	expect(own(a)).toBe("alpha");
	const reachable = JSON.parse(s.swb("reachable", "--from", caller)) as { text: string };
	expect(reachable.text).toContain('"Auth rewrite" · dormant · ');
	expect(reachable.text).toContain(' · Group "auth"');

	s.keys("-l", `call swb_update_session {"title":"Coordinator"}`, "Enter");
	await until(() => own(caller) === "Coordinator", budgets.settle, "pi's own name");
	await waitState(s, "pi's name on the roster", (x) => row(x, caller)?.title === "Coordinator");
	s.keys("-l", "/name Planner", "Enter");
	await waitState(s, "pi's rename on the roster", (x) => row(x, caller)?.title === "Planner");

	s.keys("-l", `call swb_show_session {"session":"${a}","view":"editor"}`, "Enter");
	const shown = await waitState(s, "alpha in its editor", (x) => x.staged.id === a && x.staged.view === "editor");
	expect(shown).toMatchObject({ cursor: a, focus: "editor", staged: { savedView: "editor" } });
	await until(() => own(a) === "Auth rewrite", budgets.piReady, "alpha's pi taking its title as it starts");
	expect(s.query("SELECT title FROM marks WHERE session_id = ?", a)).toEqual([{ title: null }]);
	s.save("shown-editor.txt", s.screen());
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
