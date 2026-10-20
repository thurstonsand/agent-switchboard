import { parseArgs } from "node:util";
import { update } from "../coordinate.ts";
import { UsageError } from "../errors.ts";
import { archive as archiveSession } from "../sessions.ts";
import { openStore } from "../store.ts";

/** From a line (--from), it prints the tool result, and a session may archive itself mid-turn. */
export async function archive(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({ args, options: { from: { type: "string" } }, allowPositionals: true });
	const id = positionals[0];
	if (!id) throw new UsageError("archive: a session id is required");
	if (values.from) console.log(JSON.stringify(await update(openStore(), values.from, id, { archived: true })));
	else archiveSession(openStore(), [id]);
}
