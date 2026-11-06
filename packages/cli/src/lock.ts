import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isBusy, stateDir } from "@swb/shared";
import { SwbError } from "./errors.ts";

/**
 * Makes this the only swb holding the lock `name` until the returned release; one held longer than `waitMs` is an
 * error saying what its holder was `doing`.
 *
 * The hold is SQLite's exclusive lock on the file, an fcntl lock the kernel drops when its process ends, however it
 * ends. A holder that dies leaves nothing to take over, so there's no check of a dead holder for two waiters to race.
 */
export async function lock(name: string, doing: string, waitMs: number): Promise<() => void> {
	const dir = join(stateDir(), "locks");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const db = new Database(join(dir, `${name}.db`), { create: true });
	const until = Date.now() + waitMs;
	for (;;) {
		try {
			db.exec("BEGIN EXCLUSIVE");
			return () => {
				db.exec("ROLLBACK");
				db.close();
			};
		} catch (error) {
			if (!isBusy(error)) {
				db.close();
				throw error;
			}
		}
		if (Date.now() > until) {
			db.close();
			throw new SwbError(`another swb has been ${doing}`);
		}
		await Bun.sleep(100);
	}
}
