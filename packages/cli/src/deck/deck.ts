import { basename, join } from "node:path";
import { type Harness, stateDir } from "@swb/shared";
import { now, since, span } from "@swb/shared/trace";
import { type Config, loadConfig, type RosterWidth } from "../config.ts";
import { SwbError } from "../errors.ts";
import { ensureOperatorDir } from "../operator.ts";
import { buildStamp, ensureSessionsServer, newer } from "../sessions.ts";
import { openStore } from "../store.ts";
import { CLIENT_CWD, cleanEnv, listPanes, quote, SESSIONS, SWB, tmux, tmuxClient, tmuxTry } from "../tmux.ts";
import { VERSION } from "../version.ts";
import { applyPrefix, DECK, deckWindow, nav, PLACEHOLDER } from "./conf.ts";
import type { DeckState } from "./protocol.ts";

export const HELP_POPUP = ["-T", " swb keys ", `${SWB} __help`];

/** At least 20 columns, and never more than half the Deck. */
export function rosterCols(width: RosterWidth, deckWidth: number): number {
	const cols = "cols" in width ? width.cols : Math.round((deckWidth * width.percent) / 100);
	return Math.max(20, Math.min(cols, Math.floor(deckWidth / 2)));
}

export const NARROW_BELOW = 100;
export const SPLIT_FROM = 160;

/** The Deck's socket, the one file it keeps: everything else it shares lives in its processes and in tmux. */
export function deckSocket(): string {
	return join(stateDir(), "deck.sock");
}

/** The Deck's pane showing a session's own pane, or null when the Deck doesn't show it. */
export function deckShowing(home: string): string | null {
	const pane = listPanes(SESSIONS, "#{pane_id}", "#{session_name}", "#{@swb_home}").find(([, , owner]) => owner === home);
	return pane?.[1] === DECK ? (pane[0] as string) : null;
}

/** A Stage stand-in: it holds a slot of the Stage, and a session's own window while the Stage shows that session's pane. */
export const STAND_IN = "exec tail -f /dev/null";

/** `swb __nav`, from an Editor at its own edge: the move runs in the Deck pane showing it, as if ctrl-hjkl had reached tmux. */
export function editorNav(k: string, editor: string): void {
	if (k !== "h" && k !== "j" && k !== "k" && k !== "l") throw new SwbError(`__nav: no direction ${k}`);
	const pane = deckShowing(editor);
	if (!pane) return;
	const result = Bun.spawnSync([...tmuxClient(SESSIONS), "source-file", "-t", pane, "-"], {
		cwd: CLIENT_CWD,
		env: cleanEnv(),
		stdin: Buffer.from(nav(k)),
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new SwbError(`__nav: ${result.stderr.toString().trim()}`);
}

/**
 * The Deck's placeholder session, which renders the cards its roster streams. `fresh` restarts one already running, on
 * this swb and this roster's stream, wherever the Stage has put its pane.
 */
export function ensurePlaceholder(fresh: boolean): void {
	const command = `exec ${[SWB, "__placeholder", "--sock", deckSocket()].map(quote).join(" ")}`;
	if (tmuxTry(SESSIONS, "has-session", "-t", `=${PLACEHOLDER}`).ok) {
		const pane = listPanes(SESSIONS, "#{pane_id}", "#{@swb_home}").find(([, owner]) => owner === PLACEHOLDER)?.[0];
		if (fresh && pane) tmux(SESSIONS, "respawn-pane", "-k", "-t", pane, command);
		return;
	}
	tmux(
		SESSIONS,
		"new-session",
		"-d",
		"-s",
		PLACEHOLDER,
		"-x",
		"120",
		"-y",
		"40",
		command,
		";",
		"set",
		"-t",
		PLACEHOLDER,
		"@swb_kind",
		"placeholder",
		";",
		"set",
		"-p",
		"-t",
		`=${PLACEHOLDER}:`,
		"@swb_home",
		PLACEHOLDER,
		";",
		"set",
		"-p",
		"-t",
		`=${PLACEHOLDER}:`,
		"@swb_card",
		"1",
	);
}

const DECK_ENV = [
	"PATH",
	"HOME",
	"EDITOR",
	"LANG",
	"XDG_STATE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"SWB_INSTANCE",
	"TMUX_TMPDIR",
	"WAYLAND_DISPLAY",
	"DISPLAY",
];

/** `-e` flags carrying what Deck panes need from this environment. */
export function deckEnv(): string[] {
	return DECK_ENV.flatMap((name) => (process.env[name] ? ["-e", `${name}=${process.env[name]}`] : []));
}

/**
 * What a `swb` asks of the Deck as it attaches: a session to show, a new one to start, or the most recent session in a
 * Project, or a new one in its directory when it has none. The last two take the keyboard.
 */
export type DeckIntent =
	| { kind: "open"; id: string }
	| { kind: "new"; cwd: string; harness: Harness | null }
	| { kind: "continue"; root: string; cwd: string };

/** Attaches this terminal to the Deck, starting it or its roster as needed, and hands the roster `intent`. */
export async function openDeck(intent: DeckIntent | null): Promise<void> {
	if (!process.stdout.isTTY) throw new SwbError("swb needs a terminal");
	// A pane of swb's own is on the Deck already: the Deck attached there would show itself showing itself.
	if (basename(process.env.TMUX?.split(",")[0] ?? "") === SESSIONS) throw new SwbError("this terminal is inside the Deck already");
	const config = span("deck.config", loadConfig);
	span("deck.store", openStore);
	span("deck.operator", () => ensureOperatorDir(config.operatorInstructions));
	span("deck.server", ensureSessionsServer);
	span("deck.prefix", () => tmux(SESSIONS, ...applyPrefix(config.prefix, null)));
	const told = span("deck.roster", () => ensureRoster(config, intent));
	if (!told && intent) {
		const at = now();
		await postIntent(intent);
		since("deck.intent", at);
	}
	const attach = Bun.spawn([...tmuxClient(SESSIONS), "attach", "-t", `=${DECK}`], {
		cwd: CLIENT_CWD,
		env: cleanEnv(),
		stdio: ["inherit", "inherit", "inherit"],
	});
	process.exitCode = await attach.exited;
}

function rosterCommand(intent: DeckIntent | null): string {
	const roster = [SWB, "__roster", ...(intent ? ["--intent", JSON.stringify(intent)] : [])];
	return `exec ${roster.map(quote).join(" ")}`;
}

/**
 * Makes sure the Deck has a roster on this swb, as the clock does: one that died, or runs an older swb, is started
 * afresh in its pane, which a roster keeps after it exits; a newer swb's is left alone. Returns whether it started one,
 * which then has `intent` already. Two swbs at once serialize on the db's write lock, so the second finds the first's.
 */
function ensureRoster(config: Config, intent: DeckIntent | null): boolean {
	if (rosterState().kind === "current") return false;
	const db = openStore();
	try {
		return db.tx(() => {
			const state = rosterState();
			switch (state.kind) {
				case "current":
					return false;
				case "none":
					createDeck(config, intent);
					return true;
				case "broken":
					// The roster or the Stage lost its pane, or never said which it was: the Deck starts over.
					releaseSlots(["main", "side", "shell"]);
					tmux(SESSIONS, "kill-session", "-t", `=${DECK}`);
					createDeck(config, intent);
					return true;
				case "stale":
					respawnRoster(state.roster, state.stage, intent);
					return true;
			}
		});
	} finally {
		db.close();
	}
}

type RosterState = { kind: "none" } | { kind: "broken" } | { kind: "stale"; roster: string; stage: string } | { kind: "current" };

/** The Deck's panes: each one's id, the Stage slot it holds, whether its process is gone, and the session it belongs to. */
function deckPanes(): { pane: string; slot: string; dead: boolean; home: string }[] {
	return tmux(SESSIONS, "list-panes", "-s", "-t", `=${DECK}`, "-F", "#{pane_id}\t#{@swb_slot}\t#{pane_dead}\t#{@swb_home}")
		.split("\n")
		.map((line) => line.split("\t") as [string, string, string, string])
		.map(([pane, slot, dead, home]) => ({ pane, slot, dead: dead === "1", home }));
}

/** Whether the Deck is up with a roster running this swb or a newer one, or what it lacks. */
function rosterState(): RosterState {
	// display-message answers for a session that isn't there, from another.
	if (!tmuxTry(SESSIONS, "has-session", "-t", `=${DECK}`).ok) return { kind: "none" };
	const [roster = "", build = ""] = tmux(SESSIONS, "display", "-p", "-t", `=${DECK}:`, "#{@swb_roster}\t#{@swb_roster_build}").split("\t");
	const panes = deckPanes();
	const dead = panes.find((p) => p.pane === roster)?.dead;
	const stage = panes.find((p) => p.slot === "main")?.pane;
	if (dead === undefined || stage === undefined) return { kind: "broken" };
	if (!dead && (build === buildStamp() || newer(build.split(":")[0] ?? "", VERSION))) return { kind: "current" };
	return { kind: "stale", roster, stage };
}

/**
 * Builds the Deck: the Stage's first slot, holding a stand-in until the roster shows something there, and the roster's
 * pane beside it.
 */
function createDeck(config: Config, intent: DeckIntent | null): void {
	const panes = now();
	const cols = process.stdout.columns;
	const rows = process.stdout.rows;
	// One tmux command, not one per step. A new pane gives up a row to its border label, and tmux holds back any resize
	// within 250 ms of the last: a split sent separately reached the Stage that much later and redrew it, but resizes
	// queued together land as one. The roster's pane is named, and kept after its roster exits, in the same command: a
	// roster that died at once would leave no pane to name.
	const narrow =
		cols < NARROW_BELOW ? [";", "set", "-t", `=${DECK}:`, "@swb_narrow", "1", ";", "resize-pane", "-Z", "-t", `=${DECK}:`] : [];
	tmux(
		SESSIONS,
		"new-session",
		"-d",
		"-s",
		DECK,
		"-x",
		String(cols),
		"-y",
		String(rows),
		STAND_IN,
		";",
		"set",
		"-t",
		DECK,
		"@swb_kind",
		"deck",
		";",
		"set",
		"-p",
		"-t",
		`=${DECK}:`,
		"@swb_slot",
		"main",
		";",
		...deckWindow(`=${DECK}:`),
		";",
		"split-window",
		"-h",
		"-b",
		"-l",
		String(rosterCols(config.rosterWidth, cols)),
		"-t",
		`=${DECK}:`,
		...deckEnv(),
		rosterCommand(intent),
		";",
		"set",
		"-p",
		"-t",
		`=${DECK}:`,
		"remain-on-exit",
		"on",
		";",
		"set",
		"-F",
		"-t",
		DECK,
		"@swb_roster",
		"#{pane_id}",
		";",
		"set",
		"-t",
		DECK,
		"@swb_roster_build",
		buildStamp(),
		...narrow,
	);
	since("deck.panes", panes);
}

/**
 * Sends what holds each of the Deck's slots home, its stand-in taking its place, and closes the slots but the Stage's
 * first, which keeps its stand-in.
 */
function releaseSlots(slots: string[]): void {
	for (const { pane, slot, home } of deckPanes()) {
		if (!slots.includes(slot)) continue;
		const standIn = home ? listPanes(SESSIONS, "#{pane_id}", "#{session_name}").find(([, session]) => session === home)?.[0] : pane;
		if (home && standIn) tmux(SESSIONS, "swap-pane", "-d", "-s", pane, "-t", standIn, ";", "set", "-p", "-t", standIn, "@swb_slot", slot);
		if (slot !== "main" && standIn) tmux(SESSIONS, "kill-pane", "-t", standIn);
	}
}

/**
 * Starts a roster afresh in the dead or outdated one's pane. It starts as on a new Deck, so the Deck goes back to one:
 * the roster beside the Stage, unzoomed, with nothing else on it but what the Stage's first slot shows.
 */
function respawnRoster(roster: string, stage: string, intent: DeckIntent | null): void {
	const [rosterWindow, stageWindow, zoomed] = tmux(
		SESSIONS,
		"display",
		"-p",
		"-t",
		roster,
		"#{window_id}",
		";",
		"display",
		"-p",
		"-t",
		stage,
		"#{window_id}\n#{window_zoomed_flag}",
	).split("\n") as [string, string, string];
	if (zoomed === "1") tmux(SESSIONS, "resize-pane", "-Z", "-t", stage);
	if (rosterWindow !== stageWindow) tmux(SESSIONS, "join-pane", "-h", "-b", "-s", roster, "-t", stage);
	releaseSlots(["side", "shell"]);
	for (const { pane, slot } of deckPanes()) {
		if (pane !== roster && slot !== "main") tmux(SESSIONS, "kill-pane", "-t", pane);
	}
	tmux(
		SESSIONS,
		"set",
		"-u",
		"-t",
		DECK,
		"@swb_narrow",
		";",
		"set",
		"-u",
		"-t",
		DECK,
		"@swb_hidden",
		";",
		"respawn-pane",
		"-k",
		"-t",
		roster,
		...deckEnv(),
		rosterCommand(intent),
		";",
		"set",
		"-t",
		DECK,
		"@swb_roster_build",
		buildStamp(),
	);
}

/** Hands a running roster an intent; one that's still starting gets a moment to listen. */
async function postIntent(intent: DeckIntent): Promise<void> {
	const deadline = Date.now() + 5000;
	for (;;) {
		try {
			return await postCommand("intent", [JSON.stringify(intent)]);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if ((code !== "ENOENT" && code !== "ECONNREFUSED" && code !== "FailedToOpenSocket") || Date.now() > deadline) throw error;
			await Bun.sleep(20);
		}
	}
}

export async function fetchState(): Promise<DeckState> {
	const response = await fetch("http://deck/state", { unix: deckSocket() });
	if (!response.ok) throw new SwbError(`deck: GET /state: ${response.status}`);
	return (await response.json()) as DeckState;
}

export async function postCommand(cmd: string, args: string[]): Promise<void> {
	const response = await fetch("http://deck/cmd", { unix: deckSocket(), method: "POST", body: JSON.stringify({ cmd, args }) });
	if (!response.ok) throw new SwbError(`deck: ${cmd}: ${await response.text()}`);
}
