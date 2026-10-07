import { Db, dbPath, SCHEMA_VERSION, type View } from "@swb/shared";
import { SwbError } from "./errors.ts";

const MIGRATIONS: string[] = [
	`CREATE TABLE sessions (
		session_id      TEXT PRIMARY KEY,
		tool            TEXT NOT NULL CHECK (tool IN ('pi')),
		cwd             TEXT NOT NULL,
		project_root    TEXT NOT NULL,
		transcript      TEXT NOT NULL,
		title           TEXT,
		branch          TEXT,
		phase           TEXT NOT NULL CHECK (phase IN ('idle','working','blocked')),
		created_at      INTEGER NOT NULL,
		last_prompt_at  INTEGER NOT NULL,
		last_settled_at INTEGER
	);
	CREATE TABLE runtimes (
		tmux_session TEXT PRIMARY KEY,
		session_id   TEXT NOT NULL UNIQUE,
		cwd          TEXT NOT NULL,
		project_root TEXT NOT NULL,
		boot_id      TEXT NOT NULL,
		pid          INTEGER NOT NULL,
		started_at   INTEGER NOT NULL
	);
	CREATE TABLE marks (
		session_id  TEXT PRIMARY KEY REFERENCES sessions,
		archived_at INTEGER,
		visited_at  INTEGER,
		view        TEXT NOT NULL DEFAULT 'pi' CHECK (view IN ('pi','editor','split'))
	);`,
];

if (MIGRATIONS.length !== SCHEMA_VERSION) throw new Error(`${MIGRATIONS.length} migrations for schema v${SCHEMA_VERSION}`);

export function markVisited(db: Db, id: string): void {
	db.run(
		"INSERT INTO marks (session_id, visited_at) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET visited_at = excluded.visited_at",
		id,
		Date.now(),
	);
}

export function setView(db: Db, id: string, view: View): void {
	db.run("INSERT INTO marks (session_id, view) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET view = excluded.view", id, view);
}

/** Opens the db and brings it to this binary's schema; refuses a db from a newer swb. */
export function openStore(): Db {
	const db = new Db(dbPath(), { create: true });
	const version = db.userVersion();
	if (version > SCHEMA_VERSION) throw new SwbError(`db ${db.path} is schema v${version}, newer than this swb (v${SCHEMA_VERSION})`);
	if (version < SCHEMA_VERSION) {
		db.tx(() => {
			for (const sql of MIGRATIONS.slice(db.userVersion())) db.exec(sql);
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		});
	}
	return db;
}
