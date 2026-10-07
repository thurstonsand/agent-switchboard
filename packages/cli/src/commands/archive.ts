import { UsageError } from "../errors.ts";
import { archive as archiveSession } from "../sessions.ts";
import { openStore } from "../store.ts";

export function archive(args: string[]): void {
	const id = args[0];
	if (!id) throw new UsageError("archive: a session id is required");
	archiveSession(openStore(), id);
}
