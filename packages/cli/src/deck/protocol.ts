import type { Harness, Snooze, View } from "@swb/shared";
import type { Config } from "../config.ts";
import type { SessionState } from "../derive.ts";
import type { TargetTree } from "../dirs.ts";
import type { Catalog, LaunchTarget } from "../harnesses.ts";
import type { Pending, ScheduleView } from "../schedules.ts";
import type { DeckLayout } from "../store.ts";
import type { Ending } from "../transcripts/conversation.ts";

/** One roster entry: a Session, or a live pi that has had no prompt yet (provisional, titled by its id). */
export type Entry = SessionState & {
	view: View;
	transcript: string | null;
	/** The tmux session hosting it, when live. */
	host: string | null;
	provisional: boolean;
	worktree: string | null;
	/** What its Peek lists: schedules aimed at it, or launches it set, pending ones and the last that finished. */
	schedules: ScheduleView[];
	/** Every pending schedule it set or that's aimed at it: what archiving it cancels. */
	pending: Pending[];
};

export type Snapshot = {
	entries: Entry[];
	/** Every pi tmux session on the sessions server, recorded or still starting. */
	hosts: string[];
	/** Each directory's Editor, by its tmux session. */
	editors: Record<string, string>;
	shells: Record<string, string>;
	/** The last lines of each pi this Deck launched that died before it registered, by its tmux session. */
	died: Record<string, string[]>;
	serverUp: boolean;
	/** The swb that last configured the sessions server. */
	swbVersion: string;
};

export type Turn = { who: "you" | "agent"; text: string };

/** A conversation as a card shows it: its turns, the tool calls the last one made after its last text, and how it ended. */
export type Transcript = { turns: Turn[]; tail: string[]; ending: Ending | null };

/** A worktree's uncommitted changes against HEAD. */
export type Diff = { files: number; add: number; del: number };

/** What a Peek shows that the snapshot doesn't carry: the last turn, or why it won't read, and its directory's uncommitted changes. */
export type PeekInfo = { last: Turn | null; ending: Ending | null; diff: Diff | null; error: string | null };

/** What the Stage shows when it shows no live session; the placeholder renders it. */
export type Card = {
	/** Title, state, and path, only while the roster is off-screen; its detail bar owns them otherwise. */
	head: string[];
	lines: string[];
	/** The conversation's newest turns, as many as could fill the screen, oldest first; null while it is still being read. */
	turns: Turn[] | null;
	/** The tool calls its last turn made after its last text, shown when the turn didn't end with a reply. */
	tail: string[];
	/** Where the conversation stopped short of a reply, drawn as a rule beneath it. */
	ending: string | null;
	/** What labels the agent's replies: its harness. */
	agent: string;
};

export type State = "loading" | "blocked" | "working" | "unseen" | "idle" | "dormant" | "cut-off" | "errored" | "archived";

export type StatSummary = { n: number; lastMs: number; avgMs: number; medianMs: number; maxMs: number };

/**
 * `group` is the Group it sits in, null when directly under its Project or a section. `level` is how deep it nests in
 * its family, 0 for a root; `origin` is the mark a row not nested under its parent shows for who started it; a folded
 * row hides `hidden` sessions.
 */
export type SessionStateRow = {
	kind: "session";
	id: string;
	title: string;
	glyph: string;
	state: State;
	provisional: boolean;
	group: string | null;
	level: number;
	origin: "session" | "operator" | null;
	folded: boolean;
	hidden: number;
};

/** A Project header has a null group; a Group beneath it names its own. */
export type HeaderStateRow = { kind: "header"; project: string; group: string | null; expanded: boolean };

export type StateRow = SessionStateRow | HeaderStateRow | { kind: "section"; label: string; count: number; expanded: boolean };

/** The directory picker: its rows as shown, the highlighted one (-1 in add mode is the typed path), and the remove prompt's name. */
export type PickerState = {
	mode: "pick" | "add";
	input: string;
	rows: { name: string; path: string | null; worktree: boolean; dim: boolean }[];
	choice: number;
	confirm: string | null;
	/** What a session started from it runs in: its preset's label and harness, null until the harnesses are found. */
	preset: string | null;
	harness: Harness | null;
	/** Every preset the launch card's menu offers, in its order: a harness at a time, the default's first. */
	presets: string[];
	/** The menu, while Tab has it open: what's typed, its highlight, and the presets it shows. */
	menu: { query: string; cursor: number; shown: string[] } | null;
};

/** One row of Settings' list as a driver sees it. */
export type SettingsItem = {
	kind: string;
	/** The setting it belongs to, by its TOML key. */
	key: string | null;
	label: string;
	value: string;
	/** Written in config.toml, rather than the default. */
	set: boolean;
	selected: boolean;
	default?: boolean;
	note?: string;
	problem?: string | null;
};

export type SettingsState = {
	section: string;
	area: "rail" | "list";
	search: string | null;
	changedOnly: boolean;
	cursor: number;
	/** What's being edited: text, choices, chord, or add:<step>. */
	editing: string | null;
	error: string | null;
	items: SettingsItem[];
	/** The section's editor, when it's one: what's in it, saved or not, and whether it has the keyboard. */
	prose: { text: string; focused: boolean } | null;
	adding: { step: string; query: string; rows: string[]; choice: number } | null;
};

/** What `GET /state` answers: the Deck as a driver sees it. */
export type DeckState = {
	ready: boolean;
	terminalFocused: boolean;
	cursor: string | null;
	/** The cursor's index in `rows`, headers included. */
	cursorRow: number;
	mode: "filter" | "name" | "picker" | "snooze" | "archive" | "roster" | "settings";
	picker: PickerState | null;
	/** The archive prompt: whose, its counts line, and how many `all` would archive. */
	/** `cancels`: on the prompt's second step, the labels of the schedules archiving cancels. */
	archive: { id: string; counts: string; all: number; cancels: string[] | null } | null;
	settings: SettingsState | null;
	/** config.toml as it is on disk can't be read; the Deck keeps what it had. */
	configError: string | null;
	/** Mid-drag, the header a release would drop into: its Project, and its Group, if any. */
	drop: { project: string; group: string | null } | null;
	filter: string;
	/** The session row under the pointer, or null once the pointer has left the roster. */
	hover: string | null;
	/** The Peek beside a row: whose, why, and what it says, its lines stripped of color. */
	peek: { id: string; source: "pointer" | "cursor"; lines: string[] } | null;
	/** In the picker, the launch card and its open menu as they're shown, stripped of color. */
	launch: { card: string[] | null; menu: string[] | null } | null;
	focus: "roster" | "stage" | "editor" | "shell";
	staged: {
		id: string | null;
		host: string | null;
		kind: "live" | "loading" | "dormant" | "exited" | "failed" | "empty";
		view: View;
		savedView: View;
	};
	layout: { width: number; rosterOnly: boolean; split: boolean; shell: ShellAt | null; rosterHidden: boolean };
	waking: { id: string | null; keyboardWaiting: boolean }[];
	rows: StateRow[];
	colors: { background: string | null; scheme: string | null };
	toasts: { text: string; level: "info" | "error" }[];
	/** What `swb drive click --on` aimed at, and whether the press that followed landed on it or was dropped. */
	aim: Aim | null;
	perf: { render: StatSummary; switchClient: StatSummary; keyToSwitch: StatSummary; keyToFrame: StatSummary };
};

/** Text a driver means to click, and the outcome of the press it sends: null until one comes. */
export type Aim = { text: string; outcome: "hit" | "missed" | null };

/** Where the shell sits against the pane holding the agent, or that it replaces the agent in its pane, when neither half would have room. */
export type ShellAt = "below" | "beside" | "replace";

/** A Deck's terminal as its programs see it, in hex; `palette` is null when the terminal didn't report all 16. */
export type TerminalProfile = { foreground: string; background: string; palette: string[] | null; scheme: "light" | "dark" };

/** A new session on `target`, or, with none, on `harness`'s first preset or the default, once the harnesses are found. */
export type NewSession = {
	type: "new";
	req: number;
	cwd: string;
	group: string | null;
	target: LaunchTarget | null;
	harness: Harness | null;
};

export type ToWorker =
	| { type: "init"; config: Config }
	| { type: "layout"; layout: DeckLayout }
	| { type: "wake"; req: number; id: string }
	| { type: "config"; config: Config }
	| { type: "refresh"; models: boolean }
	| NewSession
	| { type: "visit"; id: string; read: boolean }
	| { type: "markUnseen"; id: string; marked: boolean }
	| { type: "archive"; req: number; ids: string[]; deleteWorktreeFor?: string }
	| { type: "unarchive"; req: number; id: string }
	| { type: "snooze"; req: number; id: string; snooze: Snooze }
	| { type: "stop"; req: number; id: string }
	| { type: "reload"; req: number; id: string }
	| { type: "transcript"; id: string; path: string; harness: Harness }
	| { type: "peek"; id: string; cwd: string; transcript: string | null; harness: Harness }
	| { type: "dirty"; id: string; worktree: string }
	| { type: "colors"; colors: TerminalProfile }
	| { type: "view"; req: number; id: string; view: View }
	| { type: "group"; req: number; ids: string[]; name: string | null }
	| { type: "editor"; dir: string }
	| { type: "shell"; req: number; dir: string }
	| { type: "dirs" }
	| { type: "addDir"; path: string }
	| { type: "removeDir"; path: string }
	| { type: "sync"; req: number };

/**
 * What the worker sends back. A request that carries `req` gets exactly one reply carrying it: `launched` or
 * `launchFailed` for wake, reload, and new, `synced` for sync, and `done` for the rest. The roster applies a reply only where it still holds
 * that `req`, so one for a request it has since moved past changes nothing but its error.
 */
export type FromWorker =
	| { type: "restore"; layout: DeckLayout | null }
	| { type: "snapshot"; snapshot: Snapshot }
	| { type: "launched"; req: number; host: string }
	| { type: "launchFailed"; req: number; text: string }
	| { type: "done"; req: number; error: string | null }
	/** An archive's stop, which runs on after its `done`, failed. */
	| { type: "stopFailed"; text: string }
	| { type: "transcript"; id: string; transcript: Transcript | null; error: string | null }
	| { type: "peek"; id: string; info: PeekInfo }
	| { type: "dirty"; id: string; dirty: boolean }
	| { type: "editor"; dir: string; name: string | null; text: string | null }
	| { type: "shell"; req: number; dir: string; name: string | null; text: string | null }
	| { type: "dirs"; trees: TargetTree[] }
	| { type: "catalog"; catalog: Catalog }
	/** Every snapshot the worker could take since its sync came in has gone out ahead of this. */
	| { type: "synced"; req: number }
	| { type: "error"; text: string };
