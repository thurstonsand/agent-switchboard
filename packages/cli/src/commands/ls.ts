import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { deriveSessions, displayName, projectName, type SessionState, sessionRows, world } from "../derive.ts";
import { openStore } from "../store.ts";

export const LS_HELP = `swb ls [--json]

Lists every Session, open and archived, with its derived state.

--json prints an array of objects with these fields:
  id           pi session id
  harness      "pi", "claude", or "codex"
  parentId     id of the session that started it, or null
  title        pi session name, or null
  project      project root: the parent of the git common dir, else the cwd
  cwd          current working directory
  branch       git branch (or short HEAD), or null outside git
  group        its Group, or null
  operator     its cwd is the Operator folder
  open         not archived
  live         its pi process is running in this boot
  activity     "working", "blocked", or "idle" (always "idle" when not live)
  unseen       open, not snoozed, and its agent finished a turn, or its snooze ran out, after my last Visit
  cutOff       how its process ended mid-turn, when not live: "shutdown" (its harness quit), "killed" (it died without quitting), or "restart" (an earlier boot); else null
  errored      its last turn ended on its provider's error, and none has started since
  inactive     open, not an Operator, not snoozed, and its whole Family has had no activity within inactive_after, none of it blocked or unseen
  snoozed      open and snoozed, neither blocked, cut off, nor errored
  snoozedUntil epoch ms a snoozed session's snooze ends, or null when it waits for a message
  reload       "continue" or "idle" while a reload waits for its turn to end, or for its restart; else null
  createdAt    epoch ms of its first prompt
  activityAt   epoch ms of the last prompt or settle
  visitedAt    epoch ms of my last Visit, or null
  archivedAt   epoch ms it was archived, or null when open`;

function glyph(s: SessionState): string {
	if (s.activity === "blocked") return "◆";
	if (s.activity === "working") return "◐";
	if (s.cutOff || s.errored) return "⚠";
	if (s.unseen) return "●";
	return "○";
}

export function ls(args: string[]): void {
	const { values } = parseArgs({ args, options: { json: { type: "boolean", default: false } } });
	const config = loadConfig();
	const db = openStore();
	const w = world(config.inactiveAfterMs);
	const states = deriveSessions(sessionRows(db), w).sort((a, b) => b.activityAt - a.activityAt);
	if (values.json) {
		console.log(JSON.stringify(states, null, 2));
		return;
	}
	for (const s of states) {
		const where = s.open ? (s.snoozed ? "snoozed" : s.inactive ? "inactive" : "open") : "archived";
		console.log([glyph(s), s.id, where, projectName(s.project), displayName(s)].join("\t"));
	}
}
