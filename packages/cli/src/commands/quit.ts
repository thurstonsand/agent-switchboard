import { parseArgs } from "node:util";
import { bootId } from "@swb/shared";
import { displayName, type RuntimeRow, runtimeLive, states } from "../derive.ts";
import { SwbError } from "../errors.ts";
import { stopPis } from "../sessions.ts";
import { openStore } from "../store.ts";
import { killServer, listSessions, SESSIONS, tmuxTry, UI } from "../tmux.ts";

/**
 * Stops everything swb runs: every harness, saving drafts as an upgrade does, then the Decks, the Editors, and the
 * clock. Sessions stay open and dormant, and schedules wait in the db for the next swb. A running turn refuses it
 * without --force, which interrupts it.
 */
export function quit(args: string[]): void {
	const { values } = parseArgs({ args, options: { force: { type: "boolean", default: false } } });
	const db = openStore();
	const working = states(db).filter((s) => s.live && s.activity !== "idle");
	if (working.length > 0 && !values.force)
		throw new SwbError(
			`turn running in ${working.map((s) => `"${displayName(s)}"`).join(", ")}: wait for it to complete, or swb quit --force`,
		);
	const hosts = new Set(listSessions(SESSIONS).map(([name]) => name as string));
	const live = (db.all("SELECT tmux_session, boot_id, pid FROM runtimes") as RuntimeRow[]).filter((r) => runtimeLive(r, bootId(), hosts));
	db.close();
	// The clock first, so it can't wake a session this is stopping.
	tmuxTry(SESSIONS, "kill-session", "-t", "=swb-ctl");
	stopPis(live);
	killServer(UI);
	killServer(SESSIONS);
	console.log(`Stopped ${live.length} session${live.length === 1 ? "" : "s"}, every Deck, and swb's clock. swb starts them again.`);
}
