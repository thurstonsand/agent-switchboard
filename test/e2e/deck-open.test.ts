import { afterEach, expect, test } from "bun:test";
import { config, cursorTo, entry, reply, seed, state, terminal, waitState } from "./harness/deck.ts";
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
	s.tmux(s.servers.sessions, "kill-session", "-t", `=${up.staged.host}`);
	await until(() => !entry(s, a).live, budgets.settle, "a dormant");
	s.swb("drive", "stop");
	await until(() => entry(s, a).inactive, budgets.settle, "a inactive");
	s.swb("drive", "start", "--", "open", a);
	const st = await waitState(s, "a selected", (x) => x.cursor === a && x.staged.id === a);
	expect(st.rows).toContainEqual({ kind: "section", label: "Inactive", count: 1, expanded: true });
	s.save("open-inactive.txt", s.screen());
});

test("swb_show_session moves the Deck showing its caller onto the session it names, leaving other Decks where they were", async () => {
	s = scenario("phase2", "show");
	const [a, b] = (await seed(s, { turns: ["alpha"], title: "alpha" }, { turns: ["beta"], title: "beta" })) as [string, string];
	const other = terminal(s, "other", `swb open ${b}`);
	await other.ready();
	await until(() => other.state().cursor === b, budgets.settle, "the other Deck on beta");
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the caller live", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await reply(s, "caller");
	const caller = state(s).staged.id as string;

	s.keys("-l", `call swb_show_session {"session":"${a}"}`, "Enter");
	await waitState(s, "alpha shown", (x) => x.cursor === a && x.staged.id === a);
	// Dormant until now, it starts with the keyboard on it, as a click on its row would.
	const live = await waitState(s, "alpha live", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	expect(live.focus).toBe("stage");
	expect(entry(s, a).live).toBe(true);
	expect(other.state()).toMatchObject({ cursor: b, staged: { id: b } });
	s.save("shown.txt", s.screen());

	// The caller runs on, but no Deck shows it now, so there's none for it to switch.
	expect(entry(s, caller).live).toBe(true);
	const unseen = s.swbTry("show", b, "--from", caller);
	expect(unseen.code).not.toBe(0);
	expect(unseen.err).toContain("no Deck is showing this session");
	expect(other.state().cursor).toBe(b);
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
