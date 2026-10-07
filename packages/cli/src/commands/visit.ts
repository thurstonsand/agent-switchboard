import { parseArgs } from "node:util";
import { UsageError } from "../errors.ts";
import { markVisited, openStore } from "../store.ts";
import { listPanes, SESSIONS, tmuxTry, UI } from "../tmux.ts";

/** A plain `tmux attach` viewer gained or lost terminal focus: that is a Visit. Deck Stage clients visit through the Deck's dwell instead. */
export function visit(args: string[]): void {
	const { values } = parseArgs({ args, options: { client: { type: "string" }, in: { type: "boolean" }, out: { type: "boolean" } } });
	const client = values.client;
	if (!client) throw new UsageError("visit: --client is required");
	if (listPanes(UI, "#{pane_tty}").some(([tty]) => tty === client)) return;
	const host = tmuxTry(SESSIONS, "display", "-p", "-c", client, "#{client_session}");
	if (!host.ok) return;
	const db = openStore();
	db.tx(() => {
		const runtime = db.get("SELECT session_id FROM runtimes r JOIN sessions s USING (session_id) WHERE r.tmux_session = ?", host.out);
		if (runtime) markVisited(db, runtime.session_id as string);
	});
}
