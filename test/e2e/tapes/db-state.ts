// What a tape shows of swb's db beside the Deck, refreshed by `watch`: each launch waiting for its process's first
// turn, each session with its parent and Group, and the processes hosting a session that has no row yet. Read-only, and
// it reads a db on schema v6, which has no launches table, so one tape can run against the build before and after.
import { Database } from "bun:sqlite";

const db = new Database(process.argv[2] as string, { readonly: true });
const all = (sql: string) => db.query(sql).all() as Record<string, string | null>[];
const sessions = all(
	"SELECT s.session_id, s.title, s.parent_id, m.group_name FROM sessions s LEFT JOIN marks m USING (session_id) ORDER BY s.created_at",
);
// pi's ids are UUIDv7, which start with the time: the end tells apart two sessions started a moment apart.
const short = (id: string) => `…${id.slice(-6)}`;
const name = (id: string | null) => {
	if (id === null) return "—";
	const s = sessions.find((row) => row.session_id === id);
	return s?.title ?? short(id);
};
const pad = (cells: string[], widths: number[]) => cells.map((cell, i) => cell.padEnd(widths[i] as number)).join("  ");
const table = (title: string, header: string[], rows: string[][]) => {
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
	console.log(`\x1b[1m${title}\x1b[0m`);
	console.log(`  \x1b[2m${pad(header, widths)}\x1b[0m`);
	for (const row of rows) console.log(`  ${pad(row, widths)}`);
	if (rows.length === 0) console.log("  \x1b[2m(none)\x1b[0m");
};

const tables = new Set(all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name));
const version = db.query("PRAGMA user_version").get() as { user_version: number };
console.log(`\x1b[2mswb.db, schema v${version.user_version}\x1b[0m`);
if (tables.has("launches"))
	table(
		"launches",
		["tmux session", "parent", "group", "resumes"],
		all("SELECT tmux_session, parent_id, group_name, resume_id FROM launches").map((r) => [
			r.tmux_session as string,
			name(r.parent_id ?? null),
			r.group_name ?? "—",
			r.resume_id === null ? "—" : name(r.resume_id ?? null),
		]),
	);
else console.log("\x1b[1mlaunches\x1b[0m  \x1b[2mno such table on this schema\x1b[0m");
table(
	"sessions",
	["session", "parent", "group"],
	sessions.map((s) => [name(s.session_id ?? null), name(s.parent_id ?? null), s.group_name ?? "—"]),
);
table(
	"hosted, no row yet",
	["tmux session", "session"],
	all("SELECT tmux_session, session_id FROM runtimes WHERE session_id NOT IN (SELECT session_id FROM sessions)").map((r) => [
		r.tmux_session as string,
		short(r.session_id as string),
	]),
);
