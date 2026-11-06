import { hook, notify } from "../tmux.ts";

/** The Deck's session. There is one, which every `swb` attaches its terminal to. */
export const DECK = "deck";

/** The session whose pane renders the Deck's cards. */
export const PLACEHOLDER = "placeholder";

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
 * Overlays, the Peek among them, are floating panes the roster paints (see overlay.ts), and the roster keeps the
 * keyboard. tmux looks at every event first: the pointer leaving both the roster and every overlay, or a key typed
 * outside the roster, puts away the overlays that go with it, @swb_leave's kill-panes, before the event goes on, and
 * tells the roster. The Deck names the roster's pane in @swb_roster, and the roster sets @swb_watch while it wants to
 * hear of it. In a mouse binding the pane formats are the pane under the pointer.
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

/** A hook on a window that runs only for the Deck's: a session's own window changes too, as panes swap in and out of it. */
function deckHook(name: string, command: string): string {
	return `set-hook -g ${name} { if -F '#{==:#{session_name},${DECK}}' { ${command} } }`;
}

/**
 * What a window of the Deck's wears, which no session's own window does: its labels, dimming, and a pane whose process
 * exits kept where it is, for the roster to swap out, so the Deck's layout never moves under it. Dimming darkens
 * rendered colors, a harness's painted cursor included, without changing its own terminal or theme; pane styles have no
 * session context, so the roster is told by its pane-local label, not @swb_roster.
 */
export function deckWindow(target: string): string[] {
	const options: [string, string][] = [
		["window-style", `dim=#{?#{||:#{==:#{@swb_label},swb},${OVER_OVERLAY}},0,#{?#{==:#{@swb_scheme},light},15,35}}`],
		["window-active-style", "dim=0"],
		["pane-border-status", "top"],
		["remain-on-exit", "on"],
	];
	return options.flatMap(([option, value]) => [";", "set", "-w", "-t", target, option, value]).slice(1);
}

/**
 * The Deck's part of the server's config. Prefix bindings and hooks report to the roster through its socket. The prefix
 * itself is the Deck's to set, from its config; see applyPrefix.
 */
export function deckConf(): string[] {
	return [
		// The roster turns the Deck's status line on while it's off-screen: the line is the mouse's way back to it.
		"set -g status-position top",
		"set -g status-style default",
		`set -g status-format[0] "#[range=user|roster] #[bold]◂ #{prefix} z#[nobold] #[dim]show list#[nodim] #[norange]"`,
		`bind -n MouseDown1Status if -F '#{==:#{mouse_status_range},roster}' { if -F '#{@swb_narrow}' { select-pane -Z -t :.0 } { ${roster("focus")} } }`,
		`bind -n Any if -F '#{mouse_pane}' { if -F '${POINTER_AWAY}' { ${LEAVE} } ; send-keys -M } { if -F '${KEY_AWAY}' { ${LEAVE} } ; send-keys }`,
		// A card's own process hears Esc, but a harness starting on the Stage would take it as typeahead; its pane is tagged until it registers.
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
		"set -g pane-border-lines single",
		"set -g pane-border-style fg=brightblack",
		"set -g pane-active-border-style fg=brightblack",
		"set -g pane-border-indicators off",
		`set -g pane-border-format "${PANE_LABEL}"`,
		// tmux 3.8 paints popups dark grey by default, whatever the terminal's theme; help wears the terminal's own.
		"set -g popup-border-style default",
		"set -g set-titles on",
		"set -g set-titles-string swb",
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
		hook("client-focus-in", "__deck terminals"),
		hook("client-focus-out", "__deck terminals"),
		hook("client-attached", "__deck terminals"),
		hook("client-detached", "__deck terminals"),
		hook("client-light-theme", "__deck terminal-scheme light"),
		hook("client-dark-theme", "__deck terminal-scheme dark"),
		deckHook("window-pane-changed[0]", deckCmd("focus #{pane_id}")),
		deckHook("window-pane-changed[1]", KEY_TARGETS),
		deckHook("window-layout-changed[0]", KEY_TARGETS),
		deckHook("session-window-changed[0]", deckCmd("focus #{pane_id}")),
		deckHook("window-resized[0]", deckCmd("layout")),
	];
}

/**
 * The prefix, as the Deck's config names it, and pressing it twice to send it on. A reload of the server's config,
 * which unbinds the prefix table, takes the second with it until the next Deck sets it again.
 */
export function applyPrefix(prefix: string, previous: string | null): string[] {
	const unbind = previous && previous !== prefix ? ["unbind", "-q", previous, ";"] : [];
	return [...unbind, "set", "-g", "prefix", prefix, ";", "bind", prefix, "send-keys", prefix];
}
