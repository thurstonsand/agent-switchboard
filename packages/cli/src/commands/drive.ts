import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { stateDir } from "@swb/shared";
import { SwbError, UsageError } from "../errors.ts";
import { SWB } from "../sessions.ts";
import { DRIVE, quote, tmux, tmuxTry } from "../tmux.ts";

// The harness stands in for a real terminal with Gruvbox Light Hard / Dark Hard. A detached tmux pane answers no color
// queries; with these styles its server answers OSC 10/11 from window-style and OSC 4 from pane-colours, as Ghostty would.
const THEMES = {
	light: {
		fg: "#3c3836",
		bg: "#f9f5d7",
		palette: [
			"#f9f5d7",
			"#cc241d",
			"#98971a",
			"#d79921",
			"#458588",
			"#b16286",
			"#689d6a",
			"#7c6f64",
			"#928374",
			"#9d0006",
			"#79740e",
			"#b57614",
			"#076678",
			"#8f3f71",
			"#427b58",
			"#3c3836",
		],
	},
	dark: {
		fg: "#ebdbb2",
		bg: "#1d2021",
		palette: [
			"#1d2021",
			"#cc241d",
			"#98971a",
			"#d79921",
			"#458588",
			"#b16286",
			"#689d6a",
			"#a89984",
			"#928374",
			"#fb4934",
			"#b8bb26",
			"#fabd2f",
			"#83a598",
			"#d3869b",
			"#8ec07c",
			"#ebdbb2",
		],
	},
};
type Theme = keyof typeof THEMES;

function theme(name: string | undefined): Theme {
	if (name !== "light" && name !== "dark") throw new UsageError(`drive: theme must be light or dark, got ${name}`);
	return name;
}

function themeCommands(name: Theme): [string, string, string, string][] {
	const t = THEMES[name];
	return [
		["set", "-g", "window-style", `bg=${t.bg},fg=${t.fg}`],
		["set", "-g", "window-active-style", `bg=${t.bg},fg=${t.fg}`],
		...t.palette.map((color, i): [string, string, string, string] => ["set", "-g", `pane-colours[${i}]`, color]),
	];
}

const HARNESS_CONF = [
	"set -g default-terminal tmux-256color",
	"set -s set-clipboard on",
	"set -g status off",
	"set -s escape-time 0",
	"set -s extended-keys always",
	"set -s extended-keys-format csi-u",
	"set -s focus-events on",
	"set -g remain-on-exit on",
	"set -g history-limit 0",
];

const PANE = "=drive:";

function harness(...args: string[]): string {
	return tmux(DRIVE, ...args);
}

// SGR mouse reports, 1-based, exactly as a terminal sends them.
function sgr(button: number, col: number, row: number, release = false): string {
	return `\x1b[<${button};${col + 1};${row + 1}${release ? "m" : "M"}`;
}

async function raw(...sequences: string[]): Promise<void> {
	for (const sequence of sequences) {
		// As hex bytes: sent as keys, the ESC could be re-encoded under the harness's extended-keys mode.
		harness("send-keys", "-t", PANE, "-H", ...[...Buffer.from(sequence)].map((b) => b.toString(16).padStart(2, "0")));
		await Bun.sleep(40);
	}
}

export async function drive(args: string[]): Promise<void> {
	const [verb, ...rest] = args;
	switch (verb) {
		case "start": {
			const split = rest.indexOf("--");
			const own = split === -1 ? rest : rest.slice(0, split);
			const swbArgs = split === -1 ? [] : rest.slice(split + 1);
			const { values } = parseArgs({
				args: own,
				options: { size: { type: "string", default: "140x40" }, theme: { type: "string", default: "light" } },
			});
			const match = /^(\d+)x(\d+)$/.exec(values.size);
			if (!match) throw new UsageError(`drive: --size must be COLSxROWS, got ${values.size}`);
			tmuxTry(DRIVE, "kill-server");
			const dir = join(stateDir(), "drive");
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const conf = join(dir, `${DRIVE}.conf`);
			const themeLines = themeCommands(theme(values.theme)).map(([set, flag, option, value]) => `${set} ${flag} ${option} ${quote(value)}`);
			writeFileSync(conf, [...HARNESS_CONF, ...themeLines, ""].join("\n"));
			const command = [SWB, ...swbArgs].map(quote).join(" ");
			harness("-f", conf, "new-session", "-d", "-s", "drive", "-x", match[1] as string, "-y", match[2] as string, command);
			break;
		}
		case "keys": {
			// In order, as typed: `-l TEXT` is literal text, anything else a tmux key name.
			let delay = 30;
			for (let i = 0; i < rest.length; i++) {
				const arg = rest[i] as string;
				if (arg === "--delay") delay = Number(rest[++i]);
				else if (arg === "-l") harness("send-keys", "-t", PANE, "-l", rest[++i] as string);
				else harness("send-keys", "-t", PANE, arg);
				await Bun.sleep(delay);
			}
			break;
		}
		case "capture":
			process.stdout.write(`${harness("capture-pane", "-p", ...(rest.includes("--ansi") ? ["-e"] : []), "-t", PANE)}\n`);
			break;
		case "theme":
			for (const command of themeCommands(theme(rest[0]))) harness(...command);
			break;
		case "focus":
			await raw(rest[0] === "out" ? "\x1b[O" : "\x1b[I");
			break;
		case "click": {
			const [col, row] = rest.map(Number) as [number, number];
			await raw(sgr(0, col, row), sgr(0, col, row, true));
			break;
		}
		case "drag": {
			const [c1, r1, c2, r2] = rest.map(Number) as [number, number, number, number];
			const steps = [1, 2, 3, 4].map((i) => sgr(32, Math.round(c1 + ((c2 - c1) * i) / 4), Math.round(r1 + ((r2 - r1) * i) / 4)));
			await raw(sgr(0, c1, r1), ...steps, sgr(0, c2, r2, true));
			break;
		}
		case "resize": {
			const match = /^(\d+)x(\d+)$/.exec(rest[0] ?? "");
			if (!match) throw new UsageError(`drive: resize takes COLSxROWS, got ${rest[0]}`);
			harness("resize-window", "-t", PANE, "-x", match[1] as string, "-y", match[2] as string);
			break;
		}
		case "clipboard": {
			const buffer = tmuxTry(DRIVE, "show-buffer");
			if (!buffer.ok) throw new SwbError("drive: nothing copied yet");
			process.stdout.write(buffer.out);
			break;
		}
		case "stop":
			tmuxTry(DRIVE, "kill-server");
			break;
		default:
			throw new UsageError(`drive: unknown verb ${verb ?? "(none)"}`);
	}
}
