// PROTOTYPE, never ships. The agent driver: runs a Deck inside a hidden harness tmux server and drives it the
// way a human would, through the harness pane's keyboard. See README.md.
//
//   bun run drive start [--size 140x40] [--hover lazy|eager] [--pi fullscreen|regular] [--theme light|dark] [--fresh]
//   bun run drive keys [--delay ms] <tmux key names…>     (-l <text> sends literal text)
//   bun run drive capture [--ansi]
//   bun run drive state
//   bun run drive wait <dotted.path>=<value> [--timeout ms]
//   bun run drive focus in|out
//   bun run drive theme light|dark                       (switch the stand-in terminal's colors live)
//   bun run drive click <col> <row> [--double]           (0-based cells of the capture; SGR mouse, like a real one)
//   bun run drive click-text <text> [--double]           (clicks the first cell of the first match in the capture)
//   bun run drive drag <col> <row> <col> <row>           (press, motion, release)
//   bun run drive resize <cols>x<rows>
//   bun run drive snap <name>                             (capture .txt, .ansi, and .state.json into captures/)
//   bun run drive bench [n]                               (key → Stage repaint latency, cursor row ↔ the row below)
//   bun run drive stop
//   bun run drive reset                                   (kill every mock server, wipe the mock state dir)

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIR, DRIVE_SERVER, paths, SESSIONS_SERVER, STATE, UI_SERVER } from "./shared.ts";

const DECK = "drive";
const env = { ...process.env };
delete env.TMUX;
delete env.TMUX_PANE;

function tmux(server: string, ...args: string[]): { code: number; out: string; err: string } {
	const r = Bun.spawnSync(["tmux", "-L", server, ...args], { env });
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString().trim() };
}

function harness(...args: string[]): string {
	const r = tmux(DRIVE_SERVER, ...args);
	if (r.code !== 0) throw new Error(`drive: tmux ${args.join(" ")}: ${r.err}`);
	return r.out;
}

async function state(): Promise<Record<string, unknown>> {
	const res = await fetch("http://deck/state", { unix: paths.deckSock(DECK) });
	return (await res.json()) as Record<string, unknown>;
}

function pluck(obj: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((o, k) => (o === null || o === undefined ? o : (o as Record<string, unknown>)[k]), obj);
}

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	if (i === -1) return undefined;
	const value = args[i + 1];
	args.splice(i, 2);
	return value;
}

// SGR mouse reports, 1-based, exactly as a terminal sends them to the Deck's tmux client.
const sgrMouse = (button: number, col: number, row: number, release = false) => `\x1b[<${button};${col + 1};${row + 1}${release ? "m" : "M"}`;
async function mouse(...events: string[]): Promise<void> {
	for (const e of events) {
		// Raw bytes (-H): as keys, the ESC could be re-encoded under the harness's extended-keys mode.
		harness("send-keys", "-t", "drive", "-H", ...[...Buffer.from(e)].map((b) => b.toString(16).padStart(2, "0")));
		await Bun.sleep(40);
	}
}
async function click(col: number, row: number, double: boolean): Promise<void> {
	await mouse(sgrMouse(0, col, row), sgrMouse(0, col, row, true));
	if (double) await mouse(sgrMouse(0, col, row), sgrMouse(0, col, row, true));
}

function reset(): void {
	for (const server of [DRIVE_SERVER, UI_SERVER, SESSIONS_SERVER]) tmux(server, "kill-server");
	// SIGHUPed fake pis and rosters write their last runtime files and logs on the way out.
	Bun.sleepSync(400);
	rmSync(STATE, { recursive: true, force: true });
}

// The harness stands in for Ghostty with Gruvbox Light Hard / Dark Hard (from Ghostty.app's bundled themes). A bare
// detached tmux answers no color queries at all; with these it answers OSC 10/11 from window-style and OSC 4 from
// pane-colours, the way Ghostty answers them itself.
const THEMES = {
	light: { fg: "#3c3836", bg: "#f9f5d7", palette: ["#f9f5d7", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#7c6f64", "#928374", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#3c3836"] },
	dark: { fg: "#ebdbb2", bg: "#1d2021", palette: ["#1d2021", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"] },
};
type Theme = keyof typeof THEMES;
function themeCommands(theme: Theme): string[][] {
	const t = THEMES[theme];
	return [
		["set", "-g", "window-style", `bg=${t.bg},fg=${t.fg}`],
		["set", "-g", "window-active-style", `bg=${t.bg},fg=${t.fg}`],
		...t.palette.map((c, i) => ["set", "-g", `pane-colours[${i}]`, c]),
	];
}

// It also takes OSC 52 from the Deck and writes the macOS clipboard, as Ghostty's `clipboard-write = allow` does.
const HARNESS_CONF = [
	"set -g default-terminal tmux-256color",
	"set -s set-clipboard on",
	`set-hook -g pane-set-clipboard 'run-shell "tmux -L ${DRIVE_SERVER} save-buffer - | pbcopy"'`,
	"set -g status off",
	"set -s escape-time 0",
	"set -s extended-keys always",
	"set -g extended-keys-format csi-u",
	"set -g focus-events on",
	"set -g remain-on-exit on",
	"set -g history-limit 0",
	"",
].join("\n");

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
	case "start": {
		const fresh = args.includes("--fresh");
		const [cols, rows] = (flag(args, "--size") ?? "140x40").split("x");
		const hover = flag(args, "--hover") ?? "lazy";
		const pi = flag(args, "--pi") ?? "fullscreen";
		const theme = (flag(args, "--theme") ?? "light") as Theme;
		if (fresh) reset();
		tmux(DRIVE_SERVER, "kill-server");
		mkdirSync(STATE, { recursive: true });
		const conf = join(STATE, "harness.conf");
		writeFileSync(conf, [HARNESS_CONF, ...themeCommands(theme).map((c) => c.map((a) => (a.includes(" ") || a.includes("#") ? `"${a}"` : a)).join(" "))].join("\n"));
		const t0 = performance.now();
		harness(
			"-f", conf, "new-session", "-d", "-s", "drive", "-x", cols!, "-y", rows!,
			"-e", `SWB_DECK_ID=${DECK}`, "-e", `SWB_HOVER=${hover}`, "-e", `FAKEPI_TUI=${pi}`, "-e", `SWB_MOCK_STATE=${STATE}`,
			`cd ${DIR} && bun deck.ts`,
		);
		for (;;) {
			try {
				const s = await state();
				if (pluck(s, "stage.title") !== null) {
					console.log(`deck up in ${Math.round(performance.now() - t0)} ms at ${cols}x${rows}, hover ${hover}`);
					break;
				}
			} catch {}
			if (performance.now() - t0 > 20_000) throw new Error(`drive: deck did not come up:\n${harness("capture-pane", "-p", "-t", "drive")}`);
			await Bun.sleep(50);
		}
		break;
	}
	case "keys": {
		const delay = Number(flag(args, "--delay") ?? 60);
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "-l") harness("send-keys", "-t", "drive", "-l", args[++i]!);
			else harness("send-keys", "-t", "drive", args[i]!);
			await Bun.sleep(delay);
		}
		break;
	}
	case "capture":
		process.stdout.write(harness("capture-pane", "-p", ...(args.includes("--ansi") ? ["-e"] : []), "-t", "drive"));
		break;
	case "state":
		console.log(JSON.stringify(await state(), null, 2));
		break;
	case "wait": {
		const [path, value] = args[0]!.split("=") as [string, string];
		const timeout = Number(flag(args, "--timeout") ?? 10_000);
		const t0 = performance.now();
		for (;;) {
			const got = pluck(await state(), path);
			if (String(got) === value) {
				console.log(`${path}=${value} after ${Math.round(performance.now() - t0)} ms`);
				break;
			}
			if (performance.now() - t0 > timeout) throw new Error(`drive: ${path} is ${JSON.stringify(got)}, not ${value}, after ${timeout} ms`);
			await Bun.sleep(25);
		}
		break;
	}
	case "focus":
		// A focus report on the harness pane's input is exactly what a terminal sends the Deck's tmux client.
		harness("send-keys", "-t", "drive", "-H", "1b", "5b", args[0] === "out" ? "4f" : "49");
		break;
	case "click": {
		await click(Number(args[0]), Number(args[1]), args.includes("--double"));
		break;
	}
	case "click-text": {
		const lines = harness("capture-pane", "-p", "-t", "drive").split("\n");
		const row = lines.findIndex((l) => l.includes(args[0]!));
		if (row === -1) throw new Error(`drive: "${args[0]}" is not on screen`);
		// Columns are cells; the capture's lines are UTF-16 strings, and every glyph the roster uses is one cell wide.
		const col = [...lines[row]!.slice(0, lines[row]!.indexOf(args[0]!))].length;
		await click(col, row, args.includes("--double"));
		console.log(`clicked ${col},${row}`);
		break;
	}
	case "drag": {
		const [c1, r1, c2, r2] = args.map(Number) as [number, number, number, number];
		const steps = 4;
		const motion = Array.from({ length: steps }, (_, i) => sgrMouse(32, Math.round(c1 + ((c2 - c1) * (i + 1)) / steps), Math.round(r1 + ((r2 - r1) * (i + 1)) / steps)));
		await mouse(sgrMouse(0, c1, r1), ...motion, sgrMouse(0, c2, r2, true));
		break;
	}
	case "theme": {
		for (const c of themeCommands(args[0] as Theme)) harness(...c);
		break;
	}
	case "resize": {
		const [cols, rows] = args[0]!.split("x");
		harness("resize-window", "-t", "drive", "-x", cols!, "-y", rows!);
		break;
	}
	case "snap": {
		const dir = join(DIR, "captures");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${args[0]}.txt`), harness("capture-pane", "-p", "-t", "drive"));
		writeFileSync(join(dir, `${args[0]}.ansi`), harness("capture-pane", "-p", "-e", "-t", "drive"));
		writeFileSync(join(dir, `${args[0]}.state.json`), `${JSON.stringify(await state(), null, 2)}\n`);
		console.log(`captures/${args[0]}`);
		break;
	}
	case "bench": {
		const n = Number(args[0] ?? 20);
		const s0 = await state();
		const rows = s0.rows as { kind: string; title: string }[];
		const at = rows.findIndex((r) => r.kind === "session" && r.title === pluck(s0, "cursor.title"));
		const pair = [rows[at + 1], rows[at]];
		if (pair.some((r) => r?.kind !== "session")) throw new Error("drive bench: put the cursor on a session with a session below it");
		const stageText = () =>
			harness("capture-pane", "-p", "-t", "drive")
				.split("\n")
				.map((l) => l.slice(l.indexOf("│") + 1))
				.join("\n");
		const stats = (xs: number[]) => {
			const sorted = [...xs].sort((a, b) => a - b);
			const r = (x: number) => Math.round(x * 10) / 10;
			return { n: xs.length, avgMs: r(xs.reduce((a, b) => a + b, 0) / xs.length), p50Ms: r(sorted[Math.floor(xs.length / 2)]!), maxMs: r(sorted.at(-1)!) };
		};
		const keyToStage: number[] = [];
		for (let i = 0; i < n; i++) {
			const target = pair[i % 2]!.title;
			const t0 = performance.now();
			harness("send-keys", "-t", "drive", i % 2 === 0 ? "j" : "k");
			while (!stageText().includes(target)) if (performance.now() - t0 > 3000) throw new Error(`drive bench: ${target} never reached the Stage`);
			keyToStage.push(performance.now() - t0);
			await Bun.sleep(100);
		}
		const capture: number[] = [];
		const spawn: number[] = [];
		for (let i = 0; i < 20; i++) {
			let t0 = performance.now();
			stageText();
			capture.push(performance.now() - t0);
			t0 = performance.now();
			tmux(SESSIONS_SERVER, "display", "-p", "x");
			spawn.push(performance.now() - t0);
		}
		console.log(JSON.stringify({ between: pair.map((r) => r!.title), keyToStageRepaint: stats(keyToStage), oneCapturePoll: stats(capture), tmuxProcessSpawn: stats(spawn) }, null, 2));
		break;
	}
	case "stop":
		tmux(DRIVE_SERVER, "kill-server");
		break;
	case "reset":
		reset();
		break;
	default:
		console.error("usage: drive start|keys|capture|state|wait|focus|click|click-text|drag|resize|snap|bench|stop|reset");
		process.exit(2);
}
