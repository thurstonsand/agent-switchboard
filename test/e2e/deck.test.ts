import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeckState, SessionStateRow } from "../../packages/cli/src/deck/protocol.ts";
import { config, cursorTo, entry, piSessions, reply, rowIndex, seed, sessionRows, state, waitState } from "./harness/deck.ts";
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
	const [id] = (await seed(s, ["one"])) as [string];
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
	s.save("live.txt", s.screen());
});

test("Enter on a dormant row holds the keyboard on the loading card and hands it to pi; Enter then esc backs out while pi still comes up", async () => {
	s = scenario("phase2", "enter-wake");
	const [a, b] = (await seed(s, ["alpha"], ["beta"])) as [string, string];
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
	await waitState(s, "keyboard on b's loading card", (x) => x.staged.id === b && x.focus === "stage");
	await Bun.sleep(100);
	s.keys("Escape");
	const back = await waitState(s, "back in the roster", (x) => x.focus === "roster");
	expect(back.waking.every((w) => !w.keyboardWaiting)).toBe(true);
	await until(() => entry(s, b).live, budgets.piReady, "b live after esc");
	await waitState(s, "b live on the Stage", (x) => x.staged.id === b && x.staged.kind === "live", budgets.piReady);
	expect(state(s).focus).toBe("roster");
	s.save("esc-live.txt", s.screen());
});

test("moving the cursor while n's pi starts stages that row, and the pi landing doesn't take it back", async () => {
	s = scenario("phase2", "new-then-move");
	const [a, b] = (await seed(s, ["a"], ["b"])) as [string, string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	const below = rowIndex(state(s), b) > rowIndex(state(s), a) ? "j" : "k";
	s.keys("n");
	await waitState(s, "stage focus", (x) => x.focus === "stage");
	s.keys("M-a", "h");
	await waitState(s, "roster focus", (x) => x.focus === "roster");
	s.keys(below);
	const moved = await waitState(s, "b staged", (x) => x.cursor === b && x.staged.id === b);
	expect(moved.waking.map((w) => w.id)).toEqual([null]);
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
	const [a] = (await seed(s, ["a"], ["b"])) as [string, string];
	config(s, 'inactive_after = "2s"');
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("w");
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

test("a dormant card shows the whole conversation, newest at the bottom, cropped from the top", async () => {
	s = scenario("phase2", "dormant-card");
	const turns = Array.from({ length: 12 }, (_, i) => `turn-${i}-${"lorem ipsum dolor sit amet ".repeat(4).trim().replaceAll(" ", "_")}`);
	const [id] = (await seed(s, turns)) as [string];
	s.swb("drive", "start");
	await cursorTo(s, id);
	await until(() => s.screen().includes("turn-11"), budgets.settle, "the newest turn on the card");
	const screen = s.screen();
	s.save("dormant-card.txt", screen);
	expect(screen).toContain("Idle");
	expect(screen).toContain("you");
	expect(screen).not.toContain("turn-0-");
	expect(screen.indexOf("reply turn-10")).toBeLessThan(screen.lastIndexOf("turn-11"));
	expect(screen).toContain("…");
});

test("an idle, unviewed pi is reaped after reap_after; the one on view is not", async () => {
	s = scenario("phase2", "reap");
	const [a, b] = (await seed(s, ["a"], ["b"])) as [string, string];
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

test("a live session on view for a second is Visited and stops being Unseen; a dormant one on view is not", async () => {
	s = scenario("phase2", "visit");
	const [a, b] = (await seed(s, ["a"], ["b"])) as [string, string];
	s.swb("drive", "start");
	await cursorTo(s, b);
	await Bun.sleep(1500);
	expect(entry(s, b).unseen).toBe(true);
	await cursorTo(s, a);
	s.keys("w");
	await waitState(s, "a live", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
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
	s.keys("n");
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

/** The OSC 11 reply a pi gets from its terminal, asked by `/e2e-bg` typed into its tmux session on the sessions server. */
async function piBackground(host: string): Promise<string> {
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
			return lines.find((line) => line.startsWith("\x1b]11;")) ?? false;
		},
		budgets.settle,
		`${host}'s OSC 11 reply`,
	);
}

const LIGHT_BG = "\x1b]11;rgb:f9f9/f5f5/d7d7\x1b\\";
const DARK_BG = "\x1b]11;rgb:1d1d/2020/2121\x1b\\";

test("with the db writer lock held and a 50 MB transcript being parsed, the cursor still moves within 100 ms", async () => {
	s = scenario("phase2", "slow-worker");
	const [a, b] = (await seed(s, ["small"], ["huge"])) as [string, string];
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
	const [a, b] = (await seed(s, ["a"], ["b"])) as [string, string];
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
	const [a, b] = (await seed(s, ["a"], ["b"])) as [string, string];
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
	expect(await piBackground(st.staged.host as string)).toBe(LIGHT_BG);
	s.save("light.ansi", s.swb("drive", "capture", "--ansi"));
	s.swb("drive", "theme", "dark");
	await waitState(s, "the roster's dark background", (x) => x.colors.background === "#1d2021");
	await until(async () => (await piBackground(st.staged.host as string)) === DARK_BG, budgets.settle, "pi's dark background");
	s.save("dark.ansi", s.swb("drive", "capture", "--ansi"));
});

test("a pi woken with w and never viewed reports the terminal's background and re-themes while still unviewed", async () => {
	s = scenario("phase2", "unviewed-theme");
	const [a, b] = (await seed(s, ["a"], ["b"])) as [string, string];
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
	expect(await piBackground(host)).toBe(LIGHT_BG);
	s.swb("drive", "theme", "dark");
	await waitState(s, "the roster's dark background", (x) => x.colors.background === "#1d2021");
	await until(async () => (await piBackground(host)) === DARK_BG, budgets.settle, "the unviewed pi's dark background");
});

test("Enter, then a prompt typed in the Stage, shows working then idle in the roster", async () => {
	s = scenario("phase2", "working");
	const [a] = (await seed(s, ["a"])) as [string];
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

test("two Decks waking one session start exactly one pi", async () => {
	s = scenario("phase2", "two-decks");
	const [a] = (await seed(s, ["a"])) as [string];
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
	const [a] = (await seed(s, ["a"])) as [string];
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
	const [a] = (await seed(s, ["a"])) as [string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.tmux(s.servers.sessions, "kill-server");
	await Bun.sleep(1000);
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
	const rows = s.screen().split("\n");
	const row = rows.findLastIndex((line) => line.includes("copy-me-please"));
	const col = (rows[row] as string).lastIndexOf("copy-me-please");
	s.swb("drive", "drag", String(col), String(row), String(col + "copy-me-please".length - 1), String(row));
	const copied = await until(() => s.swbTry("drive", "clipboard").out || false, budgets.settle, "the clipboard");
	s.save("clipboard.txt", `${copied}\n---\n${s.screen()}`);
	expect(copied).toContain("copy-me-please");
});
