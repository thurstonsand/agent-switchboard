import { openDeck } from "../deck/deck.ts";
import { SwbError, UsageError } from "../errors.ts";
import { openStore } from "../store.ts";

export async function open(args: string[]): Promise<void> {
	const id = args[0];
	if (!id) throw new UsageError("open: a session id is required");
	if (!openStore().get("SELECT 1 FROM sessions WHERE session_id = ?", id)) throw new SwbError(`open: no session ${id}`);
	await openDeck({ select: id, newCwd: null });
}
