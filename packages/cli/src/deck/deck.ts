import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "@swb/shared";
import { type Config, loadConfig } from "../config.ts";
import { SwbError } from "../errors.ts";
import { ensureServer, ensureSessionsServer, hook, notify, randomHex, SWB, startScrubbed } from "../sessions.ts";
import { openStore } from "../store.ts";
import { CLIENT_CWD, cleanEnv, listSessions, quote, SESSIONS, tmux, tmuxBin, tmuxTry, UI } from "../tmux.ts";
import type { Card, DeckPaths, DeckState } from "./protocol.ts";

export const HELP_POPUP = ["-w", "62", "-h", "27", "-T", " swb keys ", `${SWB} __help`];

export const ROSTER_WIDTH = 42;
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

/** The whole config of the UI server. Prefix bindings and hooks report to the Deck's roster through its socket. */
function uiConf(config: Config): string {
	const prefix = config.prefix;
	const roster = (what: string) => notify(`__deck #{session_name} roster ${what}`);
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
		// Panes by index (roster, then the Stage's one or two, pi last). A narrow Deck shows one pane at a time and never
		// splits, so its moves carry the zoom along. @swb_hidden is the wide Deck's roster state; the roster makes it so.
		`bind Tab if -F '#{@swb_narrow}' { select-pane -Z -t :.+ } { if -F '#{@swb_hidden}' { set -u @swb_hidden ; ${roster("focus")} } { if -F '#{pane_index}' { select-pane -t :.0 } { if -F '#{==:#{window_panes},3}' { select-pane -t :.2 } { select-pane -t :.1 } } } }`,
		`bind h if -F '#{@swb_narrow}' { select-pane -Z -t :.0 } { if -F '#{pane_index}' { select-pane -t :.- } { set -u @swb_hidden ; ${roster("focus")} } }`,
		"bind l if -F '#{@swb_narrow}' { select-pane -Z -t :.1 } { if -F '#{e|<:#{pane_index},#{e|-:#{window_panes},1}}' { select-pane -t :.+ } }",
		`bind z if -F '#{@swb_narrow}' { select-pane -Z -t :.0 } { if -F '#{@swb_hidden}' { set -u @swb_hidden } { set @swb_hidden 1 } ; ${roster("sync")} }`,
		...[..."nawyY/jk"].map((k) => `bind ${k} ${notify(`__deck #{session_name} key ${k}`)}`),
		`bind e ${notify("__deck #{session_name} view-swap")}`,
		`bind v ${notify("__deck #{session_name} view-split")}`,
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
	ensureServer(UI, uiConf(config), (path) =>
		startScrubbed(UI, ["-f", path, "new-session", "-d", "-s", "swb-ctl", ";", "set", "-t", "swb-ctl", "@swb_kind", "control"]),
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
 * to the Deck's current target, else the placeholder.
 */
export function stageScript(deck: string, targetPath: string): string {
	const ui = `${quote(tmuxBin())} -L ${quote(UI)}`;
	const sessions = `${quote(tmuxBin())} -L ${quote(SESSIONS)}`;
	return [
		"unset TMUX TMUX_PANE",
		`until ${ui} list-clients -t ${quote(`=${deck}`)} 2>/dev/null | grep -q .; do sleep 0.05; done`,
		"while :; do",
		`  t=$(cat ${quote(targetPath)} 2>/dev/null)`,
		`  ${sessions} attach -t "=$t" >/dev/null 2>&1 || ${sessions} attach -t ${quote(`=${placeholderName(deck)}`)} >/dev/null 2>&1 || sleep 0.2`,
		"done",
	].join("\n");
}

export type DeckIntent = { select: string | null; newCwd: string | null };

/** Builds a Deck (roster pane and Stage pane) and attaches this terminal to it. */
export async function openDeck(intent: DeckIntent): Promise<void> {
	if (!process.stdout.isTTY) throw new SwbError("swb needs a terminal");
	const config = loadConfig();
	openStore();
	ensureSessionsServer();
	liveDecks();
	ensureUiServer(config);
	const deck = `deck-${randomHex(3)}`;
	const paths = deckPaths(deck);
	mkdirSync(decksDir(), { recursive: true, mode: 0o700 });
	writeCard(paths, {
		tone: "empty",
		headline: "",
		title: "",
		path: "",
		lines: ["Deck starting…"],
		turns: null,
		keys: "",
		since: Date.now(),
	});
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
	const rosterPane = tmux(
		UI,
		"split-window",
		"-h",
		"-b",
		"-l",
		String(ROSTER_WIDTH),
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
	for (const path of [paths.sock, paths.card, paths.target, paths.side]) rmSync(path, { force: true });
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
