import type { Db, Harness } from "@swb/shared";
import { harnessName } from "@swb/shared/mailbox";
import { titleOf } from "@swb/shared/record";
import type { ToolResult } from "@swb/shared/tools";
import { locateTranscript, readTranscript } from "./deck/transcript.ts";
import { SwbError } from "./errors.ts";

// What session_ask's reader reads, the same in every harness: a session's conversation from its own transcript.

/** recall_read: every prompt and reply in the session's transcript, oldest first, and where its last turn stopped. */
export function recallRead(db: Db, id: string): ToolResult {
	const row = db.get("SELECT harness, cwd, transcript FROM sessions WHERE session_id = ?", id);
	if (!row) throw new SwbError(`no session ${id}`);
	const harness = row.harness as Harness;
	const { turns, tail, ending } = readTranscript(locateTranscript(row.transcript as string, harness), harness);
	const lines = [
		`Session "${titleOf(db, id) ?? id}" (session: ${id}, ${harnessName(harness)}, in ${row.cwd as string}):`,
		...turns.map((turn) => `\n[${turn.who === "you" ? "user" : "agent"}]\n${turn.text}`),
		...(tail.length > 0 ? ["\n[tool calls after the last reply]", ...tail] : []),
		...(ending ? [`\n[the last turn ${ending.kind === "stopped" ? "was stopped" : `failed: ${ending.message}`}]`] : []),
	];
	return { text: lines.join("\n"), details: { id, harness, turns: turns.length } };
}
