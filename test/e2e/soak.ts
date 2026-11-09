// Runs e2e tests over and over with every CPU kept busy, and counts which ones failed: a test that only passes on an
// idle machine fails here. `bun test/e2e/soak.ts --help` for options.
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const HELP = `mise run e2e:soak -- [--runs N] [--load N] [--against DIR] [-- BUN_TEST_ARGS...]

  --runs N       how many times to run them (default 5)
  --load N       busy loops held for the whole soak (default: one per CPU)
  --against DIR  another built checkout, such as a worktree of main, run in turn with this one under the same load
  BUN_TEST_ARGS  what to run, as bun test takes it (default: every e2e file but deck-latency, in parallel)

Example: mise run e2e:soak -- --runs 10 -- test/e2e/archive-worktree.test.ts -t "clickable archive choice"`;

const split = process.argv.indexOf("--");
const own = split === -1 ? process.argv.slice(2) : process.argv.slice(2, split);
const { values } = parseArgs({
	args: own,
	options: {
		runs: { type: "string", default: "5" },
		load: { type: "string", default: String(availableParallelism()) },
		against: { type: "string" },
		help: { type: "boolean", default: false },
	},
});
if (values.help) {
	console.log(HELP);
	process.exit(0);
}
const runs = Number(values.runs);
const here = resolve(import.meta.dir, "../..");
const checkouts = [here, ...(values.against ? [resolve(values.against)] : [])];
const jobs = Math.max(1, Math.floor((availableParallelism() * 3) / 2));
const selection =
	split === -1 ? [`--parallel=${jobs}`, "--path-ignore-patterns=**/deck-latency.test.ts", "test/e2e"] : process.argv.slice(split + 1);

const spinners = Array.from({ length: Number(values.load) }, () => Bun.spawn(["sh", "-c", "while :; do :; done"]));
const stop = () => {
	for (const spinner of spinners) spinner.kill();
};
process.on("SIGINT", () => {
	stop();
	process.exit(130);
});

type Run = { run: number; passed: number; failed: string[]; seconds: number };
const results = new Map<string, Run[]>(checkouts.map((dir) => [dir, []]));
try {
	for (let run = 1; run <= runs; run++) {
		for (const cwd of checkouts) {
			const started = Date.now();
			const proc = Bun.spawn(["bun", "test", "--timeout", "180000", ...selection], { cwd, stdout: "pipe", stderr: "pipe" });
			const [out, err] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
			const text = `${out}\n${err}`;
			// bun names a failure where it happens and again in its summary.
			const named = (outcome: string) =>
				new Set([...text.matchAll(new RegExp(`^\\(${outcome}\\) (.+?)(?: \\[[\\d.]+m?s\\])?$`, "gm"))].map((m) => m[1] as string));
			const failed = [...named("fail")];
			const seconds = Math.round((Date.now() - started) / 1000);
			results.get(cwd)?.push({ run, passed: named("pass").size, failed, seconds });
			const label = checkouts.length > 1 ? ` ${cwd}` : "";
			console.log(
				`run ${run}/${runs}${label}: ${named("pass").size} passed, ${failed.length} failed (${seconds}s)${failed.map((n) => `\n  ✗ ${n}`).join("")}`,
			);
			const logs = join(cwd, "test/e2e/artifacts/soak");
			mkdirSync(logs, { recursive: true });
			writeFileSync(join(logs, `run-${run}.log`), text);
		}
	}
} finally {
	stop();
}

let anyFailed = false;
for (const [cwd, list] of results) {
	const counts = new Map<string, number>();
	for (const { failed } of list) for (const name of failed) counts.set(name, (counts.get(name) ?? 0) + 1);
	const flaky = [...counts].sort((a, b) => b[1] - a[1]);
	const total = list.reduce((sum, r) => sum + r.failed.length, 0);
	if (cwd === here && flaky.length > 0) anyFailed = true;
	console.log(`\n${cwd}: ${total} failures in ${runs} runs${flaky.map(([name, n]) => `\n  ${n}/${runs}  ${name}`).join("")}`);
	writeFileSync(join(cwd, "test/e2e/artifacts/soak/summary.json"), JSON.stringify({ selection, runs, results: list }, null, 2));
}
process.exit(anyFailed ? 1 : 0);
