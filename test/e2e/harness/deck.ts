import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeckState, HeaderStateRow, SessionStateRow } from "../../../packages/cli/src/deck/protocol.ts";
import { budgets, type LsEntry, type Scenario, until } from "./index.ts";

export function sessionRows(st: DeckState): SessionStateRow[] {
	return st.rows.flatMap((row) => (row.kind === "session" ? [row] : []));
}

export function headerRows(st: DeckState): HeaderStateRow[] {
	return st.rows.flatMap((row) => (row.kind === "header" ? [row] : []));
}

/** The driven Deck's state, once it has caught up with everything before this call and come to rest. */
export function state(s: Scenario): DeckState {
	return JSON.parse(s.swb("drive", "state"));
}

/**
 * Runs `fn` with every read of the Deck, and every key and click into it, taken as it is rather than once it has caught
 * up: for a test that holds part of the Deck on purpose, its worker or its tmux, which it can't come to rest past.
 */
export async function whileHeld<T>(s: Scenario, fn: () => Promise<T>): Promise<T> {
	s.env.SWB_DRIVE_NOW = "1";
	try {
		return await fn();
	} finally {
		delete s.env.SWB_DRIVE_NOW;
	}
}

/**
 * Clicks the one place on the driven screen showing `text`, as a hand aiming at it does, or the cell `at` when a test
 * is about exactly where the pointer goes. Either way the Deck refuses a press its frame doesn't show `text` under, so
 * a screen that moved can't take a click meant for something else. Use it for every click on the Deck's own controls
 * and rows; a bare click by cell is for a harness's own pane.
 */
export function click(s: Scenario, text: string, at?: [number, number]): void {
	s.swb("drive", "click", ...(at ? at.map(String) : []), "--on", text);
}

/**
 * Moves the driven terminal's pointer from one cell to another as a hand does, fast off the mark and slowing into the
 * target, one report per cell it enters, as a terminal sends them; `swb drive move` takes too long for each to keep pace.
 * Cells are as `swb drive move` takes them.
 */
export async function glide(s: Scenario, from: [number, number], to: [number, number], ms: number): Promise<void> {
	const [[x0, y0], [x1, y1]] = [from, to];
	// From where the pointer already is: a terminal reports only the cells it enters.
	let last = `${x0 + 1};${y0 + 1}`;
	for (const begin = performance.now(); ; await Bun.sleep(4)) {
		const f = Math.min(1, (performance.now() - begin) / ms);
		const ease = 1 - (1 - f) ** 3;
		const at = `${Math.round(x0 + (x1 - x0) * ease) + 1};${Math.round(y0 + (y1 - y0) * ease) + 1}`;
		// As hex bytes, as `swb drive` sends them: as keys, the ESC could be re-encoded.
		if (at !== last)
			s.tmux(s.servers.drive, "send-keys", "-t", "=drive:", "-H", ...[...Buffer.from(`\x1b[<35;${at}M`)].map((b) => b.toString(16)));
		last = at;
		if (f === 1) return;
	}
}

/** The title the Deck's tmux gives its terminal. */
export function title(s: Scenario): string {
	return s.tmux(s.servers.sessions, "display", "-p", "-t", "=deck:", "#{T:set-titles-string}");
}

export function entry(s: Scenario, id: string): LsEntry {
	return s.ls().find((e) => e.id === id) as LsEntry;
}

/** The host of every harness on the sessions server. */
export function piSessions(s: Scenario): string[] {
	return s.tmux(s.servers.sessions, "list-panes", "-a", "-F", "#{@swb_host}").split("\n").filter(Boolean);
}

export function config(s: Scenario, toml: string): void {
	const dir = join(s.env.XDG_CONFIG_HOME as string, "agent-switchboard");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.toml"), toml);
}

/**
 * The Deck's state once it passes `probe`. Every look is settled, as `state` is: a state that passes holds everything
 * that happened before it was read, in the db, in tmux, and in what the Deck was asked.
 */
export async function waitState(s: Scenario, what: string, probe: (st: DeckState) => boolean, ms = budgets.settle): Promise<DeckState> {
	// Polling the Deck's public socket avoids three processes per observation.
	const socket = join(s.env.XDG_STATE_HOME as string, "agent-switchboard/deck.sock");
	return until(
		async () => {
			const response = await fetch(`http://deck/state${s.env.SWB_DRIVE_NOW === "1" ? "" : "?settled"}`, { unix: socket });
			if (!response.ok) throw new Error(`Deck state: ${response.status} ${await response.text()}`);
			const st = (await response.json()) as DeckState;
			return probe(st) && st;
		},
		ms,
		what,
	);
}

/**
 * Opens the directory picker with `keys` (`n` by default) and starts a session in the directory it highlights: the
 * highlighted row's. `deck` reads another terminal's Deck.
 */
export async function pickNew(
	s: Scenario,
	keys = ["n"],
	deck: { keys: (...keys: string[]) => void; state: () => DeckState } = { keys: s.keys, state: () => state(s) },
): Promise<void> {
	deck.keys(...keys);
	await until(
		() => {
			const picker = deck.state().picker;
			return picker !== null && picker.rows[picker.choice]?.path != null;
		},
		budgets.settle,
		"the picker on a directory",
	);
	deck.keys("Enter");
}

/** Prompts the pi on the Stage and waits for its scripted reply, and for the turn to be over. */
export async function reply(s: Scenario, text: string): Promise<void> {
	const id = state(s).staged.id as string;
	const since = Date.now();
	s.keys("-l", `reply ${text}`, "Enter");
	await until(() => s.signal(`replied.${text}`) !== "", budgets.settle, `reply ${text}`);
	await until(
		() => s.ls().some((e) => e.id === id && e.activity === "idle" && e.activityAt >= since),
		budgets.settle,
		`reply ${text}, its turn over`,
	);
}

/** Dormant, Unseen conversations, made through /new in one headless pi. No Deck needs to watch fixture setup. */
export async function seed(s: Scenario, ...conversations: { turns: string[]; title?: string }[]): Promise<string[]> {
	const ids: string[] = [];
	const first = conversations[0];
	if (!first) return ids;
	let id = await launched(s, `reply ${first.turns[0]}`, { cwd: s.project });
	const { tmux_session: host } = s.query("SELECT tmux_session FROM runtimes WHERE session_id = ?", id)[0] as { tmux_session: string };
	const prompt = (text: string) => {
		s.tmux(s.servers.sessions, "send-keys", "-t", s.pane(host), "-l", text);
		s.tmux(s.servers.sessions, "send-keys", "-t", s.pane(host), "Enter");
	};
	for (const { turns, title } of conversations) {
		if (ids.length > 0) {
			prompt("/new");
			id = await until(
				() => {
					const row = s.query<{ session_id: string }>("SELECT session_id FROM runtimes WHERE tmux_session = ?", host)[0];
					return row && row.session_id !== ids.at(-1) && row.session_id;
				},
				budgets.settle,
				"the next conversation",
			);
		}
		for (const turn of turns.slice(ids.length === 0 ? 1 : 0)) {
			prompt(`reply ${turn}`);
			await until(() => s.signal(`replied.${turn}`) !== "", budgets.settle, `reply ${turn}`);
		}
		if (title) {
			prompt(`/name ${title}`);
			await until(() => entry(s, id)?.title === title, budgets.settle, `${title} titled`);
		}
		await until(() => s.ls().some((row) => row.id === id && row.activity === "idle" && row.unseen), budgets.settle, "idle and Unseen");
		ids.push(id);
	}
	s.tmux(s.servers.sessions, "kill-pane", "-t", s.pane(host));
	await until(() => s.ls().every((row) => !ids.includes(row.id) || !row.live), budgets.settle, "seeded conversations dormant");
	// The scenario's first Deck starts where a fresh one would, on the newest session.
	s.query("DELETE FROM deck_layout");
	return ids;
}

export function rowIndex(st: DeckState, id: string): number {
	return st.rows.findIndex((row) => row.kind === "session" && row.id === id);
}

/** Moves the roster cursor onto a session's row with j/k, one step at a time, so rows moving underneath don't overshoot. */
export async function cursorTo(s: Scenario, id: string): Promise<void> {
	const deadline = Date.now() + budgets.settle;
	for (let st = state(s); st.cursor !== id; ) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for cursor on ${id}`);
		const before = st.cursorRow;
		const on = st.cursor;
		s.keys(rowIndex(st, id) > before ? "j" : "k");
		// A row re-sorting as the key lands can put the cursor's next session at the index it left.
		st = await waitState(s, `cursor off row ${before}`, (x) => x.cursorRow !== before || x.cursor !== on || x.cursor === id);
	}
}

/**
 * Takes the Deck's terminal off it, and its roster's pane with it, so the next `swb drive start` finds the Deck broken
 * and builds it afresh, sending the sessions on its Stage home first.
 */
export function closeDeck(s: Scenario): void {
	s.swb("drive", "stop");
	s.tmux(s.servers.sessions, "kill-pane", "-t", s.tmux(s.servers.sessions, "show", "-qv", "-t", "=deck:", "@swb_roster"));
}

export type Terminal = {
	server: string;
	/** Whether this terminal is attached to the Deck. */
	attached: () => boolean;
	state: () => DeckState;
	/** Waits until a ready Deck is attached to this terminal. */
	ready: () => Promise<void>;
	screen: () => string;
	keys: (...keys: string[]) => void;
};

/** Another terminal beside the drive harness: its own tmux server running `command`; `state` reads the Deck attached there. */
export function terminal(s: Scenario, name: string, command: string, size = "140x40"): Terminal {
	const server = `term-${name}-${s.instance}`;
	const [x, y] = size.split("x") as [string, string];
	s.tmux(server, "new-session", "-d", "-s", "t", "-c", s.project, "-x", x, "-y", y, command);
	s.tmux(server, "set", "-s", "escape-time", "0", ";", "set", "-g", "status", "off", ";", "set", "-g", "remain-on-exit", "on");
	const attached = () => {
		const tty = s.tmux(server, "display", "-p", "-t", "=t:", "#{pane_tty}");
		return s.tmux(s.servers.sessions, "list-clients", "-F", "#{client_tty}").split("\n").includes(tty);
	};
	const state = (): DeckState => {
		if (!attached()) throw new Error(`no Deck on terminal ${name}`);
		return JSON.parse(s.swb("deck", "state", "--json"));
	};
	return {
		server,
		attached,
		state,
		ready: async () => {
			await until(
				() => {
					try {
						return state().ready;
					} catch {
						return false;
					}
				},
				budgets.piReady,
				`a ready Deck on terminal ${name}`,
			);
		},
		screen: () => s.tmux(server, "capture-pane", "-p", "-t", "=t:"),
		/** As `s.keys`: `-l TEXT` is literal text, anything else a tmux key name. */
		keys: (...keys) => {
			for (let i = 0; i < keys.length; i++) {
				if (keys[i] === "-l") s.tmux(server, "send-keys", "-t", "=t:", "-l", keys[++i] as string);
				else s.tmux(server, "send-keys", "-t", "=t:", keys[i] as string);
			}
		},
	};
}

/** `swb launch` as session_launch runs it for a pi, from `from` when given, with the briefing on stdin. */
export async function launchTry(
	s: Scenario,
	briefing: string,
	options: { cwd?: string; from?: string; title?: string; group?: string | null } = {},
): Promise<{ code: number; out: string; err: string }> {
	const args = ["--harness", "pi"];
	if (options.cwd) args.push("--cwd", options.cwd);
	if (options.from) args.push("--from", options.from);
	if (options.title) args.push("--title", options.title);
	if (options.group === null) args.push("--no-group");
	else if (options.group !== undefined) args.push("--group", options.group);
	const proc = Bun.spawn([`${s.bin}/swb`, "launch", ...args], {
		env: s.env,
		cwd: s.project,
		stdin: new Blob([briefing]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	return { code, out, err };
}

/** A pi session launched as `launchTry` does, once its first turn has settled; returns its id. */
export async function launched(
	s: Scenario,
	briefing: string,
	options: { cwd?: string; from?: string; title?: string; group?: string | null } = {},
): Promise<string> {
	const { code, out, err } = await launchTry(s, briefing, options);
	if (code !== 0) throw new Error(`swb launch exited ${code}: ${err}`);
	const id = (JSON.parse(out) as { details: { id: string } }).details.id;
	await until(() => entry(s, id)?.activity === "idle" && entry(s, id).unseen, budgets.piReady, `${options.title ?? briefing} settled`);
	return id;
}
