import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pidAlive } from "@swb/shared";
import { SwbError } from "./errors.ts";

/**
 * Makes this the only swb holding `path` until the returned release. The lock holds its owner's pid, so one left by a
 * process that died is taken over; one held longer than `waitMs` is an error saying what its holder was `doing`.
 */
export async function lock(path: string, doing: string, waitMs: number): Promise<() => void> {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const mine = `${process.pid} ${crypto.randomUUID()}`;
	const until = Date.now() + waitMs;
	for (;;) {
		try {
			writeFileSync(path, mine, { flag: "wx", mode: 0o600 });
			return () => {
				if (readFileSync(path, "utf8") === mine) rmSync(path);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let holder = 0;
		try {
			holder = Number(readFileSync(path, "utf8").split(" ")[0]);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			continue;
		}
		// An empty file is a lock being written.
		if (holder > 0 && !pidAlive(holder)) rmSync(path, { force: true });
		else if (Date.now() > until) throw new SwbError(`swb ${holder} has been ${doing}; remove ${path} if it's stuck`);
		else await Bun.sleep(100);
	}
}
