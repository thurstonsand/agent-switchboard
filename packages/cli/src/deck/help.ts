import { decodeKittyPrintable, matchesKey, StdinBuffer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { loadConfig } from "../config.ts";
import { blockedMark, blue, bold, cyan, dim, green, keyName, red } from "./style.ts";

const CLOSES = "any key or click closes";

/** The popup's lines, the hint under them aside: a blank line, then a key and what it does on each. */
function lines(prefix: string, columns = Infinity): string[] {
	prefix = keyName(prefix);
	const row = (k: string, label: string) => `  ${bold(k.padEnd(17))} ${label}`;
	const left = [
		bold("  Move"),
		row("j k ↑ ↓", "Move"),
		row("g G", "First / last"),
		row("⏎", "Focus session; wake if dormant"),
		row("l →", "Focus session / expand"),
		row("h ←", "Fold family / collapse header"),
		row("space", "Toggle header or family fold"),
		"",
		bold("  Find & relationships"),
		row("p", "Session that started this one"),
		row("[ ]", "Back / forward through Visits"),
		row("/", "Filter; esc clears"),
		row("hover", "Peek; its actions use these keys"),
		row("drag", "Move into Group / onto Project"),
		"",
		bold("  Session lifecycle"),
		row("w / x", "Wake / stop; session stays open"),
		row("R", "Reload agent on fresh config"),
		row("n / N", "New in known / added directory"),
		row("⇥", "Choose preset in directory picker"),
		row("a", "Archive family or session / unarchive"),
		"",
		bold("  Organize"),
		row("s", "Snooze / unsnooze"),
		row("u", "Mark / unmark Unseen"),
		row("m", "Pick or rename Group"),
		"",
		bold("  Copy & settings"),
		row("y / Y", "Copy swb open <id> / @session:<id>"),
		row(",", "Settings"),
		row("q", "Close Deck; sessions keep running"),
	];
	const right = [
		bold("  State marks"),
		"  ○ idle                 ◌ dormant (not running)",
		`  ${cyan("◐")} working              ${green("●")} Unseen (finished since Visit)`,
		`  ${blockedMark("◆")} blocked              ${bold(red("!"))} cut off · resume unfinished turn`,
		`  ✓ archived             ${bold(red("×"))} errored · inspect and retry`,
		`  ${dim("⎇")} worktree`,
		`  ${blue("⌁")} started by Operator  ↳ started by session`,
		"  +N folded family       ◷ once / ↻ recurring schedule",
		"",
		bold("  Views"),
		row(`${prefix} e`, "Swap agent / editor"),
		row(`${prefix} v`, "Split editor beside agent"),
		row(`${prefix} s`, "Shell beside / below / instead; ctrl-d closes"),
		row(`${prefix} z`, "Hide / show roster; click ◂ to show"),
		"",
		bold("  From any pane · navigate"),
		`  ${prefix}, then key · hold to reveal pane keys`,
		row("Ctrl+h j k l", "Move through panes and nvim windows"),
		row(`${prefix} h j k l`, "Focus the pane bearing that key"),
		row(`${prefix} J K`, "Next / previous session; j k in roster"),
		row(`${prefix} Tab`, "Roster / pane you left"),
		"",
		bold("  From any pane · session actions"),
		row(`${prefix} S`, "Snooze / unsnooze"),
		row(`${prefix} <key>`, "n N w x R a p u [ ] y Y / m , as in roster"),
		row(`${prefix} d`, "Remove highlighted directory in picker"),
		row(`${prefix} q / ?`, "Close Deck / help"),
		row(`${prefix} ${prefix}`, `Send literal ${prefix}`),
	];
	const width = Math.max(...left.map(visibleWidth)) + 4;
	if (width + Math.max(...right.map(visibleWidth)) > columns) return ["", ...left, "", ...right];
	return ["", ...left.map((line, i) => `${line}${" ".repeat(width - visibleWidth(line))}${right[i] ?? ""}`)];
}

/** The popup that shows every line, its border and the hint below included, with room to its right. */
export function helpSize(prefix: string): { width: number; height: number } {
	const all = lines(prefix);
	return { width: Math.max(...all.map(visibleWidth)) + 4, height: all.length + 4 };
}

/** `?`'s popup. Shorter than its lines, it scrolls by j k ↑ ↓, a page by space and PgUp PgDn, and by the wheel. */
export async function help(): Promise<void> {
	const prefix = loadConfig().prefix;
	let all = lines(prefix, process.stdout.columns);
	let top = 0;
	const room = () => Math.max(1, process.stdout.rows - 2);
	const overflow = () => Math.max(0, all.length - room());
	const draw = () => {
		all = lines(prefix, process.stdout.columns);
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
