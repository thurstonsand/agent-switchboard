import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { repo } from "../e2e/harness/index.ts";
import type { Variant } from "./probe.ts";

function run(argv: string[], cwd: string): string {
	const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${result.exitCode}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

export function sha(ref: string): string {
	return run(["git", "rev-parse", "--short", ref], repo);
}

/** Builds swb and the pi line at `ref` in a scratch worktree, the way this checkout's own `mise run build` does. */
export function buildRef(ref: string): Variant & { cleanup: () => void } {
	const dir = mkdtempSync("/tmp/swb-perf-ref-");
	run(["git", "worktree", "add", "--detach", dir, ref], repo);
	const cleanup = () => {
		Bun.spawnSync(["git", "worktree", "remove", "--force", dir], { cwd: repo });
		rmSync(dir, { recursive: true, force: true });
	};
	try {
		run(["mise", "trust", "-q", dir], dir);
		run(["bun", "install", "--frozen-lockfile"], dir);
		run(["mise", "run", "build"], dir);
		run(["mise", "run", "dist:pi"], dir);
	} catch (error) {
		cleanup();
		throw error;
	}
	return { label: `${ref}@${sha(ref)}`, dist: join(dir, "dist"), cleanup };
}
