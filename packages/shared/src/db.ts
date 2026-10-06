import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

export type Param = string | number | null;
export type Row = Record<string, Param>;

type Statement = {
	get(...params: Param[]): Row | null | undefined;
	all(...params: Param[]): Row[];
	run(...params: Param[]): unknown;
};
type Driver = { prepare(sql: string): Statement; exec(sql: string): void; close(): void };

// pi runs on Node, swb on Bun: each gets its own built-in driver, behind the same three calls.
const require = createRequire(import.meta.url);
function connect(path: string): Driver {
	if (process.versions.bun) {
		const { Database } = require("bun:sqlite");
		return new Database(path, { strict: false });
	}
	const { DatabaseSync } = require("node:sqlite");
	return new DatabaseSync(path);
}

export class Db {
	readonly #driver: Driver;

	constructor(
		readonly path: string,
		{ create }: { create: boolean },
	) {
		if (create) {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			closeSync(openSync(path, "a", 0o600));
		} else if (!existsSync(path)) {
			throw new Error(`no db at ${path}`);
		}
		this.#driver = connect(path);
		this.#driver.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
	}

	get(sql: string, ...params: Param[]): Row | undefined {
		return this.#driver.prepare(sql).get(...params) ?? undefined;
	}

	all(sql: string, ...params: Param[]): Row[] {
		return this.#driver.prepare(sql).all(...params);
	}

	run(sql: string, ...params: Param[]): void {
		this.#driver.prepare(sql).run(...params);
	}

	exec(sql: string): void {
		this.#driver.exec(sql);
	}

	userVersion(): number {
		return Number(this.get("PRAGMA user_version")?.user_version);
	}

	dataVersion(): number {
		return Number(this.get("PRAGMA data_version")?.data_version);
	}

	/** A read-then-write transaction: takes the write lock up front. */
	tx<T>(body: () => T): T {
		this.#driver.exec("BEGIN IMMEDIATE");
		try {
			const result = body();
			this.#driver.exec("COMMIT");
			return result;
		} catch (error) {
			this.#driver.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		this.#driver.close();
	}
}
