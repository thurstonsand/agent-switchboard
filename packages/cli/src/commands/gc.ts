import { openStore } from "../store.ts";
import { listSessions, SESSIONS, tmuxTry } from "../tmux.ts";

/** Kills each editor whose directory no open session uses any more. */
export function gc(): void {
	const editors = listSessions(SESSIONS, "#{@swb_kind}", "#{@swb_dir}").filter(([, kind]) => kind === "editor");
	if (editors.length === 0) return;
	const db = openStore();
	const used = new Set(
		db
			.all(
				`SELECT s.cwd FROM sessions s LEFT JOIN marks m USING (session_id)
				 WHERE m.archived_at IS NULL OR m.archived_at < s.last_prompt_at
				 UNION SELECT cwd FROM runtimes WHERE session_id NOT IN (SELECT session_id FROM sessions)`,
			)
			.map((row) => row.cwd as string),
	);
	for (const [name, , dir] of editors) {
		if (!used.has(dir as string)) tmuxTry(SESSIONS, "kill-session", "-t", `=${name}`);
	}
}
