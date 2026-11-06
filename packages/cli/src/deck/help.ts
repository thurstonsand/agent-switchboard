import { decodeKittyPrintable, matchesKey, StdinBuffer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { loadConfig } from "../config.ts";
import { bold, dim } from "./style.ts";

function keys(prefix: string): [string, string][] {
	return [
		["j k ↑ ↓", "move"],
		["g G", "first, last"],
		["⏎", "focus the session (wakes it)"],
		["l →", "focus the session; expand a header or a fold"],
		["h ←", "fold what a session started; collapse a header"],
		["space", "toggle a header or a fold"],
		["w", "wake without focusing"],
		["x", "stop a running session; it stays open"],
		["R", "reload: restart its agent on fresh config, and carry on"],
		["n", "new session: pick a directory, and with ⇥ a preset"],
		["N", "new session in a directory to add"],
		["a", "archive, asking about what it started; unarchive"],
		["p", "the session that started this one"],
		["[ ]", "back, forward through the sessions I visited"],
		["s", "snooze into Snoozed for a while, or until a message; unsnooze"],
		["u", "mark Unseen until I leave it and come back; unmark"],
		["y Y", "copy swb open <id>; @session:<id>"],
		["m", "pick the session's Group; rename a Group"],
		[",", "settings"],
		["hover", "a session's Peek beside it; its buttons are these keys"],
		["drag", "into a Group, or out onto its Project"],
		["/", "filter; esc clears"],
		["q", "leave the Deck, as it is, for the next swb"],
		["", ""],
		["C-h j k l", "move between panes, through nvim's windows"],
		[`${prefix} h j k l`, `the pane whose label shows that key while ${prefix} is down`],
		[`${prefix} J K`, "the next or previous session; j k too, in the sidebar"],
		[`${prefix} Tab`, "the sidebar, or back to the pane you left"],
		[`${prefix} e`, "swap the agent and the editor"],
		[`${prefix} v`, "split the editor beside the agent"],
		[`${prefix} s`, "a shell beside, below, or in place of the agent; ctrl-d closes it"],
		[`${prefix} z`, "hide or show the sidebar; click ◂ to show it"],
		[`${prefix} S`, "snooze or unsnooze, as s in the sidebar"],
		[`${prefix} <key>`, "n N w x R a p u [ ] y Y / m , as in the sidebar"],
		[`${prefix} d`, "in the directory picker, remove the highlighted one"],
		[`${prefix} q`, "leave the Deck from anywhere"],
		[`${prefix} ?`, "these keys"],
		[`${prefix} ${prefix}`, `a literal ${prefix}`],
	];
}

const CLOSES = "any key or click closes";

/** The popup's lines, the hint under them aside: a blank line, then a key and what it does on each. */
function lines(prefix: string): string[] {
	return ["", ...keys(prefix).map(([k, label]) => (k === "" ? "" : `  ${bold(k.padEnd(12))} ${label}`))];
}

/** The popup that shows every line, its border and the hint below included, with room to its right. */
export function helpSize(prefix: string): { width: number; height: number } {
	const all = lines(prefix);
	return { width: Math.max(...all.map(visibleWidth)) + 4, height: all.length + 4 };
}

/** `?`'s popup. Shorter than its lines, it scrolls by j k ↑ ↓, a page by space and PgUp PgDn, and by the wheel. */
export async function help(): Promise<void> {
	const all = lines(loadConfig().prefix);
	let top = 0;
	const room = () => Math.max(1, process.stdout.rows - 2);
	const overflow = () => Math.max(0, all.length - room());
	const draw = () => {
		top = Math.max(0, Math.min(overflow(), top));
		const below = all.length - top - room();
		const more = [top > 0 ? `↑ ${top}` : "", below > 0 ? `↓ ${below}` : ""].filter(Boolean).join(" ");
		const hint = overflow() === 0 ? CLOSES : `${more} · j k, wheel scroll · any other key or click closes`;
		const shown = [...all.slice(top, top + room()), "", `  ${dim(hint)}`];
		process.stdout.write(`\x1b[H\x1b[2J${shown.map((line) => truncateToWidth(line, process.stdout.columns, "")).join("\r\n")}`);
	};
	// Mouse reporting on, so a click and the wheel reach stdin like keys.
	process.stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h");
	process.stdin.setRawMode(true);
	process.stdout.on("resize", draw);
	draw();
	// One key or mouse report at a time: a wheel's turns can arrive together.
	const input = new StdinBuffer();
	process.stdin.on("data", (data: Buffer) => input.process(data));
	await new Promise<void>((resolve) =>
		input.on("data", (data) => {
			const step = overflow() === 0 ? null : scroll(data, room());
			if (step === null) resolve();
			else {
				top += step;
				draw();
			}
		}),
	);
	process.exit(0);
}

/** How far a key or a wheel's turn moves the lines, or null for anything else, which closes the popup. */
function scroll(data: string, page: number): number | null {
	if (data.startsWith("\x1b[<")) {
		const button = data.slice(3).split(";")[0];
		return button === "64" ? -1 : button === "65" ? 1 : null;
	}
	const k = decodeKittyPrintable(data) ?? data;
	if (k === "j" || matchesKey(data, "down")) return 1;
	if (k === "k" || matchesKey(data, "up")) return -1;
	if (k === " " || matchesKey(data, "pageDown")) return page;
	if (matchesKey(data, "pageUp")) return -page;
	return null;
}
