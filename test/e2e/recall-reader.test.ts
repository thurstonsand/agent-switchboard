import { afterEach, expect, test } from "bun:test";
import { launched, pane, recalled, subagentDone, type } from "./harness/agents.ts";
import { entry } from "./harness/deck.ts";
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
