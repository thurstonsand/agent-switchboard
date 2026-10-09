import type { View } from "@swb/shared";
import type { Config } from "../config.ts";
import type { SessionState } from "../derive.ts";
import type { DeckLayout } from "../store.ts";

/** One roster entry: a Session, or a live pi that has had no prompt yet (provisional, titled by its id). */
export type Entry = SessionState & {
	view: View;
	transcript: string | null;
	/** The tmux session hosting it, when live. */
	host: string | null;
	provisional: boolean;
};

export type Snapshot = {
	entries: Entry[];
	/** Every pi tmux session on the sessions server, recorded or still starting. */
	hosts: string[];
	/** Each directory's Editor, by its tmux session. */
	editors: Record<string, string>;
	/** The last lines of each pi this Deck launched that died before it registered, by its tmux session. */
	died: Record<string, string[]>;
	serverUp: boolean;
	/** The swb that last configured the sessions server. */
	swbVersion: string;
};

export type Turn = { who: "you" | "pi"; text: string };

/** What the Stage shows when it shows no live session; the placeholder renders it. */
export type Card = {
	/** Title, state, and path, only while the roster is off-screen; its detail bar owns them otherwise. */
	head: string[];
	lines: string[];
	/** The whole conversation, oldest first; null while it is still being read. */
	turns: Turn[] | null;
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

/** What `GET /state` answers: the Deck as a driver sees it. */
export type DeckState = {
	deck: string;
	ready: boolean;
	terminalFocused: boolean;
	cursor: string | null;
	/** The cursor's index in `rows`, headers included. */
	cursorRow: number;
	mode: "filter" | "name" | "roster";
	/** Mid-drag, the header a release would drop into: its Project, and its Group or worktree bucket, if any. */
	drop: { project: string; group: string | null } | null;
	filter: string;
	focus: "roster" | "stage" | "editor";
	staged: {
		id: string | null;
		host: string | null;
		kind: "live" | "loading" | "dormant" | "exited" | "failed" | "empty";
		view: View;
		savedView: View;
	};
	layout: { width: number; rosterOnly: boolean; split: boolean; rosterHidden: boolean };
	waking: { id: string | null; keyboardWaiting: boolean }[];
	rows: StateRow[];
	colors: { background: string | null; scheme: string | null };
	toasts: { text: string; level: "info" | "error" }[];
	perf: { render: StatSummary; switchClient: StatSummary; keyToSwitch: StatSummary; keyToFrame: StatSummary };
};

/** `side` is the target file of the Stage's second pane, which exists only while split is showing. */
export type DeckPaths = { sock: string; card: string; target: string; side: string };

export type ToWorker =
	| { type: "init"; deck: string; paths: DeckPaths; config: Config; here: string }
	| { type: "layout"; layout: DeckLayout }
	| { type: "wake"; id: string }
	| { type: "new"; cwd: string; group: string | null }
	| { type: "visit"; id: string }
	| { type: "archive"; id: string }
	| { type: "unarchive"; id: string }
	| { type: "transcript"; id: string; path: string }
	| { type: "background"; color: string }
	| { type: "view"; id: string; view: View }
	| { type: "group"; ids: string[]; name: string | null }
	| { type: "editor"; dir: string };

export type FromWorker =
	| { type: "restore"; layout: DeckLayout | null }
	| { type: "snapshot"; snapshot: Snapshot }
	| { type: "woke"; id: string; host: string }
	| { type: "created"; host: string }
	| { type: "transcript"; id: string; turns: Turn[] | null; error: string | null }
	| { type: "launchFailed"; id: string | null; text: string }
	| { type: "toggled"; error: string | null }
	| { type: "editor"; dir: string; name: string | null; text: string | null }
	| { type: "viewFailed"; id: string; text: string }
	| { type: "groupFailed"; text: string }
	| { type: "error"; text: string };
