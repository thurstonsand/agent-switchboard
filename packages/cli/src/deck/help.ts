import { decodeKittyPrintable, matchesKey, StdinBuffer, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { loadConfig } from "../config.ts";
import { blockedMark, blue, bold, cyan, dim, gray, green, keyName, red } from "./style.ts";

const CLOSES = "any key or click closes";

/** The popup's lines, the hint under them aside: a blank line, then a key and what it does on each. */
function lines(prefix: string, columns = Infinity): string[] {
	prefix = keyName(prefix);
	const row = (k: string, label: string) => {
		const lead = `  ${bold(k.padEnd(17))} `;
		const indent = visibleWidth(lead);
		return wrapTextWithAnsi(label, Math.max(1, columns - indent))
			.map((line, i) => `${i === 0 ? lead : " ".repeat(indent)}${line}`)
			.join("\n");
	};
	const start = [
		bold("  Start here · in the roster"),
		row("j k ↑ ↓", "Move"),
		row("enter", "Focus session; wake if dormant"),
		row(`${prefix} Tab`, "Return to roster from any pane; again goes back"),
		row("q", "Leave the Deck as it is for the next swb"),
		row("esc", "Close help"),
	];
	const move = [
		bold("  In the roster · Move"),
		row("g G", "First / last"),
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
		row("w / x", "Wake in background / shut down"),
		row("R", "Reload agent on fresh config"),
		row("n / N", "New in known / added directory"),
		row("Tab", "Choose preset in directory picker"),
		row("a", "Archive family or session / unarchive"),
	];
	const organize = [bold("  Organize"), row("s", "Snooze / unsnooze"), row("u", "Mark / unmark Unseen"), row("m", "Pick or rename Group")];
	const settings = [bold("  Copy & settings"), row("y / Y", "Copy swb open <id> / @session:<id>"), row(",", "Settings")];
	const left = [...start, "", ...move, "", ...relationships, "", ...lifecycle, "", ...organize, "", ...settings].flatMap((s) => s.split("\n"));
	const states = [
		bold("  State marks"),
		`  ${blockedMark("◆")} blocked · waiting for you`,
		`  ${bold(red("!"))} cut off · resume unfinished turn`,
		`  ${bold(red("×"))} errored · inspect error`,
		`  ${green("●")} Unseen · finished since last viewed`,
		`  ${bold(cyan("◐"))} working`,
		"  ○ idle · running",
		"  – dormant · not running",
		"  ✓ archived",
		dim("  Stopped · turn ended early on purpose"),
		dim("  Snoozed · until its time or next message"),
		"",
		bold("  Relationships & schedules"),
		`  ${dim("⎇")}  worktree`,
		`  ${blue("↳")}  started by Operator or session; Peek names who`,
		"  +N folded family       ◷ once / ↻ recurring schedule",
	];
	const right = [
		bold("  From any pane · Views"),
		`  ${prefix}, then key · hold to reveal pane keys`,
		row(`${prefix} e`, "Swap agent / editor"),
		row(`${prefix} v`, "Split editor beside agent"),
		row(`${prefix} s`, "Shell beside / below / instead; ctrl-d closes"),
		row(`${prefix} z`, "Hide / show roster; click ◂ to show"),
		"",
		bold("  From any pane · navigate"),
		row("Ctrl+h j k l", "Move through panes and nvim windows"),
		row(`${prefix} h j k l`, "Focus the pane bearing that key"),
		row(`${prefix} J K`, "Next / previous session; j k in roster"),
		"",
		bold("  From any pane · session actions"),
		row(`${prefix} + roster key`, "Run its action; S snoozes, s opens shell"),
		row(`${prefix} d`, "Remove highlighted directory in picker"),
		row(`${prefix} q / ?`, "Leave Deck from anywhere / help"),
		row(`${prefix} ${prefix}`, `Send literal ${prefix}`),
		"",
		...states,
	].flatMap((s) => s.split("\n"));
	const width = Math.max(...left.map(visibleWidth)) + 4;
	if (width + Math.max(...right.map(visibleWidth)) > columns)
		return ["", ...left, "", ...right].flatMap((line) => wrapTextWithAnsi(line, columns));
	return [
		"",
		...Array.from(
			{ length: Math.max(left.length, right.length) },
			(_, i) => `${left[i] ?? ""}${" ".repeat(width - visibleWidth(left[i] ?? ""))}${right[i] ?? ""}`,
		),
	];
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
		const hint =
			overflow() === 0
				? CLOSES
				: width < 80
					? `${more.replace(" lines", "")} · j/k scroll · PgDn page · Esc close`
					: `${more} · j/k ↑/↓ scroll · PgUp/PgDn page · Esc closes`;
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
