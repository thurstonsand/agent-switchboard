import { mkdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import {
	decodeKittyPrintable,
	Input,
	isKeyRelease,
	matchesKey,
	type RgbColor,
	type TerminalColors,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { harness as asHarness, configDir, type Harness, operatorDir, type SnoozePreset, type View } from "@swb/shared";
import { harnessName } from "@swb/shared/mailbox";
import { mark, span } from "@swb/shared/trace";
import { ConfigError, configPath, type Loaded, readConfig } from "../config.ts";
import { type CutOff, displayName, openDescendants, projectName } from "../derive.ts";
import { completions, expandHome, type TargetTree, targetName } from "../dirs.ts";
import { SwbError } from "../errors.ts";
import { unnameable } from "../groups.ts";
import { type Choice, defaultLaunch, fromDefault, type LaunchTarget, presetLabels, shortlist } from "../harnesses.ts";
import { ensureOperatorDir } from "../operator.ts";
import { loginShell, nvimEditor } from "../sessions.ts";
import type { DeckLayout } from "../store.ts";
import { quote, tmuxAsync, UI } from "../tmux.ts";
import { writeConfig } from "../write-config.ts";
import { Control } from "./control.ts";
import { HELP_POPUP, rosterCols, SPLIT_FROM } from "./deck.ts";
import { args, deck, here, placeholder, rosterPane, stagePane, stageTty } from "./env.ts";
import { helpSize } from "./help.ts";
import {
	type Binding,
	bindingFor,
	type Choosing,
	type ClickTarget,
	type Command,
	type Drag,
	type Drop,
	type EditorAsk,
	type Frame,
	type Frozen,
	type HeaderRow,
	LAUNCH_COLS,
	type Launch,
	type Mode,
	type Model,
	type NameMode,
	type Nest,
	PEEK_MIN_COLS,
	type PeekSpot,
	type PendingPeek,
	type PickRow,
	type Row,
	type RowAct,
	type SectionKey,
	type SessionRow,
	type SnoozeMode,
	type Toast,
} from "./model.ts";
import type { Card, Entry, FromWorker, PeekInfo, ShellAt, Snapshot, State, StatSummary, ToWorker, Transcript } from "./protocol.ts";
import { SettingsPane } from "./settings.ts";
import { type Applied, StagePanes } from "./stage.ts";
import { attention, bold, cyan, dimColors, gray, green, hex, keyName, mix, red, sgrBg, shortPath } from "./style.ts";

const VISIT_MS = 1000;

const HIGHLIGHT_MS = 500;

const TOAST_MS = 3500;

const LAYOUT_SETTLE_MS = 500;

// biome-ignore lint/plugin: before the roster's first frame, when nothing waits on its keys yet.
const firstLoaded = readConfig();

const m: Model = {
	loaded: firstLoaded,
	config: firstLoaded.config,
	configError: null,
	catalog: null,
	snapshot: null,
	entries: new Map<string, Entry>(),
	launches: [],
	focus: "roster",
	terminalFocused: true,
	focusedPane: rosterPane,
	ready: false,
	toasts: [],
	transcripts: new Map<string, { transcript: Transcript | null; error: string | null }>(),
	transcriptsAsked: new Map<string, number>(),
	localViews: new Map<string, { view: View; req: number }>(),
	localGroups: new Map<string, { name: string | null; req: number }>(),
	stage: {
		staged: null,
		stagedAt: 0,
		ended: null,
		holdForNew: false,
		cardJson: JSON.stringify({ head: [], lines: ["Deck starting…"], turns: null, tail: [], ending: null, agent: "" } satisfies Card),
		cardChanged: Promise.withResolvers<void>(),
		watched: null,
		marked: null,
		visited: false,
		visitTimer: null,
		highlightTimer: null,
	},
	shellsShown: new Set<string>(),
	shellsAsked: new Map<string, number>(),
	editors: new Map<string, EditorAsk>(),
	history: { ids: [], at: -1 },
	returning: false,
	restoredKey: null,
	started: false,
	hereRoot: "",
	continueTo: null,
	cursorBg: null,
	colors: { background: null, scheme: null },
	dirTrees: null,
	peek: {
		settled: null,
		pending: null,
		expires: null,
		spot: null,
		dismissed: null,
		byKeys: false,
		watching: false,
		info: new Map(),
		asked: new Set(),
	},
	details: { expanded: false, top: 0, id: null },
	focusMoves: 0,
	profile: null,
	selectedKey: "",
	lastIndex: 0,
	pin: null,
	lingering: null,
	collapsed: new Set<string>(),
	expanded: new Set<SectionKey>(["operators"]),
	filter: new Input({ prompt: "/ " }),
	mode: { kind: "roster" },
	search: new Input({ prompt: "/ " }),
	completed: null,
	path: new Input({ prompt: "" }),
	gesture: { kind: "none" },
	hover: null,
	pointer: null,
};
/** The model for the view to read; only a change, inside dispatch, writes it, through m. */
export const model: Frozen<Model> = m;

// ── perf ────────────────────────────────────────────────────────────────

class Stat {
	n = 0;
	last = 0;
	sum = 0;
	max = 0;
	// The median is over the last 1000 samples; the other stats are lifetime.
	samples: number[] = [];
	add(ms: number): void {
		this.n++;
		this.last = ms;
		this.sum += ms;
		this.max = Math.max(this.max, ms);
		this.samples.push(ms);
		if (this.samples.length > 1000) this.samples.shift();
	}
	summary(): StatSummary {
		const r = (x: number) => Math.round(x * 100) / 100;
		const sorted = this.samples.toSorted((a, b) => a - b);
		return {
			n: this.n,
			lastMs: r(this.last),
			avgMs: r(this.n ? this.sum / this.n : 0),
			medianMs: r(sorted[Math.floor(sorted.length / 2)] ?? 0),
			maxMs: r(this.max),
		};
	}
}

export const perf = { render: new Stat(), switchClient: new Stat(), keyToSwitch: new Stat(), keyToFrame: new Stat() };

// ── tmux ────────────────────────────────────────────────────────────────

export const ctl = new Control((line) => {
	const [kind, tty, , session] = line.split(" ");
	if (kind !== "%client-session-changed" || !tty) return;
	dispatch(() => stageUp([tty]));
	if (session === placeholder) panes.parked(tty, placeholder);
});

/** The last request id handed out; see FromWorker. */
let lastReq = 0;

const nextReq = () => ++lastReq;

/**
 * The one piece of state an effect adds to directly, as a tmux command's failure does: a notice, which no change reads
 * but to put it away. A failure can land during a commit, where a change can't start.
 */
export function toast(text: string, level: Toast["level"]): void {
	m.toasts.push({ text, level, until: Date.now() + TOAST_MS });
	screen.requestRender();
}

/**
 * Reads a dormant session's transcript for its card when its activity moved since the last read, or always when staged:
 * the file can change with nothing in swb seeing it, as when the session is resumed outside swb.
 */
function readTranscript(e: Entry, staged: boolean): void {
	if (e.live || !e.transcript || (!staged && m.transcriptsAsked.get(e.id) === e.activityAt)) return;
	m.transcriptsAsked.set(e.id, e.activityAt);
	post({ type: "transcript", id: e.id, path: e.transcript, harness: e.harness });
}

function launchFor(id: string): Launch | undefined {
	return m.launches.find((launch) => launch.id === id);
}

function isUnseen(e: Entry): boolean {
	return e.unseen && m.stage.watched !== e.id;
}

export function viewOf(e: Entry): View {
	return m.localViews.get(e.id)?.view ?? e.view;
}

/** The Group a session carries, as set here or in the db; Operators take none. */
export function groupOf(e: Entry): string | null {
	if (e.operator) return null;
	const local = m.localGroups.get(e.id);
	return local ? local.name : e.group;
}

function setGroup(ids: string[], name: string | null): void {
	const req = nextReq();
	for (const id of ids) m.localGroups.set(id, { name, req });
	post({ type: "group", req, ids, name });
}

/** Where a session is listed: Archived, Operators, Inactive, or open beneath its Project. */
function sectionOf(e: Entry): "archived" | "snoozed" | "operators" | "inactive" | "open" {
	if (!e.open) return "archived";
	if (e.snoozed) return "snoozed";
	if (e.operator) return "operators";
	return e.inactive ? "inactive" : "open";
}

export function parentOf(e: Entry): Entry | undefined {
	return e.parentId === null ? undefined : m.entries.get(e.parentId);
}

/** Who started a session, as its row marks it wherever its parent's row isn't right above it. */
export function origin(e: Entry): "session" | "operator" | null {
	if (e.parentId === null) return null;
	return parentOf(e)?.operator ? "operator" : "session";
}

const foldKey = (id: string) => `fold:${id}`;

export function stateOf(e: Entry): State {
	if (launchFor(e.id) && !e.live) return "loading";
	if (!e.open) return "archived";
	if (e.cutOff) return "cut-off";
	if (e.activity === "blocked") return "blocked";
	if (e.activity === "working") return "working";
	if (e.errored) return "errored";
	if (!e.live) return isUnseen(e) ? "unseen" : "dormant";
	return isUnseen(e) ? "unseen" : "idle";
}

/** The one place a session's state is named; the row's glyph is where it's scanned, and its section says snoozed. */
export function status(e: Entry): string {
	return `${phaseStatus(e)}${e.reload && e.live ? gray(" · reloads when this turn ends") : ""}`;
}

function phaseStatus(e: Entry): string {
	if (m.stage.ended?.id === e.id && m.stage.ended.failed && e.open && !e.live && !launchFor(e.id)) return red("failed to start");
	const state = stateOf(e);
	switch (state) {
		case "loading":
			return cyan("starting");
		case "blocked":
			return attention("blocked");
		case "working":
			return cyan("working");
		case "unseen":
			return e.live ? green("unseen") : `${green("unseen")}${gray(" · dormant")}`;
		case "idle":
			return e.provisional ? `idle${gray(" · no prompt yet")}` : "idle";
		case "dormant":
			return m.transcripts.get(e.id)?.transcript?.ending?.kind === "stopped" ? "dormant · stopped" : "dormant";
		case "cut-off":
			return `${red("cut off")}${gray(` · ${CAUSES[e.cutOff as CutOff]}`)}`;
		case "errored":
			return e.live ? red("errored") : `${red("errored")}${gray(" · dormant")}`;
		case "archived":
			return gray("archived");
	}
}

const CAUSES: Record<CutOff, string> = { shutdown: "shut down", killed: "killed", restart: "machine restarted" };

export const archivedKey = (e: Entry) => Math.max(e.activityAt, e.archivedAt ?? 0);

/** How long a session has been starting, while it is. */
export function launchElapsed(e: Entry, now: number): string {
	const launch = launchFor(e.id);
	return launch && !e.live ? gray(` ${((now - launch.since) / 1000).toFixed(1)} s`) : "";
}

// ── stage ───────────────────────────────────────────────────────────────

const EMPTY: Card = { head: [], lines: ["Nothing selected."], turns: [], tail: [], ending: null, agent: "" };

function onCard(kind: Applied["kind"], id: string | null, card: Card): Applied {
	return { kind, id, host: null, card, view: "agent", target: placeholder, side: null, shell: null };
}

/** A pi still starting, on view so whatever it asks before it registers (a missing cwd, project trust) can be answered. */
function starting(id: string | null, host: string): Applied {
	return { kind: "loading", id, host: null, card: null, view: "agent", target: host, side: null, shell: null };
}

function piShown(a: Applied): boolean {
	return a.kind === "live" && a.view !== "editor" && a.shell?.at !== "replace";
}

/** The Stage's panes, and the roster's place beside them. */
export const panes = new StagePanes(
	{
		deck,
		rosterPane,
		stagePane,
		stageTty,
		ctl,
		focusedPane: () => m.focusedPane,
		configuredCols: (width) => rosterCols(m.config.rosterWidth, width),
		settingsOpen: () => settingsPane() !== null,
		scheme: () => m.profile?.scheme ?? null,
		closeOverlays: () => screen.closeOverlays(),
		toast,
		switched: (ms, keyAt) => {
			perf.switchClient.add(ms);
			if (keyAt > 0) perf.keyToSwitch.add(performance.now() - keyAt);
		},
		resized: () => commit(),
		rosterPlaced: () => commit(),
	},
	onCard("empty", null, EMPTY),
);

const rosterOffScreen = () => panes.narrow || panes.rosterHidden;

let statusShown = false;

let statusOps = Promise.resolve();

/** While the Stage fills the Deck, its status line carries the click that brings the roster back. */
function syncStatus(): void {
	const want = panes.rosterHidden || (panes.narrow && m.focus === "stage");
	if (want === statusShown) return;
	statusShown = want;
	statusOps = statusOps.then(() =>
		tmuxAsync(UI, "set", "-t", deck, "status", want ? "on" : "off").then(
			() => {},
			(error: Error) => toast(`status: ${error.message}`, "error"),
		),
	);
}

let titleShown = "swb";

let titleOps = Promise.resolve();

/** The terminal's title counts what needs me, for the times the Deck isn't the tab I'm looking at. */
function syncTitle(): void {
	const states = [...m.entries.values()].map(stateOf);
	const count = (state: State, mark: string) => {
		const n = states.filter((s) => s === state).length;
		return n > 0 ? ` ${mark}${n}` : "";
	};
	const want = `swb${count("blocked", "◆")}${count("unseen", "●")}`;
	if (want === titleShown) return;
	titleShown = want;
	titleOps = titleOps.then(() =>
		tmuxAsync(UI, "set", "-t", deck, "set-titles-string", want).then(
			() => {},
			(error: Error) => toast(`title: ${error.message}`, "error"),
		),
	);
}

/** Where a conversation stopped short of a reply. Why it was cut off is its status's to say, not this. */
function ending(e: Entry, read: Transcript | null): string | null {
	const wake = e.open && m.mode.kind === "roster" ? ` · ${bold("⏎")} ${e.cutOff ? "resume unfinished turn" : "wake & focus"}` : "";
	if (e.cutOff) return `${bold(red("cut off"))}${wake}`;
	if (read?.ending?.kind === "stopped") return `◌ dormant · stopped${wake}`;
	if (read?.ending?.kind === "error") return `${bold(red("errored"))}${wake}`;
	return null;
}

function card(e: Entry, lines: string[] = []): Card {
	if (pickerMode()) return { head: [], lines: [], turns: [], tail: [], ending: null, agent: "" };
	const transcript = m.transcripts.get(e.id);
	const extra = transcript?.error ? [red(transcript.error)] : [];
	const read = transcript?.transcript ?? null;
	const end = transcript ? ending(e, read) : null;
	return {
		head: rosterOffScreen() ? [bold(displayName(e)), status(e), gray(shortPath(e.cwd))] : [],
		lines: [...lines, ...extra],
		// A screen shows at most a turn per two rows, and the Stage is no taller than the roster.
		turns: transcript ? (read?.turns.slice(-process.stdout.rows) ?? []) : null,
		// An error's own words hang beneath the turn it ended, like the calls before it.
		tail: end ? [...(read?.tail ?? []), ...(read?.ending?.kind === "error" ? [read.ending.message] : [])].slice(-process.stdout.rows) : [],
		ending: m.peek.settled?.id === e.id ? null : end,
		agent: e.harness,
	};
}

const ESC_LINE = "esc goes back to the list.";

function newLaunch(): Launch | undefined {
	return m.launches.find((launch) => launch.id === null);
}

/** The Stage as pi view would have it. */
function piStage(): Applied {
	const pending = newLaunch();
	if (m.stage.staged === null && pending) {
		if (pending.host) return starting(null, pending.host);
		// A new session has no row yet, so its card is the only place that says it's starting.
		const lines = pending.keyboard && rosterOffScreen() ? [ESC_LINE] : [];
		return onCard("loading", null, { head: [cyan("starting a new session")], lines, turns: [], tail: [], ending: null, agent: "" });
	}
	const e = m.stage.staged === null ? undefined : m.entries.get(m.stage.staged);
	if (!e) return onCard("empty", null, EMPTY);
	if (m.stage.ended?.id === e.id && e.open) {
		const failed = m.stage.ended.failed;
		return onCard(
			failed ? "failed" : "exited",
			e.id,
			card(e, failed ? [`${harnessName(e.harness)} quit before it was ready:`, ...m.stage.ended.lines] : []),
		);
	}
	if (e.live && e.host) return { kind: "live", id: e.id, host: e.host, card: null, view: "agent", target: e.host, side: null, shell: null };
	const launch = launchFor(e.id);
	if (launch?.host) return starting(e.id, launch.host);
	if (launch) return onCard("loading", e.id, card(e, launch.keyboard && rosterOffScreen() ? [ESC_LINE] : []));
	return onCard("dormant", e.id, card(e));
}

/** The session's own view, as far as it can show, and its directory's shell when this Deck shows it, in pi's pane when it can't split it. */
function desired(): Applied {
	const d = viewed();
	const e = d.id === null ? undefined : m.entries.get(d.id);
	const target = e?.open && m.shellsShown.has(e.cwd) ? m.snapshot?.shells[e.cwd] : undefined;
	if (!target) return d;
	const shell = { target, at: shellAt(d, target) };
	if (shell.at !== "replace") return { ...d, shell };
	return d.side ? { ...d, side: target, shell } : { ...d, target, shell };
}

/** Each half of the pane the shell splits keeps at least this much: pi is cramped below 60 columns, and a shell below 10 rows. */
const SHELL_MIN_COLS = 60;

const SHELL_MIN_ROWS = 10;

/**
 * zellij's rule: a shell goes below a pane that's taller than it is wide, counting a cell's height in widths, and beside one
 * that isn't. Unlike zellij, one that doesn't fit its way takes the other, and one that fits neither takes pi's pane. Under auto, a shell keeps its side through resizes
 * while it fits, so it doesn't jump; another directory's shell, or entering or leaving split, chooses again.
 */
function shellAt(d: Applied, target: string): ShellAt {
	const stageCols = panes.rosterHidden ? panes.width : panes.width - panes.rosterWidth() - 1;
	const cols = d.side ? Math.round(stageCols * 0.35) : stageCols;
	const fits = { beside: cols >= 2 * SHELL_MIN_COLS + 1, below: panes.height >= 2 * SHELL_MIN_ROWS + 1 };
	// A narrow Deck zooms whichever pane has the keyboard, so a second one would never show beside the first.
	if (panes.narrow) return "replace";
	const prev = panes.applied.shell;
	const sameStage = prev?.target === target && (panes.applied.side === null) === (d.side === null);
	if (m.config.shellPosition === "auto" && sameStage && prev.at !== "replace" && fits[prev.at]) return prev.at;
	const want = m.config.shellPosition !== "auto" ? m.config.shellPosition : panes.height * panes.cellRatio > cols ? "below" : "beside";
	const other = want === "below" ? "beside" : "below";
	return fits[want] ? want : fits[other] ? other : "replace";
}

/** Split needs pi live and a wide Deck, and both need the Editor. */
function viewed(): Applied {
	const d = piStage();
	const e = d.id === null ? undefined : m.entries.get(d.id);
	const editor = e?.open ? m.snapshot?.editors[e.cwd] : undefined;
	if (!e || !editor) return d;
	const view = viewOf(e);
	if (view === "editor") return { ...d, view, target: editor };
	if (view === "split" && d.host && panes.width >= SPLIT_FROM) return { ...d, view, target: editor, side: d.host };
	return d;
}

/** Asks the worker for the directory's Editor, to show `shows` once it runs. */
function requestEditor(dir: string, shows: { id: string; view: View } | null): void {
	m.editors.set(dir, { kind: "asking", shows });
	post({ type: "editor", dir });
}

function onEditor(dir: string, name: string | null): void {
	const ask = m.editors.get(dir);
	if (ask?.kind !== "asking") return;
	m.editors.set(dir, { kind: "asked" });
	const e = ask.shows && m.entries.get(ask.shows.id);
	if (name !== null && e && ask.shows && panes.applied.id === e.id) setView(e, ask.shows.view);
}

/** A harness on the Stage's pane before it's up, which shows its terminal's echo, not its own screen. */
function harnessStarting(a: Applied): boolean {
	return a.kind === "loading" && a.target !== placeholder;
}

function setStageCard(d: Applied): void {
	if (!d.card || d.target !== placeholder) return;
	const json = JSON.stringify(d.card);
	if (json === m.stage.cardJson) return;
	m.stage.cardJson = json;
	m.stage.cardChanged.resolve();
	m.stage.cardChanged = Promise.withResolvers();
}

let dispatching = false;

/** tmux work the changes since the last commit started, which commit runs once the Stage is in line with them. */
let effects: (() => void)[] = [];

/** Runs a change to the Deck's state, one at a time: a change that starts another inside it is a bug. */
function transition<T>(change: () => T): T {
	if (dispatching) throw new Error("a Deck change started inside another");
	dispatching = true;
	const before = effects.length;
	try {
		return change();
	} catch (error) {
		// What a change that failed started goes with it.
		effects.length = before;
		throw error;
	} finally {
		dispatching = false;
	}
}

/**
 * Every change to the Deck's state comes in here: a key, a click, a prefix key, a worker's reply, a timer, a config
 * edit. A change only changes state, posts to the worker, and leaves tmux work for afterCommit.
 */
function dispatch<T>(change: () => T): T {
	const result = transition(change);
	commit();
	return result;
}

/**
 * Runs `effect` once the change in progress is committed, behind the Stage's placement for it: a pane the change
 * brings up is in place before the keyboard goes there.
 */
function afterCommit(effect: () => void): void {
	if (!dispatching) throw new Error("afterCommit outside a Deck change");
	effects.push(effect);
}

/**
 * Settles what the changes left: the roster's cursor and mode first, then the Stage, the status line, and the screen,
 * then the tmux work they started. Also runs on its own after a tmux command the UI server sent finishes.
 */
export function commit(): void {
	if (dispatching) throw new Error("a Deck commit inside a change");
	normalize();
	const detailId = cursorEntry()?.id ?? null;
	if (detailId !== m.details.id) {
		m.details.id = detailId;
		m.details.top = 0;
	}
	if (panes.narrow && m.details.expanded && detailId) askPeekInfo(detailId);
	apply();
	// A key's time goes only to the switch its own commit makes.
	panes.keyAt = 0;
	syncStatus();
	// Setting it repaints the whole Deck, best done in the change's own frame than a tick later.
	syncTitle();
	const run = effects;
	effects = [];
	for (const effect of run) effect();
}

function apply(): void {
	const d = desired();
	span("roster.card", () => setStageCard(d));
	const prev = panes.applied;
	panes.sync(d, stageLabel(d), { editor: nvimEditor(m.config.editor) && editorShown(d), starting: harnessStarting(d) });
	syncVisit();
	const e = d.id === null ? undefined : m.entries.get(d.id);
	if (d.host && e?.open && viewOf(e) !== "agent" && m.snapshot && !m.snapshot.editors[e.cwd]) {
		const ask = m.editors.get(e.cwd);
		if (!ask) requestEditor(e.cwd, null);
		else if (ask.kind === "asked") {
			m.editors.set(e.cwd, { kind: "lost" });
			toast(`editor for ${e.cwd} exited; showing ${harnessName(e.harness)}`, "error");
		}
	}
	screen.requestRender();
	const shellMoved = d.shell?.target !== prev.shell?.target || d.shell?.at !== prev.shell?.at;
	if (shellMoved && d.shell && !panes.narrow && m.config.shellPosition !== "auto" && d.shell.at !== m.config.shellPosition) {
		const room = m.config.shellPosition === "beside" ? `${2 * SHELL_MIN_COLS + 1} columns` : `${2 * SHELL_MIN_ROWS + 1} rows`;
		const where = d.shell.at === "replace" ? `in ${e ? harnessName(e.harness) : "the agent"}'s place` : d.shell.at;
		toast(`a shell ${m.config.shellPosition} needs ${room}; showing it ${where}`, "info");
	}
}

/** What the Stage's agent pane is labelled: its session's harness, or what it waits on without one. */
function stageLabel(a: Applied): string {
	if (pickerMode() && a.card) return "new session";
	if (a.id === null) return newLaunch() ? "new" : "empty";
	const e = m.entries.get(a.id);
	if (!e) throw new Error(`the Stage applied ${a.id}, which has no entry`);
	return e.harness;
}

/** Whether the Stage's first pane shows the Editor, which a shell replacing it in editor view hides. */
export function editorShown(a: Applied): boolean {
	return a.view === "split" || (a.view === "editor" && a.shell?.at !== "replace");
}

/** The pane the shell is in: its own, or pi's when it replaces pi. */
export function shellShownIn(): string | null {
	const a = panes.applied;
	if (a.shell?.at === "replace") return a.side !== null ? (panes.side?.pane ?? null) : stagePane;
	return panes.shellPane?.pane ?? null;
}

function watching(): string | null {
	const a = panes.applied;
	if (!m.terminalFocused || m.focus !== "stage" || !piShown(a)) return null;
	if (a.view === "split" && m.focusedPane === stagePane) return null;
	return a.id;
}

/** A Visit is pi focused on a focused Deck's Stage for 1 s; passing over a session in the roster isn't one. */
function syncVisit(): void {
	if (m.stage.marked !== panes.applied.id) m.stage.marked = null;
	const watched = watching();
	const id = watched === m.stage.marked ? null : watched;
	if (id === m.stage.watched) return;
	if (m.stage.visitTimer) clearTimeout(m.stage.visitTimer);
	m.stage.visitTimer = null;
	// Turns that landed while I watched are seen.
	if (m.stage.watched && m.stage.visited) post({ type: "visit", id: m.stage.watched });
	m.stage.visited = false;
	m.stage.watched = id;
	if (id === null) return;
	m.stage.visitTimer = setTimeout(
		() =>
			dispatch(() => {
				m.stage.visitTimer = null;
				if (m.stage.watched !== id) return;
				m.stage.visited = true;
				post({ type: "visit", id });
				remember(id);
			}),
		VISIT_MS,
	);
}

/** A Visit somewhere new drops what lay ahead, as a browser's history does; one where `[` or `]` landed changes nothing. */
function remember(id: string): void {
	if (m.history.ids[m.history.at] === id) return;
	m.history.ids = m.history.ids.slice(0, m.history.at + 1).filter((other) => other !== id);
	m.history.ids.push(id);
	m.history.at = m.history.ids.length - 1;
}

/**
 * Where `[` lands: the latest visited session at or behind my place that isn't on view, so one I've only moved off
 * comes first; `]`: the next one past my place. Archived sessions are passed over; snoozed ones aren't.
 */
export function historyStep(step: -1 | 1): number {
	for (let i = step < 0 ? m.history.at : m.history.at + 1; i >= 0 && i < m.history.ids.length; i += step) {
		const id = m.history.ids[i] as string;
		if (id !== m.stage.staged && m.entries.get(id)?.open) return i;
	}
	return -1;
}

/** Shows that session as `swb show` does: from the roster the cursor goes to it, and from the Stage it's focused, waking it. */
function goHistory(step: -1 | 1): void {
	const i = historyStep(step);
	if (i === -1) {
		toast(step < 0 ? "no earlier visit" : "no later visit", "info");
		return;
	}
	m.history.at = i;
	const e = m.entries.get(m.history.ids[i] as string) as Entry;
	reveal(e.id);
	if (m.focus === "stage") focusEntry(e);
}

function stageSession(id: string): void {
	if (m.stage.staged === id) return;
	m.stage.staged = id;
	m.stage.stagedAt = Date.now();
	if (m.stage.ended?.id !== id) m.stage.ended = null;
	// An ask in flight stays, so its directory isn't asked twice; what it shows waits on its own session.
	for (const [dir, ask] of m.editors) if (ask.kind !== "asking") m.editors.delete(dir);
	const e = m.entries.get(id);
	if (e) readTranscript(e, true);
	scheduleHighlightWake();
}

function scheduleHighlightWake(): void {
	if (m.stage.highlightTimer) clearTimeout(m.stage.highlightTimer);
	m.stage.highlightTimer = null;
	const e = m.stage.staged === null ? undefined : m.entries.get(m.stage.staged);
	// A snoozed session is out of the way: looking at it doesn't start it.
	if (!m.config.wakeOnHighlight || !e?.open || e.snoozed || e.live || launchFor(e.id) || m.stage.ended?.id === e.id) return;
	const id = e.id;
	m.stage.highlightTimer = setTimeout(
		() =>
			dispatch(() => {
				m.stage.highlightTimer = null;
				if (m.stage.staged === id) wake(id, false);
			}),
		HIGHLIGHT_MS,
	);
}

function wake(id: string, keyboard: boolean): void {
	if (m.stage.ended?.id === id) m.stage.ended = null;
	const existing = launchFor(id);
	if (existing) {
		existing.keyboard ||= keyboard;
		return;
	}
	if (m.entries.get(id)?.live) return;
	const req = nextReq();
	m.launches.push({ req, id, host: null, since: Date.now(), keyboard });
	post({ type: "wake", req, id });
}

/** Restarts a session's harness, live or not, to carry on; the Stage shows it starting, as a wake does, until it's back. */
function reload(id: string): void {
	if (m.stage.ended?.id === id) m.stage.ended = null;
	if (launchFor(id)) return;
	const req = nextReq();
	m.launches.push({ req, id, host: null, since: Date.now(), keyboard: m.focus === "stage" });
	post({ type: "reload", req, id });
}

/** A new session on `target`; with none, the worker picks `harness`'s first preset, or the default, once it knows what can start. */
function newSession(cwd: string, group: string | null, target: LaunchTarget | null, harness: Harness | null = null): void {
	if (newLaunch()) {
		toast("a new session is already starting", "info");
		return;
	}
	const req = nextReq();
	m.launches.push({ req, id: null, host: null, since: Date.now(), keyboard: true });
	m.stage.holdForNew = true;
	m.stage.staged = null;
	m.stage.ended = null;
	post({ type: "new", req, cwd, group, target, harness });
	focusOnceShown(() => panes.side?.pane ?? stagePane);
}

/** Launches whose host is now live resolve; one whose host vanished first failed to start. */
function settleLaunches(): void {
	if (!m.snapshot) return;
	const hosts = new Set(m.snapshot.hosts);
	for (const launch of [...m.launches]) {
		if (launch.host === null) continue;
		const live = [...m.entries.values()].find((e) => e.live && e.host === launch.host);
		if (live) {
			m.launches.splice(m.launches.indexOf(launch), 1);
			if ((launch.id === null && m.stage.staged === null) || (launch.id !== null && m.stage.staged === launch.id)) {
				m.selectedKey = live.id;
				stageSession(live.id);
			}
			continue;
		}
		if (hosts.has(launch.host)) continue;
		const lastWords = m.snapshot.died[launch.host] ?? [];
		launchEnded(
			launch,
			lastWords,
			lastWords.length > 0 ? `the session failed to start: ${lastWords.at(-1)}` : "the session failed to start",
		);
	}
}

/**
 * A launch that won't come up, whether its host died or it never got one. On view, its session's card says why; a new
 * session's Stage goes back to the cursor's. The keyboard comes back to the roster either way, from a Stage with
 * nothing on it to type into.
 */
function launchEnded(launch: Launch, lines: string[], text: string): void {
	m.launches.splice(m.launches.indexOf(launch), 1);
	if (launch.id !== null && m.stage.staged === launch.id) m.stage.ended = { id: launch.id, failed: true, lines };
	else toast(text, "error");
	if (launch.id === null && m.stage.staged === null) {
		m.stage.holdForNew = false;
		const e = cursorEntry();
		if (e) stageSession(e.id);
	}
	if (launch.keyboard || m.focus === "stage") {
		// The keyboard may still be on its way to the launch: that move is called off, and if it already went, its arrival
		// isn't a move onto what's staged now.
		m.focusMoves++;
		m.returning = true;
		afterCommit(() => void panes.showRoster(true));
	}
}

/** Whatever the Stage's host now runs is what's selected: `/new` or `/resume` inside pi moves the selection with it. */
function followHost(): void {
	// A session that quit while watched and is back, woken by a message or restarted by its reload, shows live again.
	if (m.stage.ended && !m.stage.ended.failed && m.entries.get(m.stage.ended.id)?.live) {
		m.stage.ended = null;
		return;
	}
	const { id, host } = panes.applied;
	if (id === null || host === null) return;
	const e = m.entries.get(id);
	if (e?.live && e.host === host) return;
	const moved = [...m.entries.values()].find((x) => x.live && x.host === host);
	if (moved) {
		m.selectedKey = moved.id;
		m.stage.staged = moved.id;
		m.stage.stagedAt = Date.now();
		return;
	}
	// A reload stops it on purpose; its new host takes over the Stage.
	if (launchFor(id)) return;
	m.stage.ended = { id, failed: false, lines: [] };
	if (m.focus === "stage") afterCommit(() => void panes.showRoster(true));
}

/**
 * Where the first snapshot puts the cursor: `swb open`'s session, `-c`'s most recent session here, where the last Deck in
 * this Project left it, else the session I last visited. Only `-c` takes the keyboard.
 */
function startCursor(): void {
	m.started = true;
	// `[` reaches back past this Deck, through the Visits every Deck and tmux client before it made.
	m.history.ids = [...m.entries.values()]
		.filter((e) => e.open && e.visitedAt !== null)
		.sort((a, b) => (a.visitedAt ?? 0) - (b.visitedAt ?? 0))
		.map((e) => e.id);
	m.history.at = m.history.ids.length - 1;
	if (args.select || args.new) return;
	// A snoozed session is out of the way until it wakes: neither -c nor the last visit lands on one.
	const open = [...m.entries.values()].filter((e) => e.open && !e.provisional && !e.snoozed);
	if (args.continue) {
		const recent = open
			.filter((e) => e.project === m.hereRoot)
			.sort((a, b) => (b.visitedAt ?? 0) - (a.visitedAt ?? 0) || b.activityAt - a.activityAt)[0];
		if (!recent) {
			newSession(here, null, null);
			return;
		}
		reveal(recent.id);
		m.continueTo = recent;
		return;
	}
	// Nor does where the last Deck left off, if it has been snoozed since.
	const restored = m.restoredKey === null ? undefined : m.entries.get(m.restoredKey);
	if (restored?.open && !restored.snoozed) {
		reveal(restored.id);
		return;
	}
	if (m.restoredKey !== null && !restored?.snoozed && rosterRows().some((row) => row.key === m.restoredKey)) {
		m.selectedKey = m.restoredKey;
		return;
	}
	const visited = open.filter((e) => e.visitedAt !== null).sort((a, b) => (b.visitedAt ?? 0) - (a.visitedAt ?? 0))[0];
	if (visited) reveal(visited.id);
}

let savedLayout = "";

let draftLayout = "";

let draftSince = 0;

/** Keeps this Project's layout for the next Deck opened in it, once it has held still for a moment. */
function keepLayout(now: number): void {
	if (!m.started) return;
	const kept: DeckLayout = {
		selectedKey: m.selectedKey,
		rosterCols: panes.dragged,
		collapsed: [...m.collapsed],
		expanded: [...m.expanded],
	};
	const json = JSON.stringify(kept);
	if (json !== draftLayout) {
		draftLayout = json;
		draftSince = now;
		return;
	}
	if (json === savedLayout || now - draftSince < LAYOUT_SETTLE_MS) return;
	savedLayout = json;
	post({ type: "layout", layout: kept });
}

function onSnapshot(next: Snapshot): void {
	if (m.snapshot === null) mark("roster.first-snapshot");
	m.snapshot = next;
	m.entries = new Map(next.entries.map((e) => [e.id, e]));
	for (const [id, { view }] of m.localViews) if (m.entries.get(id)?.view === view) m.localViews.delete(id);
	for (const [id, { name }] of m.localGroups) {
		const e = m.entries.get(id);
		if (!e || e.group === name) m.localGroups.delete(id);
	}
	// Ctrl-D in a shell is the same as hiding it.
	for (const dir of m.shellsShown) if (!next.shells[dir]) m.shellsShown.delete(dir);
	settleLaunches();
	followHost();
	settlePin();
	if (!m.started) startCursor();
	const e = m.stage.staged === null ? undefined : m.entries.get(m.stage.staged);
	if (e) readTranscript(e, false);
	// A turn that lands while I'm already watching is seen as it lands; commit settles what I'm watching.
	afterCommit(() => {
		if (m.stage.watched && m.stage.visited && m.entries.get(m.stage.watched)?.unseen) post({ type: "visit", id: m.stage.watched });
	});
	checkReady();
}

// ── worker ──────────────────────────────────────────────────────────────

// The compiled binary embeds the worker relative to its entrypoints' common root, packages/cli/src, and only a plain
// string path finds it there.
const worker = new Worker("./deck/worker.ts");

function post(message: ToWorker): void {
	worker.postMessage(message);
}

// Nothing works without the worker; a Deck that can't reach the db says so instead of showing a stale list.
worker.onerror = (event: ErrorEvent) => {
	m.toasts.push({ text: `worker died: ${event.message}`, level: "error", until: Number.POSITIVE_INFINITY });
	screen.requestRender();
};

worker.onmessage = (event: MessageEvent<FromWorker>) => dispatch(() => onWorker(event.data));

function onWorker(message: FromWorker): void {
	switch (message.type) {
		case "restore":
			m.hereRoot = message.root;
			if (message.layout) {
				m.collapsed = new Set(message.layout.collapsed);
				m.expanded = new Set(message.layout.expanded.flatMap((saved) => SECTION_KEYS.filter((key) => key === saved)));
				panes.dragged = message.layout.rosterCols;
				m.restoredKey = message.layout.selectedKey;
				afterCommit(() => void panes.layout());
			}
			break;
		case "snapshot":
			onSnapshot(message.snapshot);
			break;
		case "launched": {
			const launch = m.launches.find((l) => l.req === message.req);
			if (launch) launch.host = message.host;
			break;
		}
		case "transcript":
			m.transcripts.set(message.id, { transcript: message.transcript, error: message.error });
			break;
		case "peek":
			onPeekInfo(message.id, message.info);
			break;
		case "done": {
			const { req, error } = message;
			if (m.pin?.req === req) {
				if (error === null) m.pin.answered = true;
				else {
					m.pin = null;
					m.lingering = null;
				}
			}
			if (error === null) break;
			for (const [id, local] of m.localViews) if (local.req === req) m.localViews.delete(id);
			for (const [id, local] of m.localGroups) if (local.req === req) m.localGroups.delete(id);
			toast(error, "error");
			break;
		}
		case "stopFailed":
			toast(message.text, "error");
			break;
		case "launchFailed": {
			const launch = m.launches.find((l) => l.req === message.req);
			if (launch) launchEnded(launch, [message.text], message.text);
			else toast(message.text, "error");
			break;
		}
		case "editor":
			onEditor(message.dir, message.name);
			if (message.text) toast(`editor: ${message.text}`, "error");
			break;
		case "shell":
			if (message.text) toast(`shell: ${message.text}`, "error");
			if (m.shellsAsked.get(message.dir) !== message.req) break;
			m.shellsAsked.delete(message.dir);
			if (message.name) showShell(message.dir);
			break;
		case "dirs": {
			// The highlight stays on its directory through a fresh list.
			const choosing = pickerMode();
			const before = choosing && pickRows()[choosing.choice];
			m.dirTrees = message.trees;
			if (choosing?.mode === "pick") {
				const rows = pickRows();
				// Before the first list landed there was nothing to highlight but the directory it opened on.
				const path = before?.kind === "target" ? before.target.path : choosing.pin;
				const at = rows.findIndex((r) => r.kind === "target" && r.target.path === path);
				choosing.choice = at === -1 ? Math.min(choosing.choice, rows.length - 1) : at;
			}
			break;
		}
		case "catalog":
			m.catalog = message.catalog;
			break;
		case "error":
			toast(message.text, "error");
			break;
	}
}

// ── roster ──────────────────────────────────────────────────────────────

async function clip(text: string): Promise<void> {
	const proc = Bun.spawn(["/bin/sh", "-c", m.config.clipboard], { stdin: new Blob([text]), stdout: "ignore", stderr: "pipe" });
	const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	if (code !== 0) throw new Error(stderr.trim() || `${m.config.clipboard} exited ${code}`);
}

/** `swb open` and `swb show`: select a session wherever it is, opening the section, project, and families that hide it. */
function reveal(id: string): void {
	const e = m.entries.get(id);
	if (!e) {
		toast(`no open or archived session ${id}`, "error");
		return;
	}
	if (!matches(e)) m.filter.setValue("");
	const section = sectionOf(e);
	if (section === "archived" || section === "operators" || section === "snoozed") m.expanded.add(section);
	else {
		if (section === "inactive") m.expanded.add("inactive");
		const group = groupOf(e);
		m.collapsed.delete(`${section}:${e.project}`);
		if (group) m.collapsed.delete(`${section}:${e.project}:${groupKey(group)}`);
	}
	for (let up = parentOf(e); up; up = parentOf(up)) m.collapsed.delete(foldKey(up.id));
	m.selectedKey = id;
}

const SECTION_KEYS: SectionKey[] = ["operators", "inactive", "snoozed", "archived"];

/** `s`'s menu: Amp's presets. */
export const SNOOZE_CHOICES: { label: string; snooze: SnoozePreset }[] = [
	{ label: "1 hour", snooze: "one_hour" },
	{ label: "1 day", snooze: "one_day" },
	{ label: "Monday", snooze: "monday" },
	{ label: "Until a message", snooze: "next_message" },
];

const isHeader = (row: Row) => row.kind !== "session";

export const levelOf = (nest: Nest | null) => (nest === null ? 0 : nest.continues.length + 1);

const flat = (e: Entry, depth: number, header: string): SessionRow => ({
	kind: "session",
	key: e.id,
	entry: e,
	depth,
	header,
	nest: null,
	family: [],
	folded: false,
});

const isCollapsed = (row: Row) => (row.kind === "header" ? row.collapsed : row.kind === "section" ? !row.expanded : false);

function groupByProject(list: Entry[]): [string, Entry[]][] {
	const groups = new Map<string, Entry[]>();
	for (const e of [...list].sort((a, b) => b.activityAt - a.activityAt)) {
		const group = groups.get(e.project) ?? [];
		group.push(e);
		groups.set(e.project, group);
	}
	return [...groups.entries()].sort(([a], [b]) => projectName(a).localeCompare(projectName(b)) || a.localeCompare(b));
}

function groupKey(group: string): string {
	return `g:${group}`;
}

export function cursorLine(line: string, focused: boolean): string {
	line = line.replaceAll("\x1b[2m", "");
	if (!m.cursorBg) return focused ? sgrBg("7", line) : sgrBg("4", line);
	return sgrBg(focused ? m.cursorBg.focused : m.cursorBg.unfocused, line);
}

export function hoverLine(line: string): string {
	return m.cursorBg ? sgrBg(m.cursorBg.hover, line.replaceAll("\x1b[2m", "")) : line;
}

export const frame: Frame = {
	scrollTop: 0,
	pickerTop: 0,
	pickerListY: 0,
	card: null,
	over: [],
	wanted: { floats: [], leaves: false, spot: null },
	frameQueued: false,
	listTop: 0,
	listHeight: 0,
	promptGap: null,
	details: null,
	targets: [],
	keyAt: 0,
};

export function filtering(): boolean {
	return m.mode.kind === "filter";
}

export function nameMode(): NameMode | null {
	return m.mode.kind === "name" ? m.mode : null;
}

export function snoozeMode(): SnoozeMode | null {
	return m.mode.kind === "snooze" ? m.mode : null;
}

/** The session whose archive prompt offers its family or linked worktree. */
export function archiving(): string | null {
	return m.mode.kind === "archive" ? m.mode.id : null;
}

/** The schedules archiving cancels, by session, the session first, then with `all` its family: each schedule once. */
export function archiveCancels(e: Entry, all: boolean): { entry: Entry; schedules: Entry["pending"] }[] {
	const seen = new Set<string>();
	return [e, ...(all ? openDescendants(m.entries.values(), e.id) : [])].flatMap((entry) => {
		const schedules = entry.pending.filter((p) => !seen.has(p.id));
		for (const p of schedules) seen.add(p.id);
		return schedules.length > 0 ? [{ entry, schedules }] : [];
	});
}

export function pickerMode(): Choosing | null {
	return m.mode.kind === "picker" ? m.mode.picker : null;
}

export function settingsPane(): SettingsPane | null {
	return m.mode.kind === "settings" ? m.mode.pane : null;
}

/** Leaves the mode it's in for `next`. */
/** A mode takes keys, so one opened while the Stage has the keyboard brings it to the roster. */
function enter(next: Mode): void {
	leave();
	m.mode = next;
	if (m.focus === "stage") afterCommit(() => void panes.showRoster(true));
}

/**
 * Back to the roster, abandoning what the mode was doing: the filter keeps its query, a prompt or picker closes
 * unanswered, and Settings saves what its editor holds.
 */
function leave(): void {
	const was = m.mode;
	m.mode = { kind: "roster" };
	if (was.kind === "settings") {
		was.pane.saveProse();
		afterCommit(() => panes.zoomRoster(false));
	}
}

export function dragging(): Drag | null {
	return m.gesture.kind === "drag" ? m.gesture : null;
}

export function query(): string {
	return m.filter.getValue().trim().toLowerCase();
}

function matches(e: Entry): boolean {
	const q = query();
	const label = groupOf(e) ?? "";
	return q === "" || `${displayName(e)} ${projectName(e.project)} ${e.branch ?? ""} ${label}`.toLowerCase().includes(q);
}

export function rosterRows(): Row[] {
	const rows: Row[] = [];
	const all = [...m.entries.values()].filter((e) => matches(e));
	// Keep a match's ancestors as context, so filtering doesn't turn a child into a new root.
	const included = new Set(all.map((e) => e.id));
	for (const e of all) {
		const parent = parentOf(e);
		if (
			parent &&
			!included.has(parent.id) &&
			!parent.operator &&
			parent.project === e.project &&
			groupOf(parent) === groupOf(e) &&
			sectionOf(parent) === sectionOf(e)
		) {
			included.add(parent.id);
			all.push(parent);
		}
	}
	const lingers = (e: Entry) => !e.open && e.id === m.lingering && e.id === m.selectedKey;
	const open = all.filter((e) => e.open || lingers(e));
	const sectionHere = (e: Entry) => (lingers(e) ? (e.operator ? "operators" : "open") : sectionOf(e));
	// A session nests under its parent when they share a bucket. Siblings, and families, go by the newest activity
	// anywhere beneath them, so a busy grandchild brings its whole line up.
	const pushFamilies = (members: Entry[], depth: number, header: string) => {
		const here = new Set(members.map((e) => e.id));
		const kids = new Map<string, Entry[]>();
		const roots: Entry[] = [];
		for (const e of members) {
			if (e.parentId === null || !here.has(e.parentId)) {
				roots.push(e);
				continue;
			}
			const siblings = kids.get(e.parentId);
			if (siblings) siblings.push(e);
			else kids.set(e.parentId, [e]);
		}
		const latest = new Map<string, number>();
		const latestOf = (e: Entry): number => {
			let at = latest.get(e.id);
			if (at === undefined) {
				at = Math.max(e.activityAt, ...(kids.get(e.id) ?? []).map(latestOf));
				latest.set(e.id, at);
			}
			return at;
		};
		const newest = (a: Entry, b: Entry) => latestOf(b) - latestOf(a);
		const tree = (e: Entry, nest: Nest | null): { entry: Entry; nest: Nest | null }[] => {
			const children = (kids.get(e.id) ?? []).sort(newest);
			const continues = nest ? [...nest.continues, !nest.last] : [];
			return [{ entry: e, nest }, ...children.flatMap((c, i) => tree(c, { continues, last: i === children.length - 1 }))];
		};
		for (const root of roots.sort(newest)) {
			const placed = tree(root, null);
			for (let i = 0; i < placed.length; ) {
				const { entry, nest } = placed[i] as { entry: Entry; nest: Nest | null };
				const level = levelOf(nest);
				let end = i + 1;
				while (end < placed.length && levelOf((placed[end] as { nest: Nest | null }).nest) > level) end++;
				const family = placed.slice(i + 1, end).map((p) => {
					const at = p.nest as Nest;
					return { entry: p.entry, nest: { continues: at.continues.slice(level), last: at.last } };
				});
				// A filter shows every match, folded or not.
				const folded = family.length > 0 && m.collapsed.has(foldKey(entry.id)) && query() === "";
				rows.push({ kind: "session", key: entry.id, entry, depth, header, nest, family, folded });
				i = folded ? end : i + 1;
			}
		}
	};
	const pushGroups = (list: Entry[], depth: number, parent: string) => {
		for (const [project, members] of groupByProject(list)) {
			const key = `${parent}:${project}`;
			const collapsed = query() === "" && m.collapsed.has(key);
			rows.push({ kind: "header", key, projectKey: key, project, group: null, cwd: project, count: members.length, depth, collapsed });
			if (collapsed) continue;
			// Groups sit beneath the Project, ahead of its sessions in none.
			const buckets = new Map<string, Entry[]>();
			const loose: Entry[] = [];
			for (const e of members) {
				const group = groupOf(e);
				if (group === null) loose.push(e);
				else buckets.set(group, [...(buckets.get(group) ?? []), e]);
			}
			const sorted = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
			for (const [group, inside] of sorted) {
				const subKey = `${key}:${groupKey(group)}`;
				const subCollapsed = query() === "" && m.collapsed.has(subKey);
				const cwd = (inside[0] as Entry).cwd;
				rows.push({
					kind: "header",
					key: subKey,
					projectKey: key,
					project,
					group,
					cwd,
					count: inside.length,
					depth: depth + 1,
					collapsed: subCollapsed,
				});
				if (!subCollapsed) pushFamilies(inside, depth + 1, subKey);
			}
			pushFamilies(loose, depth, key);
		}
	};
	// A filter opens every section it has matches in, so a match is never hidden behind a caret.
	const section = (key: SectionKey, label: string, count: number) => {
		if (query() !== "" && count === 0) return false;
		const expanded = m.expanded.has(key) || (query() !== "" && count > 0);
		rows.push({ kind: "section", key, label, count, expanded });
		return expanded;
	};
	const operators = open.filter((e) => e.operator && !e.snoozed).sort((a, b) => b.activityAt - a.activityAt);
	if (section("operators", "Operators", operators.length)) {
		for (const e of operators) rows.push(flat(e, 0, "operators"));
	}
	pushGroups(
		open.filter((e) => sectionHere(e) === "open"),
		0,
		"open",
	);
	const idle = open.filter((e) => sectionHere(e) === "inactive");
	if (idle.length > 0 && section("inactive", "Inactive", idle.length)) pushGroups(idle, 1, "inactive");
	// Soonest to wake first; one waiting on a message has no time, so it comes last.
	const resting = open
		.filter((e) => e.snoozed)
		.sort(
			(a, b) => (a.snoozedUntil ?? Number.POSITIVE_INFINITY) - (b.snoozedUntil ?? Number.POSITIVE_INFINITY) || b.activityAt - a.activityAt,
		);
	if (resting.length > 0 && section("snoozed", "Snoozed", resting.length)) {
		for (const e of resting) rows.push(flat(e, 0, "snoozed"));
	}
	const archived = all.filter((e) => !e.open && !lingers(e)).sort((a, b) => archivedKey(b) - archivedKey(a));
	if (section("archived", "Archived", archived.length)) {
		for (const e of archived) rows.push(flat(e, 0, "archived"));
	}
	return rows;
}

/** The cursor follows the selected key through reorders; if that row vanished, it stays at the same index. */
/** The cursor's index in rows, without moving anything: what a frame and `deck state` show. */
export function cursorIndex(rows: Row[]): number {
	if (rows.length === 0) return -1;
	let index = rows.findIndex((r) => r.key === m.selectedKey);
	if (index === -1 && m.selectedKey === "") {
		// Nothing chosen yet: land on the first session past the Operators, and don't settle on a section before the first
		// snapshot fills in.
		index = rows.findIndex((r) => r.kind === "session" && !r.entry.operator);
		if (index === -1) index = rows.findIndex((r) => r.kind === "session");
		if (index === -1)
			return Math.max(
				0,
				rows.findIndex((r) => r.kind !== "section" || r.key !== "operators"),
			);
	}
	if (index === -1) index = Math.min(m.lastIndex, rows.length - 1);
	return index;
}

/** Settles the cursor on a row of rows, once there are sessions to settle on, and returns its index. */
function resolveCursor(rows: Row[]): number {
	const index = cursorIndex(rows);
	if (index < 0 || (!rows.some((r) => r.kind === "session") && m.selectedKey === "")) return index;
	m.selectedKey = (rows[index] as Row).key;
	m.lastIndex = index;
	// Left by any means, a lingering row is in Archived for good, even when the cursor comes back to it there.
	if (m.lingering !== m.selectedKey) m.lingering = null;
	return index;
}

/**
 * What a change leaves to settle: the cursor on a row, a prompt whose row is gone put away, a typed path's completions
 * read, and the Stage on the cursor's session; it stays put while the cursor is on a header, and while a new session
 * starts, until the cursor moves.
 */
function normalize(): void {
	const rows = rosterRows();
	const row = rows[resolveCursor(rows)];
	if (archiving() !== null && !rows.some((r) => r.key === archiving())) leave();
	if (pickerMode()?.mode === "add") addRows();
	if (row?.kind !== "session" || row.entry.id === m.stage.staged || (m.stage.staged === null && newLaunch() && m.stage.holdForNew)) return;
	stageSession(row.entry.id);
}

function selected(): Row | undefined {
	const rows = rosterRows();
	return rows[cursorIndex(rows)];
}

export function cursorEntry(): Entry | null {
	const row = selected();
	return row?.kind === "session" ? row.entry : null;
}

function input(data: string): void {
	if (isKeyRelease(data)) return;
	// A key reaches the roster only while its pane has the keyboard, ahead of the focus hook saying so.
	focusOn(rosterPane);
	const peek = m.mode.kind === "roster" ? m.peek.settled : null;
	const binding = bindingFor(keymap(), data);
	let command = binding?.command;
	if (peek && command?.kind === "row") command = { ...command, row: peek.id };
	if (peek && command?.kind === "activate" && command.enter) command = { kind: "row", act: "focus", row: peek.id };
	m.hover = null;
	m.pointer = null;
	m.peek.byKeys = false;
	syncPeek(null);
	panes.keyAt = performance.now();
	frame.keyAt = panes.keyAt;
	// A key puts the toasts away, all but a stopped worker's: the Deck can't go on without it.
	m.toasts = m.toasts.filter((t) => t.until === Number.POSITIVE_INFINITY);
	const settings = settingsPane();
	if (settings) {
		settings.handleInput(data);
		return;
	}
	if (command) run(command);
	else if (!binding && typing()) run({ kind: "type", data });
}

/** Whether the mode has a field that takes the keys its keymap doesn't. */
function typing(): boolean {
	const choosing = pickerMode();
	return filtering() || nameMode() !== null || (choosing !== null && !choosing.confirm);
}

/** Every key, click, prefix key, and button ends here. */
function run(c: Command): void {
	switch (c.kind) {
		case "step":
			stepMode(c.by);
			break;
		case "choose":
			choose(c.index);
			break;
		case "cancel":
			cancel();
			break;
		case "type":
			typeInto(c.data);
			break;
		case "activate":
			activate(c.enter);
			break;
		case "unfold":
			if (c.open) right();
			else left();
			break;
		case "select":
			select(c.key, c.index);
			break;
		case "fold": {
			const row = rosterRows().find((r): r is SessionRow => r.kind === "session" && r.key === c.id);
			if (row) setFolded(row, !row.folded);
			break;
		}
		case "moveSession":
			moveSession(c.by);
			break;
		case "row":
			act(c.act, c.row === null ? selected() : rosterRows().find((r) => r.key === c.row));
			break;
		case "archiveAnswer":
			finishArchiving(c.all, c.deleteWorktree);
			break;
		case "history":
			goHistory(c.step);
			break;
		case "reveal":
			reveal(c.id);
			break;
		case "filter":
			enter({ kind: "filter" });
			break;
		case "clearFilter":
			if (filtering()) leave();
			m.filter.setValue("");
			break;
		case "addDir":
			openPicker("add", null, null);
			break;
		case "menu":
			toggleMenu();
			break;
		case "complete":
			complete();
			break;
		case "remove":
			askRemove();
			break;
		case "view": {
			const e = m.stage.staged === null ? undefined : m.entries.get(m.stage.staged);
			if (e) showView(e, c.view);
			break;
		}
		case "shell":
			toggleShell();
			break;
		case "details":
			m.details.expanded = !m.details.expanded;
			m.details.top = 0;
			break;
		case "detailScroll":
			if (frame.details) m.details.top = Math.max(0, Math.min(frame.details.total - frame.details.height, m.details.top + c.by));
			break;
		case "dismissPeek":
			m.peek.dismissed = m.peek.settled?.id ?? null;
			m.peek.byKeys = false;
			syncPeek(null);
			break;
		case "roster":
			if (c.to === "hide") {
				if (!settingsPane()) afterCommit(() => void panes.hideRoster());
			} else afterCommit(() => void panes.showRoster(c.to === "focus"));
			break;
		case "settings":
			openSettings();
			break;
		case "config":
			afterCommit(() => openConfig(c.line));
			break;
		case "help":
			afterCommit(() => void showHelp());
			break;
		case "quit":
			afterCommit(quit);
			break;
	}
}

/** A row's own command, from its key on the cursor's row, its Peek's buttons, or a prefix key. */
function act(act: RowAct, row: Row | undefined): void {
	switch (act) {
		case "focus":
			if (row?.kind === "session") {
				reveal(row.entry.id);
				focusEntry(row.entry);
			}
			break;
		case "wake":
			wakeRow(row);
			break;
		case "stop":
			stopRow(row);
			break;
		case "reload":
			reloadRow(row);
			break;
		case "archive":
			toggleArchived(row);
			break;
		case "snooze":
			toggleSnooze(row);
			break;
		case "unseen":
			toggleUnseen(row);
			break;
		case "parent":
			toParent(row);
			break;
		case "copyOpen":
			copy(true, row);
			break;
		case "copyMention":
			copy(false, row);
			break;
		case "new":
			newAt(row);
			break;
		case "group":
			startNaming(row);
			break;
	}
}

/** The mode's highlight moves by `by`: the cursor, or a prompt's, picker's, or menu's choice. */
function stepMode(by: number): void {
	const mode = m.mode;
	if (mode.kind === "roster" || mode.kind === "filter") move(by);
	else if (mode.kind === "snooze") mode.choice = Math.max(0, Math.min(SNOOZE_CHOICES.length - 1, mode.choice + by));
	else if (mode.kind === "name") mode.choice = Math.max(0, Math.min(nameChoices().length - 1, mode.choice + by));
	else if (mode.kind === "picker") {
		const choosing = mode.picker;
		if (choosing.confirm) return;
		if (choosing.menu) {
			choosing.menu.cursor = Math.max(0, Math.min(menuPresets(choosing.menu.query).length - 1, choosing.menu.cursor + by));
			return;
		}
		const first = choosing.mode === "pick" ? 0 : -1;
		const count = choosing.mode === "pick" ? pickRows().length : addRows().length;
		choosing.choice = Math.max(first, Math.min(count - 1, choosing.choice + by));
	}
}

/** ⏎, or a click on a choice: what the mode's choice does. */
function choose(index: number | null): void {
	const mode = m.mode;
	if (mode.kind === "filter") leave();
	else if (mode.kind === "snooze") {
		const choice = SNOOZE_CHOICES[index ?? mode.choice];
		if (choice) finishSnooze(choice.snooze);
	} else if (mode.kind === "name") {
		const choice = nameChoices()[index ?? mode.choice];
		if (choice) finishNaming(choice.name);
	} else if (mode.kind === "picker") {
		const choosing = mode.picker;
		if (choosing.confirm) finishRemove(true);
		else if (choosing.menu) {
			const preset = menuPresets(choosing.menu.query)[index ?? choosing.menu.cursor];
			if (preset !== undefined) choosePreset(preset);
		} else {
			if (index !== null) choosing.choice = index;
			pickerEnter();
		}
	}
}

/** esc, or a ✕: the mode backs out a step. */
function cancel(): void {
	const mode = m.mode;
	if (mode.kind === "filter") {
		m.filter.setValue("");
		leave();
	} else if (mode.kind === "name" || mode.kind === "snooze") leave();
	else if (mode.kind === "archive") finishArchiving(null);
	else if (mode.kind === "picker") {
		const choosing = mode.picker;
		if (choosing.confirm) finishRemove(false);
		else if (choosing.menu) choosing.menu = null;
		else if (choosing.mode === "add" && choosing.opened === "pick") {
			choosing.mode = "pick";
			choosing.choice = pickRows().length - 1;
		} else closePicker();
	}
}

/** A key into the mode's field. */
function typeInto(data: string): void {
	const naming = nameMode();
	const choosing = pickerMode();
	if (filtering()) {
		m.filter.handleInput(data);
		const rows = rosterRows();
		const first = rows.find((r) => r.kind === "session" && matches(r.entry));
		if (first && !rows.some((r) => r.kind === "session" && r.key === m.selectedKey && matches(r.entry))) m.selectedKey = first.key;
	} else if (naming) {
		const before = naming.input.getValue();
		naming.input.handleInput(data);
		const refused = unnameable(naming.input.getValue());
		if (refused.length > 0) {
			naming.input.setValue(before);
			toast(`a Group's name can't hold ${refused.map((char) => JSON.stringify(char)).join(" ")}`, "info");
		}
		naming.choice = 0;
	} else if (choosing?.menu) {
		const menu = choosing.menu;
		const k = decodeKittyPrintable(data) ?? data;
		if (matchesKey(data, "backspace")) menu.query = menu.query.slice(0, -1);
		else if (k.length === 1 && k >= " ") menu.query += k;
		else return;
		menu.cursor = 0;
	} else if (choosing?.mode === "pick") {
		m.search.handleInput(data);
		const typed = m.search.getValue();
		// A path typed into the search is an add.
		if (typed.startsWith("/") || typed.startsWith("~")) {
			choosing.mode = "add";
			m.path.setValue(typed);
			m.search.setValue("");
			choosing.choice = typedChoice(typed);
			return;
		}
		choosing.choice = bestMatch();
	} else if (choosing) {
		m.path.handleInput(data);
		choosing.choice = typedChoice(m.path.getValue());
	}
}

/** A click on a row: the cursor goes there, and it acts as ⏎ does. Picking a row is done filtering, and the filter stays. */
function select(key: string, index: number): void {
	if (filtering()) leave();
	const row = rosterRows().find((r) => r.key === key);
	if (!row) return;
	m.selectedKey = key;
	m.lastIndex = index;
	m.stage.holdForNew = false;
	if (isHeader(row)) toggle(row);
	else focusEntry(row.entry);
}

/** The click target under a point, as of the last render. */
function targetAt(p: { x: number; y: number } | null): ClickTarget | undefined {
	return p ? frame.targets.find((t) => t.y === p.y && p.x >= t.from && p.x < t.to) : undefined;
}

function press(p: { x: number; y: number }): ClickTarget | undefined {
	const target = targetAt(p);
	m.gesture = target ? { kind: "press", target } : { kind: "none" };
	return target;
}

/** The button a click lands on: the one under its press. */
function clicked(): ClickTarget | null {
	const target = m.gesture.kind === "press" ? m.gesture.target : null;
	m.gesture = { kind: "none" };
	return target;
}

function mouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
	// A control under the pointer lights up, wherever it is.
	let relit = false;
	// tmux selects the pane before it hands over a press, ahead of the focus hook saying so.
	if (event.type === "press" && event.button === "left") focusOn(rosterPane);
	const settings = settingsPane();
	if (settings) return settings.handleMouse(event);
	if (event.type === "move") {
		screen.pointerAway();
		const before = targetAt(m.pointer);
		m.pointer = { x: event.x, y: event.y };
		m.peek.dismissed = null;
		if (m.peek.settled) expirePeek();
		relit = targetAt(m.pointer) !== before;
	}
	// A prompt answers to its own buttons, never the rows underneath it.
	if (archiving() !== null || nameMode() || snoozeMode()) {
		if (event.type === "move") return { handled: true, render: relit };
		if (event.type === "wheel" && archiving() === null) run({ kind: "step", by: Math.sign(event.wheelDelta ?? 0) });
		else if (event.button === "left" && event.type === "press") press(event);
		else if (event.button === "left" && event.type === "click") {
			const target = clicked();
			if (target?.command) run(target.command);
		}
		return { handled: true, render: true };
	}
	const choosing = pickerMode();
	if (choosing) {
		const listRow = frame.pickerTop + event.y - frame.pickerListY;
		if (event.type === "move") {
			if (choosing.confirm || choosing.menu || event.y < frame.pickerListY || event.y >= frame.pickerListY + frame.listHeight)
				return { handled: true, render: relit };
			const count = choosing.mode === "pick" ? pickRows().length : addRows().length;
			if (listRow < count && listRow !== choosing.choice) {
				choosing.choice = listRow;
				return { handled: true, render: true };
			}
			return { handled: true, render: relit };
		}
		if (event.type === "wheel") run({ kind: "step", by: Math.sign(event.wheelDelta ?? 0) });
		else if (event.button === "left" && event.type === "press") press(event);
		else if (event.button === "left" && event.type === "click") {
			const target = clicked();
			if (target?.command) run(target.command);
			else if (!target && choosing.menu) choosing.menu = null;
		}
		return { handled: true, render: true };
	}
	if (event.type === "move") {
		const on = frame.over.find((o) => event.x >= o.x && event.x < o.x + o.width && event.y >= o.y && event.y < o.y + o.view.lines.length);
		if (on) {
			if (on.hovers === null || on.hovers === m.hover) return { handled: true, render: relit };
			cancelPendingPeek();
			m.hover = on.hovers;
			return { handled: true, render: true };
		}
		const row = rowAt(event.y);
		const hover = row?.kind === "session" ? row.key : null;
		if (hover === m.hover) return { handled: true, render: relit };
		m.hover = hover;
		return { handled: true, render: true };
	}
	if (event.type === "wheel") {
		run({ kind: frame.details && event.y >= frame.details.y ? "detailScroll" : "step", by: Math.sign(event.wheelDelta ?? 0) });
		return { handled: true };
	}
	if (event.button !== "left") return undefined;
	// Clicking the roster focuses it, and its focus hook can re-render the legend before the release: the target is the
	// one under the press.
	if (event.type === "press") {
		const target = press(event);
		const row = rowAt(event.y);
		if (target || row?.kind !== "session" || !row.entry.open || row.entry.operator) return undefined;
		m.gesture = { kind: "drag", id: row.entry.id, moved: false, drop: null };
		return { capture: true };
	}
	const drag = dragging();
	if (event.type === "drag" && drag) {
		const e = m.entries.get(drag.id);
		drag.moved = true;
		drag.drop = e ? dropAt(event.y, e) : null;
		return { handled: true };
	}
	if (event.type === "release" && drag) {
		finishDrag(event.y);
		return { handled: true, render: true };
	}
	if (event.type !== "click") return undefined;
	const target = clicked();
	if (target) {
		if (target.command) run(target.command);
		return { handled: true };
	}
	const row = rowAt(event.y);
	if (!row) return undefined;
	run({ kind: "select", key: row.key, index: rosterRows().findIndex((r) => r.key === row.key) });
	return { handled: true };
}

/**
 * Where a Peek belongs: beside the row under the pointer, else, after a navigation key, beside the cursor's while the
 * roster has the keyboard. Only a session's row on screen has one.
 */
export function peekSpot(rows: Row[], index: number): PeekSpot | null {
	if (
		panes.rosterHidden ||
		panes.narrow ||
		pickerMode() ||
		nameMode() ||
		snoozeMode() ||
		dragging() ||
		archiving() !== null ||
		settingsPane()
	)
		return null;
	const spot = (i: number, source: "pointer" | "cursor"): PeekSpot | null => {
		const row = rows[i];
		if (row?.kind !== "session" || i < frame.scrollTop || i >= frame.scrollTop + frame.listHeight) return null;
		if (source === "cursor" && row.entry.activity === "blocked") return null;
		return { id: row.key, source, y: frame.listTop + i - frame.scrollTop };
	};
	if (m.hover !== null)
		return spot(
			rows.findIndex((r) => r.key === m.hover),
			"pointer",
		);
	return m.peek.byKeys && m.focus === "roster" ? spot(index, "cursor") : null;
}

function rowAt(y: number): Row | undefined {
	if (frame.promptGap && y >= frame.promptGap.at) {
		if (y < frame.promptGap.at + frame.promptGap.rows) return undefined;
		y -= frame.promptGap.rows;
	}
	if (y < frame.listTop || y >= frame.listTop + frame.listHeight) return undefined;
	return rosterRows()[frame.scrollTop + (y - frame.listTop)];
}

function move(delta: number): void {
	m.peek.byKeys = true;
	const from = stepFrom(delta);
	const rows = rosterRows();
	if (rows.length === 0) return;
	const next = Math.max(0, Math.min(rows.length - 1, from));
	m.selectedKey = (rows[next] as Row).key;
	m.lastIndex = next;
	m.stage.holdForNew = false;
}

/**
 * Where a step of delta from the cursor lands. Off a lingering row, which goes to Archived as the cursor leaves, it
 * counts as if that row were gone already: the row below has taken its place.
 */
function stepFrom(delta: number): number {
	const rows = rosterRows();
	const index = resolveCursor(rows);
	const row = rows[index];
	if (row?.kind !== "session" || row.entry.open || row.entry.id !== m.lingering) return index + delta;
	m.lingering = null;
	return delta > 0 ? index + delta - 1 : index + delta;
}

/** Moves to the next session row in that direction, if there is one. */
function moveSession(delta: number): void {
	const from = stepFrom(delta);
	const rows = rosterRows();
	for (let i = from; i >= 0 && i < rows.length; i += delta) {
		const row = rows[i] as Row;
		if (row.kind !== "session") continue;
		m.selectedKey = row.key;
		m.lastIndex = i;
		m.stage.holdForNew = false;
		return;
	}
}

function activate(enter: boolean): void {
	const row = selected();
	if (!row) return;
	if (row.kind !== "session") toggle(row);
	else if (enter) focusEntry(row.entry);
	else setFolded(row, !row.folded);
}

/** ⏎: wake it if needed and focus it at once; a session still starting holds the keyboard on its loading card. */
function focusEntry(e: Entry): void {
	stageSession(e.id);
	if (!e.live) wake(e.id, true);
	afterCommit(() => void panes.focusStage());
}

function right(): void {
	const row = selected();
	if (!row) return;
	if (row.kind === "session" && row.folded) setFolded(row, false);
	else if (row.kind === "session") focusEntry(row.entry);
	else setExpanded(row, true);
}

function left(): void {
	const row = selected();
	if (row?.kind === "session") setFolded(row, true);
	else if (row) setExpanded(row, false);
}

/** The actions below act on the cursor's row unless given one: a Peek's buttons act on its row, wherever the cursor is. */
function wakeRow(row = selected()): void {
	const e = row?.kind === "session" ? row.entry : null;
	if (!e) return;
	if (e.live) toast("already running", "info");
	else wake(e.id, false);
}

/** R: restarts its harness on the same conversation, so it reads its configuration afresh, and has it carry on. */
function reloadRow(row = selected()): void {
	const e = row?.kind === "session" ? row.entry : null;
	if (!e) return;
	if (!e.open) toast("archived: unarchive it first", "info");
	else if (e.provisional) toast("nothing to reload before the first prompt", "info");
	else reload(e.id);
}

/** x: the counterpart to w. Frees the process and keeps the session open; any unsent prompt is saved as a draft. */
function stopRow(row = selected()): void {
	const e = row?.kind === "session" ? row.entry : null;
	if (!e) return;
	if (!e.live) toast("dormant", "info");
	else post({ type: "stop", req: nextReq(), id: e.id });
}

function promptAnchor(row: Row): { x: number; y: number; row: string } {
	return {
		...(m.pointer ?? { x: 0, y: frame.listTop + rosterRows().findIndex((r) => r.key === row.key) - frame.scrollTop + 1 }),
		row: row.key,
	};
}

/**
 * a: archives or unarchives the session. One that started others still open asks first whether they go too, and one
 * in a linked worktree whether that goes too; then, if any going has schedules, it names them and asks again.
 */
function toggleArchived(row = selected()): void {
	if (row?.kind !== "session" || m.pin) return;
	const e = row.entry;
	if (e.provisional) {
		toast("nothing to archive before the first prompt", "error");
		return;
	}
	const asks = e.worktree !== null || openDescendants(m.entries.values(), e.id).length > 0;
	if (e.open && (asks || e.pending.length > 0)) {
		m.selectedKey = e.id;
		m.hover = null;
		enter({ kind: "archive", at: promptAnchor(row), id: e.id, chosen: asks ? null : { all: false, deleteWorktree: false } });
		return;
	}
	// Only the cursor's own row moving takes the cursor along; archived, it lingers where it is.
	const req = nextReq();
	if (row.key === selected()?.key) {
		m.pin = { index: resolveCursor(rosterRows()), req, answered: false };
		// The cursor's session lingers once archived, and the keyboard comes to the roster to look it over or move on.
		if (e.open) m.lingering = e.id;
		if (e.open && m.focus === "stage") afterCommit(() => void panes.showRoster(true));
	}
	post(e.open ? { type: "archive", req, ids: [e.id] } : { type: "unarchive", req, id: e.id });
}

/** The archive prompt's answer: the session alone, all it started besides, or (null) neither. */
function finishArchiving(all: boolean | null, deleteWorktree = false): void {
	const mode = m.mode;
	const e = mode.kind === "archive" ? m.entries.get(mode.id) : undefined;
	if (mode.kind === "archive" && e && all !== null && mode.chosen === null && archiveCancels(e, all).length > 0) {
		mode.chosen = { all, deleteWorktree };
		return;
	}
	leave();
	if (!e || all === null) return;
	const req = nextReq();
	m.pin = { index: resolveCursor(rosterRows()), req, answered: false };
	m.lingering = e.id;
	post({
		type: "archive",
		req,
		ids: [e.id, ...(all ? openDescendants(m.entries.values(), e.id).map((d) => d.id) : [])],
		...(deleteWorktree ? { deleteWorktreeFor: e.id } : {}),
	});
}

/** h folds the family under a session; l and space open it again. */
function setFolded(row: SessionRow, folded: boolean): void {
	if (row.family.length === 0) return;
	if (folded) m.collapsed.add(foldKey(row.key));
	else m.collapsed.delete(foldKey(row.key));
}

/** p: to the session that started this one, wherever it is. */
function toParent(row = selected()): void {
	if (row?.kind !== "session") return;
	const parent = parentOf(row.entry);
	if (parent) reveal(parent.id);
	else toast(row.entry.parentId === null ? "you started this one" : "its parent is gone", "info");
}

/** u: marks a session Unseen until I come back to it from another, or takes that mark off. */
function toggleUnseen(row = selected()): void {
	if (row?.kind !== "session") return;
	const e = row.entry;
	if (!e.open) toast("archived; unarchive it first", "info");
	else if (e.provisional) toast("nothing to mark before the first prompt", "error");
	else if (e.snoozed) toast("snoozed; unsnooze it first", "info");
	else {
		if (e.markedUnseen) {
			if (m.stage.marked === e.id) m.stage.marked = null;
		} else if (panes.applied.id === e.id) {
			// Looking at it until now isn't the Visit that clears the mark.
			m.stage.visited = false;
			m.stage.marked = e.id;
		}
		post({ type: "markUnseen", id: e.id, marked: !e.markedUnseen });
		syncVisit();
	}
}

/** s: unsnoozes a snoozed session, or asks how long to snooze an open one. */
function toggleSnooze(row = selected()): void {
	if (row?.kind !== "session" || m.pin) return;
	const e = row.entry;
	if (!e.open) toast("archived; unarchive it first", "info");
	else if (e.provisional) toast("nothing to snooze before the first prompt", "error");
	else if (e.snoozed) {
		const req = nextReq();
		if (row.key === selected()?.key) m.pin = { index: resolveCursor(rosterRows()), req, answered: false };
		post({ type: "snooze", req, id: e.id, snooze: "off" });
	} else enter({ kind: "snooze", at: promptAnchor(row), id: e.id, title: displayName(e), choice: 0 });
}

function finishSnooze(snooze: SnoozePreset): void {
	const snoozing = snoozeMode();
	leave();
	if (!snoozing) return;
	// As with archive, the cursor keeps its place rather than following the row into Snoozed.
	const req = nextReq();
	if (selected()?.key === snoozing.id) m.pin = { index: resolveCursor(rosterRows()), req, answered: false };
	post({ type: "snooze", req, id: snoozing.id, snooze });
}

/** Runs on every snapshot; the one that answers `a` puts the cursor back on its row's index. */
function settlePin(): void {
	if (!m.pin?.answered) return;
	const rows = rosterRows();
	const index = Math.min(m.pin.index, rows.length - 1);
	const row = rows[index];
	m.pin = null;
	if (!row) return;
	m.selectedKey = row.key;
	m.lastIndex = index;
}

function copy(command: boolean, row = selected()): void {
	const e = row?.kind === "session" ? row.entry : null;
	if (!e) return;
	const text = command ? `swb open ${e.id}` : `@session:${e.id}`;
	afterCommit(
		() =>
			void clip(text).then(
				() => toast(`copied ${text}`, "info"),
				(error: Error) => toast(`copy failed: ${error.message}`, "error"),
			),
	);
}

/**
 * n: the directory picker, on the cursor's directory: a Group header's newest session's, there being no other.
 * Starting there joins its Group.
 */
function newAt(row = selected()): void {
	// On the Operator folder, so Tab picks its harness as anywhere else.
	if ((row?.kind === "section" && row.key === "operators") || (row?.kind === "session" && row.entry.operator)) {
		openPicker("pick", operatorDir(), null);
		return;
	}
	if (!row || row.kind === "section") {
		openPicker("pick", null, null);
		return;
	}
	const group = row.kind === "session" ? groupOf(row.entry) : row.group;
	openPicker("pick", row.kind === "session" ? row.entry.cwd : row.cwd, group);
}

/**
 * m: picks the Group for the session under the cursor, or for every session under the Group header it's on, which
 * merges into an existing Group or renames to a new one.
 */
function startNaming(row = selected()): void {
	const input = new Input({ prompt: "/ ", placeholder: "filter or new Group", placeholderStyle: gray });
	input.focused = m.filter.focused;
	if (row?.kind === "session" && row.entry.operator) toast("Operators don't take Groups", "info");
	else if (row?.kind === "session") {
		const group = groupOf(row.entry);
		const project = row.entry.project;
		enter({
			kind: "name",
			at: promptAnchor(row),
			ids: [row.entry.id],
			renaming: null,
			project,
			title: displayName(row.entry),
			choice: 0,
			input,
		});
		const naming = nameMode() as NameMode;
		naming.choice = Math.max(
			0,
			nameChoices().findIndex((c) => c.name === group),
		);
	} else if (row?.kind === "header" && row.group !== null) {
		const name = row.group;
		const ids = [...m.entries.values()].filter((e) => e.project === row.project && groupOf(e) === name).map((e) => e.id);
		enter({
			kind: "name",
			at: promptAnchor(row),
			ids,
			renaming: { projectKey: row.projectKey },
			project: row.project,
			title: name,
			choice: 0,
			input,
		});
		const naming = nameMode() as NameMode;
		naming.choice = Math.max(
			0,
			nameChoices().findIndex((c) => c.name === name),
		);
	} else toast("m picks a session's Group, or renames a Group", "info");
}

/** No Group when nothing is typed, then the Project's Groups matching what is, then a new one unless one matches exactly. */
export function nameChoices(): { label: string; name: string | null }[] {
	const naming = nameMode();
	if (!naming) return [];
	const typed = naming.input.getValue().trim();
	const groups = new Set<string>();
	for (const e of m.entries.values()) {
		const group = groupOf(e);
		if (e.open && e.project === naming.project && group !== null) groups.add(group);
	}
	const out: { label: string; name: string | null }[] = typed === "" ? [{ label: "(no Group)", name: null }] : [];
	for (const name of [...groups].sort((a, b) => a.localeCompare(b)))
		if (name.toLowerCase().includes(typed.toLowerCase())) out.push({ label: name, name });
	if (typed !== "" && !groups.has(typed)) out.push({ label: `+ new "${typed}"`, name: typed });
	return out;
}

function finishNaming(name: string | null): void {
	const naming = nameMode();
	leave();
	if (!naming) return;
	setGroup(naming.ids, name);
	// A renamed Group's header moves to its new key, and the cursor goes with it.
	if (naming.renaming) m.selectedKey = name === null ? naming.renaming.projectKey : `${naming.renaming.projectKey}:g:${name}`;
}

function dropAt(y: number, e: Entry): Drop {
	if (y < frame.listTop || y >= frame.listTop + frame.listHeight) return null;
	const rows = rosterRows();
	const row = rows[frame.scrollTop + (y - frame.listTop)];
	if (!row || row.kind === "section") return null;
	const header = row.kind === "header" ? row : rows.find((r): r is HeaderRow => r.kind === "header" && r.key === row.header);
	if (!header || header.project !== e.project) return null;
	return { header, name: header.group };
}

/** Lands a drag: into the Group under the pointer, out of any on its Project, or nowhere. */
function finishDrag(y: number): void {
	const drag = dragging();
	m.gesture = { kind: "none" };
	const e = drag && m.entries.get(drag.id);
	if (!e || !drag.moved) return;
	const drop = dropAt(y, e);
	if (!drop) toast("not a place for it; nothing moved", "info");
	else if (drop.name !== groupOf(e)) setGroup([e.id], drop.name);
}

function toggle(row: Row): void {
	setExpanded(row, isCollapsed(row));
}

function setExpanded(row: Row, expanded: boolean): void {
	if (row.kind === "header") {
		if (expanded) m.collapsed.delete(row.key);
		else m.collapsed.add(row.key);
	} else if (row.kind === "section") {
		if (expanded) m.expanded.add(row.key);
		else m.expanded.delete(row.key);
	}
}

/** Opens the directory picker: on the directory `from`, or straight into adding one. */
function openPicker(mode: "pick" | "add", from: string | null, group: string | null): void {
	m.search.setValue("");
	m.path.setValue("");
	frame.pickerTop = 0;
	m.completed = null;
	enter({
		kind: "picker",
		picker: {
			mode,
			opened: mode,
			choice: mode === "add" ? typedChoice("") : 0,
			from,
			group,
			pin: from,
			confirm: null,
			preset: null,
			menu: null,
		},
	});
	// The last list shows at once; the worker's fresh one replaces it when its scan lands.
	post({ type: "dirs" });
	if (mode === "pick")
		(pickerMode() as Choosing).choice = Math.max(
			0,
			pickRows().findIndex((r) => r.kind === "target" && r.target.path === from),
		);
}

/**
 * Each tree's main checkout, then its worktrees. A query keeps only matches, best match first, the way fzf and
 * VS Code's quick open rank them: a tree whose worktree matches keeps its root, dimmed, for context, and a
 * matching root brings all its worktrees.
 */
export function pickRows(): PickRow[] {
	const choosing = pickerMode();
	if (!choosing) return [];
	const q = m.search.getValue().trim().toLowerCase();
	const ranked: { score: number; rows: PickRow[] }[] = [];
	// The directory it opened on is always offered, even before a first prompt or under an exclude.
	const pin = choosing.pin;
	const pinned: TargetTree[] =
		pin !== null && !listedDirs().has(pin) ? [{ root: { path: pin, repo: null, branch: null }, worktrees: [] }] : [];
	for (const tree of [...pinned, ...(m.dirTrees ?? [])]) {
		const root = match(targetName(tree.root), q);
		const worktrees = tree.worktrees
			.map((target) => ({ target, m: match(targetName(target), q) }))
			.filter((w) => root || w.m)
			.sort((x, y) => (x.m?.score ?? 9) - (y.m?.score ?? 9));
		if (!root && worktrees.length === 0) continue;
		const rows: PickRow[] = [{ kind: "target", target: tree.root, tree, context: !root, score: root?.score ?? 9, at: root?.at ?? [] }];
		for (const w of worktrees)
			rows.push({ kind: "target", target: w.target, tree: null, context: false, score: w.m?.score ?? 9, at: w.m?.at ?? [] });
		ranked.push({ score: Math.min(root?.score ?? 9, ...worktrees.map((w) => w.m?.score ?? 9)), rows });
	}
	// Stable, so equal matches keep dirs.sort's order.
	ranked.sort((x, y) => x.score - y.score);
	return [...ranked.flatMap((r) => r.rows), { kind: "add" }];
}

/** The best-ranked row a query matched; trees keep their order, so it can sit below a dimmed repository. */
function bestMatch(): number {
	let best = 0;
	let score = 10;
	pickRows().forEach((row, i) => {
		if (row.kind === "target" && !row.context && row.score < score) {
			best = i;
			score = row.score;
		}
	});
	return best;
}

/** The completions of the path typed, which render and `deck state` read as the last change left them. */
export function completedRows(): string[] {
	return m.completed?.rows ?? [];
}

function addRows(): string[] {
	const typed = m.path.getValue();
	// The disk is read once per path typed.
	// biome-ignore lint/plugin: the directory typed is the one read, as each key types it.
	if (m.completed?.typed !== typed) m.completed = { typed, rows: completions(typed, scanBase()) };
	return m.completed.rows;
}

/** Where Enter in add mode starts: the highlighted completion, as the last change read them, or the directory typed. */
export function addTarget(): string {
	const choosing = pickerMode() as Choosing;
	const typed = m.path.getValue();
	const row = completedRows()[choosing.choice];
	if (row) return row;
	const full = typed.startsWith("/") || typed.startsWith("~") ? expandHome(typed) : join(scanBase(), typed);
	return full.length > 1 ? full.replace(/\/$/, "") : full;
}

export function listedDirs(): Set<string> {
	return new Set((m.dirTrees ?? []).flatMap((t) => [t.root.path, ...t.worktrees.map((w) => w.path)]));
}

function start(path: string): void {
	const choosing = pickerMode() as Choosing;
	const target = pickerTarget(choosing);
	closePicker();
	newSession(path, path === choosing.from ? choosing.group : null, typeof target === "string" ? null : target);
}

/** M-a d or the row's ✕: asks before taking a directory, or a repository and all its worktrees, off the list. */
function askRemove(): void {
	const choosing = pickerMode();
	if (choosing?.mode !== "pick") return;
	const row = pickRows()[choosing.choice];
	if (row?.kind !== "target" || row.context) return;
	const worktrees = row.tree?.worktrees.map((w) => w.path) ?? [];
	choosing.confirm = {
		name: targetName(row.target),
		worktrees: worktrees.length,
		path: row.target.path,
		covers: [row.target.path, ...worktrees],
	};
}

function finishRemove(yes: boolean): void {
	const choosing = pickerMode();
	if (!choosing?.confirm) return;
	if (yes) {
		const path = choosing.confirm.path;
		post({ type: "removeDir", path });
		if (choosing.pin !== null && choosing.confirm.covers.includes(choosing.pin)) choosing.pin = null;
		// Gone at once; the worker's list, which follows, agrees.
		m.dirTrees = (m.dirTrees ?? [])
			.filter((t) => t.root.path !== path)
			.map((t) => ({ root: t.root, worktrees: t.worktrees.filter((w) => w.path !== path) }));
		choosing.choice = Math.min(choosing.choice, pickRows().length - 1);
	}
	choosing.confirm = null;
}

function closePicker(): void {
	leave();
}

/** Opens the launch card's menu on the chosen preset, or closes it keeping that one. */
function toggleMenu(): void {
	const choosing = pickerMode() as Choosing;
	if (choosing.menu) choosing.menu = null;
	else if (pickerPresets().length > 0) choosing.menu = { query: "", cursor: Math.max(0, menuPresets("").indexOf(chosenPreset(choosing))) };
}

function choosePreset(index: number): void {
	const choosing = pickerMode() as Choosing;
	choosing.preset = presetLabels(pickerPresets().map((c) => c.preset))[index] ?? null;
	choosing.menu = null;
}

/** Tab in add mode: the highlighted completion, typed out. */
function complete(): void {
	const choosing = pickerMode();
	if (choosing?.mode !== "add") return;
	const match = addRows()[Math.max(0, choosing.choice)];
	if (!match) return;
	m.path.setValue(`${shortPath(match)}/`);
	choosing.choice = -1;
}

/** ⏎ in the picker: starts in the highlighted directory, or the one typed, or goes on to add one. */
function pickerEnter(): void {
	const choosing = pickerMode() as Choosing;
	if (choosing.mode === "pick") {
		const row = pickRows()[choosing.choice];
		if (row?.kind === "add") {
			choosing.mode = "add";
			m.path.setValue("");
			choosing.choice = typedChoice("");
		} else if (row) start(row.target.path);
		return;
	}
	const path = addTarget();
	// biome-ignore lint/plugin: Enter waits on the directory it starts in.
	if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
		toast(`no directory ${shortPath(path)}`, "error");
		return;
	}
	if (!listedDirs().has(path)) post({ type: "addDir", path });
	start(path);
}

/** Every preset that can start, from the default. */
export function pickerPresets(): Choice[] {
	return fromDefault(shortlist(m.config, m.catalog) ?? []).filter((c) => c.reason === null);
}

/** The chosen preset's index into pickerPresets, as long as there are any. */
export function chosenPreset(choosing: Choosing): number {
	if (choosing.preset === null) return 0;
	return Math.max(0, presetLabels(pickerPresets().map((c) => c.preset)).indexOf(choosing.preset));
}

/** What the menu shows, in shortlist order, narrowed by `query`. */
export function menuPresets(query: string): number[] {
	const presets = pickerPresets();
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const matches = (c: Choice) => {
		const p = c.preset;
		const text = `${p.harness} ${harnessName(p.harness)} ${p.provider ?? ""} ${p.model ?? ""} ${p.effort ?? ""} ${p.agent ?? ""} ${c.note}`;
		return words.every((w) => text.toLowerCase().includes(w));
	};
	return presets.flatMap((c, i) => (matches(c) ? [i] : []));
}

/**
 * What a session from the picker starts on: its preset, or with none that can, the default's harness on its own
 * defaults. Null until the harnesses are found, when the worker decides; a string says why nothing can start.
 */
export function pickerTarget(choosing: Choosing): LaunchTarget | string | null {
	const chosen = pickerPresets()[chosenPreset(choosing)];
	if (chosen) return chosen.launch;
	if (m.catalog === null && m.config.presets === null) return null;
	return defaultLaunch(m.config, m.catalog, shortlist(m.config, m.catalog) ?? []);
}

/**
 * How well a name matches the query, lower is better, and which characters matched: the whole name's start, then a
 * word's start, then anywhere. Scattered letters don't count; across a list of directory names they match too much.
 */
function match(name: string, q: string): { score: number; at: number[] } | null {
	if (q === "") return { score: 0, at: [] };
	const lower = name.toLowerCase();
	const run = (from: number) => Array.from({ length: q.length }, (_, i) => from + i);
	if (lower.startsWith(q)) return { score: 0, at: run(0) };
	const word = [...lower.matchAll(/[-_./ ]/g)].map((hit) => (hit.index as number) + 1).find((i) => lower.startsWith(q, i));
	if (word !== undefined) return { score: 1, at: run(word) };
	const inside = lower.indexOf(q);
	return inside === -1 ? null : { score: 2, at: run(inside) };
}

export function marked(name: string, at: number[]): string {
	return [...name].map((c, i) => (at.includes(i) ? cyan(c) : c)).join("");
}

/** A typed directory, ending in `/` or empty, is itself what Enter adds until a completion is highlighted. */
function typedChoice(typed: string): number {
	return typed === "" || typed.endsWith("/") ? -1 : 0;
}

export function scanBase(): string {
	return expandHome(m.config.dirs.scan[0] ?? "~");
}

/** The pointer rests this long on a row before its Peek opens. */
const PEEK_OPEN_MS = 80;

/** ...and this long before an open Peek follows it to another row, so a diagonal path into the Peek doesn't drag it along. */
const PEEK_SWITCH_MS = 150;

/** How long a Peek waits for its last turn and diff before opening without them. */
const PEEK_INFO_WAIT_MS = 200;

/** How long a session's last turn and diff stand before a Peek asks again. */
const PEEK_INFO_MS = 2000;

const spotKey = (spot: PeekSpot | null | undefined) => (spot ? `${spot.id}@${spot.y}` : null);

function cancelPendingPeek(): void {
	if (m.peek.pending) clearTimeout(m.peek.pending.timer);
	m.peek.pending = null;
}

/** Where render wants a Peek, unless it was put away; asks for what it shows. */
function wantPeek(want: PeekSpot | null): PeekSpot | null {
	let spot = want;
	if (spot?.id !== m.peek.dismissed) m.peek.dismissed = null;
	else spot = null;
	m.peek.spot = spot;
	if (spot) askPeekInfo(spot.id);
	return spot;
}

/** Settles the Peek on `spot`: at once to close, after the pointer rests, and what it shows comes in, to open or move. */
function syncPeek(spot: PeekSpot | null): void {
	if (m.peek.expires && spot === null) {
		clearTimeout(m.peek.expires);
		m.peek.expires = null;
	}
	if (spotKey(m.peek.settled) === spotKey(spot)) {
		m.peek.settled = spot;
		cancelPendingPeek();
		return;
	}
	if (m.peek.pending && spotKey(m.peek.pending.spot) === spotKey(spot)) return;
	cancelPendingPeek();
	if (!spot) {
		m.peek.settled = null;
		return;
	}
	m.peek.pending = { spot, waiting: false, timer: setTimeout(() => dispatch(peekRested), m.peek.settled ? PEEK_SWITCH_MS : PEEK_OPEN_MS) };
}

/** The pointer rested: the Peek opens once what it shows comes in, or once it's waited long enough for it. */
function peekRested(): void {
	const pending = m.peek.pending as PendingPeek;
	if (m.peek.info.has(pending.spot.id)) settlePeek();
	else {
		pending.waiting = true;
		pending.timer = setTimeout(() => dispatch(settlePeek), PEEK_INFO_WAIT_MS);
	}
}

function settlePeek(): void {
	const pending = m.peek.pending as PendingPeek;
	clearTimeout(pending.timer);
	m.peek.pending = null;
	m.peek.settled = pending.spot;
	expirePeek();
}

function expirePeek(): void {
	if (m.peek.expires) clearTimeout(m.peek.expires);
	m.peek.expires = setTimeout(
		() =>
			dispatch(() => {
				m.peek.dismissed = m.peek.settled?.id ?? null;
				m.peek.byKeys = false;
				syncPeek(null);
			}),
		30_000,
	);
}

/** Whether the UI server reports the pointer leaving: while something under it is lit, or something leaves with it. */
function syncWatch(want: boolean): void {
	if (want === m.peek.watching) return;
	m.peek.watching = want;
	void tmuxAsync(UI, "set", "-t", deck, ...(want ? ["@swb_watch", "1"] : ["-u", "@swb_watch"])).catch((error: Error) =>
		toast(`peek: ${error.message}`, "error"),
	);
}

function askPeekInfo(id: string): void {
	const e = m.entries.get(id);
	const have = m.peek.info.get(id);
	if (!e || m.peek.asked.has(id) || (have && Date.now() - have.at < PEEK_INFO_MS)) return;
	readTranscript(e, false);
	m.peek.asked.add(id);
	post({ type: "peek", id, cwd: e.cwd, transcript: e.transcript, harness: e.harness });
}

function onPeekInfo(id: string, info: PeekInfo): void {
	m.peek.asked.delete(id);
	m.peek.info.set(id, { info, at: Date.now() });
	if (m.peek.pending?.waiting && m.peek.pending.spot.id === id) settlePeek();
}

/** The pointer or the keyboard went elsewhere, as the UI server saw it, and took the Peek with it. */
function pointerOut(): void {
	m.hover = null;
	m.pointer = null;
	m.peek.byKeys = false;
	// LEAVE unset both options as it ran.
	m.peek.watching = false;
	screen.disarmed();
}

/** Whether the launch card goes on the Stage, which a narrow Deck doesn't have beside the roster. */
export function launchOnStage(width: number): boolean {
	return !panes.narrow && Math.min(LAUNCH_COLS, panes.width - width - 1) >= PEEK_MIN_COLS;
}

// ── keys ────────────────────────────────────────────────────────────────

const bind = (keys: string[], name: string, label: string | null, command: Command | null): Binding<Command> => ({
	keys,
	name,
	label,
	command,
});

const step = (by: number): Command => ({ kind: "step", by });

const CHOOSE: Command = { kind: "choose", index: null };

const CANCEL: Command = { kind: "cancel" };

const ARROWS = [bind(["up"], "↑", null, step(-1)), bind(["down"], "↓", null, step(1))];

/** The keys the roster pane takes in its mode, in the order its legend shows the ones it labels. */
export function keymap(): Binding<Command>[] {
	const mode = m.mode;
	switch (mode.kind) {
		case "settings":
			return [];
		// Their legend line is the field being typed into.
		case "filter":
			return [...ARROWS, bind(["enter"], "⏎", null, CHOOSE), bind(["escape"], "esc", null, CANCEL)];
		case "name":
			return [...ARROWS, bind(["enter"], "⏎", mode.renaming ? "rename" : "assign", CHOOSE), bind(["escape"], "esc", "cancel", CANCEL)];
		case "snooze":
			return [
				bind(["up", "k"], "↑", null, step(-1)),
				bind(["down", "j"], "↓", null, step(1)),
				bind(["enter"], "⏎", "snooze", CHOOSE),
				bind(["escape", "q", "s"], "esc", "cancel", CANCEL),
			];
		case "archive": {
			const e = m.entries.get(mode.id);
			const family = e ? openDescendants(m.entries.values(), e.id).length : 0;
			if (mode.chosen) {
				const { all, deleteWorktree } = mode.chosen;
				return [
					bind(["a"], "a", `Archive ${all ? family + 1 : 1}; cancel schedules`, { kind: "archiveAnswer", all, deleteWorktree }),
					bind(["escape"], "esc", "Cancel", CANCEL),
				];
			}
			const answer = (all: boolean, deleteWorktree: boolean): Command => ({ kind: "archiveAnswer", all, deleteWorktree });
			const out = [bind(["a"], "a", e?.worktree ? "Archive; keep worktree" : "Archive this session", answer(false, false))];
			if (family > 0) out.push(bind(["A"], "A", `Archive family (${family + 1})`, answer(true, false)));
			if (e?.worktree) out.push(bind(["d"], "d", "Archive; delete clean worktree", answer(false, true)));
			if (e?.worktree && family > 0) out.push(bind(["D"], "D", `Family (${family + 1}); delete clean worktree`, answer(true, true)));
			out.push(bind(["escape"], "esc", "Cancel", CANCEL));
			return out;
		}
		case "picker":
			return pickerKeys(mode.picker);
		case "roster":
			return rosterKeys(m.peek.settled ? rosterRows().find((row) => row.key === m.peek.settled?.id) : selected());
	}
}

function pickerKeys(choosing: Choosing): Binding<Command>[] {
	if (choosing.confirm) return [bind(["y", "enter"], "y", "remove", CHOOSE), bind(["n", "escape"], "n", "keep", CANCEL)];
	if (choosing.menu) {
		// A number picks what the menu shows by its place, until something's typed: model names have numbers in them.
		const shown = menuPresets(choosing.menu.query);
		const numbers =
			choosing.menu.query === "" && shown.length > 0
				? [
						bind([], `1–${Math.min(9, shown.length)}`, "pick", null),
						...shown.slice(0, 9).map((_, i) => bind([String(i + 1)], String(i + 1), null, { kind: "choose", index: i })),
					]
				: [];
		return [...numbers, bind(["enter"], "⏎", "choose", CHOOSE), bind(["escape", "tab", "shift+tab"], "esc", "keep", CANCEL), ...ARROWS];
	}
	if (choosing.mode === "add")
		return [
			bind(["tab"], "⇥", "complete", { kind: "complete" }),
			bind(["enter"], "⏎", "start", CHOOSE),
			bind(["escape"], "esc", choosing.opened === "pick" ? "back" : "cancel", CANCEL),
			...ARROWS,
		];
	return [
		bind(["enter"], "⏎", "start", CHOOSE),
		...(pickerPresets().length > 0 ? [bind(["tab", "shift+tab"], "⇥", "preset", { kind: "menu" })] : []),
		bind(["escape"], "esc", "cancel", CANCEL),
		// The prefix key, which reaches the roster through the UI server.
		bind([], `${keyName(m.config.prefix)} d`, "remove", { kind: "remove" }),
		...ARROWS,
	];
}

/** The roster's own keys, on its cursor's row; the legend shows what that row's are. */
function rosterKeys(row: Row | undefined): Binding<Command>[] {
	const session = row?.kind === "session" ? row.entry : null;
	const onRow = (act: RowAct): Command => ({ kind: "row", act, row: row?.key ?? null });
	let enter: string | null = null;
	if (row?.kind === "header") enter = row.collapsed ? "expand" : "collapse";
	else if (row?.kind === "section") enter = row.expanded ? "collapse" : "expand";
	else if (session) enter = !session.open ? "open" : session.cutOff ? "resume" : session.live ? "focus" : "wake";
	if (session && m.peek.settled?.id === session.id) enter = null;
	if (
		!panes.narrow &&
		session?.open &&
		panes.applied.target === placeholder &&
		panes.applied.id === session.id &&
		panes.applied.card?.ending
	)
		enter = null;
	let newLabel: string | null = null;
	if (!row || row.kind === "header" || (session?.open && !session.snoozed)) newLabel = "new";
	else if (row.kind === "section" && row.key === "operators") newLabel = "new operator";
	return [
		bind(["enter"], "⏎", enter, { kind: "activate", enter: true }),
		bind(["m"], "m", row?.kind === "header" && row.group !== null ? "rename" : null, onRow("group")),
		bind(["s"], "s", session?.snoozed ? "unsnooze" : null, onRow("snooze")),
		bind(["a"], "a", session ? (session.open ? "archive" : "unarchive") : null, onRow("archive")),
		bind(["n"], "n", newLabel, onRow("new")),
		bind(["?"], "?", "keys", { kind: "help" }),
		bind([","], ",", "settings", { kind: "settings" }),
		...(panes.narrow && session
			? [
					bind(["i"], "i", null, { kind: "details" }),
					...(m.details.expanded
						? [
								bind(["pageDown"], "PgDn", null, { kind: "detailScroll", by: frame.details?.height ?? 1 }),
								bind(["pageUp"], "PgUp", null, { kind: "detailScroll", by: -(frame.details?.height ?? 1) }),
							]
						: []),
				]
			: []),
		bind(["down", "j"], "j", null, step(1)),
		bind(["up", "k"], "k", null, step(-1)),
		bind(["g"], "g", null, step(Number.NEGATIVE_INFINITY)),
		bind(["G"], "G", null, step(Number.POSITIVE_INFINITY)),
		bind([" "], "space", null, { kind: "activate", enter: false }),
		bind(["right", "l"], "l", null, { kind: "unfold", open: true }),
		bind(["left", "h"], "h", null, { kind: "unfold", open: false }),
		bind(["escape"], "esc", null, { kind: "clearFilter" }),
		bind(["w"], "w", null, onRow("wake")),
		bind(["x"], "x", null, onRow("stop")),
		bind(["R"], "R", null, onRow("reload")),
		bind(["u"], "u", null, onRow("unseen")),
		bind(["p"], "p", null, onRow("parent")),
		bind(["["], "[", null, { kind: "history", step: -1 }),
		bind(["]"], "]", null, { kind: "history", step: 1 }),
		bind(["y"], "y", null, onRow("copyOpen")),
		bind(["Y"], "Y", null, onRow("copyMention")),
		bind(["N"], "N", null, { kind: "addDir" }),
		bind(["/"], "/", null, { kind: "filter" }),
		...(m.configError ? [bind(["O"], "O", null, { kind: "config", line: m.configError.line })] : []),
		bind(["q", "ctrl+c"], "q", null, { kind: "quit" }),
	];
}

/**
 * While the Stage has the keyboard, the legend shows the prefix keys that bring the roster back, which the UI server
 * binds; a click runs what they do.
 */
export function stageKeys(): Binding<Command>[] {
	const prefix = keyName(m.config.prefix);
	const help = bind([], `${prefix} ?`, "keys", { kind: "help" });
	if (panes.applied.target === placeholder || harnessStarting(panes.applied))
		return [bind([], "esc", "roster", { kind: "roster", to: "focus" }), help];
	return [
		bind([], `${prefix} h`, "roster", { kind: "roster", to: "focus" }),
		bind([], `${prefix} z`, "hide", { kind: "roster", to: "hide" }),
		help,
	];
}

/**
 * The roster's keys from anywhere, after the prefix: `swb __deck key`. j and k step over headers, and the keyboard stays
 * put. Given a row, as a Peek's buttons are, a key acts on that row instead of the cursor's.
 */
function prefixKeymap(row: string | null): Binding<Command>[] {
	const onRow = (act: RowAct): Command => ({ kind: "row", act, row });
	return [
		bind([","], ",", null, { kind: "settings" }),
		bind(["/"], "/", null, { kind: "filter" }),
		bind(["m"], "m", null, onRow("group")),
		bind(["J"], "J", null, { kind: "moveSession", by: 1 }),
		bind(["K"], "K", null, { kind: "moveSession", by: -1 }),
		bind(["n"], "n", null, onRow("new")),
		bind(["N"], "N", null, { kind: "addDir" }),
		bind(["w"], "w", null, onRow("wake")),
		bind(["x"], "x", null, onRow("stop")),
		bind(["R"], "R", null, onRow("reload")),
		bind(["a"], "a", null, onRow("archive")),
		bind(["p"], "p", null, onRow("parent")),
		bind(["u"], "u", null, onRow("unseen")),
		bind(["["], "[", null, { kind: "history", step: -1 }),
		bind(["]"], "]", null, { kind: "history", step: 1 }),
		bind(["s", "S"], "s", null, onRow("snooze")),
		bind(["y"], "y", null, onRow("copyOpen")),
		bind(["Y"], "Y", null, onRow("copyMention")),
		bind(["d"], "d", null, { kind: "remove" }),
	];
}

/**
 * A prefix key. Settings holds every key while it's open; any other mode is abandoned first, since a prompt or picker
 * left open would take the keys the command brings back, except for the picker's own `d`.
 */
function prefixKey(k: string, row: string | undefined): void {
	if (row !== undefined && !rosterRows().some((r) => r.key === row)) throw new Error(`no session ${row} in the roster`);
	const command = bindingFor(prefixKeymap(row ?? m.peek.settled?.id ?? null), k)?.command;
	if (!command) throw new Error(`unknown deck key ${k}`);
	if (settingsPane()) return;
	m.hover = null;
	m.pointer = null;
	m.peek.byKeys = false;
	syncPeek(null);
	if (command.kind !== "remove") leave();
	run(command);
}

// ── Deck actions ────────────────────────────────────────────────────────

async function deckClient(): Promise<string | undefined> {
	return (await tmuxAsync(UI, "list-clients", "-t", `=${deck}`, "-F", "#{client_name}")).split("\n")[0] || undefined;
}

/** `?`: every key in a popup sized to show them all, short of its terminal's size; tmux refuses a popup bigger than that. */
async function showHelp(): Promise<void> {
	const line = (await tmuxAsync(UI, "list-clients", "-t", `=${deck}`, "-F", "#{client_name}\t#{client_width}\t#{client_height}")).split(
		"\n",
	)[0];
	if (!line) return;
	const [client, cols, rows] = line.split("\t") as [string, string, string];
	const size = helpSize(m.config.prefix);
	const fit = ["-w", String(Math.min(size.width, Number(cols))), "-h", String(Math.min(size.height, Number(rows)))];
	await tmuxAsync(UI, "display-popup", "-c", client, "-E", "-B", ...fit, ...HELP_POPUP);
}

/** A Peek's buttons: each one's label, the roster key that does the same, and what it does. */
export function peekButtons(row: Row): [label: string, key: string, act: RowAct][] {
	if (row.kind === "section") return row.key === "operators" ? [["New Operator", "n", "new"]] : [];
	if (row.kind === "header") {
		const items: [string, string, RowAct][] = [["New session here", "n", "new"]];
		if (row.group !== null) items.push(["Rename Group…", "m", "group"]);
		return items;
	}
	const e = row.entry;
	const primary = !e.open
		? "Open"
		: e.cutOff
			? "Resume unfinished turn"
			: !e.live
				? "Wake & focus"
				: e.errored
					? "Inspect and retry"
					: e.activity === "blocked"
						? "Focus to respond"
						: "Focus";
	const items: [string, string, RowAct][] = [[primary, "⏎", "focus"]];
	if (!e.open) items.push(["Unarchive", "a", "archive"]);
	else {
		items.push(e.live ? ["Stop", "x", "stop"] : ["Wake in background", "w", "wake"]);
		if (!e.provisional && !e.snoozed)
			items.push([e.markedUnseen ? "Unmark Unseen" : isUnseen(e) ? "Keep Unseen" : "Mark Unseen", "u", "unseen"]);
		if (!e.provisional) items.push(e.snoozed ? ["Unsnooze", "s", "snooze"] : ["Snooze…", "s", "snooze"], ["Archive", "a", "archive"]);
		if (!e.operator) items.push(["Group…", "m", "group"]);
	}
	if (parentOf(e)) items.push(["Parent", "p", "parent"]);
	return items;
}

process.stdout.on("resize", () => void panes.noteDrag());

function quit(): void {
	void tmuxAsync(UI, "kill-session", "-t", `=${deck}`);
}

let focusReads = Promise.resolve();

/**
 * Reads the keyboard's pane afresh, then runs `then` in the same change, with the Deck's focus up to date. The hook
 * that reports a move and a prefix key pressed just after it each run in the background, and the chain keeps them in
 * the order they came.
 */
function withFocus(then: (() => void) | null): Promise<void> {
	const read = focusReads.then(async () => {
		const pane = await tmuxAsync(UI, "display", "-p", "-t", deck, "#{pane_id}");
		dispatch(() => {
			focusOn(pane);
			then?.();
		});
	});
	focusReads = read.catch(() => {});
	return read;
}

function focusOn(pane: string): void {
	if (pane !== m.focusedPane) m.focusMoves++;
	m.focusedPane = pane;
	const was = m.focus;
	m.focus = m.focusedPane === rosterPane ? "roster" : "stage";
	// Moving to another pane, by ctrl-hjkl or the prefix, leaves Settings.
	if (m.focus === "stage" && settingsPane()) closeSettings();
	if (m.focus === "roster") for (const launch of m.launches) launch.keyboard = false;
	// A drag released over another pane never reports its release here.
	else if (dragging()) m.gesture = { kind: "none" };
	// Moving onto a dormant session, by click or key, means to use it.
	const onView = m.stage.staged === null ? undefined : m.entries.get(m.stage.staged);
	if (m.focus === "roster") m.returning = false;
	if (was === "roster" && m.focus === "stage" && !m.returning && onView?.open && !onView.live) wake(onView.id, true);
	// Going to the Stage, by click or key, puts the Peek away: the pointer may still rest on the row it came from.
	if (was === "roster" && m.focus === "stage") {
		m.peek.dismissed = m.peek.spot?.id ?? null;
		m.peek.byKeys = false;
		const choosing = pickerMode();
		if (choosing) choosing.menu = null;
	}
}

/**
 * A command the UI server sent. What it asks of the Deck's state goes through dispatch; what it asks of the Stage's
 * panes goes straight to them, and the server's commit settles the rest once it's done.
 */
export async function handleCommand(cmd: string, argv: string[]): Promise<void> {
	switch (cmd) {
		case "focus":
			await withFocus(null);
			break;
		case "terminal-focus": {
			const focused = argv[0] === "in";
			if (focused === m.terminalFocused) break;
			dispatch(() => {
				m.terminalFocused = focused;
			});
			// Of several Decks, the one in use owns the colors every hosted program sees.
			if (focused && m.profile) post({ type: "colors", colors: m.profile });
			break;
		}
		case "layout":
			await panes.layout();
			break;
		case "view-swap":
		case "view-split":
			await withFocus(() => {
				if (!settingsPane()) changeView(cmd === "view-swap");
			});
			break;
		case "roster":
			// Settings holds the roster beside the Stage; showing it, and with it the keyboard, still goes.
			if (argv[0] === "focus") await panes.showRoster(true);
			else if (argv[0] === "show") await panes.showRoster(false);
			else if (argv[0] === "hide") {
				if (!settingsPane()) await panes.hideRoster();
			} else throw new Error(`roster: ${argv[0]}?`);
			break;
		case "stage":
			await panes.focusStage();
			break;
		case "shell":
			await withFocus(() => {
				if (!settingsPane()) toggleShell();
			});
			break;
		case "key":
			await withFocus(() => prefixKey(argv[0] ?? "", argv[1]));
			break;
		case "help":
			await showHelp();
			break;
		// The UI server saw the pointer leave both the roster and its overlays, or a key typed elsewhere; it put away
		// what leaves with them, and stopped watching, on its way here.
		case "pointer-out":
			dispatch(pointerOut);
			break;
		case "esc":
			dispatch(() => {
				for (const launch of m.launches) launch.keyboard = false;
				afterCommit(() => void panes.showRoster(true));
			});
			break;
		// The session on view taking me to another. One it launched a moment ago reaches this Deck with a later snapshot.
		case "show": {
			const [id = "", from, view] = argv;
			const deadline = Date.now() + 2000;
			while (!m.entries.has(id) && Date.now() < deadline) await Bun.sleep(50);
			dispatch(() => {
				const e = m.entries.get(id);
				if (!e) throw new Error(`no session ${id} on this Deck`);
				if (m.stage.staged !== from) throw new Error("the user has moved off this session; nothing switched");
				reveal(id);
				// Asking to be taken there means as much as clicking its row: a dormant one starts.
				focusEntry(e);
				if (view !== undefined && view !== viewOf(e)) showView(e, view as View);
			});
			break;
		}
		// A key typed on a session's card, which only the keyboard on the Stage can type, means to use it.
		case "wake":
			dispatch(() => {
				const { kind, id } = panes.applied;
				if (id !== null && (kind === "dormant" || kind === "exited" || kind === "failed")) wake(id, true);
			});
			break;
		default:
			throw new Error(`unknown deck command ${cmd}`);
	}
}

/** Shows or hides the shell beside, below, or in place of pi for the staged session's directory, and the keyboard follows it in and back out. */
function toggleShell(): void {
	const e = panes.applied.id === null ? undefined : m.entries.get(panes.applied.id);
	if (!e?.open) {
		toast("no open session on view", "info");
		return;
	}
	if (m.shellsAsked.delete(e.cwd)) return;
	if (m.shellsShown.delete(e.cwd)) {
		if (m.focus === "stage" && m.focusedPane === shellShownIn()) afterCommit(() => void panes.focusStage());
		return;
	}
	if (m.snapshot?.shells[e.cwd]) showShell(e.cwd);
	else {
		const req = nextReq();
		m.shellsAsked.set(e.cwd, req);
		post({ type: "shell", req, dir: e.cwd });
	}
}

/** Shows a directory's shell, once it runs, with the keyboard in it. */
function showShell(dir: string): void {
	m.shellsShown.add(dir);
	focusOnceShown(() => shellShownIn());
}

/**
 * Puts the keyboard on a pane once the Stage's pending changes have placed it, unless the keyboard moved meanwhile: a
 * key that went elsewhere after asking for this wins, whether the Deck has heard of the move yet or only tmux has. Off a
 * pane those changes closed, tmux moved it, not a key.
 */
function focusOnceShown(pane: () => string | null): void {
	const asked = m.focusMoves;
	const from = m.focusedPane;
	afterCommit(() =>
		panes.queue(async () => {
			const target = pane();
			if (!target) return;
			try {
				// tmux answers a pane id that's gone with an empty line, not an error.
				const [now, still] = (
					await tmuxAsync(UI, "display", "-p", "-t", deck, "#{pane_id}", ";", "display", "-p", "-t", from, "#{pane_id}")
				).split("\n");
				if ((asked !== m.focusMoves || now !== from) && still === from) return;
				// A key can still move it between that read and this move, so tmux checks again as it moves.
				const select = `select-pane ${panes.narrow ? "-Z " : ""}-t ${target}`;
				await tmuxAsync(UI, "if", "-F", "-t", deck, `#{==:#{pane_id},${now}}`, select);
			} catch (error) {
				toast(`focus: ${(error as Error).message}`, "error");
			}
		}),
	);
}

/**
 * `e` swaps pi and the Editor by what's showing, so an Editor that died comes back, and does nothing in split. `v` enters split with the keyboard on the Editor, and
 * leaves it for whichever pane had the keyboard.
 */
function changeView(swap: boolean): void {
	const e = panes.applied.id === null ? undefined : m.entries.get(panes.applied.id);
	if (!e?.open) {
		toast("no open session on view", "info");
		return;
	}
	const saved = viewOf(e);
	if (swap && saved === "split") return;
	const showing = panes.applied.view;
	let next: View;
	if (swap) next = showing === "editor" ? "agent" : "editor";
	else if (saved !== "split") next = "split";
	else next = showing === "split" && m.focus === "stage" && m.focusedPane === stagePane ? "editor" : "agent";
	showView(e, next);
}

/** A view with the Editor in it waits for the Editor to run; asking for one that died brings it back. */
function showView(e: Entry, next: View): void {
	const ask = next === "agent" ? undefined : m.editors.get(e.cwd);
	if (ask?.kind === "asking") ask.shows = { id: e.id, view: next };
	else if (next !== "agent" && !m.snapshot?.editors[e.cwd]) requestEditor(e.cwd, { id: e.id, view: next });
	else {
		if (next !== "agent") m.editors.set(e.cwd, { kind: "asked" });
		setView(e, next);
	}
}

/** The keyboard goes to the pane the view brought up, or stays in the shell; entering split, to the Editor, since that's what I split to look at. */
function setView(e: Entry, next: View): void {
	if (next !== "editor" && !e.live) wake(e.id, m.focus === "stage");
	if (next === "split" && panes.width < SPLIT_FROM) toast(`split needs ${SPLIT_FROM} columns; showing ${harnessName(e.harness)}`, "info");
	// Leaving split from a shell replacing pi keeps the keyboard in the shell, wherever it lands.
	const inShell = next !== "split" && m.focus === "stage" && m.focusedPane === shellShownIn();
	const req = nextReq();
	m.localViews.set(e.id, { view: next, req });
	post({ type: "view", req, id: e.id, view: next });
	focusOnceShown(() => (inShell && shellShownIn()) || stagePane);
}

// ── settings ────────────────────────────────────────────────────────────

/** Takes in a config read whole and valid: everything that reads config sees it at once, and the worker gets its copy. */
function applyLoaded(next: Loaded): void {
	const before = m.config;
	m.loaded = next;
	m.config = next.config;
	m.configError = null;
	post({ type: "config", config: m.config });
	if (JSON.stringify(before.rosterWidth) !== JSON.stringify(m.config.rosterWidth)) {
		// A new width is meant to show, over one dragged before it.
		panes.dragged = null;
		afterCommit(() => void panes.layout());
	}
	if (JSON.stringify(before.dirs) !== JSON.stringify(m.config.dirs)) post({ type: "dirs" });
	if (before.wakeOnHighlight !== m.config.wakeOnHighlight) scheduleHighlightWake();
	// biome-ignore lint/plugin: a Settings save, or a config.toml edit, writes it, once per change.
	if (before.operatorInstructions !== m.config.operatorInstructions) ensureOperatorDir(m.config.operatorInstructions);
}

/** config.toml again, after a change on disk: a valid one applies, an invalid one is reported and leaves the Deck as it was. */
function reloadConfig(): void {
	try {
		// biome-ignore lint/plugin: synchronous, so a Settings save can't land between this read and loaded.
		const next = readConfig();
		if (next.text === m.loaded.text && m.configError === null) return;
		applyLoaded(next);
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		m.configError = error;
	}
}

// The directory, not the file: an editor that saves by renaming a new file into place replaces the file watched.
// biome-ignore lint/plugin: before the roster's first frame, when nothing waits on its keys yet.
mkdirSync(configDir(), { recursive: true });

let reloadTimer: Timer | null = null;

watch(configDir(), (_event, file) => {
	if (file !== null && file !== "config.toml") return;
	if (reloadTimer) clearTimeout(reloadTimer);
	reloadTimer = setTimeout(() => {
		reloadTimer = null;
		dispatch(reloadConfig);
	}, 100);
});

/** config.toml in the Editor command, in a popup over the Deck, at a line. */
function openConfig(line: number | null): void {
	void deckClient().then(async (client) => {
		if (!client) return;
		const command = `exec ${m.config.editor} ${line === null ? "" : `+${line} `}${quote(configPath())}`;
		// biome-ignore lint/plugin: a getent, on opening config.toml.
		const shell = loginShell();
		await tmuxAsync(
			UI,
			"display-popup",
			"-c",
			client,
			"-E",
			"-w",
			"90%",
			"-h",
			"90%",
			"-T",
			" config.toml ",
			`${shell} -lic ${quote(command)}`,
		).catch((error: Error) => toast(`editor: ${error.message}`, "error"));
	});
}

const settingsHost = {
	loaded: () => m.loaded,
	error: () => m.configError,
	save: (updated: Record<string, unknown>, reorder = false): string | null => {
		try {
			// biome-ignore lint/plugin: Settings shows what it saved on the frame after the key that saved it.
			applyLoaded(writeConfig(m.loaded, updated, reorder));
			return null;
		} catch (error) {
			if (error instanceof SwbError) return error.message;
			throw error;
		}
	},
	catalog: () => m.catalog,
	refresh: (models: boolean) => post({ type: "refresh", models }),
	open: (line: number | null) => afterCommit(() => openConfig(line)),
	close: () => closeSettings(),
	help: () => afterCommit(() => void showHelp()),
	paint: { cursor: cursorLine, hover: hoverLine },
	message: (now: number, withConfigError: boolean) => screen.message(now, withConfigError),
	requestRender: () => screen.requestRender(),
	dispatch: (change: () => void) => dispatch(change),
};

/** Settings fills the Deck: the roster zooms its own pane over the Stage, which keeps running underneath. */
function openSettings(): void {
	if (settingsPane()) return;
	m.gesture = { kind: "none" };
	if (m.stage.highlightTimer) clearTimeout(m.stage.highlightTimer);
	m.stage.highlightTimer = null;
	enter({ kind: "settings", pane: new SettingsPane(settingsHost) });
	post({ type: "refresh", models: false });
	afterCommit(() => panes.zoomRoster(true));
}

function closeSettings(): void {
	if (!settingsPane()) return;
	leave();
}

// ── main ────────────────────────────────────────────────────────────────

function takeColors({ foreground, background, palette }: TerminalColors, scheme: "light" | "dark" | null): void {
	const light =
		(scheme ?? m.profile?.scheme ?? (background && background.r + background.g + background.b > 382 ? "light" : "dark")) === "light";
	if (background && foreground) dimColors(background, foreground, light);
	m.cursorBg =
		background && foreground
			? {
					focused: mix(48, background, foreground, 0.2),
					unfocused: mix(48, background, foreground, 0.12),
					hover: mix(48, background, foreground, light ? 0.12 : 0.06),
				}
			: null;
	m.colors = { background: background ? hex(background as RgbColor) : null, scheme: scheme ?? m.colors.scheme };
	if (background && foreground) {
		// Before the terminal's first report, its scheme is guessed from the background, as tmux does.
		const guess = background.r + background.g + background.b > 382 ? "light" : "dark";
		m.profile = {
			foreground: hex(foreground),
			background: hex(background),
			palette: palette?.map(hex) ?? null,
			scheme: scheme ?? m.profile?.scheme ?? guess,
		};
		post({ type: "colors", colors: m.profile });
	}
}

function stageUp(ttys: string[]): void {
	panes.clientsUp(ttys);
	checkReady();
}

/** Ready once the first snapshot is in and the Stage's nested client is attached to the sessions server. */
function checkReady(): void {
	if (m.ready || m.snapshot === null || !panes.main.up) return;
	m.ready = true;
	mark("roster.ready");
	if (args.select) reveal(args.select);
	if (m.continueTo) focusEntry(m.continueTo);
}

let listingClients = false;

/** What the Deck's state machine asks of the screen it drives, which the roster's view hands it at boot. */
type Screen = {
	requestRender(): void;
	closeOverlays(): Promise<void>;
	/** The pointer moved over the roster, off any overlay. */
	pointerAway(): void;
	/** The UI server stopped watching the pointer leave, as it does once it reports it. */
	disarmed(): void;
	message(now: number, withConfigError: boolean): string;
};

let screen: Screen;

/** Starts the Deck once its screen is up: the worker's first asks, the Stage's clients, and the clock that ticks it. */
export function boot(on: Screen): void {
	screen = on;
	post({ type: "init", deck, config: m.config, here });
	post({ type: "dirs" });
	if (args.new) {
		const cwd = args.new;
		dispatch(() => newSession(cwd, null, null, args.harness ? asHarness(args.harness) : null));
	}
	void panes.layout();
	// Attached before it lists them, the control client hears every client that attaches after the list.
	void ctl.run("list-clients -F '#{client_tty}'").then(
		(out) => dispatch(() => stageUp(out.split("\n"))),
		(error: Error) => toast(`stage: ${error.message}`, "error"),
	);
	setInterval(() => {
		// The control client misses attaches while it respawns after the sessions server restarts.
		if (!listingClients && (!panes.main.up || (panes.side && !panes.side.up))) {
			listingClients = true;
			void ctl
				.run("list-clients -F '#{client_tty}'")
				.then(
					(out) => dispatch(() => stageUp(out.split("\n"))),
					() => {},
				)
				.finally(() => {
					listingClients = false;
				});
		}
		const now = Date.now();
		keepLayout(now);
		syncTitle();
		if (m.toasts.some((t) => t.until <= now))
			dispatch(() => {
				m.toasts = m.toasts.filter((t) => t.until > now);
			});
		else if (m.launches.length > 0 || [...m.entries.values()].some((e) => e.activity === "blocked" || e.activity === "working"))
			screen.requestRender();
	}, 100);
}

/** A key the roster's pane took. */
export function onKey(data: string): void {
	dispatch(() => input(data));
}

/** The pointer on the roster's pane. Motion that lights nothing new changes nothing, and skips the commit as it skips the render. */
export function onMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
	const result = transition(() => mouse(event));
	if (result?.render !== false || effects.length > 0) commit();
	return result;
}

/**
 * A frame is out: the Peek settles where the frame wanted it, and the UI server watches for the pointer leaving while
 * something leaves with it. Returns whether the Peek moved, which the next frame shows. It doesn't commit, since that
 * draws another frame.
 */
export function onFrame(spot: PeekSpot | null, leaves: boolean): boolean {
	return transition(() => {
		const settled = spotKey(m.peek.settled);
		syncPeek(wantPeek(spot));
		syncWatch(m.pointer !== null || m.peek.spot !== null || leaves);
		if (spotKey(m.peek.settled) !== settled) setStageCard(desired());
		return spotKey(m.peek.settled) !== settled;
	});
}

/** The UI server saw the pointer leave the roster and its overlays, or a key typed elsewhere. */
export function onPointerOut(): void {
	dispatch(pointerOut);
}

/** A button on an overlay. A Peek's are its row's prefix keys, and leave a mode left open as those do. */
export function onOverlayPress(command: Command, at: { x: number; y: number }): void {
	dispatch(() => {
		m.pointer = at;
		if (command.kind === "row") leave();
		run(command);
	});
}

/** The pointer on an overlay that belongs to a row, as a Peek does: the row stays hovered. */
export function onOverlayHover(row: string): void {
	if (m.peek.settled) expirePeek();
	if (m.hover === row && !m.peek.pending) return;
	dispatch(() => {
		cancelPendingPeek();
		m.hover = row;
	});
}

/** The terminal reported its colors. */
export function onColors(reported: TerminalColors, scheme: "light" | "dark" | null): void {
	dispatch(() => takeColors(reported, scheme));
}
