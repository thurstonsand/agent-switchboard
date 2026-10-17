import type { Harness, View } from "@swb/shared";
import type { Snooze } from "@swb/shared/tools";
import type { Config } from "../config.ts";
import type { SessionState } from "../derive.ts";
import type { TargetTree } from "../dirs.ts";
import type { ScheduleView } from "../schedules.ts";
import type { DeckLayout } from "../store.ts";

/** One roster entry: a Session, or a live pi that has had no prompt yet (provisional, titled by its id). */
export type Entry = SessionState & {
	view: View;
	transcript: string | null;
	/** The tmux session hosting it, when live. */
	host: string | null;
	provisional: boolean;
	/** What its Peek lists: schedules aimed at it, or launches it set, pending ones and the last that finished. */
	schedules: ScheduleView[];
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

/** A worktree's uncommitted changes against HEAD. */
export type Diff = { files: number; add: number; del: number };

/** What a Peek shows that the snapshot doesn't carry: the last turn, or why it won't read, and its directory's uncommitted changes. */
export type PeekInfo = { last: Turn | null; diff: Diff | null; error: string | null };

/** The Peek as `swb __peek` draws it, written whole to a file it watches. */
export type PeekView = { id: string; lines: string[]; buttons: PeekButton[] };

/** A Peek's button: where it is on its line, the roster key it runs, and its line with it lit. */
export type PeekButton = { y: number; from: number; to: number; key: string; hot: string };

/** What the Stage shows when it shows no live session; the placeholder renders it. */
export type Card = {
	/** Title, state, and path, only while the roster is off-screen; its detail bar owns them otherwise. */
	head: string[];
	lines: string[];
	/** The whole conversation, oldest first; null while it is still being read. */
	turns: Turn[] | null;
	/** What labels the agent's replies: its harness. */
	agent: string;
};

export type State = "loading" | "blocked" | "working" | "unseen" | "idle" | "dormant" | "interrupted" | "archived";

export type StatSummary = { n: number; lastMs: number; avgMs: number; medianMs: number; maxMs: number };

/** `group` is the label of the Group or worktree bucket it sits in, null when directly under its Project or a section. */
export type SessionStateRow = {
	kind: "session";
	id: string;
	title: string;
	glyph: string;
	state: State;
	provisional: boolean;
	group: string | null;
};

/** A Project header has a null group; a Group or worktree bucket beneath it names its own. */
export type HeaderStateRow = { kind: "header"; project: string; group: string | null; expanded: boolean };

export type StateRow = SessionStateRow | HeaderStateRow | { kind: "section"; label: string; count: number; expanded: boolean };

/** The directory picker: its rows as shown, the highlighted one (-1 in add mode is the typed path), and the remove prompt's name. */
export type PickerState = {
	mode: "pick" | "add";
	input: string;
	rows: { name: string; path: string | null; worktree: boolean; dim: boolean }[];
	choice: number;
	confirm: string | null;
	/** What a session started from it runs in. */
	harness: Harness;
};

/** What `GET /state` answers: the Deck as a driver sees it. */
export type DeckState = {
	deck: string;
	ready: boolean;
	terminalFocused: boolean;
	cursor: string | null;
	/** The cursor's index in `rows`, headers included. */
	cursorRow: number;
	mode: "filter" | "name" | "picker" | "snooze" | "roster";
	picker: PickerState | null;
	/** Mid-drag, the header a release would drop into: its Project, and its Group or worktree bucket, if any. */
	drop: { project: string; group: string | null } | null;
	filter: string;
	/** The session row under the pointer, or null once the pointer has left the roster. */
	hover: string | null;
	/** The Peek beside a row: whose, why, and what it says, its lines stripped of color. */
	peek: { id: string; source: "pointer" | "cursor"; lines: string[] } | null;
	focus: "roster" | "stage" | "editor" | "shell";
	staged: {
		id: string | null;
		host: string | null;
		kind: "live" | "loading" | "dormant" | "exited" | "failed" | "empty";
		view: View;
		savedView: View;
	};
	layout: { width: number; rosterOnly: boolean; split: boolean; shell: boolean; rosterHidden: boolean };
	waking: { id: string | null; keyboardWaiting: boolean }[];
	rows: StateRow[];
	colors: { background: string | null; scheme: string | null };
	toasts: { text: string; level: "info" | "error" }[];
	perf: { render: StatSummary; switchClient: StatSummary; keyToSwitch: StatSummary; keyToFrame: StatSummary };
};

/** `side` is the target file of the Stage's second pane, which exists only while split is showing; `peek` is the Peek's. */
export type DeckPaths = { sock: string; card: string; target: string; side: string; below: string; peek: string };

export type ToWorker =
	| { type: "init"; deck: string; paths: DeckPaths; config: Config; here: string }
	| { type: "layout"; layout: DeckLayout }
	| { type: "wake"; id: string }
	| { type: "new"; cwd: string; group: string | null; harness: Harness }
	| { type: "visit"; id: string }
	| { type: "archive"; id: string }
	| { type: "unarchive"; id: string }
	| { type: "snooze"; id: string; snooze: Snooze }
	| { type: "stop"; id: string }
	| { type: "transcript"; id: string; path: string; harness: Harness }
	| { type: "peek"; id: string; cwd: string; transcript: string | null; harness: Harness }
	| { type: "background"; color: string }
	| { type: "view"; id: string; view: View }
	| { type: "group"; ids: string[]; name: string | null }
	| { type: "editor"; dir: string }
	| { type: "shell"; dir: string }
	| { type: "dirs" }
	| { type: "addDir"; path: string }
	| { type: "removeDir"; path: string };

export type FromWorker =
	| { type: "restore"; layout: DeckLayout | null }
	| { type: "snapshot"; snapshot: Snapshot }
	| { type: "woke"; id: string; host: string }
	| { type: "created"; host: string }
	| { type: "transcript"; id: string; turns: Turn[] | null; error: string | null }
	| { type: "peek"; id: string; info: PeekInfo }
	| { type: "launchFailed"; id: string | null; text: string }
	| { type: "toggled"; error: string | null }
	| { type: "stopped"; error: string | null }
	| { type: "editor"; dir: string; name: string | null; text: string | null }
	| { type: "shell"; dir: string; name: string | null; text: string | null }
	| { type: "viewFailed"; id: string; text: string }
	| { type: "groupFailed"; text: string }
	| { type: "dirs"; trees: TargetTree[] }
	| { type: "error"; text: string };
