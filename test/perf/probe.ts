import { now } from "../../packages/shared/src/trace.ts";
import type { PiPackage, Scenario } from "../e2e/harness/index.ts";
import type { Terminal } from "./terminal.ts";

/** A build of swb and the pi line to measure. */
export type Variant = { label: string; dist: string };

export type Env = { s: Scenario; variant: Variant };

/** One measurement: when the person acted, and how long, in ms from then, until each thing they wait for. */
export type Measured = { t0: number; metrics: Record<string, number> };

export type Probe<C> = {
	name: string;
	/** What the person does and waits for, in a sentence. */
	feels: string;
	/** The metric that stands for the probe in tables and comparisons. */
	primary: string;
	runs: number;
	/** Puts things back the way a sample needs them, untimed, then measures once. */
	sample: (env: Env, ctx: C, i: number) => Promise<Measured>;
};

/** Probes sharing one scenario and its setup, run in order. */
export type Suite<C> = {
	name: string;
	harnesses?: ("claude" | "codex")[];
	packages?: PiPackage[];
	setup: (env: Env) => Promise<C>;
	probes: Probe<C>[];
};

export function suite<C>(definition: Suite<C>): Suite<unknown> {
	return definition as Suite<unknown>;
}

/** Runs swb as a command, timing it from spawn to exit. */
export async function exits(s: Scenario, args: string[], stdin?: string): Promise<{ t0: number; ms: number; out: string }> {
	const t0 = now();
	const proc = Bun.spawn([`${s.bin}/swb`, ...args], {
		env: s.env,
		cwd: s.project,
		stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	const ms = now() - t0;
	if (code !== 0) throw new Error(`swb ${args.join(" ")} exited ${code}: ${err}`);
	return { t0, ms, out };
}

/** Polls `probe` every 5 ms; resolves with when it first held, epoch ms. */
export async function when(probe: () => boolean | Promise<boolean>, what: string, timeoutMs = 60_000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await probe()) return now();
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await Bun.sleep(5);
	}
}

/** How many times `text` appears on a tmux pane's screen. */
export function onScreen(s: Scenario, server: string, target: string, text: string): number {
	try {
		return s.tmux(server, "capture-pane", "-p", "-J", "-t", target).split(text).length - 1;
	} catch {
		return 0;
	}
}

/** Gives the roster the keyboard, from wherever it is. */
export async function focusRoster(t: Terminal): Promise<void> {
	const st = await t.waitState("a Deck", () => true);
	if (st.focus === "roster" && st.mode === "roster" && st.picker === null) return;
	if (st.picker !== null || st.mode !== "roster") await t.press("Escape");
	if (st.focus !== "roster") await t.press("M-a", "h");
	await t.waitState("the roster focused", (x) => x.focus === "roster" && x.mode === "roster" && x.picker === null);
}

/** Moves the roster cursor onto a session's row with j and k, one row at a time. */
export async function cursorTo(t: Terminal, id: string): Promise<void> {
	await focusRoster(t);
	const deadline = Date.now() + 30_000;
	for (let st = await t.waitState("a Deck", () => true); st.cursor !== id; ) {
		if (Date.now() > deadline) throw new Error(`timed out moving the cursor to ${id}`);
		const index = st.rows.findIndex((row) => row.kind === "session" && row.id === id);
		if (index === -1) throw new Error(`no roster row for ${id}`);
		const before = st.cursorRow;
		await t.press(index > before ? "j" : "k");
		// A row vanishing underneath can land the cursor on the target without the cursor moving.
		st = await t.waitState(`the cursor off row ${before}`, (x) => x.cursorRow !== before || x.cursor === id);
	}
}

/** A session's row index, from a fresh state. */
export async function rowOf(t: Terminal, id: string): Promise<number> {
	const st = await t.waitState("a Deck", () => true);
	return st.rows.findIndex((row) => row.kind === "session" && row.id === id);
}
