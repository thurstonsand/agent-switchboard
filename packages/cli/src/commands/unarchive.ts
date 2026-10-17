import { parseArgs } from "node:util";
import { update } from "../coordinate.ts";
import { UsageError } from "../errors.ts";
import { unarchive as unarchiveSession } from "../sessions.ts";
import { openStore } from "../store.ts";

export function unarchive(args: string[]): void {
	const { values, positionals } = parseArgs({ args, options: { from: { type: "string" } }, allowPositionals: true });
	const id = positionals[0];
	if (!id) throw new UsageError("unarchive: a session id is required");
	if (values.from) console.log(JSON.stringify(update(openStore(), values.from, id, { archived: false })));
	else unarchiveSession(openStore(), id);
}
