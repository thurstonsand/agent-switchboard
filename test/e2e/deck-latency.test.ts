import { afterEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DeckState } from "../../packages/cli/src/deck/protocol.ts";
import { cursorTo, entry, seed, state, waitState } from "./harness/deck.ts";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;

afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
		s.save("final-tmux.txt", s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name} #{session_attached} #{@swb_kind}"));
	} catch {}
	await s.cleanup();
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
	// The close after the sleep keeps the connection reachable: one collected mid-sleep closes, and its lock goes with it.
	const holder = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const d = new (require("bun:sqlite").Database)(${JSON.stringify(db)}); d.run("PRAGMA busy_timeout = 5000"); d.run("BEGIN IMMEDIATE"); console.log("held"); await Bun.sleep(60000); d.close();`,
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
