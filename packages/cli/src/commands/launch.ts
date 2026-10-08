import { existsSync, realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { SwbError, UsageError } from "../errors.ts";
import { launch as start } from "../sessions.ts";

/** pi-sessions' swb host: starts a handoff child managed, in the background. */
export function launch(args: string[]): void {
	const { values } = parseArgs({
		args,
		options: { cwd: { type: "string" }, "session-id": { type: "string" }, model: { type: "string" } },
	});
	const id = values["session-id"];
	if (!values.cwd || !id || !values.model) throw new UsageError("launch: --cwd, --session-id, and --model are required");
	if (!existsSync(values.cwd)) throw new SwbError(`launch: no directory ${values.cwd}`);
	console.log(start(realpathSync(values.cwd), id, ["--approve", "--model", values.model]));
}
