import { UsageError } from "../errors.ts";

// The harness stands in for a real terminal: Gruvbox Light Hard / Dark Hard as light and dark, or a named theme for seeing
// the Deck the way other terminals paint it. A detached tmux pane answers no color queries; with these styles its server
// answers OSC 10/11 from window-style and OSC 4 from pane-colours, as Ghostty would.
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
	"city-ruins": {
		fg: "#cacccc",
		bg: "#101315",
		palette: [
			"#101315",
			"#de6145",
			"#5abb88",
			"#E5A72A",
			"#9cc4dd",
			"#aeaeae",
			"#707070",
			"#cacccc",
			"#4b4e55",
			"#de6145",
			"#5abb88",
			"#c9c2b4",
			"#9cc4dd",
			"#9a9a9a",
			"#707070",
			"#a5aeb4",
		],
	},
	"copied-city": {
		fg: "#252727",
		bg: "#ecf1f4",
		palette: [
			"#ecf1f4",
			"#a52b0c",
			"#077045",
			"#8c5a00",
			"#275b7a",
			"#3f3f3f",
			"#7a7a7a",
			"#252727",
			"#9da0a8",
			"#a52b0c",
			"#077045",
			"#322d22",
			"#275b7a",
			"#515151",
			"#7a7a7a",
			"#3a4147",
		],
	},
	"catppuccin-mocha": {
		fg: "#cdd6f4",
		bg: "#1e1e2e",
		palette: [
			"#45475a",
			"#f38ba8",
			"#a6e3a1",
			"#f9e2af",
			"#89b4fa",
			"#f5c2e7",
			"#94e2d5",
			"#bac2de",
			"#585b70",
			"#f38ba8",
			"#a6e3a1",
			"#f9e2af",
			"#89b4fa",
			"#f5c2e7",
			"#94e2d5",
			"#a6adc8",
		],
	},
	"tokyo-night": {
		fg: "#c0caf5",
		bg: "#1a1b26",
		palette: [
			"#15161e",
			"#f7768e",
			"#9ece6a",
			"#e0af68",
			"#7aa2f7",
			"#bb9af7",
			"#7dcfff",
			"#a9b1d6",
			"#414868",
			"#f7768e",
			"#9ece6a",
			"#e0af68",
			"#7aa2f7",
			"#bb9af7",
			"#7dcfff",
			"#c0caf5",
		],
	},
	"solarized-light": {
		fg: "#657b83",
		bg: "#fdf6e3",
		palette: [
			"#073642",
			"#dc322f",
			"#859900",
			"#b58900",
			"#268bd2",
			"#d33682",
			"#2aa198",
			"#eee8d5",
			"#002b36",
			"#cb4b16",
			"#586e75",
			"#657b83",
			"#839496",
			"#6c71c4",
			"#93a1a1",
			"#fdf6e3",
		],
	},
};
export type Theme = keyof typeof THEMES;

export function theme(name: string | undefined): Theme {
	if (name === undefined || !(name in THEMES))
		throw new UsageError(`drive: theme must be one of ${Object.keys(THEMES).join(", ")}, got ${name}`);
	return name as Theme;
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
