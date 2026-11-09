import { Db, dbPath, type ReloadMode, SCHEMA_VERSION, type View } from "@swb/shared";
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
	"ALTER TABLE marks ADD COLUMN group_name TEXT",
	`CREATE TABLE deck_layouts (
		project_root TEXT PRIMARY KEY,
		state        TEXT NOT NULL,
		saved_at     INTEGER NOT NULL
	);`,
	`CREATE TABLE dirs (
		path  TEXT PRIMARY KEY,
		state TEXT NOT NULL CHECK (state IN ('added','removed'))
	);`,
	// A CHECK can't change in place: sessions is rebuilt, with foreign keys off around the transaction.
	`CREATE TABLE sessions_v5 (
		session_id      TEXT PRIMARY KEY,
		harness         TEXT NOT NULL CHECK (harness IN ('pi','claude','codex')),
		parent_id       TEXT,
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
	INSERT INTO sessions_v5 (session_id, harness, cwd, project_root, transcript, title, branch, phase, created_at, last_prompt_at, last_settled_at)
		SELECT session_id, tool, cwd, project_root, transcript, title, branch, phase, created_at, last_prompt_at, last_settled_at FROM sessions;
	DROP TABLE sessions;
	ALTER TABLE sessions_v5 RENAME TO sessions;
	ALTER TABLE runtimes ADD COLUMN harness TEXT NOT NULL DEFAULT 'pi' CHECK (harness IN ('pi','claude','codex'));
	CREATE TABLE messages (
		id               TEXT PRIMARY KEY,
		kind             TEXT NOT NULL CHECK (kind IN ('message','cancel')),
		source_id        TEXT NOT NULL,
		target_id        TEXT NOT NULL,
		body             TEXT NOT NULL,
		request_response INTEGER NOT NULL,
		request_id       TEXT,
		created_at       INTEGER NOT NULL,
		offered_at       INTEGER,
		delivered_at     INTEGER,
		cancelled_at     INTEGER,
		UNIQUE (source_id, request_id)
	);
	CREATE INDEX messages_pending ON messages (target_id) WHERE delivered_at IS NULL AND cancelled_at IS NULL;`,
	// A schedule delivers to a session, or launches a new one, on each fire; next_at is null once it has finished.
	// marks.title is a title set through swb, shown until the session's harness takes it and reports it back as its own.
	// The first view is the session's agent, whichever harness runs it; its CHECK can't change in place, so marks is rebuilt.
	`CREATE TABLE schedules (
		id               TEXT PRIMARY KEY,
		source_id        TEXT NOT NULL,
		target_id        TEXT,
		launch           TEXT,
		body             TEXT NOT NULL,
		request_response INTEGER NOT NULL,
		label            TEXT NOT NULL,
		cron             TEXT,
		request_id       TEXT,
		created_at       INTEGER NOT NULL,
		next_at          INTEGER,
		last_fired_at    INTEGER,
		cancelled_at     INTEGER,
		UNIQUE (source_id, request_id),
		CHECK ((target_id IS NULL) != (launch IS NULL))
	);
	CREATE INDEX schedules_due ON schedules (next_at) WHERE next_at IS NOT NULL AND cancelled_at IS NULL;
	ALTER TABLE messages ADD COLUMN schedule_id TEXT;
	ALTER TABLE messages ADD COLUMN scheduled_for INTEGER;
	CREATE INDEX messages_target ON messages (target_id, created_at);
	ALTER TABLE sessions ADD COLUMN errored_at INTEGER;
	CREATE TABLE marks_v6 (
		session_id    TEXT PRIMARY KEY REFERENCES sessions,
		archived_at   INTEGER,
		visited_at    INTEGER,
		view          TEXT NOT NULL DEFAULT 'agent' CHECK (view IN ('agent','editor','split')),
		group_name    TEXT,
		snoozed_at    INTEGER,
		snoozed_until INTEGER,
		title         TEXT
	);
	INSERT INTO marks_v6 (session_id, archived_at, visited_at, view, group_name)
		SELECT session_id, archived_at, visited_at, CASE view WHEN 'pi' THEN 'agent' ELSE view END, group_name FROM marks;
	DROP TABLE marks;
	ALTER TABLE marks_v6 RENAME TO marks;
	ALTER TABLE sessions ADD COLUMN model TEXT;
	ALTER TABLE sessions ADD COLUMN effort TEXT;`,
	// What a launch gives the process it starts in a tmux session, until that process's line records it.
	`CREATE TABLE launches (
		tmux_session TEXT PRIMARY KEY,
		resume_id    TEXT,
		parent_id    TEXT,
		group_name   TEXT,
		created_at   INTEGER NOT NULL
	);`,
	// A reload waiting for the session's turn to end, and how it should come back.
	"ALTER TABLE marks ADD COLUMN reload TEXT CHECK (reload IN ('continue','idle'))",
	// When I marked it Unseen, holding until a Visit after it.
	"ALTER TABLE marks ADD COLUMN unseen_at INTEGER",
	// The names swb's tools give them.
	`ALTER TABLE messages RENAME COLUMN request_response TO report_back;
	ALTER TABLE schedules RENAME COLUMN request_response TO report_back;
	ALTER TABLE schedules RENAME COLUMN label TO schedule_label;`,
	// Lines mark a message delivered before handing it over, so being offered is no state of its own.
	"ALTER TABLE messages DROP COLUMN offered_at",
	// Every Deck starts from where the last one left off, wherever it was opened.
	`CREATE TABLE deck_layout (
		id       INTEGER PRIMARY KEY CHECK (id = 1),
		state    TEXT NOT NULL,
		saved_at INTEGER NOT NULL
	);
	INSERT INTO deck_layout (id, state, saved_at) SELECT 1, state, saved_at FROM deck_layouts ORDER BY saved_at DESC LIMIT 1;
	DROP TABLE deck_layouts;`,
	// The last Visit that ended its Unseen: reading it starts inactive_after over.
	"ALTER TABLE marks ADD COLUMN read_at INTEGER",
];

if (MIGRATIONS.length !== SCHEMA_VERSION) throw new Error(`${MIGRATIONS.length} migrations for schema v${SCHEMA_VERSION}`);

/** Records a Visit; `read` when it found the session Unseen. */
export function markVisited(db: Db, id: string, read: boolean): void {
	const now = Date.now();
	db.run(
		`INSERT INTO marks (session_id, visited_at, read_at) VALUES (?1, ?2, ?3)
		 ON CONFLICT (session_id) DO UPDATE SET visited_at = excluded.visited_at, read_at = coalesce(excluded.read_at, read_at)`,
		id,
		now,
		read ? now : null,
	);
}

/** Marks a session Unseen until my next Visit, or (false) takes that mark off. */
export function markUnseen(db: Db, id: string, marked: boolean): void {
	db.run(
		"INSERT INTO marks (session_id, unseen_at) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET unseen_at = excluded.unseen_at",
		id,
		marked ? Date.now() : null,
	);
}

export function setView(db: Db, id: string, view: View): void {
	db.run("INSERT INTO marks (session_id, view) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET view = excluded.view", id, view);
}

/** A title for the session's harness to take, or (null) none pending. */
export function rename(db: Db, id: string, title: string | null): void {
	db.run("INSERT INTO marks (session_id, title) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET title = excluded.title", id, title);
}

/** A reload for the session's line to quit for when its turn ends, and the clock to start it again from; null for none. */
export function setReload(db: Db, id: string, mode: ReloadMode | null): void {
	db.run("INSERT INTO marks (session_id, reload) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET reload = excluded.reload", id, mode);
}

/** Moves sessions into a Group, or out of any when `name` is null. */
export function setGroup(db: Db, ids: string[], name: string | null): void {
	db.tx(() => {
		for (const id of ids)
			db.run(
				"INSERT INTO marks (session_id, group_name) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET group_name = excluded.group_name",
				id,
				name,
			);
	});
}

/** The Deck's layout as last left, which the next Deck starts from. */
export type DeckLayout = { selectedKey: string; rosterCols: number | null; collapsed: string[]; expanded: string[] };

export function loadLayout(db: Db): DeckLayout | null {
	const row = db.get("SELECT state FROM deck_layout");
	return row ? (JSON.parse(row.state as string) as DeckLayout) : null;
}

export function saveLayout(db: Db, layout: DeckLayout): void {
	db.run(
		"INSERT INTO deck_layout (id, state, saved_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state, saved_at = excluded.saved_at",
		JSON.stringify(layout),
		Date.now(),
	);
}

/** Opens the db and brings it to this binary's schema; refuses a db from a newer swb. */
export function openStore({ create } = { create: true }): Db {
	const db = new Db(dbPath(), { create });
	const version = db.userVersion();
	if (version > SCHEMA_VERSION) throw new SwbError(`db ${db.path} is schema v${version}, newer than this swb (v${SCHEMA_VERSION})`);
	if (version < SCHEMA_VERSION) {
		// Rebuilding a referenced table needs foreign keys off, which SQLite ignores inside a transaction.
		db.exec("PRAGMA foreign_keys = OFF");
		try {
			db.tx(() => {
				for (const sql of MIGRATIONS.slice(db.userVersion())) db.exec(sql);
				const broken = db.all("PRAGMA foreign_key_check");
				if (broken.length > 0) throw new SwbError(`migration broke foreign keys: ${JSON.stringify(broken)}`);
				db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
			});
		} finally {
			db.exec("PRAGMA foreign_keys = ON");
		}
	}
	return db;
}
