import { basename, join } from "node:path";
import { type Harness, stateDir } from "@swb/shared";
import { now, since, span } from "@swb/shared/trace";
import { type Config, loadConfig, type RosterWidth } from "../config.ts";
import { SwbError } from "../errors.ts";
import { ensureOperatorDir } from "../operator.ts";
import { buildStamp, ensureServer, ensureSessionsServer, hook, newer, notify, SWB, startScrubbed } from "../sessions.ts";
import { openStore } from "../store.ts";
import { CLIENT_CWD, cleanEnv, quote, SESSIONS, tmux, tmuxClient, tmuxTry, UI } from "../tmux.ts";
import { VERSION } from "../version.ts";
import type { DeckState } from "./protocol.ts";

export const HELP_POPUP = ["-T", " swb keys ", `${SWB} __help`];

/** At least 20 columns, and never more than half the Deck. */
export function rosterCols(width: RosterWidth, deckWidth: number): number {
	const cols = "cols" in width ? width.cols : Math.round((deckWidth * width.percent) / 100);
	return Math.max(20, Math.min(cols, Math.floor(deckWidth / 2)));
}

export const NARROW_BELOW = 100;
export const SPLIT_FROM = 160;

/** The Deck's session on the UI server. There is one, which every `swb` attaches its terminal to. */
export const DECK = "deck";

/** The session on the sessions server that renders the Deck's cards. */
export const PLACEHOLDER = "placeholder";

/** The Deck's socket, the one file it keeps: everything else it shares lives in its processes and in tmux. */
export function deckSocket(): string {
	return join(stateDir(), "deck.sock");
}

const deckCmd = (what: string) => notify(`__deck ${what}`);
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
	const off = k === "h" ? roster("focus") : "";
	return `if -F '#{@swb_narrow}' { ${narrow} } { if -F '#{pane_at_${edge}}' { ${off} } { select-pane -${flag} } }`;
}

/**
 * The Deck pane showing a tmux session of the sessions server: a nested client of the sessions server whose tty is that
 * pane's. Null when the Deck doesn't show it.
 */
export function deckShowing(target: string): string | null {
	const ttys = tmux(SESSIONS, "list-clients", "-t", `=${target}`, "-F", "#{client_tty}").split("\n");
	// A client attached from outside swb, with no Deck open, leaves the UI server down.
	const listed = tmuxTry(UI, "list-panes", "-a", "-F", "#{pane_tty}\t#{pane_id}");
	if (!listed.ok) return null;
	const panes = new Map(listed.out.split("\n").map((line) => line.split("\t") as [string, string]));
	return ttys.map((tty) => panes.get(tty)).find(Boolean) ?? null;
}

/** `swb __nav`, from an Editor at its own edge: the move runs in the Deck pane showing it, as if ctrl-hjkl had reached tmux. */
export function editorNav(k: string, editor: string): void {
	if (k !== "h" && k !== "j" && k !== "k" && k !== "l") throw new SwbError(`__nav: no direction ${k}`);
	const pane = deckShowing(editor);
	if (!pane) return;
	const result = Bun.spawnSync([...tmuxClient(UI), "source-file", "-t", pane, "-"], {
		cwd: CLIENT_CWD,
		env: cleanEnv(),
		stdin: Buffer.from(nav(k)),
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new SwbError(`__nav: ${result.stderr.toString().trim()}`);
}

/**
 * Overlays, the Peek among them, are floating panes the roster paints (see overlay.ts), and the roster keeps the
 * keyboard. The UI server looks at every event first: the pointer leaving both the roster and every overlay, or a key
 * typed outside the roster, puts away the overlays that go with it, @swb_leave's kill-panes, before the event goes on,
 * and tells the roster. The Deck names the roster's pane in @swb_roster, and the roster sets @swb_watch while it wants to hear of it. In a mouse
 * binding the pane formats are the pane under the pointer.
 */
const OVER_OVERLAY = "#{pane_floating_flag}";
const POINTER_AWAY = `#{&&:#{@swb_watch},#{&&:#{!=:#{mouse_pane},#{@swb_roster}},#{!:${OVER_OVERLAY}}}}`;
const KEY_AWAY = "#{&&:#{@swb_watch},#{!=:#{pane_id},#{@swb_roster}}}";
const LEAVE = `set -u @swb_watch ; if -F '#{@swb_leave}' { run-shell -C '#{@swb_leave}' ; set -u @swb_leave } ; ${deckCmd("pointer-out")}`;

const IN_ROSTER = "#{==:#{pane_id},#{@swb_roster}}";

/**
 * The pane each of prefix h, j, k, l reaches from the focused one, kept in window options for the border labels. tmux's
 * {left-of} and the rest wrap around, so an edge sets none; from the roster, l goes back to the pane it was left from.
 */
const KEY_TARGETS = [
	`if -F '#{pane_at_left}' { set -wu @swb_key_h } { set -wF -t '{left-of}' @swb_key_h '#{pane_id}' }`,
	`if -F '#{pane_at_bottom}' { set -wu @swb_key_j } { set -wF -t '{down-of}' @swb_key_j '#{pane_id}' }`,
	`if -F '#{pane_at_top}' { set -wu @swb_key_k } { set -wF -t '{up-of}' @swb_key_k '#{pane_id}' }`,
	`if -F '${IN_ROSTER}' { set -wF @swb_key_l '#{P:#{?pane_last,#{pane_id},}}' } { if -F '#{pane_at_right}' { set -wu @swb_key_l } { set -wF -t '{right-of}' @swb_key_l '#{pane_id}' } }`,
].join(" ; ");

const keyOf = (k: string, otherwise: string) => `#{?#{==:#{pane_id},#{@swb_key_${k}}},${k},${otherwise}}`;
/** The key that reaches this pane from the focused one; prefix Tab reaches the roster from anywhere. */
const PANE_KEY = keyOf("h", keyOf("j", keyOf("k", keyOf("l", `#{?${IN_ROSTER},Tab,}`))));
/**
 * Each pane names itself on its top edge, and the focused one's name is lit: a divider shared by two panes can't say
 * which of them has the keyboard. While the prefix is down, the others show the key that reaches them.
 */
const PANE_LABEL = [
	"#{?#{@swb_label},#{?pane_active,",
	"#[fg=black bg=cyan bold] #{@swb_label} #[default],",
	`#{?#{&&:#{client_prefix},${PANE_KEY}},#[fg=black bg=yellow bold] ${PANE_KEY} #[default],}`,
	"#[fg=brightblack] #{@swb_label} #[default]},}",
].join("");

/** A mouse binding that hands an overlay its event, never selecting it, and otherwise puts away what leaves first. */
function overlayAware(key: string, otherwise: string): string {
	return `bind -n ${key} if -F '${OVER_OVERLAY}' { send-keys -M } { if -F '${POINTER_AWAY}' { ${LEAVE} } ; ${otherwise} }`;
}

/** The whole config of the UI server. Prefix bindings and hooks report to the Deck's roster through its socket. */
function uiConf(config: Config): string {
	const prefix = config.prefix;
	return [
		"set -g default-terminal tmux-256color",
		"set -g default-shell /bin/sh",
		"set -as terminal-features ',*:RGB:hyperlinks:extkeys:sync'",
		"set -s extended-keys always",
		"set -s extended-keys-format csi-u",
		"set -g allow-passthrough all",
		"set -s escape-time 0",
		"set -s focus-events on",
		// Dim rendered colors, including a harness's painted cursor, without changing its own terminal or theme.
		// Pane styles have no session context: identify the roster by its pane-local label, not @swb_roster.
		`set -g window-style 'dim=#{?#{||:#{==:#{@swb_label},swb},${OVER_OVERLAY}},0,#{?#{==:#{@swb_scheme},light},15,35}}'`,
		"set -g window-active-style dim=0",
		// Its default, external, drops the sessions server's OSC 52 here.
		"set -s set-clipboard on",
		"set -s exit-empty off",
		// The roster turns its Deck's status line on while it's off-screen: the line is the mouse's way back to it.
		"set -g status off",
		"set -g status-position top",
		"set -g status-style default",
		`set -g status-format[0] "#[range=user|roster] #[bold]◂ ${prefix} z#[nobold] #[dim]show list#[nodim] #[norange]"`,
		`bind -n MouseDown1Status if -F '#{==:#{mouse_status_range},roster}' { if -F '#{@swb_narrow}' { select-pane -Z -t :.0 } { ${roster("focus")} } }`,
		"set -g mouse on",
		`bind -n Any if -F '#{mouse_pane}' { if -F '${POINTER_AWAY}' { ${LEAVE} } ; send-keys -M } { if -F '${KEY_AWAY}' { ${LEAVE} } ; send-keys }`,
		// A card's own process hears Esc, but a harness starting on the Stage would take it as typeahead; the roster tags its pane.
		`bind -n Escape { if -F '${KEY_AWAY}' { ${LEAVE} } ; if -F '#{@swb_starting}' { ${deckCmd("esc")} } { send-keys } }`,
		// tmux's own defaults, but for overlays; a right click on a pane that takes no mouse no longer opens tmux's menu.
		overlayAware("MouseDown1Pane", "select-pane -t= ; send-keys -M"),
		overlayAware(
			"MouseDown2Pane",
			"select-pane -t= ; if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' { send-keys -M } { paste-buffer -p }",
		),
		overlayAware("MouseDown3Pane", "if -F '#{mouse_any_flag}' { select-pane -t= ; send-keys -M }"),
		overlayAware("WheelUpPane", "if -F '#{||:#{alternate_on},#{||:#{pane_in_mode},#{mouse_any_flag}}}' { send-keys -M } { copy-mode -e }"),
		overlayAware("DoubleClick1Pane", "select-pane -t= ; if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' { send-keys -M }"),
		overlayAware("TripleClick1Pane", "select-pane -t= ; if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' { send-keys -M }"),
		// tmux's floating panes are the roster's to make and place: ctrl-drag would make one, alt-drag move one.
		"unbind -n C-MouseDrag1Pane",
		"unbind -n C-MouseDrag1Empty",
		"unbind -n M-MouseDrag1Pane",
		"unbind -n M-MouseDrag1Border",
		"set -g history-limit 0",
		"set -g destroy-unattached off",
		"set -g detach-on-destroy on",
		"set -g pane-border-lines single",
		"set -g pane-border-style fg=brightblack",
		"set -g pane-active-border-style fg=brightblack",
		"set -g pane-border-indicators off",
		"set -g pane-border-status top",
		`set -g pane-border-format "${PANE_LABEL}"`,
		// tmux 3.8 paints popups dark grey by default, whatever the terminal's theme; help wears the terminal's own.
		"set -g popup-style default",
		"set -g popup-border-style default",
		"set -g set-titles on",
		"set -g set-titles-string swb",
		`set -g prefix ${prefix}`,
		"set -g prefix2 None",
		"unbind -aq -T prefix",
		// The roster is pane 0 while it shows; the Stage's panes follow, and overlays after them. A narrow Deck shows one pane
		// at a time and never splits, so its moves carry the zoom along. @swb_hidden mirrors whether the wide Deck's roster is hidden; only the roster sets it.
		`bind Tab if -F '#{@swb_narrow}' { if -F '#{pane_index}' { select-pane -Z -t :.0 } { select-pane -Z -t :.1 } } { if -F '#{@swb_hidden}' { ${roster("focus")} } { if -F '#{pane_index}' { select-pane -t :.0 } { ${backToStage} } } }`,
		`bind h ${nav("h")}`,
		// j and k move between panes on the Stage; the roster has none above or below, so there they move between sessions.
		`bind j if -F '${IN_ROSTER}' { ${notify("__deck key J")} } { ${nav("j")} }`,
		`bind k if -F '${IN_ROSTER}' { ${notify("__deck key K")} } { ${nav("k")} }`,
		`bind l if -F '#{||:#{@swb_narrow},#{||:#{pane_index},#{@swb_hidden}}}' { ${nav("l")} } { ${backToStage} }`,
		...(["h", "j", "k", "l"] as const).map((k) => `bind -n C-${k} if -F '#{@swb_editor}' { send-keys C-${k} } { ${nav(k)} }`),
		// z says which it means as it's pressed, so it lands the same whichever order it and an h just after reach the roster.
		`bind z if -F '#{@swb_narrow}' { select-pane -Z -t :.0 } { if -F '#{@swb_hidden}' { ${roster("show")} } { ${roster("hide")} } }`,
		...[..."nNawxRyY/JKmdSpu,[]"].map((k) => `bind ${k} ${notify(`__deck key ${k}`)}`),
		`bind e ${notify("__deck view-swap")}`,
		`bind v ${notify("__deck view-split")}`,
		`bind s ${notify("__deck shell")}`,
		"bind q detach-client",
		`bind ? ${notify("__deck help")}`,
		`bind ${prefix} send-keys ${prefix}`,
		hook("client-focus-in", "__deck terminals"),
		hook("client-focus-out", "__deck terminals"),
		hook("client-attached", "__deck terminals"),
		hook("client-detached", "__deck terminals"),
		hook("client-light-theme", "__deck terminal-scheme light"),
		hook("client-dark-theme", "__deck terminal-scheme dark"),
		hook("window-pane-changed", "__deck focus #{pane_id}"),
		`set-hook -g window-pane-changed[1] { ${KEY_TARGETS} }`,
		`set-hook -g window-layout-changed[0] { ${KEY_TARGETS} }`,
		hook("session-window-changed", "__deck focus #{pane_id}"),
		hook("window-resized", "__deck layout"),
	].join("\n");
}

export function ensureUiServer(config: Config): void {
	ensureServer(
		UI,
		uiConf(config),
		(path) => startScrubbed(UI, ["-f", path, "new-session", "-d", "-s", "swb-ctl", ";", "set", "-t", "swb-ctl", "@swb_kind", "control"]),
		// No terminal shows the Deck, which starts over from its saved layout with the next swb.
		() => tmux(UI, "list-clients") === "",
	);
}

/**
 * The Deck's placeholder session on the sessions server, which renders the cards its roster streams. `fresh` restarts
 * one already running, on this swb and this roster's stream.
 */
export function ensurePlaceholder(fresh: boolean): void {
	const command = `exec ${[SWB, "__placeholder", "--sock", deckSocket()].map(quote).join(" ")}`;
	if (tmuxTry(SESSIONS, "has-session", "-t", `=${PLACEHOLDER}`).ok) {
		if (fresh) tmux(SESSIONS, "respawn-pane", "-k", "-t", `=${PLACEHOLDER}:`, command);
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
 * A Stage pane: a nested client of the sessions server, attached first to `target`. It waits for a terminal to attach
 * to the Deck first, because a nested client that attaches before the real terminal has no colors to inherit. Whenever
 * it drops, it parks on the placeholder, and the roster, hearing it land there, switches it back to what the Stage
 * shows; a shell's pane instead closes with its shell. A new roster's worker makes the placeholder only once the roster
 * listens, so the Stage waits for that too rather than miss it and sit out a retry.
 */
export function stageScript(target: string, closes = false): string {
	const ui = tmuxClient(UI).map(quote).join(" ");
	const sessions = tmuxClient(SESSIONS).map(quote).join(" ");
	const attached = `${ui} list-clients -t ${quote(`=${DECK}`)} 2>/dev/null | grep -q .`;
	const parking = `${sessions} has-session -t ${quote(`=${PLACEHOLDER}`)} 2>/dev/null`;
	const wait = (ready: string) => ["unset TMUX TMUX_PANE", `until ${ready}; do sleep 0.02; done`];
	const attach = (session: string) => `${sessions} attach -t ${quote(`=${session}`)} >/dev/null 2>&1`;
	if (closes) return [...wait(attached), `exec ${attach(target)}`].join("\n");
	return [...wait(`${attached} && ${parking}`), attach(target), "while :; do", `  ${attach(PLACEHOLDER)} || sleep 0.2`, "done"].join("\n");
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
	span("deck.sessions-server", ensureSessionsServer);
	span("deck.ui-server", () => ensureUiServer(config));
	const told = span("deck.roster", () => ensureRoster(config, intent));
	if (!told && intent) {
		const at = now();
		await postIntent(intent);
		since("deck.intent", at);
	}
	const attach = Bun.spawn([...tmuxClient(UI), "attach", "-t", `=${DECK}`], {
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
					tmux(UI, "kill-session", "-t", `=${DECK}`);
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

/** Whether the Deck is up with a roster running this swb or a newer one, or what it lacks. */
function rosterState(): RosterState {
	// display-message answers for a session that isn't there, from another.
	if (!tmuxTry(UI, "has-session", "-t", `=${DECK}`).ok) return { kind: "none" };
	const [roster = "", build = "", stage = ""] = tmux(
		UI,
		"display",
		"-p",
		"-t",
		`=${DECK}:`,
		"#{@swb_roster}\t#{@swb_roster_build}\t#{@swb_stage}",
	).split("\t");
	const panes = new Map(
		tmux(UI, "list-panes", "-s", "-t", `=${DECK}`, "-F", "#{pane_id} #{pane_dead}")
			.split("\n")
			.map((line) => line.split(" ") as [string, string]),
	);
	const dead = panes.get(roster);
	if (dead === undefined || !panes.has(stage)) return { kind: "broken" };
	if (dead === "0" && (build === buildStamp() || newer(build.split(":")[0] ?? "", VERSION))) return { kind: "current" };
	return { kind: "stale", roster, stage };
}

/** Builds the Deck: the Stage's pane, and the roster's beside it. */
function createDeck(config: Config, intent: DeckIntent | null): void {
	const panes = now();
	const cols = process.stdout.columns;
	const rows = process.stdout.rows;
	const env = deckEnv();
	// One tmux command, not one per step. A new pane gives up a row to its border label, and tmux holds back any resize
	// within 250 ms of the last: a split sent separately reached the Stage that much later and redrew it, but resizes
	// queued together land as one. The roster reads the Stage's id from @swb_stage, since the command can't name it; a
	// session option, since hiding and showing the roster moves the Stage between windows. The roster's pane is named,
	// and kept after its roster exits, in the same command: a roster that died at once would leave no pane to name.
	const narrow = cols < NARROW_BELOW ? [";", "set", "-t", DECK, "@swb_narrow", "1", ";", "resize-pane", "-Z", "-t", `=${DECK}:`] : [];
	tmux(
		UI,
		"new-session",
		"-d",
		"-s",
		DECK,
		"-x",
		String(cols),
		"-y",
		String(rows),
		...env,
		stageScript(PLACEHOLDER),
		";",
		"set",
		"-F",
		"-t",
		DECK,
		"@swb_stage",
		"#{pane_id}",
		";",
		"split-window",
		"-h",
		"-b",
		"-l",
		String(rosterCols(config.rosterWidth, cols)),
		"-t",
		`=${DECK}:`,
		...env,
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
 * Starts a roster afresh in the dead or outdated one's pane. It starts as on a new Deck, so the Deck goes back to one:
 * the roster beside the Stage, unzoomed, with nothing else on it.
 */
function respawnRoster(roster: string, stage: string, intent: DeckIntent | null): void {
	const [rosterWindow, stageWindow, zoomed] = tmux(
		UI,
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
	if (zoomed === "1") tmux(UI, "resize-pane", "-Z", "-t", stage);
	if (rosterWindow !== stageWindow) tmux(UI, "join-pane", "-h", "-b", "-s", roster, "-t", stage);
	for (const pane of tmux(UI, "list-panes", "-s", "-t", `=${DECK}`, "-F", "#{pane_id}").split("\n")) {
		if (pane && pane !== roster && pane !== stage) tmux(UI, "kill-pane", "-t", pane);
	}
	tmux(
		UI,
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
