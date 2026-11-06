import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { isMainThread } from "node:worker_threads";

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

/**
 * Makes the db at path, in WAL, unless it's there. Switching a db to WAL takes its write lock, and SQLite refuses a
 * process that already reads it at once, ignoring busy_timeout, when waiting could deadlock. So no db anyone can open is
 * ever switched: a new one is switched under a name only its maker knows, where its header keeps WAL for good, then
 * appears at path whole. link fails when another process's appeared first, and that one is used.
 */
function make(path: string): void {
	if (existsSync(path)) return;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const made = `${path}.${process.pid}.new`;
	closeSync(openSync(made, "w", 0o600));
	try {
		const driver = connect(made);
		driver.exec("PRAGMA journal_mode = WAL");
		driver.close();
		linkSync(made, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	} finally {
		unlinkSync(made);
	}
}

/** The db stayed locked past busy_timeout: another connection held its write lock, and a later try may get through. */
export function isBusy(error: unknown): boolean {
	const { code, errcode } = error as { code?: unknown; errcode?: number };
	// node:sqlite carries SQLite's result code apart; bun:sqlite names it.
	if (code === "ERR_SQLITE_ERROR") return ((errcode ?? 0) & 0xff) === 5;
	return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/** A call slower than this is logged to db-waits.jsonl beside the db. */
const SLOW_MS = 200;

/** Which process waited: pi's line runs in pi on Node; everything else is swb, named by its subcommand. */
const who = `${process.versions.bun ? (process.argv[2] ?? "swb") : "pi"}${isMainThread ? "" : "/worker"}`;

export class Db {
	readonly #driver: Driver;
	readonly #waits: string;

	constructor(
		readonly path: string,
		{ create }: { create: boolean },
	) {
		if (create) make(path);
		else if (!existsSync(path)) throw new Error(`no db at ${path}`);
		this.#driver = connect(path);
		this.#waits = join(dirname(path), "db-waits.jsonl");
		this.#driver.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
	}

	get(sql: string, ...params: Param[]): Row | undefined {
		return this.#timed("get", sql, () => this.#driver.prepare(sql).get(...params) ?? undefined);
	}

	all(sql: string, ...params: Param[]): Row[] {
		return this.#timed("all", sql, () => this.#driver.prepare(sql).all(...params));
	}

	run(sql: string, ...params: Param[]): void {
		this.#timed("run", sql, () => this.#driver.prepare(sql).run(...params));
	}

	exec(sql: string): void {
		this.#timed("exec", sql, () => this.#driver.exec(sql));
	}

	userVersion(): number {
		return Number(this.get("PRAGMA user_version")?.user_version);
	}

	dataVersion(): number {
		return Number(this.get("PRAGMA data_version")?.data_version);
	}

	/** A read-then-write transaction: takes the write lock up front. One begun inside another is part of it. */
	tx<T>(body: () => T): T {
		if (this.#inTx) return body();
		// begin is the wait for the write lock; tx is how long this connection then held it.
		this.#timed("begin", "BEGIN IMMEDIATE", () => this.#driver.exec("BEGIN IMMEDIATE"));
		this.#inTx = true;
		const at = performance.now();
		try {
			const result = body();
			this.#driver.exec("COMMIT");
			return result;
		} catch (error) {
			this.#driver.exec("ROLLBACK");
			throw error;
		} finally {
			this.#inTx = false;
			this.#slow("tx", "", at, false);
		}
	}
	#inTx = false;

	#timed<T>(op: string, sql: string, call: () => T): T {
		const at = performance.now();
		try {
			const result = call();
			this.#slow(op, sql, at, false);
			return result;
		} catch (error) {
			this.#slow(op, sql, at, isBusy(error));
			throw error;
		}
	}

	/**
	 * A plain file rather than a table, so a db too busy to write to can still say so. Each entry names the process that
	 * waited; the one holding the lock shows as a long tx around the same time.
	 */
	#slow(op: string, sql: string, at: number, busy: boolean): void {
		const ms = Math.round(performance.now() - at);
		if (ms < SLOW_MS && !busy) return;
		const line = {
			at: Date.now(),
			db: basename(this.path),
			who,
			pid: process.pid,
			op,
			ms,
			busy,
			sql: sql.replace(/\s+/g, " ").trim().slice(0, 80),
		};
		appendFileSync(this.#waits, `${JSON.stringify(line)}\n`, { mode: 0o600 });
	}

	close(): void {
		this.#driver.close();
	}
}
