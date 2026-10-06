import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { derive, displayName, projectName, type SessionState, sessionRows, world } from "../derive.ts";
import { openStore } from "../store.ts";

export const LS_HELP = `swb ls [--json]

Lists every Session, open and archived, with its derived state.

--json prints an array of objects with these fields:
  id           pi session id
  title        pi session name, or null
  project      project root: the parent of the git common dir, else the cwd
  cwd          current working directory
  branch       git branch (or short HEAD), or null outside git
  open         not archived
  live         its pi process is running in this boot
  activity     "working", "blocked", or "idle" (always "idle" when not live)
  unseen       open, and its agent finished a turn after my last Visit
  interrupted  not live, and its process ended mid-turn
  inactive     open, no activity within inactive_after, neither blocked nor unseen
  activityAt   epoch ms of the last prompt or settle
  archivedAt   epoch ms it was archived, or null when open`;

function glyph(s: SessionState): string {
	if (s.activity === "blocked") return "◆";
	if (s.activity === "working") return "◐";
	if (s.interrupted) return "⚠";
	if (s.unseen) return "●";
	return "○";
}

export function ls(args: string[]): void {
	const { values } = parseArgs({ args, options: { json: { type: "boolean", default: false } } });
	const config = loadConfig();
	const db = openStore();
	const w = world(config.inactiveAfterMs);
	const states = sessionRows(db)
		.map((row) => derive(row, w))
		.sort((a, b) => b.activityAt - a.activityAt);
	if (values.json) {
		console.log(JSON.stringify(states, null, 2));
		return;
	}
	for (const s of states) {
		const where = s.open ? (s.inactive ? "inactive" : "open") : "archived";
		console.log([glyph(s), s.id, where, projectName(s.project), displayName(s)].join("\t"));
	}
}
