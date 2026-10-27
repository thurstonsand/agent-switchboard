import { parseArgs } from "node:util";
import { reload as reloadSession } from "../coordinate.ts";
import { UsageError } from "../errors.ts";
import { openStore } from "../store.ts";

/** Restarts a session's harness on fresh configuration: at once to carry on, or with --idle once its turn ends. */
export function reload(args: string[]): void {
	const { values, positionals } = parseArgs({ args, options: { idle: { type: "boolean", default: false } }, allowPositionals: true });
	const id = positionals[0];
	if (!id || positionals.length > 1) throw new UsageError("reload: a session id is required");
	console.log(reloadSession(openStore(), null, id, values.idle ? "idle" : "continue"));
}
