import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stateDir } from "@swb/shared";
import { DECK } from "../deck/conf.ts";
import { fetchState, postCommand } from "../deck/deck.ts";
import { SwbError, UsageError } from "../errors.ts";
import { cleanEnv, DRIVE, killServer, quote, SESSIONS, SWB, tmux, tmuxClient, tmuxTry } from "../tmux.ts";
import { HARNESS_CONF, theme, themeCommands } from "./drive-terminal.ts";

const PANE = "=drive:";

function harness(...args: string[]): string {
	return tmux(DRIVE, ...args);
}

// SGR mouse reports, 1-based, exactly as a terminal sends them.
function sgr(button: number, col: number, row: number, release = false): string {
	return `\x1b[<${button};${col + 1};${row + 1}${release ? "m" : "M"}`;
}

const READY_MS = 15_000;

/**
 * Whether the driver reads and types into a Deck only once it has caught up and come to rest, as it does unless
 * SWB_DRIVE_NOW=1. A Deck whose worker is blocked, on a held db lock say, never catches up; a driver testing how it
 * copies meanwhile reads it as it is.
 */
const SETTLE = process.env.SWB_DRIVE_NOW !== "1";

/** Whether the drive pane's terminal is on the Deck: a client of swb's server with the pane's tty. */
function driven(): boolean {
	const tty = harness("display", "-p", "-t", PANE, "#{pane_tty}");
	const clients = tmuxTry(SESSIONS, "list-clients", "-t", `=${DECK}`, "-F", "#{client_tty}");
	return clients.ok && clients.out.split("\n").includes(tty);
}

function requireDeck(): void {
	if (!driven()) throw new SwbError(`drive: no Deck on the driven terminal\n${harness("capture-pane", "-p", "-t", PANE)}`);
}

async function waitReady(): Promise<void> {
	const deadline = Date.now() + READY_MS;
	while (Date.now() < deadline) {
		if (driven()) {
			const state = await fetchState(false).catch(() => null);
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

/** The cells a line of the screen shows `text` at, by the column each starts in. */
function columnsOf(line: string, text: string): number[] {
	const found: number[] = [];
	for (let at = line.indexOf(text); at !== -1; at = line.indexOf(text, at + 1)) found.push(visibleWidth(line.slice(0, at)));
	return found;
}

const AIM_TRIES = 5;
const AIM_MS = 5000;

/**
 * Clicks the middle of the one place on the driven screen showing `text`, read once the Deck has settled, or the cell
 * `at` when given. The Deck checks the press against the frame it hit-tests with and drops it where that frame doesn't
 * show `text` under it, so a screen that moved between reading and pressing costs another aim, never a click on
 * whatever moved under it. A cell given is pressed once: aiming again would only press it again.
 */
async function clickOn(text: string, at: [number, number] | null): Promise<void> {
	requireDeck();
	for (let tries = 1; ; tries++) {
		await fetchState(SETTLE);
		const screen = harness("capture-pane", "-p", "-t", PANE);
		let cell = at;
		if (cell === null) {
			const found = screen.split("\n").flatMap((line, y) => columnsOf(line, text).map((x): [number, number] => [x, y]));
			if (found.length !== 1)
				throw new SwbError(`drive: click --on ${JSON.stringify(text)}: on screen ${found.length} times, not once\n${screen}`);
			const [x, y] = found[0] as [number, number];
			cell = [x + Math.floor((visibleWidth(text) - 1) / 2), y];
		}
		const [col, y] = cell;
		await postCommand("aim", [text]);
		await raw(sgr(0, col, y), sgr(0, col, y, true));
		const deadline = Date.now() + AIM_MS;
		let outcome = (await fetchState(false)).aim?.outcome ?? null;
		while (outcome === null && Date.now() < deadline) {
			await Bun.sleep(20);
			outcome = (await fetchState(false)).aim?.outcome ?? null;
		}
		if (outcome === "hit") return;
		if (outcome === null)
			throw new SwbError(`drive: click --on ${JSON.stringify(text)}: the press at ${col},${y} reached no control of the Deck\n${screen}`);
		if (at !== null)
			throw new SwbError(`drive: click ${at.join(" ")} --on ${JSON.stringify(text)}: the Deck shows something else there\n${screen}`);
		if (tries === AIM_TRIES) throw new SwbError(`drive: click --on ${JSON.stringify(text)}: the screen moved under ${AIM_TRIES} aims`);
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
					...tmuxClient(DRIVE),
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
			if (swbArgs.length === 0 || ["-c", "--continue", "new", "open", "adopt"].includes(swbArgs[0] as string)) await waitReady();
			break;
		}
		case "state":
			requireDeck();
			console.log(JSON.stringify(await fetchState(SETTLE)));
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
				requireDeck();
				seen = at(await fetchState(SETTLE), path);
				if (String(seen) === want) return;
				await Bun.sleep(50);
			}
			throw new SwbError(`drive: ${path} is ${JSON.stringify(seen)}, not ${want}, after ${values.timeout} ms`);
		}
		case "keys": {
			// Into a Deck that has caught up, so a key acts on everything that happened before it.
			if (SETTLE && driven()) await fetchState(true);
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
			// As state does: a Deck on screen has caught up with everything before this, and drawn it.
			if (SETTLE && driven()) await fetchState(true);
			process.stdout.write(`${harness("capture-pane", "-p", ...(rest.includes("--ansi") ? ["-e"] : []), "-t", PANE)}\n`);
			break;
		case "theme":
			for (const command of themeCommands(theme(rest[0]))) harness(...command);
			break;
		case "focus":
			await raw(rest[0] === "out" ? "\x1b[O" : "\x1b[I");
			break;
		case "click": {
			const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { on: { type: "string" } } });
			const [col, row] = positionals.map(Number) as [number, number];
			if (values.on !== undefined) {
				await clickOn(values.on, positionals.length === 0 ? null : [col, row]);
				break;
			}
			if (SETTLE && driven()) await fetchState(true);
			await raw(sgr(0, col, row), sgr(0, col, row, true));
			break;
		}
		case "wheel": {
			const [direction, col, row] = [rest[0], Number(rest[1]), Number(rest[2])];
			if (direction !== "up" && direction !== "down") throw new UsageError(`drive: wheel takes up or down, got ${direction}`);
			if (SETTLE && driven()) await fetchState(true);
			await raw(sgr(direction === "up" ? 64 : 65, col, row));
			break;
		}
		case "drag": {
			// --hold leaves the button down, for a look mid-drag; `release` lets go.
			const [c1, r1, c2, r2] = rest.filter((arg) => arg !== "--hold").map(Number) as [number, number, number, number];
			const steps = [1, 2, 3, 4].map((i) => sgr(32, Math.round(c1 + ((c2 - c1) * i) / 4), Math.round(r1 + ((r2 - r1) * i) / 4)));
			await raw(sgr(0, c1, r1), ...steps, ...(rest.includes("--hold") ? [] : [sgr(0, c2, r2, true)]));
			break;
		}
		case "move": {
			// The pointer moving with no button held, which tmux passes on only to a pane that asked for every motion.
			const [col, row] = rest.map(Number) as [number, number];
			await raw(sgr(35, col, row));
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
