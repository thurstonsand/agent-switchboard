import { afterEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { config, cursorTo, entry, reply, seed, state, waitState } from "./harness/deck.ts";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;

afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
		s.save("final-tmux.txt", s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name} #{session_attached} #{@swb_kind}"));
	} catch {}
	await s.cleanup();
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
	s.tmux(s.servers.sessions, "kill-pane", "-t", s.pane(up.staged.host as string));
	await until(() => !entry(s, a).live, budgets.settle, "a dormant");
	s.swb("drive", "stop");
	await until(() => entry(s, a).inactive, budgets.settle, "a inactive");
	s.swb("drive", "start", "--", "open", a);
	const st = await waitState(s, "a selected", (x) => x.cursor === a && x.staged.id === a);
	expect(st.rows).toContainEqual({ kind: "section", label: "Inactive", count: 1, expanded: true });
	s.save("open-inactive.txt", s.screen());
});

test("swb_show_session moves the Deck onto the session it names while the Deck shows its caller", async () => {
	s = scenario("phase2", "show");
	const [a, b] = (await seed(s, { turns: ["alpha"], title: "alpha" }, { turns: ["beta"], title: "beta" })) as [string, string];
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the caller live", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await reply(s, "caller");
	const caller = state(s).staged.id as string;

	const asked = Date.now();
	s.keys("-l", `call swb_show_session {"session":"${a}"}`, "Enter");
	await waitState(s, "alpha shown", (x) => x.cursor === a && x.staged.id === a);
	// Dormant until now, it starts with the keyboard on it, as a click on its row would.
	const live = await waitState(s, "alpha live", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	expect(live.focus).toBe("stage");
	expect(entry(s, a).live).toBe(true);
	s.save("shown.txt", s.screen());

	// Its border says it was switched to. A key during the 10 s hold doesn't take that away, but the hold's end does.
	const arrived = (from = "") => s.screen().includes(`${from} switched you here`);
	await until(() => arrived(), budgets.settle, "word of the switch");
	s.keys("BSpace");
	await Bun.sleep(asked + 9_500 - Date.now());
	expect(arrived()).toBe(true);
	await until(() => !arrived(), budgets.settle, "the word gone as the hold ends");

	// The caller runs on, but the Deck has moved off it, so it has nothing to switch.
	expect(entry(s, caller).live).toBe(true);
	const unseen = s.swbTry("show", b, "--from", caller);
	expect(unseen.code).not.toBe(0);
	expect(unseen.err).toContain("the Deck isn't showing this session");
	expect(state(s)).toMatchObject({ cursor: a, staged: { id: a } });

	// Untouched through its hold, the word stays until the first key after it.
	s.keys("-l", `call swb_show_session {"session":"${b}"}`, "Enter");
	await waitState(s, "beta live", (x) => x.staged.id === b && x.staged.kind === "live", budgets.piReady);
	await until(() => arrived("alpha"), budgets.settle, "word from alpha");
	await Bun.sleep(11_000);
	expect(arrived("alpha")).toBe(true);
	s.keys("BSpace");
	await until(() => !arrived(), 2_000, "the word gone at the first key");
});

test("a session woken from its card and stopped again shows the turns it took meanwhile", async () => {
	s = scenario("phase2", "card-after-wake");
	const [id] = (await seed(s, { turns: ["before"] })) as [string];
	s.swb("drive", "start");
	await cursorTo(s, id);
	await until(() => s.screen().includes("before"), budgets.settle, "the dormant card");
	s.keys("Enter");
	await waitState(s, "its pi up", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await reply(s, "meanwhile");
	s.keys("M-a", "x");
	await waitState(s, "stopped, on its card", (x) => x.staged.id === id && x.staged.kind !== "live");
	await until(() => s.screen().includes("reply meanwhile"), budgets.settle, "the new turn on its card");
});

test("a dormant session's card shows a turn its transcript took while the cursor was away, with no activity in swb", async () => {
	s = scenario("phase2", "card-outside-turn");
	const [a, b] = (await seed(s, { turns: ["before"] }, { turns: ["other"] })) as [string, string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	await until(() => s.screen().includes("before"), budgets.settle, "a's dormant card");
	await cursorTo(s, b);
	// As a pi resumed outside swb would write it.
	const [{ transcript }] = s.query<{ transcript: string }>("select transcript from sessions where session_id = ?", a) as [
		{ transcript: string },
	];
	const parentId = (JSON.parse(readFileSync(transcript, "utf8").trim().split("\n").at(-1) as string) as { id: string }).id;
	const turn = (id: string, parent: string, role: string, text: string) =>
		JSON.stringify({ type: "message", id, parentId: parent, message: { role, content: [{ type: "text", text }] } });
	appendFileSync(
		transcript,
		`${turn("outside1", parentId, "user", "asked outside")}\n${turn("outside2", "outside1", "assistant", "answered outside")}\n`,
	);
	await cursorTo(s, a);
	await until(() => s.screen().includes("answered outside"), budgets.settle, "the outside turn on a's card");
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
	expect(screen).not.toContain("dormant");
	const y = screen.split("\n").findIndex((line) => line.includes(id.slice(0, 8)));
	s.swb("drive", "move", "10", String(y));
	await waitState(s, "its Peek", (x) => x.peek?.id === id);
	await until(() => s.screen().includes("dormant"), budgets.settle, "the Peek drawn");
	expect(s.screen().match(/dormant/g)).toHaveLength(1);
	s.save("dormant-card-peek.txt", s.screen());
});
