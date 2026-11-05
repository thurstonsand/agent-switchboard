import { isArchived } from "@swb/shared/record";
import { SwbError, UsageError } from "../errors.ts";
import { wake as start } from "../sessions.ts";
import { openStore } from "../store.ts";

/** pi-sessions' swb host: starts a dormant session's pi in the background, unless one already hosts it. */
export function wake(args: string[]): void {
	const id = args[0];
	if (!id) throw new UsageError("wake: a session id is required");
	const db = openStore();
	if (isArchived(db, id)) throw new SwbError(`wake: ${id} is archived; swb unarchive ${id}`);
	// pi-sessions wakes a session to deliver it a message, which is its next turn.
	console.log(start(db, id, "idle"));
}
