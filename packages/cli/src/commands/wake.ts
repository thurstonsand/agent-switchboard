import { SwbError, UsageError } from "../errors.ts";
import { wake as start } from "../sessions.ts";
import { openStore } from "../store.ts";

/** pi-sessions' swb host: starts a dormant session's pi in the background, unless one already hosts it. */
export function wake(args: string[]): void {
	const id = args[0];
	if (!id) throw new UsageError("wake: a session id is required");
	const db = openStore();
	const archived = db.get(
		"SELECT 1 FROM sessions s JOIN marks m USING (session_id) WHERE s.session_id = ? AND m.archived_at >= s.last_prompt_at",
		id,
	);
	if (archived) throw new SwbError(`wake: ${id} is archived; swb unarchive ${id}`);
	console.log(start(db, id));
}
