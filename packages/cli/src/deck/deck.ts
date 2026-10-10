import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "@swb/shared";
import { type Config, loadConfig, type RosterWidth } from "../config.ts";
import { SwbError } from "../errors.ts";
import { ensureOperatorDir } from "../operator.ts";
import { ensureServer, ensureSessionsServer, hook, notify, onlyControl, randomHex, SWB, startScrubbed } from "../sessions.ts";
import { openStore } from "../store.ts";
import { CLIENT_CWD, cleanEnv, listSessions, quote, SESSIONS, tmux, tmuxBin, tmuxTry, UI } from "../tmux.ts";
import type { Card, DeckPaths, DeckState } from "./protocol.ts";

export const HELP_POPUP = ["-w", "62", "-h", "34", "-T", " swb keys ", `${SWB} __help`];

/** At least 20 columns, and never more than half the Deck. */
export function rosterCols(width: RosterWidth, deckWidth: number): number {
	const cols = "cols" in width ? width.cols : Math.round((deckWidth * width.percent) / 100);
	return Math.max(20, Math.min(cols, Math.floor(deckWidth / 2)));
}

export const NARROW_BELOW = 100;
export const SPLIT_FROM = 160;

export function decksDir(): string {
	return join(stateDir(), "decks");
}

export function deckPaths(deck: string): DeckPaths {
	const dir = decksDir();
	return {
		sock: join(dir, `${deck}.sock`),
		card: join(dir, `${deck}.card.json`),
		target: join(dir, `${deck}.target`),
		side: join(dir, `${deck}.side`),
		below: join(dir, `${deck}.below`),
	};
}

export function placeholderName(deck: string): string {
	return `placeholder-${deck}`;
}

export function writeAtomic(path: string, content: string): void {
	writeFileSync(`${path}.tmp`, content);
	renameSync(`${path}.tmp`, path);
}

export function writeCard(paths: DeckPaths, card: Card): void {
	writeAtomic(paths.card, JSON.stringify(card));
}

const deckCmd = (what: string) => notify(`__deck #{session_name} ${what}`);
const roster = (what: string) => deckCmd(`roster ${what}`);
/** From the roster: the pane the keyboard last left, or the session's pi when that pane is gone. */
const backToStage = `if -F '#{P:#{?pane_last,1,}}' { last-pane } { ${deckCmd("stage")} }`;

/**
 * One pane toward h, j, k, or l, never wrapping, as ctrl-hjkl and an Editor at its own edge both move. Leftward off a
 * hidden roster's Stage shows it.
 */
export function nav(k: "h" | "j" | "k" | "l"): string {
	const narrow = k === "h" ? "select-pane -Z -t :.0" : k === "l" ? "select-pane -Z -t :.1" : "";
	const [edge, flag] = { h: ["left", "L"], j: ["bottom", "D"], k: ["top", "U"], l: ["right", "R"] }[k];
	// Past the left edge is always the roster: hidden, or still joining back after M-a z, the roster queues the move behind that.
	const off = k === "h" ? `set -u @swb_hidden ; ${roster("focus")}` : "";
	return `if -F '#{@swb_narrow}' { ${narrow} } { if -F '#{pane_at_${edge}}' { ${off} } { select-pane -${flag} } }`;
}

/**
 * `swb __nav`, from an Editor at its own edge: the Deck pane showing it most recently is a nested client of the sessions
 * server whose tty is that pane's, and the move runs there as if ctrl-hjkl had reached tmux.
 */
export function editorNav(k: string, editor: string): void {
	if (k !== "h" && k !== "j" && k !== "k" && k !== "l") throw new SwbError(`__nav: no direction ${k}`);
	const clients = tmux(SESSIONS, "list-clients", "-t", `=${editor}`, "-F", "#{client_activity}\t#{client_tty}")
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t") as [string, string])
		.toSorted(([a], [b]) => Number(b) - Number(a));
	const panes = new Map(
		tmux(UI, "list-panes", "-a", "-F", "#{pane_tty}\t#{pane_id}")
			.split("\n")
			.map((line) => line.split("\t") as [string, string]),
	);
	const pane = clients.map(([, tty]) => panes.get(tty)).find(Boolean);
	if (!pane) return;
	const result = Bun.spawnSync([tmuxBin(), "-L", UI, "source-file", "-t", pane, "-"], {
		cwd: CLIENT_CWD,
		env: cleanEnv(),
		stdin: Buffer.from(nav(k)),
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new SwbError(`__nav: ${result.stderr.toString().trim()}`);
}

/** The whole config of the UI server. Prefix bindings and hooks report to the Deck's roster through its socket. */
function uiConf(config: Config): string {
	const prefix = config.prefix;
	return [
		"set -g default-terminal tmux-256color",
		"set -g default-shell /bin/sh",
		"set -as terminal-features ',*:RGB:hyperlinks:extkeys'",
		"set -s extended-keys always",
		"set -s extended-keys-format csi-u",
		"set -g allow-passthrough all",
		"set -s escape-time 0",
		"set -s focus-events on",
		// Its default, external, drops the sessions server's OSC 52 here.
		"set -s set-clipboard on",
		"set -s exit-empty off",
		"set -g status off",
		"set -g mouse on",
		"set -g history-limit 0",
		"set -g destroy-unattached off",
		"set -g detach-on-destroy on",
		"set -g pane-border-lines single",
		"set -g pane-border-style fg=brightblack",
		"set -g pane-active-border-style fg=cyan",
		"set -g set-titles on",
		"set -g set-titles-string swb",
		`set -g prefix ${prefix}`,
		"set -g prefix2 None",
		"unbind -aq -T prefix",
		// The roster is pane 0 while it shows; the Stage's panes follow. A narrow Deck shows one pane at a time and never
		// splits, so its moves carry the zoom along. @swb_hidden is the wide Deck's roster state; the roster makes it so.
		`bind Tab if -F '#{@swb_narrow}' { select-pane -Z -t :.+ } { if -F '#{@swb_hidden}' { set -u @swb_hidden ; ${roster("focus")} } { if -F '#{pane_index}' { select-pane -t :.0 } { ${backToStage} } } }`,
		`bind h ${nav("h")}`,
		`bind l if -F '#{||:#{@swb_narrow},#{||:#{pane_index},#{@swb_hidden}}}' { ${nav("l")} } { ${backToStage} }`,
		...(["h", "j", "k", "l"] as const).map((k) => `bind -n C-${k} if -F '#{@swb_editor}' { send-keys C-${k} } { ${nav(k)} }`),
		`bind z if -F '#{@swb_narrow}' { select-pane -Z -t :.0 } { if -F '#{@swb_hidden}' { set -u @swb_hidden } { set @swb_hidden 1 } ; ${roster("sync")} }`,
		...[..."nNawxyY/jkm"].map((k) => `bind ${k} ${notify(`__deck #{session_name} key ${k}`)}`),
		`bind e ${notify("__deck #{session_name} view-swap")}`,
		`bind v ${notify("__deck #{session_name} view-split")}`,
		`bind s ${notify("__deck #{session_name} shell")}`,
		"bind q kill-session",
		`bind ? display-popup -E ${HELP_POPUP.map(quote).join(" ")}`,
		`bind ${prefix} send-keys ${prefix}`,
		// A Deck is created detached; destroy-unattached set globally would kill it before its client attaches.
		`set-hook -g client-attached[0] "if -F '#{m:deck-*,#{session_name}}' 'set destroy-unattached on'"`,
		hook("client-focus-in", "__deck #{session_name} terminal-focus in"),
		hook("client-focus-out", "__deck #{session_name} terminal-focus out"),
		hook("window-pane-changed", "__deck #{session_name} focus #{pane_id}"),
		hook("session-window-changed", "__deck #{session_name} focus #{pane_id}"),
		hook("window-resized", "__deck #{session_name} layout"),
	].join("\n");
}

export function ensureUiServer(config: Config): void {
	ensureServer(
		UI,
		uiConf(config),
		(path) => startScrubbed(UI, ["-f", path, "new-session", "-d", "-s", "swb-ctl", ";", "set", "-t", "swb-ctl", "@swb_kind", "control"]),
		() => onlyControl(UI),
	);
}

/** The Deck's placeholder session on the sessions server, which renders its cards. */
export function ensurePlaceholder(deck: string): void {
	const name = placeholderName(deck);
	if (tmuxTry(SESSIONS, "has-session", "-t", `=${name}`).ok) return;
	const paths = deckPaths(deck);
	const command = `exec ${[SWB, "__placeholder", "--card", paths.card, "--sock", paths.sock].map(quote).join(" ")}`;
	tmux(
		SESSIONS,
		"new-session",
		"-d",
		"-s",
		name,
		"-x",
		"120",
		"-y",
		"40",
		command,
		";",
		"set",
		"-t",
		name,
		"@swb_kind",
		"placeholder",
		";",
		"set",
		"-t",
		name,
		"@swb_deck",
		deck,
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
 * A Stage pane: a nested client of the sessions server. It waits for the Deck's own client first, because a
 * nested client that attaches before the real terminal has no colors to inherit. Whenever it drops, it re-attaches
 * to the Deck's current target, else the placeholder; a shell's pane instead closes with its shell.
 */
export function stageScript(deck: string, targetPath: string, closes = false): string {
	const ui = `${quote(tmuxBin())} -L ${quote(UI)}`;
	const sessions = `${quote(tmuxBin())} -L ${quote(SESSIONS)}`;
	const wait = ["unset TMUX TMUX_PANE", `until ${ui} list-clients -t ${quote(`=${deck}`)} 2>/dev/null | grep -q .; do sleep 0.05; done`];
	if (closes) return [...wait, `exec ${sessions} attach -t "=$(cat ${quote(targetPath)})" >/dev/null 2>&1`].join("\n");
	return [
		...wait,
		"while :; do",
		`  t=$(cat ${quote(targetPath)} 2>/dev/null)`,
		`  ${sessions} attach -t "=$t" >/dev/null 2>&1 || ${sessions} attach -t ${quote(`=${placeholderName(deck)}`)} >/dev/null 2>&1 || sleep 0.2`,
		"done",
	].join("\n");
}

/** `continue`: pi takes the keyboard on the most recent session in this Project, or a new one. */
export type DeckIntent = { select: string | null; newCwd: string | null; continue: boolean };

/** Builds a Deck (roster pane and Stage pane) and attaches this terminal to it. */
export async function openDeck(intent: DeckIntent): Promise<void> {
	if (!process.stdout.isTTY) throw new SwbError("swb needs a terminal");
	const config = loadConfig();
	openStore();
	ensureOperatorDir();
	// Reap a crashed Deck's placeholder first; left standing, it holds the sessions server back from restarting.
	liveDecks();
	ensureSessionsServer();
	ensureUiServer(config);
	const deck = `deck-${randomHex(3)}`;
	const paths = deckPaths(deck);
	mkdirSync(decksDir(), { recursive: true, mode: 0o700 });
	writeCard(paths, { head: [], lines: ["Deck starting…"], turns: null });
	writeAtomic(paths.target, placeholderName(deck));
	ensurePlaceholder(deck);

	const cols = process.stdout.columns;
	const rows = process.stdout.rows;
	const env = deckEnv();
	const stage = tmux(
		UI,
		"new-session",
		"-d",
		"-s",
		deck,
		"-x",
		String(cols),
		"-y",
		String(rows),
		"-P",
		"-F",
		"#{pane_id}",
		...env,
		stageScript(deck, paths.target),
	);
	const roster = [SWB, "__roster", "--deck", deck, "--stage", stage, "--here", process.cwd()];
	if (intent.select) roster.push("--select", intent.select);
	if (intent.newCwd) roster.push("--new", intent.newCwd);
	if (intent.continue) roster.push("--continue");
	const rosterPane = tmux(
		UI,
		"split-window",
		"-h",
		"-b",
		"-l",
		String(rosterCols(config.rosterWidth, cols)),
		"-t",
		stage,
		"-P",
		"-F",
		"#{pane_id}",
		...env,
		`exec ${roster.map(quote).join(" ")}`,
	);
	tmux(UI, "select-pane", "-t", rosterPane);
	if (cols < NARROW_BELOW) tmux(UI, "set", "-t", deck, "@swb_narrow", "1", ";", "resize-pane", "-Z", "-t", rosterPane);

	const attach = Bun.spawn([tmuxBin(), "-L", UI, "attach", "-t", `=${deck}`], {
		cwd: CLIENT_CWD,
		env: cleanEnv(),
		stdio: ["inherit", "inherit", "inherit"],
	});
	process.exitCode = await attach.exited;
}

/** Live Decks by name; sockets whose Deck session is gone are removed. */
export function liveDecks(): string[] {
	let names: string[];
	try {
		names = readdirSync(decksDir())
			.filter((file) => file.endsWith(".sock"))
			.map((file) => file.slice(0, -".sock".length));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const live = names.filter((deck) => {
		if (tmuxTry(UI, "has-session", "-t", `=${deck}`).ok) return true;
		removeDeckFiles(deck);
		return false;
	});
	// A roster that died without its cleanup leaves its placeholder behind on the sessions server.
	const decks = new Set(listSessions(UI).map(([name]) => name as string));
	for (const [name, kind, deck] of listSessions(SESSIONS, "#{@swb_kind}", "#{@swb_deck}")) {
		if (kind === "placeholder" && !decks.has(deck as string)) tmuxTry(SESSIONS, "kill-session", "-t", `=${name}`);
	}
	return live;
}

export function removeDeckFiles(deck: string): void {
	const paths = deckPaths(deck);
	for (const path of [paths.sock, paths.card, paths.target, paths.side, paths.below]) rmSync(path, { force: true });
}

export async function fetchState(deck: string): Promise<DeckState> {
	const response = await fetch("http://deck/state", { unix: deckPaths(deck).sock });
	if (!response.ok) throw new SwbError(`deck ${deck}: GET /state: ${response.status}`);
	return (await response.json()) as DeckState;
}

export async function postCommand(deck: string, cmd: string, args: string[]): Promise<void> {
	const response = await fetch("http://deck/cmd", { unix: deckPaths(deck).sock, method: "POST", body: JSON.stringify({ cmd, args }) });
	if (!response.ok) throw new SwbError(`deck ${deck}: ${cmd}: ${await response.text()}`);
}
