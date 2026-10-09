import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { stateDir } from "@swb/shared";
import { fetchState } from "../deck/deck.ts";
import { SwbError, UsageError } from "../errors.ts";
import { SWB } from "../sessions.ts";
import { cleanEnv, DRIVE, killServer, quote, tmux, tmuxBin, tmuxTry, UI } from "../tmux.ts";

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

const READY_MS = 15_000;

/** The Deck the drive pane's terminal is attached to: its client on the UI server shares the pane's tty. */
function drivenDeck(): string | null {
	const tty = harness("display", "-p", "-t", PANE, "#{pane_tty}");
	const clients = tmuxTry(UI, "list-clients", "-F", "#{client_tty}\t#{session_name}");
	if (!clients.ok) return null;
	const match = clients.out.split("\n").find((line) => line.split("\t")[0] === tty);
	return match ? (match.split("\t")[1] as string) : null;
}

function requireDeck(): string {
	const deck = drivenDeck();
	if (!deck) throw new SwbError(`drive: no Deck on the driven terminal\n${harness("capture-pane", "-p", "-t", PANE)}`);
	return deck;
}

async function waitReady(): Promise<void> {
	const deadline = Date.now() + READY_MS;
	while (Date.now() < deadline) {
		const deck = drivenDeck();
		if (deck) {
			const state = await fetchState(deck).catch(() => null);
			if (state?.ready === true) return;
		}
		await Bun.sleep(50);
	}
	throw new SwbError(`drive: the Deck wasn't ready within ${READY_MS / 1000} s\n${harness("capture-pane", "-p", "-t", PANE)}`);
}

function at(value: unknown, path: string): unknown {
	let current = value;
	for (const part of path.split(".")) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
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
			killServer(DRIVE);
			const dir = join(stateDir(), "drive");
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const conf = join(dir, `${DRIVE}.conf`);
			const themeLines = themeCommands(theme(values.theme)).map(([set, flag, option, value]) => `${set} ${flag} ${option} ${quote(value)}`);
			writeFileSync(conf, [...HARNESS_CONF, ...themeLines, ""].join("\n"));
			const command = [SWB, ...swbArgs].map(quote).join(" ");
			// From the caller's directory, so a mise tmux shim applies the env the caller already has instead of the one at /,
			// which would leave the caller's project env looking like a baseline the Deck's scrub can't remove.
			const started = Bun.spawnSync(
				[
					tmuxBin(),
					"-L",
					DRIVE,
					"-f",
					conf,
					"new-session",
					"-d",
					"-s",
					"drive",
					"-c",
					process.cwd(),
					"-x",
					match[1] as string,
					"-y",
					match[2] as string,
					command,
				],
				{ cwd: process.cwd(), env: cleanEnv(), stdout: "pipe", stderr: "pipe" },
			);
			if (started.exitCode !== 0) throw new SwbError(`starting tmux -L ${DRIVE}: ${started.stderr.toString().trim()}`);
			if (swbArgs.length === 0 || ["new", "open", "adopt"].includes(swbArgs[0] as string)) await waitReady();
			break;
		}
		case "state":
			console.log(JSON.stringify(await fetchState(requireDeck())));
			break;
		case "wait": {
			const { values, positionals } = parseArgs({
				args: rest,
				allowPositionals: true,
				options: { timeout: { type: "string", default: "15000" } },
			});
			const expectation = positionals[0] ?? "";
			const split = expectation.indexOf("=");
			if (split < 1) throw new UsageError(`drive: wait takes PATH=VALUE, got ${expectation}`);
			const path = expectation.slice(0, split);
			const want = expectation.slice(split + 1);
			const deadline = Date.now() + Number(values.timeout);
			let seen: unknown;
			while (Date.now() < deadline) {
				seen = at(await fetchState(requireDeck()), path);
				if (String(seen) === want) return;
				await Bun.sleep(50);
			}
			throw new SwbError(`drive: ${path} is ${JSON.stringify(seen)}, not ${want}, after ${values.timeout} ms`);
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
			// --hold leaves the button down, for a look mid-drag; `release` lets go.
			const [c1, r1, c2, r2] = rest.filter((arg) => arg !== "--hold").map(Number) as [number, number, number, number];
			const steps = [1, 2, 3, 4].map((i) => sgr(32, Math.round(c1 + ((c2 - c1) * i) / 4), Math.round(r1 + ((r2 - r1) * i) / 4)));
			await raw(sgr(0, c1, r1), ...steps, ...(rest.includes("--hold") ? [] : [sgr(0, c2, r2, true)]));
			break;
		}
		case "release": {
			const [col, row] = rest.map(Number) as [number, number];
			await raw(sgr(0, col, row, true));
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
			killServer(DRIVE);
			break;
		default:
			throw new UsageError(`drive: unknown verb ${verb ?? "(none)"}`);
	}
}
