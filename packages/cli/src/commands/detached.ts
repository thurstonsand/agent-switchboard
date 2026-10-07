import { parseArgs } from "node:util";
import { UsageError } from "../errors.ts";
import { openStore } from "../store.ts";
import { SESSIONS, tmuxTry } from "../tmux.ts";

/** The last viewer left a pi that was never prompted: nothing would ever find it again, so it goes. */
export function detached(args: string[]): void {
	const { values } = parseArgs({ args, options: { session: { type: "string" } } });
	const name = values.session;
	if (!name) throw new UsageError("detached: --session is required");
	const info = tmuxTry(SESSIONS, "display", "-p", "-t", `=${name}:`, "#{@swb_kind}\t#{?session_attached,1,0}\t#{@swb_launch_id}");
	if (!info.ok) return;
	const [kind, attached, launchId] = info.out.split("\t");
	if (kind !== "pi" || attached !== "0") return;
	const db = openStore();
	const runtime = db.get(
		"SELECT r.session_id, s.session_id AS recorded FROM runtimes r LEFT JOIN sessions s USING (session_id) WHERE r.tmux_session = ?",
		name,
	);
	const provisional = runtime ? runtime.recorded === null : !launchId;
	if (provisional) tmuxTry(SESSIONS, "kill-session", "-t", `=${name}`);
}
