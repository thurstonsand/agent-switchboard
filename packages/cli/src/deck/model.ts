import { decodeKittyPrintable, type Input, type KeyId, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { View } from "@swb/shared";
import type { Config, ConfigError, Loaded } from "../config.ts";
import type { Target, TargetTree } from "../dirs.ts";
import type { Catalog } from "../harnesses.ts";
import type { DeckIntent } from "./deck.ts";
import type { Overlay } from "./overlay.ts";
import type { Aim, Entry, PeekInfo, Snapshot, TerminalProfile, Transcript } from "./protocol.ts";
import type { SettingsPane } from "./settings.ts";
import { key } from "./style.ts";

/**
 * The model as the view reads it: nothing in it can be assigned, added to, or taken out. What the Deck only ever
 * replaces whole stays as it is: the worker's snapshot, entries, and transcripts, config, the catalog, pi-tui's inputs,
 * and Settings, which keeps its own state. Spelled out over the model's own types so the view can't write the model,
 * which a convention couldn't keep.
 */
export type Frozen<T> = T extends Whole
	? T
	: T extends ReadonlyMap<infer K, infer V>
		? ReadonlyMap<K, Frozen<V>>
		: T extends ReadonlySet<infer V>
			? ReadonlySet<V>
			: T extends readonly (infer V)[]
				? readonly Frozen<V>[]
				: T extends object
					? { readonly [P in keyof T]: Frozen<T[P]> }
					: T;
type Whole =
	| ((...args: never[]) => unknown)
	| Input
	| SettingsPane
	| Timer
	| PromiseWithResolvers<void>
	| Entry
	| Snapshot
	| Transcript
	| PeekInfo
	| Config
	| Loaded
	| ConfigError
	| Catalog
	| TargetTree
	| TerminalProfile;

/** What a row can be asked to do: by its key on the cursor's row, by its Peek's buttons, or by a prefix key from anywhere. */
export type RowAct =
	| "focus"
	| "wake"
	| "stop"
	| "reload"
	| "archive"
	| "snooze"
	| "unseen"
	| "parent"
	| "copyOpen"
	| "copyMention"
	| "new"
	| "group";

/**
 * What a key, a click, a prefix key, or a button asks the roster to do. Keys find theirs in the mode's keymap, and every
 * button carries one, so a click goes through the same checks its key does.
 */
export type Command =
	/** The mode's highlight: the roster's cursor, or a prompt's or picker's choice. */
	| { kind: "step"; by: number }
	/** ⏎ in a prompt or picker, or a click on one of its choices; null is the highlighted one. */
	| { kind: "choose"; index: number | null }
	/** esc in a prompt or picker, or its ✕. */
	| { kind: "cancel" }
	/** A key no binding takes, typed into the mode's field. */
	| { kind: "type"; data: string }
	/** ⏎ (enter) or space on the cursor's row. */
	| { kind: "activate"; enter: boolean }
	/** l (open) or h (fold) on the cursor's row. */
	| { kind: "unfold"; open: boolean }
	/** A click on a row: the cursor goes there, and it acts as ⏎ does. */
	| { kind: "select"; key: string; index: number }
	/** A click on a session's fold mark. */
	| { kind: "fold"; id: string }
	/** J and K: the cursor to the next session that way. */
	| { kind: "moveSession"; by: 1 | -1 }
	/** On the row with this key, or the cursor's when null. */
	| { kind: "row"; act: RowAct; row: string | null }
	/** The archive prompt's answers; esc is cancel. */
	| { kind: "archiveAnswer"; all: boolean; deleteWorktree: boolean }
	| { kind: "history"; step: -1 | 1 }
	/** The cursor onto a session, wherever it is, opening what hides it. */
	| { kind: "reveal"; id: string }
	| { kind: "filter" }
	| { kind: "clearFilter" }
	/** The directory picker, straight into adding one. */
	| { kind: "addDir" }
	/** The picker: its launch card's menu, opened or closed. */
	| { kind: "menu" }
	/** The picker: Tab, completing the path typed. */
	| { kind: "complete" }
	/** The picker: asks to take the highlighted directory off its list. */
	| { kind: "remove" }
	| { kind: "view"; view: View }
	| { kind: "shell" }
	| { kind: "details" }
	| { kind: "detailScroll"; by: number }
	| { kind: "dismissPeek" }
	/** The roster back on screen with the keyboard, back on screen without it, or off it. */
	| { kind: "roster"; to: "focus" | "show" | "hide" }
	| { kind: "settings" }
	| { kind: "config"; line: number | null }
	| { kind: "help" }
	| { kind: "quit" };

/**
 * A key and what it does, which input runs and the legend shows: a mode's keymap is the one place both read, so the
 * legend can't offer a key that does something else.
 */
export type Binding<C> = {
	/** A printable character as typed, or a key name pi-tui's matchesKey knows; none for one only the legend shows. */
	keys: string[];
	/** How the legend writes it. */
	name: string;
	/** What the legend says it does; null keeps it out of the legend. */
	label: string | null;
	/** Null for a legend entry that names keys bound one by one beside it, as "1–9 pick" does. */
	command: C | null;
};

/** The binding a key runs, if any. */
export function bindingFor<C>(bindings: Binding<C>[], data: string): Binding<C> | undefined {
	const typed = decodeKittyPrintable(data) ?? data;
	return bindings.find((b) => b.keys.some((k) => (k.length === 1 ? typed === k : matchesKey(data, k as KeyId))));
}

/** A keymap's labelled bindings as legend buttons, in its order. What doesn't fit in `room` goes whole, from the end. */
export function legendParts<C>(bindings: Binding<C>[], room: number): [text: string, command: C | null][] {
	const shown = bindings.filter((b) => b.label !== null);
	const width = () => shown.reduce((n, b) => n + 2 + visibleWidth(key(b.name, b.label as string)), -1);
	while (shown.length > 0 && width() > room - 1) shown.pop();
	return shown.flatMap((b, i): [string, C | null][] => [
		[i === 0 ? " " : "  ", null],
		[key(b.name, b.label as string), b.command],
	]);
}

type StageState = {
	/** The session on the Stage, or the pending new session (id null) when `new` is starting. */
	staged: string | null;
	stagedAt: number;
	/** A session whose pi quit or failed while on view: a card until `w` or Enter. */
	ended: { id: string; failed: boolean; lines: string[] } | null;
	/** While `new` starts, the Stage holds on its loading card until the cursor is moved. */
	holdForNew: boolean;
	/** The card the placeholder shows, as the JSON `/card` streams; `cardChanged` settles each time it changes. */
	cardJson: string;
	cardChanged: PromiseWithResolvers<void>;
	watched: string | null;
	/** The session I marked Unseen while it was on the Stage: watching it is no Visit until the Stage leaves it. */
	marked: string | null;
	visited: boolean;
	visitTimer: Timer | null;
	highlightTimer: Timer | null;
	/** The session another switched the Deck to, while tmux may still show the word it left, and its hold's end. */
	arrival: { id: string; held: Timer } | null;
};

type PeekState = {
	/** Where the Peek is, once the pointer rested there and what it shows came in or stopped being waited for. */
	settled: PeekSpot | null;
	pending: PendingPeek | null;
	expires: Timer | null;
	/** Where the last render wanted the Peek. */
	spot: PeekSpot | null;
	/** The Peek put away when the keyboard went to the Stage; it stays away until its row changes. */
	dismissed: string | null;
	/** Set by a navigation key: the cursor's row has a Peek while the roster has the keyboard. */
	byKeys: boolean;
	/** Whether tmux reports the pointer leaving; it stops by itself when it reports. */
	watching: boolean;
	/**
	 * Where the pointer last was on the Peek's row, the tip of the triangle it crosses into the Peek by, and whether it
	 * was moving across the row to get there.
	 */
	aim: { id: string; x: number; y: number; across: boolean } | null;
	/** Ends a rest inside that triangle, when the row under the pointer takes the hover after all. */
	aimRest: Timer | null;
	info: Map<string, { info: PeekInfo; at: number }>;
	asked: Set<string>;
};

/** Everything the Deck knows and has asked for: only a change, inside dispatch, writes it. */
export type Model = {
	/** config.toml as this Deck last applied it; a file that fails to read leaves it be, and says so. */
	loaded: Loaded;
	config: Config;
	configError: ConfigError | null;
	/** What the harnesses can start, as the worker last found it. */
	catalog: Catalog | null;
	// ── model ───────────────────────────────────────────────────────────────
	snapshot: Snapshot | null;
	entries: Map<string, Entry>;
	launches: Launch[];
	focus: "roster" | "stage";
	// No focus event has arrived when the Deck starts; the terminal that just launched it is assumed focused.
	terminalFocused: boolean;
	/** The pane id the keyboard is on. */
	focusedPane: string;
	ready: boolean;
	toasts: Toast[];
	/** A driver's aim at text on screen: the next press goes ahead only where the frame shows that text. */
	aim: Aim | null;
	transcripts: Map<string, { transcript: Transcript | null; error: string | null }>;
	/** The activity each dormant session's transcript was last asked for at; one that moved on since is read again. */
	transcriptsAsked: Map<string, number>;
	/** Views chosen in this Deck that the db doesn't reflect yet, each with the request that writes it. */
	localViews: Map<string, { view: View; req: number }>;
	/** Groups set here and not yet back in a snapshot, each with the request that writes it; null is ungrouped. */
	localGroups: Map<string, { name: string | null; req: number }>;
	stage: StageState;
	/** Directories whose shell this Deck shows; a shell that exits leaves the set. */
	shellsShown: Set<string>;
	/** Directories whose shell this Deck asked the worker to start, by the request; toggling again takes the ask back. */
	shellsAsked: Map<string, number>;
	editors: Map<string, EditorAsk>;
	/** `[` and `]`: the sessions this Deck has visited, oldest first, each once, and the one it stands on. */
	history: { ids: string[]; at: number };
	/** The keyboard is coming back to the roster from a launch that failed; landing on the Stage meanwhile wakes nothing. */
	returning: boolean;
	/** The cursor the last Deck left, until the first snapshot places it. */
	restoredKey: string | null;
	started: boolean;
	/** What a swb asked of the Deck before its first snapshot, which acts on it; a new session doesn't wait for that. */
	intent: DeckIntent | null;
	/** `-c`: the session whose pi takes the keyboard once the Stage is up. */
	continueTo: Entry | null;
	// The cursor's background is mixed from the terminal's own background and foreground, as pi's system theme
	// does. Until the terminal reports its colors, reverse video stands in. The row under the pointer gets a fainter mix
	// than the cursor's, focused or not; the cursor also has the ▌ bar while its session is on the Stage.
	cursorBg: { focused: string; unfocused: string; hover: string } | null;
	colors: { background: string | null; scheme: string | null };
	/** The picker's list as the worker last found it; null until its first scan lands. */
	dirTrees: TargetTree[] | null;
	peek: PeekState;
	details: { expanded: boolean; top: number; id: string | null };
	/** How many times the keyboard moved panes; a move asked for before the latest one is abandoned. */
	focusMoves: number;
	// Like pi: query the colors, and again on every light/dark report (997). The roster starts before the Deck's
	// client attaches, so the first query gets nothing; tmux sends a 997 on attach, and that query gets everything.
	// The worker mirrors them into the sessions server, for the panes it hosts; see its mirror().
	profile: TerminalProfile | null;
	selectedKey: string;
	lastIndex: number;
	/**
	 * After `a`, the cursor keeps its index instead of chasing the session into its new section: until the reply to
	 * `req` lands, and the snapshot after it.
	 */
	pin: { index: number; req: number; answered: boolean } | null;
	/**
	 * The session the cursor archived here, which keeps its row where it was, marked archived, for one last look, until
	 * the cursor leaves it. Only the cursor's own row lingers, so leaving it by any means sends it to Archived.
	 */
	lingering: string | null;
	collapsed: Set<string>;
	expanded: Set<SectionKey>;
	/** The filter's query, which stays applied after the filter mode ends. */
	filter: Input;
	/** What the keyboard and pointer are doing. One mode at a time, so entering one leaves the last. */
	mode: Mode;
	search: Input;
	completed: { typed: string; rows: string[] } | null;
	path: Input;
	gesture: Gesture;
	/** The session row under the pointer. A key clears it until the pointer moves again, and so does the pointer leaving. */
	hover: string | null;
	/** Where the pointer rests, which lights the control under it; null after a key or once it leaves. */
	pointer: { x: number; y: number } | null;
};

/** A wake or new-session request: it resolves once a live entry is hosted by its tmux session. */
export type Launch = { req: number; id: string | null; host: string | null; since: number; keyboard: boolean };

export type Toast = { text: string; level: "info" | "error"; until: number };

/**
 * Each directory whose Editor this staging asked for, so one that dies isn't restarted in a loop: still `asking`, with
 * the view it `shows` once it runs; `asked`; or `lost`, died since and already reported once.
 */
export type EditorAsk = { kind: "asking"; shows: { id: string; view: View } | null } | { kind: "asked" } | { kind: "lost" };

export type SectionKey = "operators" | "inactive" | "snoozed" | "archived";

/** A Project header has no group; a Group beneath it does, and starts sessions in its newest member's cwd. */
export type HeaderRow = {
	kind: "header";
	key: string;
	projectKey: string;
	project: string;
	group: string | null;
	cwd: string;
	count: number;
	depth: number;
	collapsed: boolean;
};

/**
 * Where a nested row hangs in its family's tree: for each ancestor between it and the family's root, whether that
 * ancestor has a sibling below it, so its guide carries on; and whether this row is the last of its siblings.
 */
export type Nest = { continues: boolean[]; last: boolean };

type Placed = { entry: Entry; nest: Nest };

/**
 * A family's root has no `nest`. `family` is everything beneath the row in its bucket, in tree order, placed relative to
 * it; a folded row hides it.
 */
export type SessionRow = {
	kind: "session";
	key: string;
	entry: Entry;
	depth: number;
	header: string;
	nest: Nest | null;
	family: Placed[];
	folded: boolean;
};

export type Row = HeaderRow | SessionRow | { kind: "section"; key: SectionKey; label: string; count: number; expanded: boolean };

/** Where a dragged session would land: a header to light up and the Group it would take, or nowhere. */
export type Drop = { header: HeaderRow; name: string | null } | null;

/** A session being dragged by the mouse; `moved` once the pointer has left its row. */
export type Drag = { kind: "drag"; id: string; moved: boolean; drop: Drop };

/** What the left button is in the middle of: a press on a button, which its click runs, or a drag. */
type Gesture = { kind: "none" } | { kind: "press"; target: ClickTarget } | Drag;

/** Where a click lands, as of the last render, and the command it runs; null takes the click and does nothing. */
export type ClickTarget = { y: number; from: number; to: number; command: Command | null };

/** A stretch of a line, and the command a click on it runs. */
export type Part = [text: string, command: Command | null];

/** `m`'s picker: the sessions it moves, the Group it renames when it started on one's header, and the highlighted choice. */
export type NameMode = {
	kind: "name";
	at: { x: number; y: number; row: string };
	ids: string[];
	renaming: { projectKey: string } | null;
	project: string;
	title: string;
	choice: number;
	input: Input;
};

/** `s`'s menu for a session: how long to snooze it. */
export type SnoozeMode = { kind: "snooze"; at: { x: number; y: number; row: string }; id: string; title: string; choice: number };

/** Named as `deck state` reports them. */
export type Mode =
	| { kind: "roster" }
	| { kind: "filter" }
	| NameMode
	| SnoozeMode
	/**
	 * `a`'s prompt: first whether its family or worktree goes too, then, once `chosen` holds that answer, the
	 * schedules archiving cancels. A session with schedules but neither family nor worktree starts at the second.
	 */
	| {
			kind: "archive";
			at: { x: number; y: number; row: string };
			id: string;
			chosen: { all: boolean; deleteWorktree: boolean } | null;
			/** Whether its worktree has modified or untracked files, which deleting it refuses; null until git answers. */
			dirty: boolean | null;
	  }
	/** The directory picker, `n` and `N`, which takes over the whole roster while it's open. */
	| { kind: "picker"; picker: Choosing }
	/** Settings, which takes over the whole Deck while it's open. */
	| { kind: "settings"; pane: SettingsPane };

/**
 * The frame cache, which only render writes: where it scrolled to and drew things, for the mouse to hit-test and the
 * next frame to scroll from. Everything else changes only in a dispatch.
 */
export type Frame = {
	scrollTop: number;
	pickerTop: number;
	/** The picker's first list row, under its title, a narrow Deck's launch card, its input, and a rule. */
	pickerListY: number;
	/** The launch card as the picker drew it in the roster, when the Stage has no room for it. */
	card: string[] | null;
	/** The overlays over the roster's own lines, as the last render drew them. */
	over: Overlay[];
	/** What the last frame wants put in place once it's out; see afterFrame. */
	wanted: { floats: Overlay[]; leaves: boolean; spot: PeekSpot | null };
	frameQueued: boolean;
	listTop: number;
	listHeight: number;
	promptGap: { at: number; rows: number } | null;
	details: { y: number; height: number; total: number } | null;
	/** What a click does, by row and column range, as of the last render. */
	targets: ClickTarget[];
	/** When the key the next frame answers came in, for the key-to-frame time; 0 with none waiting. */
	keyAt: number;
};

export type PickRow =
	| { kind: "target"; target: Target; tree: TargetTree | null; context: boolean; score: number; at: number[] }
	| { kind: "add" };

/** The directory picker, `n` and `N`, which takes over the whole roster while it's open. */
export type Choosing = {
	mode: "pick" | "add";
	opened: "pick" | "add";
	/** The highlighted row; in add mode -1 is the directory typed, highlighting nothing. */
	choice: number;
	/** The directory it opened on, whose Group a session started there joins. */
	from: string | null;
	group: string | null;
	/** The directory it opened on, offered whether or not it's listed, until I remove it. */
	pin: string | null;
	confirm: { name: string; worktrees: number; path: string; covers: string[] } | null;
	/**
	 * What the new session runs in, by its label, so it stays the same preset as the shortlist changes beneath it; null
	 * for the first, the default's, and so is one whose label is gone.
	 */
	preset: string | null;
	menu: Menu | null;
};

/** The launch card's menu, while it's open: what's typed to narrow it, and its highlight, an index into what it shows. */
export type Menu = { query: string; cursor: number };

/** Narrower than this, as the roster is for a moment while tmux zooms a pane over it, there is no Peek. */
export const PEEK_MIN_COLS = 28;

export type PeekSpot = { id: string; source: "pointer" | "cursor"; y: number };

/** Where the pointer rests until the Peek opens there; `waiting` once it has rested, for what the Peek shows. */
export type PendingPeek = { spot: PeekSpot; timer: Timer; waiting: boolean };

/** The launch card is as wide as this, or the Stage, whichever is narrower. */
export const LAUNCH_COLS = 56;
