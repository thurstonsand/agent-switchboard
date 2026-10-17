import { appendFileSync } from "node:fs";

// Timings for `mise run perf`: with SWB_TRACE set to a file, every swb process and line appends one JSON line per
// mark or span to it. Unset, each call is a single check. Small appends to one O_APPEND file don't interleave.

const file = process.env.SWB_TRACE;

/** Epoch milliseconds, sub-millisecond, on the same clock in every process. */
export function now(): number {
	return performance.timeOrigin + performance.now();
}

function write(event: { name: string; at: number; ms?: number }): void {
	if (file) appendFileSync(file, `${JSON.stringify({ ...event, pid: process.pid })}\n`);
}

export function mark(name: string): void {
	if (file) write({ name, at: now() });
}

/** Times `run`, until its promise settles if it returns one. */
export function span<T>(name: string, run: () => T): T {
	if (!file) return run();
	const at = now();
	const result = run();
	if (result instanceof Promise) return result.finally(() => write({ name, at, ms: now() - at })) as T;
	write({ name, at, ms: now() - at });
	return result;
}

/** A span from `at`, a `now()` taken earlier, to now: for a stretch too long to wrap. */
export function since(name: string, at: number): void {
	if (file) write({ name, at, ms: now() - at });
}

/** How long this process's runtime took to start, as a span ending now. */
export function booted(name: string): void {
	if (file) write({ name, at: performance.timeOrigin, ms: performance.now() });
}
