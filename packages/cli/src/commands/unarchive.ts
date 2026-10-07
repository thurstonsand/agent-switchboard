import { UsageError } from "../errors.ts";
import { unarchive as unarchiveSession } from "../sessions.ts";
import { openStore } from "../store.ts";

export function unarchive(args: string[]): void {
	const id = args[0];
	if (!id) throw new UsageError("unarchive: a session id is required");
	unarchiveSession(openStore(), id);
}
