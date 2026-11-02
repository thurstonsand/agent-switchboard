import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launched, settled, type } from "./harness/agents.ts";
import { repo, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	if (s) await s.cleanup();
});

const prompted = (id: string) =>
	(s.query<{ at: number }>("select last_prompt_at as at from sessions where session_id = ?", id)[0] as { at: number }).at;

/** Types a prompt into a session's TUI and waits for the turn it starts to end. */
async function turn(id: string, prompt: string): Promise<void> {
	const before = prompted(id);
	type(s, id, prompt);
	await until(() => prompted(id) > before, 60_000, `the turn for ${prompt}`);
	await settled(s, id, `the turn for ${prompt} to end`);
}

function evaluate(...args: string[]): string {
	const run = Bun.spawnSync(
		[
			process.execPath,
			join(repo, "test/eval/search.ts"),
			"--state",
			join(s.env.XDG_STATE_HOME as string, "agent-switchboard"),
			"--out",
			join(s.root, "eval"),
			...args,
		],
		{ env: s.env, cwd: repo, stdout: "pipe", stderr: "pipe" },
	);
	if (run.exitCode !== 0) throw new Error(`eval ${args.join(" ")}: ${run.stderr.toString()}`);
	return `${run.stdout.toString()}${run.stderr.toString()}`;
}

type Example = { harness: string; query: string; target: string; rank: number | null; shownAt: number | null };

test("the search eval replays each recorded session_search as it stood then, scored by the session the agent picked", async () => {
	s = scenario("eval", "search", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const alpha = await launched(s, "pi", "reply SWB-eval-alpha lantern");
	const beta = await launched(s, "pi", "reply SWB-eval-beta lantern harbor");
	const echo = await launched(s, "pi", "reply SWB-eval-echo");
	const pi = await launched(s, "pi", "reply searcher ready");
	const claude = await launched(s, "claude", "reply claude ready");
	const codex = await launched(s, "codex", "reply codex ready");

	// Found first, and picked: a hit.
	await turn(pi.id, "search lantern harbor");
	await turn(pi.id, `ask-id ${beta.id} :: Which marker?`);
	// Nothing matched, and the agent went to a session anyway: a miss.
	await turn(pi.id, "search zeppelin");
	await turn(pi.id, `ask-id ${alpha.id} :: Which marker?`);
	// Searched again before picking anything: no label.
	await turn(pi.id, "search lantern");
	// The session only says the word after the search; replayed as it stood then, it can't be found.
	await turn(pi.id, "search quokka");
	await turn(echo.id, "reply quokka");
	await turn(pi.id, `ask-id ${echo.id} :: Which marker?`);
	// The session it picked didn't exist when it searched: no label.
	await turn(pi.id, "search wombat");
	const later = await launched(s, "pi", "reply wombat");
	await turn(pi.id, `ask-id ${later.id} :: Which marker?`);
	// Claude Code's and Codex's searches, through their own MCP tool names.
	await turn(claude.id, "search SWB-eval-beta");
	await turn(claude.id, `ask-id ${beta.id} :: Which marker?`);
	await turn(codex.id, "search SWB-eval-alpha");
	await turn(codex.id, `ask-id ${alpha.id} :: Which marker?`);
	// Claude Code writes its transcript behind the idle event.
	const [{ transcript }] = s.query<{ transcript: string }>("select transcript from sessions where session_id = ?", claude.id) as [
		{ transcript: string },
	];
	await until(() => readFileSync(transcript, "utf8").includes(`ask-id ${beta.id}`), 10_000, "Claude's last turn in its transcript");

	const first = evaluate("--json", "--note", "first");
	s.save("first.txt", first);
	const results = JSON.parse(first.split("\n").find((line) => line.startsWith("{")) as string) as {
		tune: { examples: number; top1: number };
		holdout: { examples: number; top1: number; mrr: number };
		examples: Example[];
		skipped: { query: string; why: string }[];
	};
	const scored = results.examples
		.map(({ harness, query, target, rank, shownAt }) => ({ harness, query, target, rank, shownAt }))
		.sort((a, b) => a.query.localeCompare(b.query));
	expect(scored).toEqual([
		{ harness: "pi", query: "lantern harbor", target: beta.id, rank: 1, shownAt: 1 },
		{ harness: "pi", query: "quokka", target: echo.id, rank: null, shownAt: null },
		{ harness: "codex", query: "SWB-eval-alpha", target: alpha.id, rank: 1, shownAt: 1 },
		{ harness: "claude", query: "SWB-eval-beta", target: beta.id, rank: 1, shownAt: 1 },
		{ harness: "pi", query: "zeppelin", target: alpha.id, rank: null, shownAt: null },
	]);
	expect(results.tune.examples + results.holdout.examples).toBe(5);
	expect(results.tune.top1 + results.holdout.top1).toBe(3);
	expect(results.skipped.map(({ query, why }) => ({ query, why })).sort((a, b) => a.query.localeCompare(b.query))).toEqual([
		{ query: "lantern", why: "unpicked" },
		{ query: "wombat", why: "target-newer" },
	]);

	// Runs are kept, and compared on the examples both have.
	evaluate("--note", "second");
	const compared = evaluate("compare");
	s.save("compare.txt", compared);
	expect(compared).toContain("· first");
	expect(compared).toContain("· second");
	expect(compared).toContain("5 examples in both (0 only in base, 0 only in other)");
	expect(compared).toContain("better (0):");
	const history = evaluate("history").trim().split("\n");
	expect(history.map((line) => line.split(" · ").at(-1))).toEqual(["first", "second"]);
});
