import { join } from "node:path";
import { Db, stateDir } from "@swb/shared";
import { SwbError } from "../errors.ts";

// recall.db: the search index over every Session's transcripts and its subagents', kept apart from swb.db because
// all of it can be rebuilt from the transcripts. An older index is dropped and rebuilt rather than migrated.

const RECALL_VERSION = 1;

const SCHEMA = `
	CREATE TABLE sources (
		id         INTEGER PRIMARY KEY,
		path       TEXT NOT NULL UNIQUE,
		session_id TEXT NOT NULL,
		harness    TEXT NOT NULL,
		-- The subagent this transcript is, or null for the session's own.
		subagent   TEXT,
		label      TEXT,
		-- Where indexing last read it to; null until it has been.
		size       INTEGER,
		mtime      INTEGER
	);
	CREATE INDEX sources_session ON sources (session_id);
	CREATE TABLE chunks (
		id     INTEGER PRIMARY KEY,
		source INTEGER NOT NULL REFERENCES sources ON DELETE CASCADE,
		ref    TEXT NOT NULL,
		kind   TEXT NOT NULL CHECK (kind IN ('user','agent','call','result','summary')),
		at     INTEGER,
		active INTEGER NOT NULL,
		text   TEXT NOT NULL
	);
	CREATE INDEX chunks_source ON chunks (source);
	CREATE VIRTUAL TABLE chunks_fts USING fts5 (text, content = 'chunks', content_rowid = 'id', tokenize = "unicode61 remove_diacritics 2 tokenchars '_'");
	CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
		INSERT INTO chunks_fts (rowid, text) VALUES (new.id, new.text);
	END;
	CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
		INSERT INTO chunks_fts (chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
	END;
	CREATE TABLE touches (
		source INTEGER NOT NULL REFERENCES sources ON DELETE CASCADE,
		ref    TEXT NOT NULL,
		path   TEXT NOT NULL,
		op     TEXT NOT NULL CHECK (op IN ('read','changed')),
		at     INTEGER
	);
	CREATE INDEX touches_source ON touches (source);
	CREATE INDEX touches_path ON touches (path);
`;

export function recallPath(): string {
	return join(stateDir(), "recall.db");
}

export function openRecall(): Db {
	const db = new Db(recallPath(), { create: true });
	const version = db.userVersion();
	if (version > RECALL_VERSION) throw new SwbError(`index ${db.path} is v${version}, newer than this swb (v${RECALL_VERSION})`);
	if (version < RECALL_VERSION)
		db.tx(() => {
			if (db.userVersion() === RECALL_VERSION) return;
			for (const row of db.all(
				"SELECT type, name FROM sqlite_schema WHERE type IN ('table','trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'chunks_fts_%'",
			))
				db.exec(`DROP ${row.type} IF EXISTS "${row.name}"`);
			db.exec(SCHEMA);
			db.exec(`PRAGMA user_version = ${RECALL_VERSION}`);
		});
	return db;
}
