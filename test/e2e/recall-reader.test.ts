import { afterEach, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { CodexClient } from "../../packages/cli/src/codex/client.ts";
import { host, launched, pane, recalled, subagentDone, type } from "./harness/agents.ts";
import { cursorTo, entry } from "./harness/deck.ts";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";

// session_ask's reader works from a map of the session in its first message, then finds and reads entries by ref:
// through a compaction, and into a subagent's own conversation.

let s: Scenario;
afterEach(async () => {
	if (!s) return;
	try {
		s.save("ls.json", JSON.stringify(s.ls(), null, 2));
		for (const session of s.ls().filter((session) => session.live))
			s.save(`pane-${session.harness}-${session.id}.txt`, pane(s, session.id));
	} finally {
		await s.cleanup();
	}
});

function recall(op: "begin" | "search", id: string, args: Record<string, unknown>): string {
	const run = Bun.spawnSync([`${s.bin}/swb`, "recall", op, id], { env: s.env, cwd: s.project, stdin: Buffer.from(JSON.stringify(args)) });
	if (run.exitCode !== 0) throw new Error(`swb recall ${op}: ${run.stderr.toString()}`);
	return (JSON.parse(run.stdout.toString()) as { text: string }).text;
}

/** What session_ask returned to a pi caller's model, from the faux provider's log. */
async function ask(caller: string, target: string, question: string): Promise<string> {
	const prompt = `ask-id ${target} :: ${question}`;
	type(s, caller, prompt);
	const answer = await until(
		() =>
			s
				.signal("recall.jsonl")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { prompt: string; role: string; text: string })
				.find((r) => r.prompt === prompt && r.role === "toolResult")?.text,
		budgets.piReady,
		"the reader's answer",
	);
	await until(() => entry(s, caller).activity === "idle", budgets.settle, "caller idle");
	return answer;
}

test("a reader's map marks a compaction, and it reads the turns from before it", async () => {
	s = scenario("recall-reader", "compaction", { packages: [], recorder: true, harnesses: ["codex"] });
	const codex = await launched(s, "codex", "reply SWB-before-compact alpha");
	type(s, codex.id, "/compact");
	await until(() => recalled(s, codex.id).includes("compaction summary"), budgets.piReady, "Codex's compaction in its rollout");
	await until(() => entry(s, codex.id).activity === "idle", budgets.settle, "Codex idle after compacting");
	type(s, codex.id, "reply SWB-after-compact beta");
	await until(() => recalled(s, codex.id).includes("SWB-after-compact beta\n"), budgets.piReady, "the turn after the compaction");

	const map = recall("begin", codex.id, { question: "What came before the compaction?" });
	s.save("map.txt", map);
	console.log(map);
	expect(map).toStartWith(`Question about session ${codex.id}:\n\nWhat came before the compaction?\n\n---\n`);
	const turns = map.split("\n").filter((line) => /^- \S+ · .* entries · "/.test(line));
	expect(turns.map((line) => /"(.*)"$/.exec(line)?.[1])).toEqual(["reply SWB-before-compact alpha", "reply SWB-after-compact beta"]);
	const order = map.split("\n").filter((line) => /^- (compaction|\S+ · .* entries)/.test(line));
	expect(order[1]).toStartWith("- compaction ");

	// The ref the map gives the first turn reads it, and on through the compaction.
	const first = /^- (\S+) · /.exec(turns[0] as string)?.[1] as string;
	const read = recalled(s, codex.id, { ref: first });
	expect(read).toStartWith(`[${first} · user`);
	const pieces = ["SWB-before-compact alpha", "compaction summary", "SWB-after-compact beta"].map((piece) => read.indexOf(piece));
	expect(pieces.every((at) => at >= 0)).toBe(true);
	expect([...pieces].sort((a, b) => a - b)).toEqual(pieces);

	const caller = await launched(s, "pi", "reply caller ready");
	expect(await ask(caller.id, codex.id, "Which markers, before and after the compaction?")).toBe(
		"reader found: SWB-before-compact SWB-after-compact",
	);
});

test("a Codex session rewound again and again, across a wake and an archive, reads as Codex itself sees it", async () => {
	s = scenario("recall-reader", "revert", { packages: [], recorder: true, harnesses: ["codex"] });
	const codex = await launched(s, "codex", "reply SWB-rewind-alpha");
	const socket = () => join(s.env.XDG_STATE_HOME as string, "agent-switchboard/codex", `${host(s, codex.id)}.sock`);
	const transcript = () => s.query<{ transcript: string }>("select transcript from sessions where session_id = ?", codex.id)[0]?.transcript;
	/** The prompts of the turns Codex itself holds now, oldest first: the oracle, independent of swb's reading. */
	const held = async (): Promise<string[]> => {
		const client = await CodexClient.connect(socket(), "swb-evidence");
		try {
			const { data } = (await client.request("thread/turns/list", { threadId: codex.id, sortDirection: "asc", limit: 100 })) as {
				data: { items: { type: string; content?: { type: string; text?: string }[] }[] }[];
			};
			return data.flatMap((turn) => turn.items.filter((i) => i.type === "userMessage").map((i) => i.content?.[0]?.text ?? ""));
		} finally {
			client.close();
		}
	};
	/** The prompts on the branch swb reads as active, from the reader's map. */
	const section = (map: string, heading: string) => {
		const from = map.split("\n").findIndex((line) => line.startsWith(heading));
		if (from === -1) return [];
		const rest = map.split("\n").slice(from + 1);
		return rest.slice(0, rest.findIndex((line) => !line.startsWith("- ")) >>> 0);
	};
	const active = () =>
		section(recall("begin", codex.id, { question: "?" }), "Its turns on the active branch").flatMap(
			(line) => /^- \d+ · .* entries · "(.*)"$/.exec(line)?.[1] ?? [],
		);
	const turn = async (marker: string) => {
		type(s, codex.id, `reply ${marker}`);
		await until(() => active().includes(`reply ${marker}`), budgets.piReady, `the turn ${marker}`);
		await until(() => entry(s, codex.id).activity === "idle", budgets.settle, `idle after ${marker}`);
	};
	/** Reverts to before the nth of the turns Codex holds, as the TUI's Esc-Esc does, and waits for swb to follow. */
	const revert = async (nth: number) => {
		const before = transcript();
		const client = await CodexClient.connect(socket(), "swb-evidence");
		const { data } = (await client.request("thread/turns/list", { threadId: codex.id, sortDirection: "asc", limit: 100 })) as {
			data: { id: string }[];
		};
		await client.request("thread/revert", { threadId: codex.id, beforeTurnId: data[nth]?.id });
		client.close();
		await until(() => transcript() !== before, budgets.settle, "the session's transcript moved to the revert's rollout");
	};
	const agrees = async (expected: string[]) => {
		const codexSees = await held();
		expect(codexSees).toEqual(expected.map((m) => `reply ${m}`));
		expect(active()).toEqual(codexSees);
	};

	await turn("SWB-rewind-bravo");
	await turn("SWB-rewind-charlie");
	await agrees(["SWB-rewind-alpha", "SWB-rewind-bravo", "SWB-rewind-charlie"]);
	await revert(2);
	await agrees(["SWB-rewind-alpha", "SWB-rewind-bravo"]);
	await turn("SWB-rewind-delta");
	await agrees(["SWB-rewind-alpha", "SWB-rewind-bravo", "SWB-rewind-delta"]);
	// Into the first rollout, past the one the last revert started.
	await revert(1);
	await turn("SWB-rewind-echo");
	await agrees(["SWB-rewind-alpha", "SWB-rewind-echo"]);

	// Dormant, then awake again: the woken Codex goes on in the rollout the reverts left it in.
	s.tmux(s.servers.sessions, "kill-session", "-t", `=${host(s, codex.id)}`);
	await until(() => !entry(s, codex.id).live, budgets.settle, "dormant");
	expect(active()).toEqual(["reply SWB-rewind-alpha", "reply SWB-rewind-echo"]);
	s.swb("drive", "start");
	await cursorTo(s, codex.id);
	s.keys("w");
	await until(() => entry(s, codex.id).live, budgets.piReady, "awake");
	await turn("SWB-rewind-foxtrot");
	await agrees(["SWB-rewind-alpha", "SWB-rewind-echo", "SWB-rewind-foxtrot"]);
	// Back before the first prompt.
	await revert(0);
	await turn("SWB-rewind-golf");
	await agrees(["SWB-rewind-golf"]);

	// Every undone prompt and its reply are an abandoned branch, once each; the kept one is a turn.
	const where = (marker: string) =>
		recall("search", codex.id, { query: marker })
			.split("\n")
			.filter((line) => line.startsWith("- "))
			.map((line) => / · (abandoned branch|turn \d+) · .* · (user|agent) · /.exec(line)?.slice(1).join(" "));
	for (const marker of [
		"SWB-rewind-alpha",
		"SWB-rewind-bravo",
		"SWB-rewind-charlie",
		"SWB-rewind-delta",
		"SWB-rewind-echo",
		"SWB-rewind-foxtrot",
	])
		expect(where(marker).sort()).toEqual(["abandoned branch agent", "abandoned branch user"]);
	expect(
		where("SWB-rewind-golf")
			.map((w) => w?.replace(/\d+/, "N"))
			.sort(),
	).toEqual(["turn N agent", "turn N user"]);

	// Codex's own /archive moves the thread's four rollouts to archived_sessions; swb archives it, and reads all of them.
	const size = (map: string) => /; (\d+) entries, /.exec(map)?.[1];
	const live = size(recall("begin", codex.id, { question: "?" }));
	const client = await CodexClient.connect(socket(), "swb-evidence");
	await client.request("thread/archive", { threadId: codex.id });
	client.close();
	await until(() => entry(s, codex.id).archivedAt !== null, budgets.settle, "archived in swb");
	expect(readdirSync(join(s.home, ".codex/archived_sessions")).filter((f) => f.includes(codex.id))).toHaveLength(4);
	const map = recall("begin", codex.id, { question: "What was undone?" });
	s.save("map.txt", map);
	console.log(map);
	expect(active()).toEqual(["reply SWB-rewind-golf"]);
	expect(Number(live)).toBeGreaterThan(14);
	expect(size(map)).toBe(live as string);
	// Each revert cut off a branch, and the last, undoing every turn, cut off the rest along with them.
	const branches = section(map, "Abandoned branches");
	expect(branches).toHaveLength(1);
	expect(branches[0]).toEndWith('"reply SWB-rewind-alpha"');
});

test("a Claude Code subagent appears in the map, and its refs search and read its own conversation", async () => {
	s = scenario("recall-reader", "subagent", { packages: [], recorder: true, harnesses: ["claude"] });
	const other = await launched(s, "claude", "reply SWB-sub-beacon elsewhere");
	const parent = await launched(s, "claude", "reply parent ready");
	const subagent = { description: "Find the beacon", subagent_type: "general-purpose", prompt: "reply SWB-sub-beacon" };
	type(s, parent.id, `call Agent ${JSON.stringify(subagent)}`);
	await subagentDone(s, parent.id, subagent.description);

	const map = recall("begin", parent.id, { question: "What did the subagent find?" });
	s.save("map.txt", map);
	console.log(map);
	const sub = /^- (sub:[^/]+\/) · "Find the beacon" · \d+ entries · .* · "reply SWB-sub-beacon"$/m.exec(map)?.[1];
	expect(sub).toBeDefined();

	// Search stays in the one session, and finds the subagent's entries under its refs.
	const hits = recall("search", parent.id, { query: "SWB-sub-beacon" });
	s.save("hits.txt", hits);
	console.log(hits);
	expect(hits).not.toContain("elsewhere");
	const ref = new RegExp(`^- (${sub}\\S+) · subagent "Find the beacon", turn ${sub}`, "m").exec(hits)?.[1] as string;
	expect(ref).toBeDefined();
	const read = recalled(s, parent.id, { ref, before: 10 });
	expect(read).toContain(`[${sub}`);
	expect(read).toContain("reply SWB-sub-beacon");
	expect(read).not.toContain("parent ready");
	expect(recall("search", other.id, { query: "SWB-sub-beacon" })).not.toContain("sub:");

	const caller = await launched(s, "pi", "reply caller ready");
	expect(await ask(caller.id, parent.id, "What did the subagent find?")).toContain("SWB-sub-beacon");
});
