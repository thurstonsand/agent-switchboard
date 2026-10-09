import type { View } from "@swb/shared";
import type { Config } from "../config.ts";
import type { SessionState } from "../derive.ts";

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
};

export type Turn = { who: "you" | "pi"; text: string };

/** What the Stage shows when it shows no live session; the placeholder renders it. */
export type Card = {
	tone: "empty" | "loading" | "exited" | "dormant" | "interrupted" | "archived" | "failed";
	headline: string;
	title: string;
	path: string;
	lines: string[];
	/** The whole conversation, oldest first; null while it is still being read. */
	turns: Turn[] | null;
	keys: string;
	since: number;
};

export type State = "loading" | "blocked" | "working" | "unseen" | "idle" | "dormant" | "interrupted" | "archived";

export type StatSummary = { n: number; lastMs: number; avgMs: number; medianMs: number; maxMs: number };

export type SessionStateRow = { kind: "session"; id: string; title: string; glyph: string; state: State; provisional: boolean };

export type HeaderStateRow = { kind: "header"; project: string; expanded: boolean };

export type StateRow = SessionStateRow | HeaderStateRow | { kind: "section"; label: string; count: number; expanded: boolean };

/** What `GET /state` answers: the Deck as a driver sees it. */
export type DeckState = {
	deck: string;
	ready: boolean;
	terminalFocused: boolean;
	cursor: string | null;
	/** The cursor's index in `rows`, headers included. */
	cursorRow: number;
	mode: "filter" | "roster";
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
	| { type: "init"; deck: string; paths: DeckPaths; config: Config }
	| { type: "wake"; id: string }
	| { type: "new"; cwd: string }
	| { type: "visit"; id: string }
	| { type: "archive"; id: string }
	| { type: "unarchive"; id: string }
	| { type: "transcript"; id: string; path: string }
	| { type: "background"; color: string }
	| { type: "view"; id: string; view: View }
	| { type: "editor"; dir: string };

export type FromWorker =
	| { type: "snapshot"; snapshot: Snapshot }
	| { type: "woke"; id: string; host: string }
	| { type: "created"; host: string }
	| { type: "transcript"; id: string; turns: Turn[] | null; error: string | null }
	| { type: "launchFailed"; id: string | null; text: string }
	| { type: "toggled"; error: string | null }
	| { type: "editor"; dir: string; name: string | null; text: string | null }
	| { type: "viewFailed"; id: string; text: string }
	| { type: "error"; text: string };
