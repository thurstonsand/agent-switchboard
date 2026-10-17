import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, hostname, totalmem } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { repo, type Scenario, scenario, which } from "../e2e/harness/index.ts";
import { buildRef, sha } from "./build.ts";
import { html } from "./html.ts";
import type { Measured, Suite, Variant } from "./probe.ts";
import { type Meta, type ProbeResult, type Results, slowest, spans, stats, type TraceEvent, table } from "./report.ts";
import { cli } from "./suites/cli.ts";
import { deckLive, deckNav, deckOpen } from "./suites/deck.ts";
import { sessionsClaude, sessionsCodex, sessionsPi } from "./suites/sessions.ts";
import { tools } from "./suites/tools.ts";
import type { Terminal } from "./terminal.ts";

const SUITES: Suite<unknown>[] = [cli, deckOpen, deckNav, deckLive, sessionsPi, sessionsClaude, sessionsCodex, tools];

const USAGE = `mise run perf [-- OPTIONS]        measure what a person waits for in swb, on real harnesses
mise run perf:compare BASE.json OTHER.json

  --only P[,P…]     probes whose name contains P, or whole suites by name (cli, deck-open, sessions-codex, …)
  --runs N          samples per probe, overriding each probe's own count
  --warmup N        samples taken and discarded first, per probe and build (default 1)
  --against REF     also build REF in a scratch worktree and interleave its samples with this checkout's
  --baseline FILE   compare with an earlier run's results
  --list            list the probes and stop
  --json            print the results as JSON on stdout; progress stays on stderr

Every run writes test/perf/results/<date>-<sha>.json and .html beside it.`;

const { values, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: {
		only: { type: "string" },
		runs: { type: "string" },
		warmup: { type: "string", default: "1" },
		against: { type: "string" },
		baseline: { type: "string" },
		list: { type: "boolean", default: false },
		json: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
	},
});

const log = (text: string) => process.stderr.write(`${text}\n`);
/** One line rewritten in place on a terminal; nothing in a log, which gets a line per probe instead. */
const progress = (text: string) => {
	if (process.stderr.isTTY) process.stderr.write(`\r\x1b[K${text}`);
};
const resultsDir = join(repo, "test/perf/results");

function git(...args: string[]): string {
	return Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe" })
		.stdout.toString()
		.trim();
}

function meta(): Meta {
	const cpu = cpus();
	return {
		date: new Date().toISOString(),
		sha: sha("HEAD"),
		dirty: git("status", "--porcelain") !== "",
		branch: git("rev-parse", "--abbrev-ref", "HEAD"),
		host: hostname(),
		platform: `${process.platform}-${process.arch}`,
		cpus: `${cpu.length}× ${cpu[0]?.model.trim() ?? "unknown"}`,
		memoryGb: Math.round(totalmem() / 2 ** 30),
		bun: Bun.version,
		tmux: Bun.spawnSync([which("tmux"), "-V"])
			.stdout.toString()
			.trim(),
		args: Bun.argv.slice(2),
	};
}

function selected(suite: Suite<unknown>, patterns: string[] | null) {
	if (!patterns) return suite.probes;
	if (patterns.includes(suite.name)) return suite.probes;
	return suite.probes.filter((probe) => patterns.some((p) => probe.name.includes(p)));
}

function readTrace(s: Scenario): TraceEvent[] {
	const path = s.env.SWB_TRACE as string;
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as TraceEvent];
			} catch {
				return [];
			}
		});
}

type Live = { variant: Variant; s: Scenario | null; ctx: unknown; failed: string | null; skipped: string | null };

async function runSuite(suite: Suite<unknown>, probes: Suite<unknown>["probes"], variants: Variant[]): Promise<ProbeResult[]> {
	const warmup = Number(values.warmup);
	const lives: Live[] = [];
	for (const [index, variant] of variants.entries()) {
		log(`${suite.name}: setting up ${variant.label}`);
		let s: Scenario | null = null;
		try {
			s = scenario("perf", `${suite.name}-${index}`, {
				packages: suite.packages ?? [],
				recorder: true,
				...(suite.harnesses ? { harnesses: suite.harnesses } : {}),
				dist: variant.dist,
			});
			s.env.SWB_TRACE = join(s.root, "trace.jsonl");
			const ctx = await suite.setup({ s, variant });
			lives.push({ variant, s, ctx, failed: null, skipped: null });
		} catch (error) {
			const message = (error as Error).message;
			const missing = /needs (\w+), and this host has no npm-global install/.exec(message);
			lives.push({ variant, s, ctx: null, failed: missing ? null : message, skipped: missing ? `no ${missing[1]} on this host` : null });
			if (!missing) log(`${suite.name}: setup failed in ${variant.label}: ${message}`);
		}
	}
	const results: ProbeResult[] = [];
	for (const probe of probes) {
		const runs = values.runs ? Number(values.runs) : probe.runs;
		const samples = new Map<Live, Measured[]>(lives.map((live) => [live, []]));
		const errors = new Map<Live, string>();
		if (!process.stderr.isTTY) log(`${probe.name}: ${warmup} warmup, ${runs} runs`);
		for (let i = 0; i < warmup + runs; i++) {
			// Alternating which build goes first spreads the machine's drift evenly over both.
			for (const live of i % 2 === 0 ? lives : lives.toReversed()) {
				if (!live.s || live.failed || live.skipped || errors.has(live)) continue;
				progress(`${probe.name}: ${live.variant.label} ${i < warmup ? "warmup" : `${i - warmup + 1}/${runs}`}`);
				try {
					const measured = await probe.sample({ s: live.s, variant: live.variant }, live.ctx, i);
					if (i >= warmup) samples.get(live)?.push(measured);
				} catch (error) {
					errors.set(live, (error as Error).message);
					log(`${probe.name}: failed in ${live.variant.label}: ${(error as Error).message}`);
					const t = (live.ctx as { t?: Terminal }).t;
					if (t) {
						const file = join(live.s.artifacts, `${probe.name}.failure.txt`);
						writeFileSync(file, `${t.screen()}\n\n${JSON.stringify(await t.state(), null, 1)}\n`);
						log(`  its screen and Deck state: ${file}`);
					}
				}
			}
		}
		progress("");
		const skipped = lives.find((live) => live.skipped)?.skipped ?? null;
		results.push({
			name: probe.name,
			suite: suite.name,
			feels: probe.feels,
			primary: probe.primary,
			skipped,
			variants: Object.fromEntries(
				lives.map((live) => {
					const measured = samples.get(live) ?? [];
					const trace = live.s ? readTrace(live.s) : [];
					const windows = measured.map(({ t0, metrics }) => ({ t0, end: t0 + Math.max(0, ...Object.values(metrics)) }));
					return [
						live.variant.label,
						{
							samples: measured.map((m) => m.metrics),
							stats: stats(measured.map((m) => m.metrics)),
							spans: spans(trace, windows),
							error: live.failed ?? errors.get(live) ?? null,
						},
					];
				}),
			),
		});
	}
	for (const live of lives) {
		(live.ctx as { t?: Terminal } | null)?.t?.close();
		await live.s?.cleanup();
	}
	return results;
}

/** Puts an earlier run's numbers beside these as the baseline, for the probes both have. */
function withBaseline(results: Results, file: string): Results {
	const base = JSON.parse(readFileSync(file, "utf8")) as Results;
	const from = base.variants.at(-1) as string;
	const label = results.variants.includes(from) ? `${from} (${basename(file)})` : from;
	return {
		...results,
		variants: [label, ...results.variants],
		probes: results.probes.map((probe) => {
			const earlier = base.probes.find((p) => p.name === probe.name)?.variants[from];
			return earlier ? { ...probe, variants: { [label]: earlier, ...probe.variants } } : probe;
		}),
	};
}

function report(results: Results, stamp: string): void {
	mkdirSync(resultsDir, { recursive: true });
	const json = join(resultsDir, `${stamp}.json`);
	const page = join(resultsDir, `${stamp}.html`);
	writeFileSync(json, `${JSON.stringify(results, null, 1)}\n`);
	writeFileSync(page, html(results));
	if (values.json) console.log(JSON.stringify(results));
	log(`\n${table(results)}\n\n${slowest(results)}\n\nresults: ${json}\nreport:  ${page}`);
}

if (values.help) {
	console.log(USAGE);
	process.exit(0);
}

if (positionals[0] === "compare") {
	const [, baseFile, otherFile] = positionals;
	if (!baseFile || !otherFile) throw new Error(`compare takes two results files\n\n${USAGE}`);
	const results = withBaseline(JSON.parse(readFileSync(otherFile, "utf8")) as Results, baseFile);
	report(results, `compare-${basename(baseFile, ".json")}-${basename(otherFile, ".json")}`);
	process.exit(0);
}

const patterns = values.only ? values.only.split(",").map((p) => p.trim()) : null;
const plan = SUITES.map((suite) => ({ suite, probes: selected(suite, patterns) })).filter((p) => p.probes.length > 0);
if (values.list) {
	for (const { suite, probes } of plan)
		for (const probe of probes)
			console.log(`${probe.name.padEnd(22)} ${suite.name.padEnd(15)} ${String(probe.runs).padStart(3)}  ${probe.feels}`);
	process.exit(0);
}
if (plan.length === 0) throw new Error(`no probe matches ${values.only}`);

const m = meta();
const self: Variant = { label: `${m.branch}@${m.sha}${m.dirty ? "+" : ""}`, dist: join(repo, "dist") };
if (values.against) log(`building ${values.against}…`);
const ref = values.against ? buildRef(values.against) : null;
const variants = ref ? [ref, self] : [self];
let results: Results = { meta: m, variants: variants.map((v) => v.label), probes: [] };
try {
	for (const { suite, probes } of plan) results.probes.push(...(await runSuite(suite, probes, variants)));
} finally {
	ref?.cleanup();
}
if (values.baseline) results = withBaseline(results, values.baseline);
report(results, `${m.date.replaceAll(":", "-").slice(0, 19)}-${m.sha}${m.dirty ? "+" : ""}`);
const failed = results.probes.some((probe) => Object.values(probe.variants).some((v) => v.error));
process.exit(failed ? 1 : 0);
