import { decodeKittyPrintable, matchesKey, StdinBuffer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { loadConfig } from "../config.ts";
import { blockedMark, blue, bold, cyan, dim, gray, green, keyName, red } from "./style.ts";

const CLOSES = "any key or click closes";

/** The popup's lines, the hint under them aside: a blank line, then a key and what it does on each. */
function lines(prefix: string, columns = Infinity): string[] {
	prefix = keyName(prefix);
	const row = (k: string, label: string) => `  ${bold(k.padEnd(17))} ${label}`;
	const move = [
		bold("  Move"),
		row("j k ↑ ↓", "Move"),
		row("g G", "First / last"),
		row("Enter", "Focus session; wake if dormant"),
		row("l →", "Focus session / expand"),
		row("h ←", "Fold family / collapse header"),
		row("space", "Toggle header or family fold"),
	];
	const relationships = [
		bold("  Find & relationships"),
		row("p", "Session that started this one"),
		row("[ ]", "Back / forward through viewed sessions"),
		row("/", "Filter; esc clears"),
		row("hover", "Peek; its actions use these keys"),
		row("i", "Expand / collapse narrow details"),
		row("PgUp PgDn", "Scroll expanded details"),
		row("drag", "Move into Group / onto Project"),
	];
	const lifecycle = [
		bold("  Session lifecycle"),
		row("w / x", "Wake in background / stop"),
		row("R", "Reload agent on fresh config"),
		row("n / N", "New in known / added directory"),
		row("Tab", "Choose preset in directory picker"),
		row("a", "Archive family or session / unarchive"),
	];
	const organize = [bold("  Organize"), row("s", "Snooze / unsnooze"), row("u", "Mark / unmark Unseen"), row("m", "Pick or rename Group")];
	const settings = [
		bold("  Copy & settings"),
		row("y / Y", "Copy swb open <id> / @session:<id>"),
		row(",", "Settings"),
		row("q", "Close Deck; sessions keep running"),
	];
	const left = [...move, "", ...relationships, "", ...lifecycle, "", ...organize, "", ...settings];
	const states = [
		bold("  State marks"),
		"  ○ idle · running       – dormant · not running",
		`  ${bold(cyan("◐"))} working              ${green("●")} Unseen · finished since last viewed`,
		`  ${blockedMark("◆")} blocked              ${bold(red("!"))} cut off · resume unfinished turn`,
		`  ✓ archived             ${bold(red("×"))} errored · inspect and retry`,
		`  ${dim("⎇")}  worktree`,
		`  ${blue("⌁")}  started by Operator ↳ started by session`,
		"  +N folded family       ◷ once / ↻ recurring schedule",
		"  stopped: turn ended early on purpose; nothing to resume",
	];
	const right = [
		...states,
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
	if (width + Math.max(...right.map(visibleWidth)) > columns)
		return [
			"",
			...move,
			row("/", "Filter; esc clears"),
			row(`${prefix} Tab`, "Roster / pane you left"),
			"",
			...states,
			"",
			...lifecycle,
			"",
			...organize,
			"",
			...settings,
			"",
			...relationships.filter((line) => line !== row("/", "Filter; esc clears")),
			"",
			...right.slice(states.length + 1).filter((line) => line !== row(`${prefix} Tab`, "Roster / pane you left")),
		];
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
	let all = lines(prefix, process.stdout.columns - 2);
	let top = 0;
	const room = () => Math.max(1, process.stdout.rows - 4);
	const overflow = () => Math.max(0, all.length - room());
	const draw = () => {
		const width = process.stdout.columns;
		all = lines(prefix, width - 2);
		top = Math.max(0, Math.min(overflow(), top));
		const below = all.length - top - room();
		const more = [top > 0 ? `↑ ${top}` : "", below > 0 ? `↓ ${below} more lines` : ""].filter(Boolean).join(" ");
		const hint = overflow() === 0 ? CLOSES : `${more} · j/k ↑/↓ scroll · PgUp/PgDn page · Esc closes`;
		const shown = [...all.slice(top, top + room()), "", `  ${hint}`];
		const framed = [
			`${gray("╭─")} Keys ${gray("─".repeat(Math.max(0, width - 12)))} ✕ ${gray("╮")}`,
			...shown.map((line) => `${gray("│")}${truncateToWidth(line, width - 2, "", true)}${gray("│")}`),
			gray(`╰${"─".repeat(width - 2)}╯`),
		];
		process.stdout.write(`\x1b[H\x1b[2J${framed.join("\r\n")}`);
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
