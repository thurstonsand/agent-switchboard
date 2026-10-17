import { UsageError } from "../errors.ts";

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
export type Theme = keyof typeof THEMES;

export function theme(name: string | undefined): Theme {
	if (name !== "light" && name !== "dark") throw new UsageError(`drive: theme must be light or dark, got ${name}`);
	return name;
}

export function themeCommands(name: Theme): [string, string, string, string][] {
	const t = THEMES[name];
	// The background change sends the light/dark report, so the palette must already be in place, as in a real terminal.
	return [
		...t.palette.map((color, i): [string, string, string, string] => ["set", "-g", `pane-colours[${i}]`, color]),
		["set", "-g", "window-style", `bg=${t.bg},fg=${t.fg}`],
		["set", "-g", "window-active-style", `bg=${t.bg},fg=${t.fg}`],
	];
}

export const HARNESS_CONF = [
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
