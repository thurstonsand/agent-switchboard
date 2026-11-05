import { mkdirSync, rmSync, statSync, watch } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
	type Component,
	decodeKittyPrintable,
	type Focusable,
	Input,
	isKeyRelease,
	matchesKey,
	ProcessTerminal,
	type RgbColor,
	sliceByColumn,
	TuiAltScreen,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { harness as asHarness, configDir, type Harness, operatorDir, type SnoozePreset, VIEWS, type View } from "@swb/shared";
import { harnessName } from "@swb/shared/mailbox";
import { mark, span } from "@swb/shared/trace";
import { ConfigError, configPath, type Loaded, readConfig } from "../config.ts";
import { type CutOff, displayName, openDescendants, projectName } from "../derive.ts";
import { completions, expandHome, type Target, type TargetTree, targetName } from "../dirs.ts";
import { SwbError, UsageError } from "../errors.ts";
import { unnameable } from "../groups.ts";
import { type Catalog, type Choice, defaultLaunch, fromDefault, type LaunchTarget, presetLabels, shortlist } from "../harnesses.ts";
import { ensureOperatorDir } from "../operator.ts";
import { presetUntil } from "../schedules.ts";
import { loginShell, newer, nvimEditor } from "../sessions.ts";
import type { DeckLayout } from "../store.ts";
import { quote, SESSIONS, tmux, tmuxAsync, tmuxTry, UI } from "../tmux.ts";
import { VERSION } from "../version.ts";
import { writeConfig } from "../write-config.ts";
import { Control } from "./control.ts";
import { deckSocket, HELP_POPUP, placeholderName, rosterCols, SPLIT_FROM } from "./deck.ts";
import { helpSize } from "./help.ts";
import { type Overlay, type OverlayButton, Overlays, type OverlayView } from "./overlay.ts";
import type {
	Card,
	DeckState,
	Entry,
	FromWorker,
	PeekInfo,
	PickerState,
	ShellAt,
	Snapshot,
	State,
	StatSummary,
	TerminalProfile,
	ToWorker,
	Transcript,
} from "./protocol.ts";
import { SettingsPane } from "./settings.ts";
import { type Applied, StagePanes } from "./stage.ts";
import {
	age,
	attention,
	blue,
	bold,
	breathe,
	cyan,
	dim,
	flashOn,
	gray,
	green,
	hex,
	key,
	lerp,
	magenta,
	mix,
	red,
	sgrBg,
	shortPath,
	spinnerFrame,
	wakeAt,
	yellow,
} from "./style.ts";

const VISIT_MS = 1000;
const HIGHLIGHT_MS = 500;
const TOAST_MS = 3500;
const LAYOUT_SETTLE_MS = 500;

const { values: args } = parseArgs({
	args: process.argv.slice(3),
	options: {
		deck: { type: "string" },
		select: { type: "string" },
		new: { type: "string" },
		harness: { type: "string" },
		here: { type: "string" },
		continue: { type: "boolean" },
	},
});
if (!args.deck || !args.here) throw new UsageError("__roster: --deck and --here are required");
const deck = args.deck;
/** Where swb was run: `-c` and `swb new` start there, and this Project keeps the Deck's layout. */
const here = args.here;
if (!process.env.TMUX_PANE) throw new UsageError("__roster: runs only inside a Deck pane");
const rosterPane = process.env.TMUX_PANE;
/** The Stage's pane and its tty, from the window option the Deck set as it made the Stage. */
// biome-ignore lint/plugin: before the roster's first frame, when nothing waits on its keys yet.
const [stagePane, stageTty] = tmux(UI, "display", "-p", "-t", rosterPane, "#{P:#{?#{==:#{pane_id},#{@swb_stage}},#{pane_id} #{pane_tty},}}")
	.trim()
	.split(" ") as [string, string];
if (!stagePane || !stageTty) throw new UsageError("__roster: its window names no Stage");
const sock = deckSocket(deck);
const placeholder = placeholderName(deck);
/** config.toml as this Deck last applied it; a file that fails to read leaves it be, and says so. */
// biome-ignore lint/plugin: before the roster's first frame, when nothing waits on its keys yet.
let loaded: Loaded = readConfig();
let config = loaded.config;
let configError: ConfigError | null = null;
/** What the harnesses can start, as the worker last found it. */
let catalog: Catalog | null = null;

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
const perf = { render: new Stat(), switchClient: new Stat(), keyToSwitch: new Stat(), keyToFrame: new Stat() };

// ── tmux ────────────────────────────────────────────────────────────────

const ctl = new Control((line) => {
	const [kind, tty, , session] = line.split(" ");
	if (kind !== "%client-session-changed" || !tty) return;
	stageUp([tty]);
	if (session === placeholder) panes.parked(tty, placeholder);
});

// ── model ───────────────────────────────────────────────────────────────

let snapshot: Snapshot | null = null;
let entries = new Map<string, Entry>();

/** A wake or new-session request: it resolves once a live entry is hosted by its tmux session. */
type Launch = { req: number; id: string | null; host: string | null; since: number; keyboard: boolean };
const launches: Launch[] = [];

/** The last request id handed out; see FromWorker. */
let lastReq = 0;
const nextReq = () => ++lastReq;

let focus: "roster" | "stage" = "roster";
// No focus event has arrived when the Deck starts; the terminal that just launched it is assumed focused.
let terminalFocused = true;
/** The pane id the keyboard is on. */
let focusedPane = "";
let ready = false;

type Toast = { text: string; level: "info" | "error"; until: number };
let toasts: Toast[] = [];
function toast(text: string, level: Toast["level"]): void {
	toasts.push({ text, level, until: Date.now() + TOAST_MS });
	tui.requestRender();
}

const transcripts = new Map<string, { transcript: Transcript | null; error: string | null }>();
/** The activity each dormant session's transcript was last asked for at; one that moved on since is read again. */
const transcriptsAsked = new Map<string, number>();

/**
 * Reads a dormant session's transcript for its card when its activity moved since the last read, or always when staged:
 * the file can change with nothing in swb seeing it, as when the session is resumed outside swb.
 */
function readTranscript(e: Entry, staged: boolean): void {
	if (e.live || !e.transcript || (!staged && transcriptsAsked.get(e.id) === e.activityAt)) return;
	transcriptsAsked.set(e.id, e.activityAt);
	post({ type: "transcript", id: e.id, path: e.transcript, harness: e.harness });
}

function launchFor(id: string): Launch | undefined {
	return launches.find((launch) => launch.id === id);
}

function isUnseen(e: Entry): boolean {
	return e.unseen && stage.watched !== e.id;
}

/** Views chosen in this Deck that the db doesn't reflect yet, each with the request that writes it. */
const localViews = new Map<string, { view: View; req: number }>();

function viewOf(e: Entry): View {
	return localViews.get(e.id)?.view ?? e.view;
}

/** Groups set here and not yet back in a snapshot, each with the request that writes it; null is ungrouped. */
const localGroups = new Map<string, { name: string | null; req: number }>();

/** The Group a session carries, as set here or in the db; Operators take none. */
function groupOf(e: Entry): string | null {
	if (e.operator) return null;
	const local = localGroups.get(e.id);
	return local ? local.name : e.group;
}

function setGroup(ids: string[], name: string | null): void {
	const req = nextReq();
	for (const id of ids) localGroups.set(id, { name, req });
	post({ type: "group", req, ids, name });
}

/** Where a session is listed: Archived, Operators, Inactive, or open beneath its Project. */
function sectionOf(e: Entry): "archived" | "snoozed" | "operators" | "inactive" | "open" {
	if (!e.open) return "archived";
	if (e.snoozed) return "snoozed";
	if (e.operator) return "operators";
	return e.inactive ? "inactive" : "open";
}

function parentOf(e: Entry): Entry | undefined {
	return e.parentId === null ? undefined : entries.get(e.parentId);
}

/** Who started a session, as its row marks it wherever its parent's row isn't right above it. */
function origin(e: Entry): "session" | "operator" | null {
	if (e.parentId === null) return null;
	return parentOf(e)?.operator ? "operator" : "session";
}

const foldKey = (id: string) => `fold:${id}`;

function stateOf(e: Entry): State {
	if (launchFor(e.id) && !e.live) return "loading";
	if (!e.open) return "archived";
	if (e.cutOff) return "cut-off";
	if (e.activity === "blocked") return "blocked";
	if (e.activity === "working") return "working";
	if (e.errored) return "errored";
	if (!e.live) return isUnseen(e) ? "unseen" : "dormant";
	return isUnseen(e) ? "unseen" : "idle";
}

function glyph(state: State, now: number): string {
	switch (state) {
		case "loading":
			return cyan(spinnerFrame(now));
		case "blocked":
			return flashOn(now) ? bold(attention("◆")) : dim(attention("◆"));
		case "working":
			return breath ? breathe(breath.faint, breath.strong, now, "◐") : cyan("◐");
		case "unseen":
			return green("●");
		case "idle":
			return "○";
		case "dormant":
			return gray("○");
		case "cut-off":
		case "errored":
			return red("⚠");
		case "archived":
			return gray("✓");
	}
}

/** The one place a session's state is named; the row's glyph is where it's scanned, and its section says snoozed. */
function status(e: Entry): string {
	const base = `${phaseStatus(e)}${e.reload && e.live ? gray(" · reloads when this turn ends") : ""}`;
	if (!e.snoozed) return base;
	return `${base}${gray(` · snoozed until ${e.snoozedUntil === null ? "a message" : wakeAt(e.snoozedUntil, Date.now())}`)}`;
}

function phaseStatus(e: Entry): string {
	if (stage.ended?.id === e.id && stage.ended.failed && e.open && !e.live && !launchFor(e.id)) return red("failed to start");
	const state = stateOf(e);
	switch (state) {
		case "loading":
			return cyan("starting");
		case "blocked":
			return attention("blocked");
		case "working":
			return cyan("working");
		case "unseen":
			return e.live ? green("unseen") : `${green("unseen")}${gray(" · not running")}`;
		case "idle":
			return e.provisional ? `idle${gray(" · no prompt yet")}` : "idle";
		case "dormant":
			return "not running";
		case "cut-off":
			return `${red("cut off")}${gray(` · ${CAUSES[e.cutOff as CutOff]} · waking continues it`)}`;
		case "errored":
			return e.live ? red("errored") : `${red("errored")}${gray(" · not running")}`;
		case "archived":
			return gray("archived");
	}
}

const CAUSES: Record<CutOff, string> = { shutdown: "shut down", killed: "killed", restart: "machine restarted" };

const archivedKey = (e: Entry) => Math.max(e.activityAt, e.archivedAt ?? 0);

/** How long a session has been starting, while it is. */
function launchElapsed(e: Entry, now: number): string {
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
const panes = new StagePanes(
	{
		deck,
		rosterPane,
		stagePane,
		stageTty,
		ctl,
		focusedPane: () => focusedPane,
		configuredCols: (width) => rosterCols(config.rosterWidth, width),
		settingsOpen: () => roster.settings !== null,
		scheme: () => profile?.scheme ?? null,
		closeOverlays: () => overlays.closeAll(),
		toast,
		switched: (ms, keyAt) => {
			perf.switchClient.add(ms);
			if (keyAt > 0) perf.keyToSwitch.add(performance.now() - keyAt);
		},
		resized: () => apply(),
		rosterPlaced: () => {
			syncStatus();
			setStageCard(desired());
		},
	},
	onCard("empty", null, EMPTY),
);

const stage = {
	/** The session on the Stage, or the pending new session (id null) when `new` is starting. */
	staged: null as string | null,
	stagedAt: 0,
	/** A session whose pi quit or failed while on view: a card until `w` or Enter. */
	ended: null as { id: string; failed: boolean; lines: string[] } | null,
	/** While `new` starts, the Stage holds on its loading card until the cursor is moved. */
	holdForNew: false,
	/** The card the placeholder shows, as the JSON `/card` streams; `cardChanged` settles each time it changes. */
	cardJson: JSON.stringify({ head: [], lines: ["Deck starting…"], turns: null, tail: [], ending: null, agent: "" } satisfies Card),
	cardChanged: Promise.withResolvers<void>(),
	watched: null as string | null,
	/** The session I marked Unseen while it was on the Stage: watching it is no Visit until the Stage leaves it. */
	marked: null as string | null,
	visited: false,
	visitTimer: null as Timer | null,
	highlightTimer: null as Timer | null,
};

const rosterOffScreen = () => panes.narrow || panes.rosterHidden;

let statusShown = false;
let statusOps = Promise.resolve();
/** While the Stage fills the Deck, its status line carries the click that brings the roster back. */
function syncStatus(): void {
	const want = panes.rosterHidden || (panes.narrow && focus === "stage");
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
	const states = [...entries.values()].map(stateOf);
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
	if (e.cutOff) return red("cut off");
	if (read?.ending?.kind === "stopped") return yellow("stopped");
	if (read?.ending?.kind === "error") return red("errored");
	return null;
}

function card(e: Entry, lines: string[] = []): Card {
	const transcript = transcripts.get(e.id);
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
		ending: end,
		agent: e.harness,
	};
}

const ESC_LINE = "esc goes back to the list.";

function newLaunch(): Launch | undefined {
	return launches.find((launch) => launch.id === null);
}

/** The Stage as pi view would have it. */
function piStage(): Applied {
	const pending = newLaunch();
	if (stage.staged === null && pending) {
		if (pending.host) return starting(null, pending.host);
		// A new session has no row yet, so its card is the only place that says it's starting.
		const lines = pending.keyboard && rosterOffScreen() ? [ESC_LINE] : [];
		return onCard("loading", null, { head: [cyan("starting a new session")], lines, turns: [], tail: [], ending: null, agent: "" });
	}
	const e = stage.staged === null ? undefined : entries.get(stage.staged);
	if (!e) return onCard("empty", null, EMPTY);
	if (stage.ended?.id === e.id && e.open) {
		const failed = stage.ended.failed;
		return onCard(
			failed ? "failed" : "exited",
			e.id,
			card(e, failed ? [`${harnessName(e.harness)} quit before it was ready:`, ...stage.ended.lines] : []),
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
	const e = d.id === null ? undefined : entries.get(d.id);
	const target = e?.open && shellsShown.has(e.cwd) ? snapshot?.shells[e.cwd] : undefined;
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
	if (config.shellPosition === "auto" && sameStage && prev.at !== "replace" && fits[prev.at]) return prev.at;
	const want = config.shellPosition !== "auto" ? config.shellPosition : panes.height * panes.cellRatio > cols ? "below" : "beside";
	const other = want === "below" ? "beside" : "below";
	return fits[want] ? want : fits[other] ? other : "replace";
}

/** Directories whose shell this Deck shows; a shell that exits leaves the set. */
const shellsShown = new Set<string>();
/** Directories whose shell this Deck asked the worker to start, by the request; toggling again takes the ask back. */
const shellsAsked = new Map<string, number>();

/** Split needs pi live and a wide Deck, and both need the Editor. */
function viewed(): Applied {
	const d = piStage();
	const e = d.id === null ? undefined : entries.get(d.id);
	const editor = e?.open ? snapshot?.editors[e.cwd] : undefined;
	if (!e || !editor) return d;
	const view = viewOf(e);
	if (view === "editor") return { ...d, view, target: editor };
	if (view === "split" && d.host && panes.width >= SPLIT_FROM) return { ...d, view, target: editor, side: d.host };
	return d;
}

/** Directories whose Editor this staging already asked for, so an Editor that dies isn't restarted in a loop. */
const editorsAsked = new Set<string>();
/** Directories whose Editor died after this staging asked for it, already reported once. */
const editorsLost = new Set<string>();
const editorWaits = new Map<string, ((name: string | null) => void)[]>();

/** Resolves to the directory's Editor once the worker reports it, or null if it couldn't start. */
function requestEditor(dir: string): Promise<string | null> {
	editorsAsked.add(dir);
	const existing = snapshot?.editors[dir];
	if (existing) return Promise.resolve(existing);
	return new Promise((resolve) => {
		const waits = editorWaits.get(dir);
		if (waits) {
			waits.push(resolve);
			return;
		}
		editorWaits.set(dir, [resolve]);
		post({ type: "editor", dir });
	});
}

function settleEditorWaits(dir: string, name: string | null): void {
	for (const resolve of editorWaits.get(dir) ?? []) resolve(name);
	editorWaits.delete(dir);
}

/** A harness on the Stage's pane before it's up, which shows its terminal's echo, not its own screen. */
function harnessStarting(a: Applied): boolean {
	return a.kind === "loading" && a.target !== placeholder;
}

function setStageCard(d: Applied): void {
	if (!d.card || d.target !== placeholder) return;
	const json = JSON.stringify(d.card);
	if (json === stage.cardJson) return;
	stage.cardJson = json;
	stage.cardChanged.resolve();
	stage.cardChanged = Promise.withResolvers();
}

/**
 * The Stage's card as newline-delimited JSON, for the placeholder: each line the latest card, once the placeholder has
 * taken the last one, so a burst of cursor moves sends only where it ended. It ends with the Deck.
 */
function cardStream(): Response {
	const encoder = new TextEncoder();
	let sent: string | null = null;
	let gone = false;
	const body = new ReadableStream(
		{
			async pull(controller) {
				while (!gone && stage.cardJson === sent) await stage.cardChanged.promise;
				if (gone) return;
				sent = stage.cardJson;
				controller.enqueue(encoder.encode(`${sent}\n`));
			},
			cancel() {
				gone = true;
			},
		},
		{ highWaterMark: 0 },
	);
	return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

function apply(): void {
	const d = desired();
	span("roster.card", () => setStageCard(d));
	const prev = panes.applied;
	panes.sync(d, stageLabel(d), { editor: nvimEditor(config.editor) && editorShown(d), starting: harnessStarting(d) });
	syncVisit();
	const e = d.id === null ? undefined : entries.get(d.id);
	if (d.host && e?.open && viewOf(e) !== "agent" && snapshot && !snapshot.editors[e.cwd]) {
		if (!editorsAsked.has(e.cwd)) void requestEditor(e.cwd);
		else if (!editorWaits.has(e.cwd) && !editorsLost.has(e.cwd)) {
			editorsLost.add(e.cwd);
			toast(`editor for ${e.cwd} exited; showing ${harnessName(e.harness)}`, "error");
		}
	}
	tui.requestRender();
	const shellMoved = d.shell?.target !== prev.shell?.target || d.shell?.at !== prev.shell?.at;
	if (shellMoved && d.shell && !panes.narrow && config.shellPosition !== "auto" && d.shell.at !== config.shellPosition) {
		const room = config.shellPosition === "beside" ? `${2 * SHELL_MIN_COLS + 1} columns` : `${2 * SHELL_MIN_ROWS + 1} rows`;
		const where = d.shell.at === "replace" ? `in ${e ? harnessName(e.harness) : "the agent"}'s place` : d.shell.at;
		toast(`a shell ${config.shellPosition} needs ${room}; showing it ${where}`, "info");
	}
}

/** What the Stage's agent pane is labelled: its session's harness, or what it waits on without one. */
function stageLabel(a: Applied): string {
	if (a.id === null) return newLaunch() ? "new" : "empty";
	const e = entries.get(a.id);
	if (!e) throw new Error(`the Stage applied ${a.id}, which has no entry`);
	return e.harness;
}

/** Whether the Stage's first pane shows the Editor, which a shell replacing it in editor view hides. */
function editorShown(a: Applied): boolean {
	return a.view === "split" || (a.view === "editor" && a.shell?.at !== "replace");
}

/** The pane the shell is in: its own, or pi's when it replaces pi. */
function shellShownIn(): string | null {
	const a = panes.applied;
	if (a.shell?.at === "replace") return a.side !== null ? (panes.side?.pane ?? null) : stagePane;
	return panes.shellPane?.pane ?? null;
}

function watching(): string | null {
	const a = panes.applied;
	if (!terminalFocused || focus !== "stage" || !piShown(a)) return null;
	if (a.view === "split" && focusedPane === stagePane) return null;
	return a.id;
}

/** A Visit is pi focused on a focused Deck's Stage for 1 s; passing over a session in the roster isn't one. */
function syncVisit(): void {
	if (stage.marked !== panes.applied.id) stage.marked = null;
	const watched = watching();
	const id = watched === stage.marked ? null : watched;
	if (id === stage.watched) return;
	if (stage.visitTimer) clearTimeout(stage.visitTimer);
	stage.visitTimer = null;
	// Turns that landed while I watched are seen.
	if (stage.watched && stage.visited) post({ type: "visit", id: stage.watched });
	stage.visited = false;
	stage.watched = id;
	if (id === null) return;
	stage.visitTimer = setTimeout(() => {
		stage.visitTimer = null;
		if (stage.watched !== id) return;
		stage.visited = true;
		post({ type: "visit", id });
		remember(id);
		tui.requestRender();
	}, VISIT_MS);
}

/** `[` and `]`: the sessions this Deck has visited, oldest first, each once, and the one it stands on. */
const history = { ids: [] as string[], at: -1 };

/** A Visit somewhere new drops what lay ahead, as a browser's history does; one where `[` or `]` landed changes nothing. */
function remember(id: string): void {
	if (history.ids[history.at] === id) return;
	history.ids = history.ids.slice(0, history.at + 1).filter((other) => other !== id);
	history.ids.push(id);
	history.at = history.ids.length - 1;
}

/**
 * Where `[` lands: the latest visited session at or behind my place that isn't on view, so one I've only moved off
 * comes first; `]`: the next one past my place. Archived sessions are passed over; snoozed ones aren't.
 */
function historyStep(step: -1 | 1): number {
	for (let i = step < 0 ? history.at : history.at + 1; i >= 0 && i < history.ids.length; i += step) {
		const id = history.ids[i] as string;
		if (id !== stage.staged && entries.get(id)?.open) return i;
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
	history.at = i;
	const e = entries.get(history.ids[i] as string) as Entry;
	reveal(e.id);
	if (focus === "stage") roster.focusEntry(e);
}

function stageSession(id: string): void {
	if (stage.staged === id) return;
	stage.staged = id;
	stage.stagedAt = Date.now();
	if (stage.ended?.id !== id) stage.ended = null;
	editorsAsked.clear();
	editorsLost.clear();
	const e = entries.get(id);
	if (e) readTranscript(e, true);
	scheduleHighlightWake();
	apply();
}

function scheduleHighlightWake(): void {
	if (stage.highlightTimer) clearTimeout(stage.highlightTimer);
	stage.highlightTimer = null;
	const e = stage.staged === null ? undefined : entries.get(stage.staged);
	// A snoozed session is out of the way: looking at it doesn't start it.
	if (!config.wakeOnHighlight || !e?.open || e.snoozed || e.live || launchFor(e.id) || stage.ended?.id === e.id) return;
	const id = e.id;
	stage.highlightTimer = setTimeout(() => {
		stage.highlightTimer = null;
		if (stage.staged === id) wake(id, false);
	}, HIGHLIGHT_MS);
}

function wake(id: string, keyboard: boolean): void {
	if (stage.ended?.id === id) stage.ended = null;
	const existing = launchFor(id);
	if (existing) {
		existing.keyboard ||= keyboard;
		apply();
		return;
	}
	if (entries.get(id)?.live) return;
	const req = nextReq();
	launches.push({ req, id, host: null, since: Date.now(), keyboard });
	post({ type: "wake", req, id });
	apply();
}

/** Restarts a session's harness, live or not, to carry on; the Stage shows it starting, as a wake does, until it's back. */
function reload(id: string): void {
	if (stage.ended?.id === id) stage.ended = null;
	if (launchFor(id)) return;
	const req = nextReq();
	launches.push({ req, id, host: null, since: Date.now(), keyboard: focus === "stage" });
	post({ type: "reload", req, id });
	apply();
}

/** A new session on `target`; with none, the worker picks `harness`'s first preset, or the default, once it knows what can start. */
function newSession(cwd: string, group: string | null, target: LaunchTarget | null, harness: Harness | null = null): void {
	if (newLaunch()) {
		toast("a new session is already starting", "info");
		return;
	}
	const req = nextReq();
	launches.push({ req, id: null, host: null, since: Date.now(), keyboard: true });
	stage.holdForNew = true;
	stage.staged = null;
	stage.ended = null;
	post({ type: "new", req, cwd, group, target, harness });
	apply();
	focusOnceShown(() => panes.side?.pane ?? stagePane);
}

/** Launches whose host is now live resolve; one whose host vanished first failed to start. */
function settleLaunches(): void {
	if (!snapshot) return;
	const hosts = new Set(snapshot.hosts);
	for (const launch of [...launches]) {
		if (launch.host === null) continue;
		const live = [...entries.values()].find((e) => e.live && e.host === launch.host);
		if (live) {
			launches.splice(launches.indexOf(launch), 1);
			if ((launch.id === null && stage.staged === null) || (launch.id !== null && stage.staged === launch.id)) {
				roster.selectedKey = live.id;
				stageSession(live.id);
			}
			continue;
		}
		if (hosts.has(launch.host)) continue;
		const lastWords = snapshot.died[launch.host] ?? [];
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
	launches.splice(launches.indexOf(launch), 1);
	if (launch.id !== null && stage.staged === launch.id) stage.ended = { id: launch.id, failed: true, lines };
	else toast(text, "error");
	if (launch.id === null && stage.staged === null) {
		stage.holdForNew = false;
		const e = roster.cursorEntry();
		if (e) stageSession(e.id);
	}
	if (launch.keyboard || focus === "stage") {
		// The keyboard may still be on its way to the launch: that move is called off, and if it already went, its arrival
		// isn't a move onto what's staged now.
		focusMoves++;
		returning = true;
		void panes.showRoster(true);
	}
}

/** The keyboard is coming back to the roster from a launch that failed; landing on the Stage meanwhile wakes nothing. */
let returning = false;

/** Whatever the Stage's host now runs is what's selected: `/new` or `/resume` inside pi moves the selection with it. */
function followHost(): void {
	// A session that quit while watched and is back, woken by a message or restarted by its reload, shows live again.
	if (stage.ended && !stage.ended.failed && entries.get(stage.ended.id)?.live) {
		stage.ended = null;
		return;
	}
	const { id, host } = panes.applied;
	if (id === null || host === null) return;
	const e = entries.get(id);
	if (e?.live && e.host === host) return;
	const moved = [...entries.values()].find((x) => x.live && x.host === host);
	if (moved) {
		roster.selectedKey = moved.id;
		stage.staged = moved.id;
		stage.stagedAt = Date.now();
		return;
	}
	// A reload stops it on purpose; its new host takes over the Stage.
	if (launchFor(id)) return;
	stage.ended = { id, failed: false, lines: [] };
	if (focus === "stage") void panes.showRoster(true);
}

/** The cursor the last Deck in this Project left, until the first snapshot places it. */
let restoredKey: string | null = null;
let started = false;
/** The Project `here` is in, which the worker finds before its first snapshot. */
let hereRoot = "";
/** `-c`: the session whose pi takes the keyboard once the Stage is up. */
let continueTo: Entry | null = null;

/**
 * Where the first snapshot puts the cursor: `swb open`'s session, `-c`'s most recent session here, where the last Deck in
 * this Project left it, else the session I last visited. Only `-c` takes the keyboard.
 */
function startCursor(): void {
	started = true;
	// `[` reaches back past this Deck, through the Visits every Deck and tmux client before it made.
	history.ids = [...entries.values()]
		.filter((e) => e.open && e.visitedAt !== null)
		.sort((a, b) => (a.visitedAt ?? 0) - (b.visitedAt ?? 0))
		.map((e) => e.id);
	history.at = history.ids.length - 1;
	if (args.select || args.new) return;
	// A snoozed session is out of the way until it wakes: neither -c nor the last visit lands on one.
	const open = [...entries.values()].filter((e) => e.open && !e.provisional && !e.snoozed);
	if (args.continue) {
		const recent = open
			.filter((e) => e.project === hereRoot)
			.sort((a, b) => (b.visitedAt ?? 0) - (a.visitedAt ?? 0) || b.activityAt - a.activityAt)[0];
		if (!recent) {
			newSession(here, null, null);
			return;
		}
		reveal(recent.id);
		continueTo = recent;
		return;
	}
	// Nor does where the last Deck left off, if it has been snoozed since.
	const restored = restoredKey === null ? undefined : entries.get(restoredKey);
	if (restored?.open && !restored.snoozed) {
		reveal(restored.id);
		return;
	}
	if (restoredKey !== null && !restored?.snoozed && roster.rows().some((row) => row.key === restoredKey)) {
		roster.selectedKey = restoredKey;
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
	if (!started) return;
	const kept: DeckLayout = {
		selectedKey: roster.selectedKey,
		rosterCols: panes.dragged,
		collapsed: [...roster.collapsed],
		expanded: [...roster.expanded],
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
	if (snapshot === null) mark("roster.first-snapshot");
	snapshot = next;
	entries = new Map(next.entries.map((e) => [e.id, e]));
	for (const [id, { view }] of localViews) if (entries.get(id)?.view === view) localViews.delete(id);
	for (const [id, { name }] of localGroups) {
		const e = entries.get(id);
		if (!e || e.group === name) localGroups.delete(id);
	}
	// Ctrl-D in a shell is the same as hiding it.
	for (const dir of shellsShown) if (!next.shells[dir]) shellsShown.delete(dir);
	settleLaunches();
	followHost();
	roster.settlePin();
	if (!started) startCursor();
	const e = stage.staged === null ? undefined : entries.get(stage.staged);
	if (e) readTranscript(e, false);
	apply();
	roster.syncStage(false);
	// A turn that lands while I'm already watching is seen as it lands.
	if (stage.watched && stage.visited && entries.get(stage.watched)?.unseen) post({ type: "visit", id: stage.watched });
	// Setting it repaints the whole Deck, best done with the snapshot's own frame than a tick later.
	syncTitle();
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
	toasts.push({ text: `worker died: ${event.message}`, level: "error", until: Number.POSITIVE_INFINITY });
	tui.requestRender();
};
worker.onmessage = (event: MessageEvent<FromWorker>) => {
	const message = event.data;
	switch (message.type) {
		case "restore":
			hereRoot = message.root;
			if (message.layout) {
				roster.collapsed = new Set(message.layout.collapsed);
				roster.expanded = new Set(message.layout.expanded.flatMap((saved) => SECTION_KEYS.filter((key) => key === saved)));
				panes.dragged = message.layout.rosterCols;
				restoredKey = message.layout.selectedKey;
				void panes.layout();
			}
			break;
		case "snapshot":
			onSnapshot(message.snapshot);
			break;
		case "launched": {
			const launch = launches.find((l) => l.req === message.req);
			if (launch) launch.host = message.host;
			apply();
			break;
		}
		case "transcript":
			transcripts.set(message.id, { transcript: message.transcript, error: message.error });
			apply();
			break;
		case "peek":
			onPeekInfo(message.id, message.info);
			break;
		case "done": {
			const { req, error } = message;
			if (roster.pin?.req === req) {
				if (error === null) roster.pin.answered = true;
				else {
					roster.pin = null;
					roster.lingering = null;
				}
			}
			if (error === null) break;
			for (const [id, local] of localViews) if (local.req === req) localViews.delete(id);
			for (const [id, local] of localGroups) if (local.req === req) localGroups.delete(id);
			toast(error, "error");
			apply();
			break;
		}
		case "stopFailed":
			toast(message.text, "error");
			break;
		case "launchFailed": {
			const launch = launches.find((l) => l.req === message.req);
			if (launch) launchEnded(launch, [message.text], message.text);
			else toast(message.text, "error");
			apply();
			break;
		}
		case "editor":
			settleEditorWaits(message.dir, message.name);
			if (message.text) toast(`editor: ${message.text}`, "error");
			break;
		case "shell":
			if (message.text) toast(`shell: ${message.text}`, "error");
			if (shellsAsked.get(message.dir) !== message.req) break;
			shellsAsked.delete(message.dir);
			if (message.name) showShell(message.dir);
			break;
		case "dirs": {
			// The highlight stays on its directory through a fresh list.
			const before = roster.choosing && roster.pickRows()[roster.choosing.choice];
			dirTrees = message.trees;
			if (roster.choosing?.mode === "pick") {
				const rows = roster.pickRows();
				// Before the first list landed there was nothing to highlight but the directory it opened on.
				const path = before?.kind === "target" ? before.target.path : roster.choosing.pin;
				const at = rows.findIndex((r) => r.kind === "target" && r.target.path === path);
				roster.choosing.choice = at === -1 ? Math.min(roster.choosing.choice, rows.length - 1) : at;
			}
			tui.requestRender();
			break;
		}
		case "catalog":
			catalog = message.catalog;
			tui.requestRender();
			break;
		case "error":
			toast(message.text, "error");
			break;
	}
};

// ── roster ──────────────────────────────────────────────────────────────

async function clip(text: string): Promise<void> {
	const proc = Bun.spawn(["/bin/sh", "-c", config.clipboard], { stdin: new Blob([text]), stdout: "ignore", stderr: "pipe" });
	const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	if (code !== 0) throw new Error(stderr.trim() || `${config.clipboard} exited ${code}`);
}

/** `swb open` and `swb show`: select a session wherever it is, opening the section, project, and families that hide it. */
function reveal(id: string): void {
	const e = entries.get(id);
	if (!e) {
		toast(`no open or archived session ${id}`, "error");
		return;
	}
	if (!roster.matches(e)) roster.filter.setValue("");
	const section = sectionOf(e);
	if (section === "archived" || section === "operators" || section === "snoozed") roster.expanded.add(section);
	else {
		if (section === "inactive") roster.expanded.add("inactive");
		const group = groupOf(e);
		roster.collapsed.delete(`${section}:${e.project}`);
		if (group) roster.collapsed.delete(`${section}:${e.project}:${groupKey(group)}`);
	}
	for (let up = parentOf(e); up; up = parentOf(up)) roster.collapsed.delete(foldKey(up.id));
	roster.selectedKey = id;
	roster.syncStage(true);
}

type SectionKey = "operators" | "inactive" | "snoozed" | "archived";
const SECTION_KEYS: SectionKey[] = ["operators", "inactive", "snoozed", "archived"];

/** `s`'s menu: Amp's presets. */
const SNOOZE_CHOICES: { label: string; snooze: SnoozePreset }[] = [
	{ label: "1 hour", snooze: "one_hour" },
	{ label: "1 day", snooze: "one_day" },
	{ label: "Monday", snooze: "monday" },
	{ label: "Until a message", snooze: "next_message" },
];

/** A Project header has no group; a Group beneath it does, and starts sessions in its newest member's cwd. */
type HeaderRow = {
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
type Nest = { continues: boolean[]; last: boolean };
type Placed = { entry: Entry; nest: Nest };

/**
 * A family's root has no `nest`. `family` is everything beneath the row in its bucket, in tree order, placed relative to
 * it; a folded row hides it.
 */
type SessionRow = {
	kind: "session";
	key: string;
	entry: Entry;
	depth: number;
	header: string;
	nest: Nest | null;
	family: Placed[];
	folded: boolean;
};
type Row = HeaderRow | SessionRow | { kind: "section"; key: SectionKey; label: string; count: number; expanded: boolean };

const isHeader = (row: Row) => row.kind !== "session";
const levelOf = (nest: Nest | null) => (nest === null ? 0 : nest.continues.length + 1);
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

/** Where a dragged session would land: a header to light up and the Group it would take, or nowhere. */
type Drop = { header: HeaderRow; name: string | null } | null;

// The cursor's background is mixed from the terminal's own background and foreground, as pi's system theme
// does. Until the terminal reports its colors, reverse video stands in. The row under the pointer gets a fainter mix
// than the cursor's, focused or not; the cursor also has the ▌ bar while its session is on the Stage.
let cursorBg: { focused: string; unfocused: string; hover: string } | null = null;
// The working glyph breathes either side of the theme's cyan: faint toward the background, strong toward the
// foreground. Fading all the way to the background would sink it below the cursor row's highlight on a dark theme.
// Until the palette arrives it holds still.
let breath: { faint: RgbColor; strong: RgbColor } | null = null;
let colors: { background: string | null; scheme: string | null } = { background: null, scheme: null };

function cursorLine(line: string, focused: boolean): string {
	if (!cursorBg) return focused ? sgrBg("7", line) : sgrBg("4", line);
	return sgrBg(focused ? cursorBg.focused : cursorBg.unfocused, line);
}

function hoverLine(line: string): string {
	return cursorBg ? sgrBg(cursorBg.hover, line) : line;
}

type ClickTarget = { y: number; from: number; to: number; act: () => void };

/** `m`'s picker: the sessions it moves, the Group it renames when it started on one's header, and the highlighted choice. */
type NameMode = {
	kind: "name";
	ids: string[];
	renaming: { projectKey: string } | null;
	project: string;
	title: string;
	choice: number;
	input: Input;
};
/** `s`'s menu for a session: how long to snooze it. */
type SnoozeMode = { kind: "snooze"; id: string; title: string; choice: number };
/** Named as `deck state` reports them. */
type Mode =
	| { kind: "roster" }
	| { kind: "filter" }
	| NameMode
	| SnoozeMode
	| { kind: "archive"; id: string }
	/** The directory picker, `n` and `N`, which takes over the whole roster while it's open. */
	| { kind: "picker"; picker: Choosing }
	/** Settings, which takes over the whole Deck while it's open. */
	| { kind: "settings"; pane: SettingsPane };

const ARCHIVE_PROMPT_LINES = 4;

class Roster implements Component, Focusable {
	selectedKey = "";
	lastIndex = 0;
	/**
	 * After `a`, the cursor keeps its index instead of chasing the session into its new section: until the reply to
	 * `req` lands, and the snapshot after it.
	 */
	pin: { index: number; req: number; answered: boolean } | null = null;
	/**
	 * The session the cursor archived here, which keeps its row where it was, marked archived, for one last look, until
	 * the cursor leaves it. Only the cursor's own row lingers, so leaving it by any means sends it to Archived.
	 */
	lingering: string | null = null;
	scrollTop = 0;
	collapsed = new Set<string>();
	expanded = new Set<SectionKey>(["operators"]);
	/**
	 * pi-tui's focus is always the roster's; it passes it on to the inputs, so the one showing places the terminal's
	 * cursor rather than drawing one of its own, and tmux shows that cursor only while the roster's pane is active.
	 */
	get focused(): boolean {
		return this.filter.focused;
	}
	set focused(on: boolean) {
		for (const input of [this.filter, this.search, this.path]) input.focused = on;
		if (this.naming) this.naming.input.focused = on;
	}
	/** The filter's query, which stays applied after the filter mode ends. */
	filter = new Input({ prompt: "/ " });
	/** What the keyboard and pointer are doing. One mode at a time, so entering one leaves the last. */
	mode: Mode = { kind: "roster" };
	get filtering(): boolean {
		return this.mode.kind === "filter";
	}
	get naming(): NameMode | null {
		return this.mode.kind === "name" ? this.mode : null;
	}
	get snoozing(): SnoozeMode | null {
		return this.mode.kind === "snooze" ? this.mode : null;
	}
	/** The session whose archive prompt offers its family or linked worktree. */
	get archiving(): string | null {
		return this.mode.kind === "archive" ? this.mode.id : null;
	}
	get choosing(): Choosing | null {
		return this.mode.kind === "picker" ? this.mode.picker : null;
	}
	get settings(): SettingsPane | null {
		return this.mode.kind === "settings" ? this.mode.pane : null;
	}

	/** Leaves the mode it's in for `next`. */
	enter(next: Mode): void {
		this.leave();
		this.mode = next;
	}

	/**
	 * Back to the roster, abandoning what the mode was doing: the filter keeps its query, a prompt or picker closes
	 * unanswered, and Settings saves what its editor holds.
	 */
	leave(): void {
		const was = this.mode;
		this.mode = { kind: "roster" };
		if (was.kind === "settings") {
			was.pane.saveProse();
			panes.zoomRoster(false);
		}
	}
	search = new Input({ prompt: "/ " });
	pickerTop = 0;
	/** The picker's first list row, under its title, a narrow Deck's launch card, its input, and a rule. */
	pickerListY = 0;
	completed: { typed: string; rows: string[] } | null = null;
	path = new Input({ prompt: "" });
	/** A session being dragged by the mouse; `moved` once the pointer has left its row. */
	dragging: { id: string; moved: boolean; drop: Drop } | null = null;
	/** The session row under the pointer. A key clears it until the pointer moves again, and so does the pointer leaving. */
	hover: string | null = null;
	/** Where the pointer rests, which lights the control under it; null after a key or once it leaves. */
	pointer: { x: number; y: number } | null = null;
	/** The launch card as the picker drew it in the roster, when the Stage has no room for it. */
	card: string[] | null = null;
	/** The overlays over the roster's own lines, as the last render drew them. */
	over: Overlay[] = [];
	listTop = 0;
	listHeight = 0;
	/** What a click does, by row and column range, as of the last render. */
	targets: ClickTarget[] = [];
	pressed: ClickTarget | null = null;

	query(): string {
		return this.filter.getValue().trim().toLowerCase();
	}

	matches(e: Entry): boolean {
		const q = this.query();
		const label = groupOf(e) ?? "";
		return q === "" || `${displayName(e)} ${projectName(e.project)} ${e.branch ?? ""} ${label}`.toLowerCase().includes(q);
	}

	rows(): Row[] {
		const rows: Row[] = [];
		const all = [...entries.values()].filter((e) => this.matches(e));
		const lingers = (e: Entry) => !e.open && e.id === this.lingering && e.id === this.selectedKey;
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
					const folded = family.length > 0 && this.collapsed.has(foldKey(entry.id)) && this.query() === "";
					rows.push({ kind: "session", key: entry.id, entry, depth, header, nest, family, folded });
					i = folded ? end : i + 1;
				}
			}
		};
		const pushGroups = (list: Entry[], depth: number, parent: string) => {
			for (const [project, members] of groupByProject(list)) {
				const key = `${parent}:${project}`;
				const collapsed = this.collapsed.has(key);
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
					const subCollapsed = this.collapsed.has(subKey);
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
			const expanded = this.expanded.has(key) || (this.query() !== "" && count > 0);
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
				(a, b) =>
					(a.snoozedUntil ?? Number.POSITIVE_INFINITY) - (b.snoozedUntil ?? Number.POSITIVE_INFINITY) || b.activityAt - a.activityAt,
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
	resolveCursor(rows: Row[]): number {
		if (rows.length === 0) return -1;
		let index = rows.findIndex((r) => r.key === this.selectedKey);
		if (index === -1 && this.selectedKey === "") {
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
		if (index === -1) index = Math.min(this.lastIndex, rows.length - 1);
		this.selectedKey = (rows[index] as Row).key;
		this.lastIndex = index;
		// Left by any means, a lingering row is in Archived for good, even when the cursor comes back to it there.
		if (this.lingering !== this.selectedKey) this.lingering = null;
		return index;
	}

	selected(): Row | undefined {
		const rows = this.rows();
		return rows[this.resolveCursor(rows)];
	}

	cursorEntry(): Entry | null {
		const row = this.selected();
		return row?.kind === "session" ? row.entry : null;
	}

	/** The Stage follows the cursor onto session rows, and stays put while the cursor is on a header. */
	syncStage(fromKey: boolean): void {
		const e = this.cursorEntry();
		if (stage.staged === null && newLaunch() && stage.holdForNew) return;
		if (e && e.id !== stage.staged) stageSession(e.id);
		else if (fromKey) apply();
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		this.hover = null;
		this.pointer = null;
		panes.keyAt = performance.now();
		frameKeyAt = panes.keyAt;
		// A key puts the toasts away, all but a stopped worker's: the Deck can't go on without it.
		toasts = toasts.filter((t) => t.until === Number.POSITIVE_INFINITY);
		if (this.settings) {
			this.settings.handleInput(data);
			panes.keyAt = 0;
			tui.requestRender();
			return;
		}
		if (this.choosing) {
			this.pickerInput(data);
			panes.keyAt = 0;
			tui.requestRender();
			return;
		}
		if (this.snoozing) {
			const k = decodeKittyPrintable(data) ?? data;
			if (matchesKey(data, "up") || k === "k") this.snoozing.choice = Math.max(0, this.snoozing.choice - 1);
			else if (matchesKey(data, "down") || k === "j") this.snoozing.choice = Math.min(SNOOZE_CHOICES.length - 1, this.snoozing.choice + 1);
			else if (matchesKey(data, "enter")) this.finishSnooze((SNOOZE_CHOICES[this.snoozing.choice] as { snooze: SnoozePreset }).snooze);
			else if (matchesKey(data, "escape") || k === "q" || k === "s") this.leave();
			panes.keyAt = 0;
			tui.requestRender();
			return;
		}
		if (this.archiving !== null) {
			const k = decodeKittyPrintable(data) ?? data;
			if (k === "a" || k === "A") this.finishArchiving(k === "A");
			else if (k === "d" && entries.get(this.archiving)?.worktree) this.finishArchiving(false, true);
			else if (k === "D" && entries.get(this.archiving)?.worktree) this.finishArchiving(true, true);
			else if (matchesKey(data, "escape")) this.finishArchiving(null);
			panes.keyAt = 0;
			tui.requestRender();
			return;
		}
		if (this.naming) {
			const naming = this.naming;
			const choices = this.choices();
			if (matchesKey(data, "up") || matchesKey(data, "down")) {
				const step = matchesKey(data, "up") ? -1 : 1;
				naming.choice = Math.max(0, Math.min(choices.length - 1, naming.choice + step));
			} else if (matchesKey(data, "enter")) {
				const choice = choices[naming.choice];
				if (choice) this.finishNaming(choice.name);
			} else if (matchesKey(data, "escape")) this.leave();
			else {
				const before = naming.input.getValue();
				naming.input.handleInput(data);
				const refused = unnameable(naming.input.getValue());
				if (refused.length > 0) {
					naming.input.setValue(before);
					toast(`a Group's name can't hold ${refused.map((char) => JSON.stringify(char)).join(" ")}`, "info");
				}
				naming.choice = 0;
			}
			panes.keyAt = 0;
			tui.requestRender();
			return;
		}
		if (this.filtering) {
			if (matchesKey(data, "up") || matchesKey(data, "down")) this.move(matchesKey(data, "up") ? -1 : 1);
			else if (matchesKey(data, "enter")) this.leave();
			else if (matchesKey(data, "escape")) {
				this.filter.setValue("");
				this.leave();
			} else {
				this.filter.handleInput(data);
				const rows = this.rows();
				const first = rows.find((r) => r.kind === "session");
				if (first && !rows.some((r) => r.kind === "session" && r.key === this.selectedKey)) this.selectedKey = first.key;
			}
			this.syncStage(true);
			panes.keyAt = 0;
			tui.requestRender();
			return;
		}
		const k = decodeKittyPrintable(data) ?? data;
		if (matchesKey(data, "ctrl+c") || k === "q") {
			quit();
			return;
		}
		if (matchesKey(data, "down") || k === "j") this.move(1);
		else if (matchesKey(data, "up") || k === "k") this.move(-1);
		else if (k === "g") this.move(Number.NEGATIVE_INFINITY);
		else if (k === "G") this.move(Number.POSITIVE_INFINITY);
		else if (matchesKey(data, "enter") || k === " ") this.activate(matchesKey(data, "enter"));
		else if (matchesKey(data, "right") || k === "l") this.right();
		else if (matchesKey(data, "left") || k === "h") this.left();
		else if (matchesKey(data, "escape")) this.filter.setValue("");
		else if (k === "w") this.wake();
		else if (k === "x") this.stop();
		else if (k === "R") this.reload();
		else if (k === "a") this.toggleArchived();
		else if (k === "s") this.toggleSnooze();
		else if (k === "u") this.toggleUnseen();
		else if (k === "p") this.toParent();
		else if (k === "[" || k === "]") goHistory(k === "[" ? -1 : 1);
		else if (k === "y" || k === "Y") this.copy(k === "y");
		else if (k === "n") this.newAt();
		else if (k === "N") this.openPicker("add", null, null);
		else if (k === "/") this.enter({ kind: "filter" });
		else if (k === "m") this.startNaming();
		else if (k === ",") openSettings();
		else if (k === "O" && configError) openConfig(configError.line);
		else if (k === "?") void showHelp();
		this.syncStage(true);
		panes.keyAt = 0;
		tui.requestRender();
	}

	/** The click target under a point, as of the last render. */
	targetAt(p: { x: number; y: number } | null): ClickTarget | undefined {
		return p ? this.targets.find((t) => t.y === p.y && p.x >= t.from && p.x < t.to) : undefined;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// A control under the pointer lights up, wherever it is.
		let relit = false;
		if (this.settings) return this.settings.handleMouse(event);
		if (event.type === "move") {
			overlays.pointerAway();
			const before = this.targetAt(this.pointer);
			this.pointer = { x: event.x, y: event.y };
			relit = this.targetAt(this.pointer) !== before;
		}
		// The archive prompt answers to its own buttons and nothing else.
		if (this.archiving !== null) {
			if (event.type === "move") return { handled: true, render: relit };
			if (event.button === "left" && event.type === "press") this.pressed = this.targetAt(event) ?? null;
			else if (event.button === "left" && event.type === "click") {
				const target = this.pressed;
				this.pressed = null;
				target?.act();
				this.syncStage(true);
			}
			return { handled: true, render: true };
		}
		if (this.choosing) {
			const listRow = this.pickerTop + event.y - this.pickerListY;
			if (event.type === "move") {
				if (this.choosing.confirm || this.choosing.menu || event.y < this.pickerListY || event.y >= this.pickerListY + this.listHeight)
					return { handled: true, render: relit };
				const count = this.choosing.mode === "pick" ? this.pickRows().length : this.addRows().length;
				if (listRow < count && listRow !== this.choosing.choice) {
					this.choosing.choice = listRow;
					return { handled: true, render: true };
				}
				return { handled: true, render: relit };
			}
			if (event.type === "wheel") this.pickerInput(event.wheelDelta && event.wheelDelta > 0 ? "\x1b[B" : "\x1b[A");
			else if (event.button === "left" && event.type === "press")
				this.pressed = this.targets.find((t) => t.y === event.y && event.x >= t.from && event.x < t.to) ?? null;
			else if (event.button === "left" && event.type === "click") {
				const target = this.pressed;
				this.pressed = null;
				if (target) target.act();
				else if (this.choosing.menu) this.choosing.menu = null;
			}
			return { handled: true, render: true };
		}
		if (event.type === "move") {
			const on = this.over.find((o) => event.x >= o.x && event.x < o.x + o.width && event.y >= o.y && event.y < o.y + o.view.lines.length);
			if (on) {
				on.pointer?.();
				return { handled: true, render: relit };
			}
			const row = this.rowAt(event.y);
			const hover = row?.kind === "session" ? row.key : null;
			if (hover === this.hover) return { handled: true, render: relit };
			this.hover = hover;
			return { handled: true, render: true };
		}
		if (event.type === "wheel") {
			this.move(Math.sign(event.wheelDelta ?? 0));
			this.syncStage(true);
			return { handled: true };
		}
		if (event.button !== "left") return undefined;
		// Clicking the roster focuses it, and its focus hook can re-render the legend before the release: the target is the
		// one under the press.
		if (event.type === "press") {
			this.pressed = this.targets.find((t) => t.y === event.y && event.x >= t.from && event.x < t.to) ?? null;
			this.dragging = null;
			const row = this.rowAt(event.y);
			if (this.pressed || row?.kind !== "session" || !row.entry.open || row.entry.operator) return undefined;
			this.dragging = { id: row.entry.id, moved: false, drop: null };
			return { capture: true };
		}
		if (event.type === "drag" && this.dragging) {
			const e = entries.get(this.dragging.id);
			this.dragging.moved = true;
			this.dragging.drop = e ? this.dropAt(event.y, e) : null;
			return { handled: true };
		}
		if (event.type === "release" && this.dragging) {
			this.finishDrag(event.y);
			return { handled: true, render: true };
		}
		if (event.type !== "click") return undefined;
		const target = this.pressed;
		this.pressed = null;
		if (target) {
			target.act();
			this.syncStage(true);
			return { handled: true };
		}
		const row = this.rowAt(event.y);
		if (!row) return undefined;
		// Picking a row is done filtering, as ⏎ is; the filter stays applied.
		if (this.filtering) this.leave();
		this.selectedKey = row.key;
		this.lastIndex = this.scrollTop + (event.y - this.listTop);
		stage.holdForNew = false;
		if (isHeader(row)) this.toggle(row);
		else this.focusEntry(row.entry);
		this.syncStage(true);
		return { handled: true };
	}

	/**
	 * Where a Peek belongs: beside the row under the pointer, else, after a navigation key, beside the cursor's while the
	 * roster has the keyboard. Only a session's row on screen has one.
	 */
	peekSpot(rows: Row[], index: number): PeekSpot | null {
		if (
			panes.rosterHidden ||
			(panes.narrow && focus !== "roster") ||
			this.choosing ||
			this.naming ||
			this.snoozing ||
			this.dragging ||
			this.archiving !== null ||
			this.settings
		)
			return null;
		const spot = (i: number, source: "pointer" | "cursor"): PeekSpot | null => {
			const row = rows[i];
			if (row?.kind !== "session" || i < this.scrollTop || i >= this.scrollTop + this.listHeight) return null;
			return { id: row.key, source, y: this.listTop + i - this.scrollTop };
		};
		if (this.hover !== null)
			return spot(
				rows.findIndex((r) => r.key === this.hover),
				"pointer",
			);
		return peek.byKeys && focus === "roster" ? spot(index, "cursor") : null;
	}

	/** Puts these overlays on screen: the roster draws those over its own lines, and the rest float over the Stage. */
	place(lines: string[], want: Overlay[], width: number): void {
		this.over = want.filter((o) => o.x + o.width <= width);
		for (const o of this.over) this.drawOver(lines, o, width);
		syncWatch(this.pointer !== null || peek.spot !== null || want.some((o) => o.leaves));
		overlays.sync(want.filter((o) => !this.over.includes(o)));
	}

	/**
	 * An overlay over the roster's own lines, drawn into them rather than floated: a float made or killed in a zoomed
	 * window, as a narrow Deck's is, has tmux resize the zoomed pane twice. Its buttons are click targets ahead of
	 * everything beneath it, and the rest of it swallows clicks.
	 */
	drawOver(lines: string[], o: Overlay, width: number): void {
		const p = this.pointer;
		const hot = o.view.buttons.find((b) => p?.y === o.y + b.y && p.x >= o.x + b.from && p.x < o.x + b.to);
		while (lines.length < o.y + o.view.lines.length) lines.push("");
		o.view.lines.forEach((line, i) => {
			const under = lines[o.y + i] as string;
			lines[o.y + i] =
				`${truncateToWidth(under, o.x, "", true)}\x1b[0m${hot?.y === i ? hot.hot : line}\x1b[0m${sliceByColumn(under, o.x + o.width, width - o.x - o.width)}`;
		});
		this.targets.unshift(
			...o.view.buttons.map((b) => ({ y: o.y + b.y, from: o.x + b.from, to: o.x + b.to, act: b.act })),
			...o.view.lines.map((_, i) => ({ y: o.y + i, from: o.x, to: o.x + o.width, act: () => {} })),
		);
	}

	rowAt(y: number): Row | undefined {
		if (y < this.listTop || y >= this.listTop + this.listHeight) return undefined;
		return this.rows()[this.scrollTop + (y - this.listTop)];
	}

	move(delta: number): void {
		peek.byKeys = true;
		const from = this.stepFrom(delta);
		const rows = this.rows();
		if (rows.length === 0) return;
		const next = Math.max(0, Math.min(rows.length - 1, from));
		this.selectedKey = (rows[next] as Row).key;
		this.lastIndex = next;
		stage.holdForNew = false;
	}

	/**
	 * Where a step of delta from the cursor lands. Off a lingering row, which goes to Archived as the cursor leaves, it
	 * counts as if that row were gone already: the row below has taken its place.
	 */
	stepFrom(delta: number): number {
		const rows = this.rows();
		const index = this.resolveCursor(rows);
		const row = rows[index];
		if (row?.kind !== "session" || row.entry.open || row.entry.id !== this.lingering) return index + delta;
		this.lingering = null;
		return delta > 0 ? index + delta - 1 : index + delta;
	}

	/** Moves to the next session row in that direction, if there is one. */
	moveSession(delta: number): void {
		const from = this.stepFrom(delta);
		const rows = this.rows();
		for (let i = from; i >= 0 && i < rows.length; i += delta) {
			const row = rows[i] as Row;
			if (row.kind !== "session") continue;
			this.selectedKey = row.key;
			this.lastIndex = i;
			stage.holdForNew = false;
			return;
		}
	}

	activate(enter: boolean): void {
		const row = this.selected();
		if (!row) return;
		if (row.kind !== "session") this.toggle(row);
		else if (enter) this.focusEntry(row.entry);
		else this.setFolded(row, !row.folded);
	}

	/** ⏎: wake it if needed and focus it at once; a session still starting holds the keyboard on its loading card. */
	focusEntry(e: Entry): void {
		stageSession(e.id);
		if (!e.live) wake(e.id, true);
		void panes.focusStage();
	}

	right(): void {
		const row = this.selected();
		if (!row) return;
		if (row.kind === "session" && row.folded) this.setFolded(row, false);
		else if (row.kind === "session") this.focusEntry(row.entry);
		else this.setExpanded(row, true);
	}

	left(): void {
		const row = this.selected();
		if (row?.kind === "session") this.setFolded(row, true);
		else if (row) this.setExpanded(row, false);
	}

	/** The actions below act on the cursor's row unless given one: a Peek's buttons act on its row, wherever the cursor is. */
	wake(row = this.selected()): void {
		const e = row?.kind === "session" ? row.entry : null;
		if (!e) return;
		if (e.live) toast("already running", "info");
		else wake(e.id, false);
	}

	/** R: restarts its harness on the same conversation, so it reads its configuration afresh, and has it carry on. */
	reload(row = this.selected()): void {
		const e = row?.kind === "session" ? row.entry : null;
		if (!e) return;
		if (!e.open) toast("archived: unarchive it first", "info");
		else if (e.provisional) toast("nothing to reload before the first prompt", "info");
		else reload(e.id);
	}

	/** x: the counterpart to w. Frees the process and keeps the session open; any unsent prompt is saved as a draft. */
	stop(row = this.selected()): void {
		const e = row?.kind === "session" ? row.entry : null;
		if (!e) return;
		if (!e.live) toast("not running", "info");
		else post({ type: "stop", req: nextReq(), id: e.id });
	}

	/** a: archives or unarchives the session; one that started others still open asks first whether they go too. */
	toggleArchived(row = this.selected()): void {
		if (row?.kind !== "session" || this.pin) return;
		const e = row.entry;
		if (e.provisional) {
			toast("nothing to archive before the first prompt", "error");
			return;
		}
		if (e.open && (e.worktree || openDescendants(entries.values(), e.id).length > 0)) {
			this.selectedKey = e.id;
			this.hover = null;
			this.enter({ kind: "archive", id: e.id });
			return;
		}
		// Only the cursor's own row moving takes the cursor along; archived, it lingers where it is.
		const req = nextReq();
		if (row.key === this.selected()?.key) {
			this.pin = { index: this.resolveCursor(this.rows()), req, answered: false };
			if (e.open) this.lingering = e.id;
		}
		post(e.open ? { type: "archive", req, ids: [e.id] } : { type: "unarchive", req, id: e.id });
	}

	/** The archive prompt's answer: the session alone, all it started besides, or (null) neither. */
	finishArchiving(all: boolean | null, deleteWorktree = false): void {
		const e = this.archiving === null ? undefined : entries.get(this.archiving);
		this.leave();
		if (!e || all === null) return;
		const req = nextReq();
		this.pin = { index: this.resolveCursor(this.rows()), req, answered: false };
		this.lingering = e.id;
		post({
			type: "archive",
			req,
			ids: [e.id, ...(all ? openDescendants(entries.values(), e.id).map((d) => d.id) : [])],
			...(deleteWorktree ? { deleteWorktreeFor: e.id } : {}),
		});
	}

	/** h folds the family under a session; l and space open it again. */
	setFolded(row: SessionRow, folded: boolean): void {
		if (row.family.length === 0) return;
		if (folded) this.collapsed.add(foldKey(row.key));
		else this.collapsed.delete(foldKey(row.key));
	}

	/** p: to the session that started this one, wherever it is. */
	toParent(row = this.selected()): void {
		if (row?.kind !== "session") return;
		const parent = parentOf(row.entry);
		if (parent) reveal(parent.id);
		else toast(row.entry.parentId === null ? "you started this one" : "its parent is gone", "info");
	}

	/** u: marks a session Unseen until I come back to it from another, or takes that mark off. */
	toggleUnseen(row = this.selected()): void {
		if (row?.kind !== "session") return;
		const e = row.entry;
		if (!e.open) toast("archived; unarchive it first", "info");
		else if (e.provisional) toast("nothing to mark before the first prompt", "error");
		else if (e.snoozed) toast("snoozed; unsnooze it first", "info");
		else {
			if (e.markedUnseen) {
				if (stage.marked === e.id) stage.marked = null;
			} else if (panes.applied.id === e.id) {
				// Looking at it until now isn't the Visit that clears the mark.
				stage.visited = false;
				stage.marked = e.id;
			}
			post({ type: "markUnseen", id: e.id, marked: !e.markedUnseen });
			syncVisit();
		}
	}

	/** s: unsnoozes a snoozed session, or asks how long to snooze an open one. */
	toggleSnooze(row = this.selected()): void {
		if (row?.kind !== "session" || this.pin) return;
		const e = row.entry;
		if (!e.open) toast("archived; unarchive it first", "info");
		else if (e.provisional) toast("nothing to snooze before the first prompt", "error");
		else if (e.snoozed) {
			const req = nextReq();
			if (row.key === this.selected()?.key) this.pin = { index: this.resolveCursor(this.rows()), req, answered: false };
			post({ type: "snooze", req, id: e.id, snooze: "off" });
		} else this.enter({ kind: "snooze", id: e.id, title: displayName(e), choice: 0 });
	}

	finishSnooze(snooze: SnoozePreset): void {
		const snoozing = this.snoozing;
		this.leave();
		if (!snoozing) return;
		// As with archive, the cursor keeps its place rather than following the row into Snoozed.
		const req = nextReq();
		if (this.selected()?.key === snoozing.id) this.pin = { index: this.resolveCursor(this.rows()), req, answered: false };
		post({ type: "snooze", req, id: snoozing.id, snooze });
	}

	/** Runs on every snapshot; the one that answers `a` puts the cursor back on its row's index. */
	settlePin(): void {
		if (!this.pin?.answered) return;
		const rows = this.rows();
		const index = Math.min(this.pin.index, rows.length - 1);
		const row = rows[index];
		this.pin = null;
		if (!row) return;
		this.selectedKey = row.key;
		this.lastIndex = index;
	}

	copy(command: boolean, row = this.selected()): void {
		const e = row?.kind === "session" ? row.entry : null;
		if (!e) return;
		const text = command ? `swb open ${e.id}` : `@session:${e.id}`;
		void clip(text).then(
			() => toast(`copied ${text}`, "info"),
			(error: Error) => toast(`copy failed: ${error.message}`, "error"),
		);
	}

	/**
	 * n: the directory picker, on the cursor's directory: a Group header's newest session's, there being no other.
	 * Starting there joins its Group.
	 */
	newAt(row = this.selected()): void {
		// On the Operator folder, so Tab picks its harness as anywhere else.
		if ((row?.kind === "section" && row.key === "operators") || (row?.kind === "session" && row.entry.operator)) {
			this.openPicker("pick", operatorDir(), null);
			return;
		}
		if (!row || row.kind === "section") {
			this.openPicker("pick", null, null);
			return;
		}
		const group = row.kind === "session" ? groupOf(row.entry) : row.group;
		this.openPicker("pick", row.kind === "session" ? row.entry.cwd : row.cwd, group);
	}

	/**
	 * m: picks the Group for the session under the cursor, or for every session under the Group header it's on, which
	 * merges into an existing Group or renames to a new one.
	 */
	startNaming(row = this.selected()): void {
		const input = new Input({ prompt: "> " });
		input.focused = this.focused;
		if (row?.kind === "session" && row.entry.operator) toast("Operators don't take Groups", "info");
		else if (row?.kind === "session") {
			const group = groupOf(row.entry);
			const project = row.entry.project;
			this.enter({ kind: "name", ids: [row.entry.id], renaming: null, project, title: displayName(row.entry), choice: 0, input });
			const naming = this.naming as NameMode;
			naming.choice = Math.max(
				0,
				this.choices().findIndex((c) => c.name === group),
			);
		} else if (row?.kind === "header" && row.group !== null) {
			const name = row.group;
			const ids = [...entries.values()].filter((e) => e.project === row.project && groupOf(e) === name).map((e) => e.id);
			this.enter({ kind: "name", ids, renaming: { projectKey: row.projectKey }, project: row.project, title: name, choice: 0, input });
			const naming = this.naming as NameMode;
			naming.choice = Math.max(
				0,
				this.choices().findIndex((c) => c.name === name),
			);
		} else toast("m picks a session's Group, or renames a Group", "info");
	}

	/** No Group when nothing is typed, then the Project's Groups matching what is, then a new one unless one matches exactly. */
	choices(): { label: string; name: string | null }[] {
		const naming = this.naming;
		if (!naming) return [];
		const typed = naming.input.getValue().trim();
		const groups = new Set<string>();
		for (const e of entries.values()) {
			const group = groupOf(e);
			if (e.open && e.project === naming.project && group !== null) groups.add(group);
		}
		const out: { label: string; name: string | null }[] = typed === "" ? [{ label: "(no Group)", name: null }] : [];
		for (const name of [...groups].sort((a, b) => a.localeCompare(b)))
			if (name.toLowerCase().includes(typed.toLowerCase())) out.push({ label: name, name });
		if (typed !== "" && !groups.has(typed)) out.push({ label: `+ new "${typed}"`, name: typed });
		return out;
	}

	/** The picker's rows, which the list gives up its bottom to; each choice is a button. */
	picker(width: number, height: number): [string, (() => void) | null][] {
		if (this.snoozing) return this.snoozeMenu(width);
		const naming = this.naming;
		if (!naming) return [];
		const choices = this.choices();
		const shown = Math.max(1, Math.min(choices.length, height - 4));
		const from = Math.max(0, Math.min(naming.choice - shown + 1, choices.length - shown));
		const title = ` ${naming.renaming ? "rename" : "Group for"} ${naming.title} `;
		const out: [string, (() => void) | null][] = [
			[`${gray(`─${truncateToWidth(title, width - 5, "…")}${"─".repeat(Math.max(0, width - 4 - visibleWidth(title)))}`)} ✕ `, null],
		];
		for (let i = from; i < from + shown; i++) {
			const choice = choices[i] as { label: string; name: string | null };
			const label = choice.name === null ? dim(choice.label) : choice.label.startsWith("+ ") ? green(choice.label) : choice.label;
			const line = truncateToWidth(`   ${label}`, width, "…", true);
			out.push([i === naming.choice ? cursorLine(line, true) : line, () => this.finishNaming(choice.name)]);
		}
		return out;
	}

	snoozeMenu(width: number): [string, (() => void) | null][] {
		const snoozing = this.snoozing;
		if (!snoozing) return [];
		const now = Date.now();
		const title = ` Snooze ${snoozing.title} `;
		const out: [string, (() => void) | null][] = [
			[`${gray(`─${truncateToWidth(title, width - 5, "…")}${"─".repeat(Math.max(0, width - 4 - visibleWidth(title)))}`)} ✕ `, null],
		];
		SNOOZE_CHOICES.forEach((choice, i) => {
			const until = presetUntil(choice.snooze, now);
			const at = gray(until === null ? "↘" : wakeAt(until, now));
			const label = `   ${choice.label}`;
			const line = `${label}${" ".repeat(Math.max(1, width - visibleWidth(label) - visibleWidth(at) - 1))}${at} `;
			out.push([i === snoozing.choice ? cursorLine(line, true) : line, () => this.finishSnooze(choice.snooze)]);
		});
		return out;
	}

	finishNaming(name: string | null): void {
		const naming = this.naming;
		this.leave();
		if (!naming) return;
		setGroup(naming.ids, name);
		// A renamed Group's header moves to its new key, and the cursor goes with it.
		if (naming.renaming) this.selectedKey = name === null ? naming.renaming.projectKey : `${naming.renaming.projectKey}:g:${name}`;
	}

	dropAt(y: number, e: Entry): Drop {
		if (y < this.listTop || y >= this.listTop + this.listHeight) return null;
		const rows = this.rows();
		const row = rows[this.scrollTop + (y - this.listTop)];
		if (!row || row.kind === "section") return null;
		const header = row.kind === "header" ? row : rows.find((r): r is HeaderRow => r.kind === "header" && r.key === row.header);
		if (!header || header.project !== e.project) return null;
		return { header, name: header.group };
	}

	/** Lands a drag: into the Group under the pointer, out of any on its Project, or nowhere. */
	finishDrag(y: number): void {
		const drag = this.dragging;
		this.dragging = null;
		const e = drag && entries.get(drag.id);
		if (!e || !drag.moved) return;
		const drop = this.dropAt(y, e);
		if (!drop) toast("not a place for it; nothing moved", "info");
		else if (drop.name !== groupOf(e)) setGroup([e.id], drop.name);
	}

	toggle(row: Row): void {
		this.setExpanded(row, isCollapsed(row));
	}

	setExpanded(row: Row, expanded: boolean): void {
		if (row.kind === "header") {
			if (expanded) this.collapsed.delete(row.key);
			else this.collapsed.add(row.key);
		} else if (row.kind === "section") {
			if (expanded) this.expanded.add(row.key);
			else this.expanded.delete(row.key);
		}
	}

	/** Opens the directory picker: on the directory `from`, or straight into adding one. */
	openPicker(mode: "pick" | "add", from: string | null, group: string | null): void {
		this.search.setValue("");
		this.path.setValue("");
		this.pickerTop = 0;
		this.completed = null;
		this.enter({
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
			(this.choosing as Choosing).choice = Math.max(
				0,
				this.pickRows().findIndex((r) => r.kind === "target" && r.target.path === from),
			);
	}

	/**
	 * Each tree's main checkout, then its worktrees. A query keeps only matches, best match first, the way fzf and
	 * VS Code's quick open rank them: a tree whose worktree matches keeps its root, dimmed, for context, and a
	 * matching root brings all its worktrees.
	 */
	pickRows(): PickRow[] {
		const choosing = this.choosing;
		if (!choosing) return [];
		const q = this.search.getValue().trim().toLowerCase();
		const ranked: { score: number; rows: PickRow[] }[] = [];
		// The directory it opened on is always offered, even before a first prompt or under an exclude.
		const pin = choosing.pin;
		const pinned: TargetTree[] =
			pin !== null && !this.listed().has(pin) ? [{ root: { path: pin, repo: null, branch: null }, worktrees: [] }] : [];
		for (const tree of [...pinned, ...(dirTrees ?? [])]) {
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
	bestMatch(): number {
		let best = 0;
		let score = 10;
		this.pickRows().forEach((row, i) => {
			if (row.kind === "target" && !row.context && row.score < score) {
				best = i;
				score = row.score;
			}
		});
		return best;
	}

	addRows(): string[] {
		const typed = this.path.getValue();
		// Asked for on every render, hover, and state read; the disk is read once per keystroke.
		// biome-ignore lint/plugin: the directory typed is the one read, as each key types it.
		if (this.completed?.typed !== typed) this.completed = { typed, rows: completions(typed, scanBase()) };
		return this.completed.rows;
	}

	/** Where Enter in add mode starts: the highlighted completion, or the directory typed. */
	addTarget(): string {
		const choosing = this.choosing as Choosing;
		const typed = this.path.getValue();
		const row = this.addRows()[choosing.choice];
		if (row) return row;
		const full = typed.startsWith("/") || typed.startsWith("~") ? expandHome(typed) : join(scanBase(), typed);
		return full.length > 1 ? full.replace(/\/$/, "") : full;
	}

	listed(): Set<string> {
		return new Set((dirTrees ?? []).flatMap((t) => [t.root.path, ...t.worktrees.map((w) => w.path)]));
	}

	start(path: string): void {
		const choosing = this.choosing as Choosing;
		const target = pickerTarget(choosing);
		this.closePicker();
		newSession(path, path === choosing.from ? choosing.group : null, typeof target === "string" ? null : target);
	}

	/** M-a d or the row's ✕: asks before taking a directory, or a repository and all its worktrees, off the list. */
	askRemove(): void {
		const choosing = this.choosing;
		if (choosing?.mode !== "pick") return;
		const row = this.pickRows()[choosing.choice];
		if (row?.kind !== "target" || row.context) return;
		const worktrees = row.tree?.worktrees.map((w) => w.path) ?? [];
		choosing.confirm = {
			name: targetName(row.target),
			worktrees: worktrees.length,
			path: row.target.path,
			covers: [row.target.path, ...worktrees],
		};
	}

	finishRemove(yes: boolean): void {
		const choosing = this.choosing;
		if (!choosing?.confirm) return;
		if (yes) {
			const path = choosing.confirm.path;
			post({ type: "removeDir", path });
			if (choosing.pin !== null && choosing.confirm.covers.includes(choosing.pin)) choosing.pin = null;
			// Gone at once; the worker's list, which follows, agrees.
			dirTrees = (dirTrees ?? [])
				.filter((t) => t.root.path !== path)
				.map((t) => ({ root: t.root, worktrees: t.worktrees.filter((w) => w.path !== path) }));
			choosing.choice = Math.min(choosing.choice, this.pickRows().length - 1);
		}
		choosing.confirm = null;
	}

	closePicker(): void {
		this.leave();
	}

	/** Opens the launch card's menu on the chosen preset, or closes it keeping that one. */
	toggleMenu(): void {
		const choosing = this.choosing as Choosing;
		if (choosing.menu) choosing.menu = null;
		else if (pickerPresets().length > 0)
			choosing.menu = { query: "", cursor: Math.max(0, menuPresets("").indexOf(chosenPreset(choosing))) };
	}

	choosePreset(index: number): void {
		const choosing = this.choosing as Choosing;
		choosing.preset = presetLabels(pickerPresets().map((c) => c.preset))[index] ?? null;
		choosing.menu = null;
	}

	/**
	 * The menu's keys: a number picks what it shows by its place until something's typed, when it narrows the menu like any
	 * other key, since model names have numbers in them; the arrows and Enter pick the highlighted one.
	 */
	menuInput(data: string): void {
		const choosing = this.choosing as Choosing;
		const menu = choosing.menu as Menu;
		const shown = menuPresets(menu.query);
		const k = decodeKittyPrintable(data) ?? data;
		if (matchesKey(data, "escape") || matchesKey(data, "tab") || matchesKey(data, "shift+tab")) choosing.menu = null;
		else if (matchesKey(data, "up") || matchesKey(data, "down"))
			menu.cursor = Math.max(0, Math.min(shown.length - 1, menu.cursor + (matchesKey(data, "up") ? -1 : 1)));
		else if (matchesKey(data, "enter")) {
			const index = shown[menu.cursor];
			if (index !== undefined) this.choosePreset(index);
		} else if (menu.query === "" && /^[1-9]$/.test(k)) {
			const index = shown[Number(k) - 1];
			if (index !== undefined) this.choosePreset(index);
		} else if (matchesKey(data, "backspace")) {
			menu.query = menu.query.slice(0, -1);
			menu.cursor = 0;
		} else if (k.length === 1 && k >= " ") {
			menu.query += k;
			menu.cursor = 0;
		}
	}

	pickerInput(data: string): void {
		const choosing = this.choosing as Choosing;
		if (choosing.confirm) {
			const k = decodeKittyPrintable(data) ?? data;
			if (k === "y" || matchesKey(data, "enter")) this.finishRemove(true);
			else if (k === "n" || matchesKey(data, "escape")) this.finishRemove(false);
			return;
		}
		if (choosing.menu) {
			this.menuInput(data);
			return;
		}
		const first = choosing.mode === "pick" ? 0 : -1;
		const count = choosing.mode === "pick" ? this.pickRows().length : this.addRows().length;
		if (matchesKey(data, "escape")) {
			if (choosing.mode === "add" && choosing.opened === "pick") {
				choosing.mode = "pick";
				choosing.choice = this.pickRows().length - 1;
			} else this.closePicker();
		} else if (matchesKey(data, "up") || matchesKey(data, "down")) {
			choosing.choice = Math.max(first, Math.min(count - 1, choosing.choice + (matchesKey(data, "up") ? -1 : 1)));
		} else if (choosing.mode === "pick" && (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))) {
			// Tab opens the menu of what runs the new session; in add mode it completes the path instead.
			this.toggleMenu();
		} else if (choosing.mode === "add" && matchesKey(data, "tab")) {
			const match = this.addRows()[Math.max(0, choosing.choice)];
			if (match) {
				this.path.setValue(`${shortPath(match)}/`);
				choosing.choice = -1;
			}
		} else if (matchesKey(data, "enter")) {
			if (choosing.mode === "pick") {
				const row = this.pickRows()[choosing.choice];
				if (row?.kind === "add") {
					choosing.mode = "add";
					this.path.setValue("");
					choosing.choice = typedChoice("");
				} else if (row) this.start(row.target.path);
				return;
			}
			const path = this.addTarget();
			// biome-ignore lint/plugin: Enter waits on the directory it starts in.
			if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
				toast(`no directory ${shortPath(path)}`, "error");
				return;
			}
			if (!this.listed().has(path)) post({ type: "addDir", path });
			this.start(path);
		} else if (choosing.mode === "pick") {
			this.search.handleInput(data);
			const typed = this.search.getValue();
			// A path typed into the search is an add.
			if (typed.startsWith("/") || typed.startsWith("~")) {
				choosing.mode = "add";
				this.path.setValue(typed);
				this.search.setValue("");
				choosing.choice = typedChoice(typed);
				return;
			}
			choosing.choice = this.bestMatch();
		} else {
			this.path.handleInput(data);
			choosing.choice = typedChoice(this.path.getValue());
		}
	}

	renderPicker(width: number, height: number): string[] {
		const choosing = this.choosing as Choosing;
		const adding = choosing.mode === "add";
		this.targets = [];
		const typed = this.path.getValue();
		const absolute = typed.startsWith("/") || typed.startsWith("~");
		const prompt = gray(absolute ? "› " : `› ${shortPath(scanBase())}/`);
		const input = adding
			? `${prompt}${this.path.render(Math.max(10, width - 2 - visibleWidth(prompt)))[0] ?? ""}`
			: (this.search.render(Math.max(10, width - 2))[0] ?? "");
		// The launch card goes on the Stage; with no room there, as on a narrow Deck, the roster draws it under its title.
		const card = launchOnStage(width) ? null : launchCard(choosing, width, "right");
		for (const b of card?.buttons ?? []) this.targets.push({ y: 1 + b.y, from: b.from, to: b.to, act: b.act });
		this.card = card ? card.lines.map((line) => Bun.stripANSI(line)) : null;
		// While the menu is open, the rest of the picker waits behind it.
		const muted = (line: string) => (choosing.menu ? gray(Bun.stripANSI(line)) : line);
		const lines = [
			muted(` ${bold(adding ? "add a directory" : "new session in")}`),
			...(card?.lines ?? []),
			muted(` ${input}`),
			gray("─".repeat(width)),
		];
		this.pickerListY = lines.length;
		// The picker's detail is its path and two blank lines.
		const bodyHeight = Math.max(1, height - lines.length - 6);
		let body: [string, (() => void) | null][];
		let detail: string;
		if (!adding) {
			const rows = this.pickRows();
			body = rows.map((row, i): [string, (() => void) | null] => {
				const act = () => {
					choosing.choice = i;
					this.pickerInput("\r");
				};
				const line = truncateToWidth(pickLine(row, width, i === choosing.choice), width, "…", true);
				return [i === choosing.choice ? cursorLine(line, true) : line, act];
			});
			const row = rows[choosing.choice];
			detail = row?.kind === "target" ? ` ${gray(shortPath(row.target.path))}` : dirTrees === null ? ` ${dim("finding directories…")}` : "";
		} else {
			const listed = this.listed();
			const matches = this.addRows();
			body = matches.map((path, i): [string, (() => void) | null] => {
				const name = `${basename(path)}/`;
				const line = truncateToWidth(`   ${listed.has(path) ? dim(name) : name}`, width, "…", true);
				const act = () => {
					choosing.choice = i;
					this.pickerInput("\r");
				};
				return [i === choosing.choice ? cursorLine(line, true) : line, act];
			});
			detail = ` ${gray(shortPath(this.addTarget()))}`;
		}
		// The window only scrolls to keep the highlight in view, so hovering never drags the list under the pointer.
		let top = Math.min(this.pickerTop, Math.max(0, body.length - bodyHeight));
		// -1 in add mode highlights nothing, and scrolls nowhere.
		if (choosing.choice < top) top = Math.max(0, choosing.choice);
		if (choosing.choice >= top + bodyHeight) top = choosing.choice - bodyHeight + 1;
		this.pickerTop = top;
		this.listHeight = bodyHeight;
		const shown = body.slice(top, top + bodyHeight);
		shown.forEach(([, act], i) => {
			// The remove prompt is modal: only its own answers are buttons; and so is the menu, which a click elsewhere closes.
			if (!act || choosing.confirm || choosing.menu) return;
			const y = this.pickerListY + i;
			// The cursor row's ✕, at its right edge, removes it.
			if (!adding && top + i === choosing.choice && this.pickRows()[choosing.choice]?.kind === "target")
				this.targets.push({ y, from: width - 3, to: width, act: () => this.askRemove() });
			this.targets.push({ y, from: 0, to: width, act });
		});
		const out = shown.map(([line]) => line);
		while (out.length < bodyHeight) out.push("");
		if (choosing.confirm) overlayConfirm(out, width, choosing.confirm, this.pickerListY, (yes) => this.finishRemove(yes), this.targets);
		lines.push(...out.map(muted), gray("─".repeat(width)), muted(detail), "", "", this.messageLine(Date.now()));
		const presets = pickerPresets();
		// The remove prompt carries its own keys.
		const hints: Hint[] = choosing.confirm
			? []
			: choosing.menu
				? [
						...(choosing.menu.query === "" ? ([[`1–${Math.min(9, presets.length)}`, "pick", () => {}]] as Hint[]) : []),
						["⏎", "choose", () => this.pickerInput("\r")],
						["esc", "keep", () => this.pickerInput("\x1b")],
					]
				: adding
					? [
							["⇥", "complete", () => this.pickerInput("\t")],
							["⏎", "start", () => this.pickerInput("\r")],
							["esc", choosing.opened === "pick" ? "back" : "cancel", () => this.pickerInput("\x1b")],
						]
					: [
							["⏎", "start", () => this.pickerInput("\r")],
							...(presets.length > 0 ? ([["⇥", "preset", () => this.toggleMenu()]] as Hint[]) : []),
							[`${config.prefix} d`, "remove", () => this.askRemove()],
							["esc", "cancel", () => this.pickerInput("\x1b")],
						];
		lines.push(
			this.clickable(
				lines.length,
				hints.flatMap(([name, label, act]): [string, (() => void) | null][] => [
					[" ", null],
					[key(name, label), act],
				]),
			),
		);
		return lines.map((line) => truncateToWidth(line, width, "…", true));
	}

	render(width: number): string[] {
		const t0 = performance.now();
		const height = tui.terminal.rows;
		if (this.settings) {
			syncPeek(wantPeek(null));
			const lines = this.settings.render(width, height);
			this.place(lines, [], width);
			return lines;
		}
		if (this.choosing) {
			syncPeek(wantPeek(null));
			const lines = this.renderPicker(width, height);
			this.place(lines, launchOverlays(this.choosing, width, height), width);
			return lines;
		}
		const now = Date.now();
		const rows = this.rows();
		const index = this.resolveCursor(rows);
		this.targets = [];
		// A wide Deck's Peek says what the session is; the narrow one's roster has no Stage beside it to show one.
		const detailLines = panes.narrow ? 3 : 1;
		const tag = this.filterTag(width);
		this.listTop = tag === null ? 0 : 1;
		const bodyHeight = Math.max(1, height - this.listTop - 3 - detailLines);
		const detail = this.detail(width, now, this.listTop + bodyHeight + 1);
		const lines = tag === null ? [] : [tag];
		lines.push(...this.list(rows, index, width, bodyHeight, now));
		lines.push(
			gray("─".repeat(width)),
			...detail,
			this.messageLine(now, this.listTop + bodyHeight + 1 + detailLines),
			this.hints(this.listTop + bodyHeight + 1 + detailLines + 1, width),
		);
		syncPeek(wantPeek(this.peekSpot(rows, index)));
		this.place(
			lines,
			[...peekOverlays(rows, width, height), ...toastOverlay(now, width, this.listTop + bodyHeight + 1 + detailLines)],
			width,
		);
		const out = lines.map((line) => truncateToWidth(line, width, "…", true));
		if (perf.render.n === 0) mark("roster.first-frame");
		perf.render.add(performance.now() - t0);
		if (frameKeyAt > 0) {
			perf.keyToFrame.add(performance.now() - frameKeyAt);
			frameKeyAt = 0;
		}
		return out;
	}

	/** The filter's tag, atop the list while one applies, is a button that clears it. */
	filterTag(width: number): string | null {
		if (this.query() === "" || this.filtering) return null;
		const parts: [string, (() => void) | null][] = [
			[" ", null],
			[`${magenta(`/${this.filter.getValue()}`)} ✕`, () => this.filter.setValue("")],
		];
		return truncateToWidth(this.clickable(0, parts), width, "…");
	}

	list(rows: Row[], index: number, width: number, full: number, now: number): string[] {
		const picker = this.picker(width, full);
		const height = Math.max(1, full - picker.length);
		picker.forEach(([, act], i) => {
			if (act) this.targets.push({ y: this.listTop + height + i, from: 0, to: width, act });
		});
		// The ✕ closing the Group picker, at its title's right end.
		if (picker.length > 0)
			this.targets.push({
				y: this.listTop + height,
				from: width - 3,
				to: width,
				act: () => this.leave(),
			});
		// The archive prompt opens beneath its row, pushing the rows after it down; its row is the cursor's.
		const asking = this.archiving === null ? -1 : rows.findIndex((r) => r.key === this.archiving);
		if (asking === -1 && this.archiving !== null) this.leave();
		const archiveEntry = this.archiving === null ? undefined : entries.get(this.archiving);
		const prompt =
			asking === -1
				? 0
				: ARCHIVE_PROMPT_LINES + (archiveEntry?.worktree ? 1 + (openDescendants(entries.values(), archiveEntry.id).length > 0 ? 1 : 0) : 0);
		if (index < this.scrollTop) this.scrollTop = index;
		if (index + prompt >= this.scrollTop + height) this.scrollTop = index + prompt - height + 1;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, rows.length + prompt - height)));
		this.listHeight = height;
		const out: string[] = [];
		for (let i = this.scrollTop; out.length < height; i++) {
			const row = rows[i];
			if (!row) {
				out.push("");
				continue;
			}
			const y = this.listTop + out.length;
			const line = truncateToWidth(rowLine(row, width, now), width, "…", true);
			if (this.dragging?.drop?.header.key === row.key) out.push(cursorLine(line, true));
			else if (i === index) out.push(cursorLine(line, focus === "roster"));
			else out.push(row.key === this.hover ? hoverLine(line) : line);
			if (row.kind === "session" && row.family.length > 0) {
				const at = foldColumn(row);
				this.targets.push({ y, from: at - 1, to: at + 1, act: () => this.setFolded(row, !row.folded) });
			}
			if (i === asking) out.push(...this.archivePrompt((row as SessionRow).entry, width, this.listTop + out.length));
		}
		out.length = height;
		if (rows.length === 0) out[0] = dim(snapshot ? (this.query() ? "   no matches" : "   no sessions yet · n new") : "   loading…");
		return [...out, ...picker.map(([line]) => line)];
	}

	/** Archive alone, with its family, or delete this linked worktree as well. */
	archivePrompt(e: Entry, width: number, top: number): string[] {
		const inner = Math.max(1, width - 4);
		const family = openDescendants(entries.values(), e.id);
		const box = (text: string) => ` │${truncateToWidth(text, inner, "…", true)}│`;
		const choices: [string, (() => void) | null][] = [
			[" │ Archive  ", null],
			[key("a", "this"), () => this.finishArchiving(false)],
		];
		if (family.length > 0) choices.push(["  ", null], [key("A", `all ${family.length + 1}`), () => this.finishArchiving(true)]);
		choices.push(["  ", null], [key("esc", "abort"), () => this.finishArchiving(null)]);
		const choice = this.clickable(top + 2, choices);
		const deletion = e.worktree
			? this.clickable(top + 3, [
					[" │ ", null],
					[key("d", "archive + delete worktree"), () => this.finishArchiving(false, true)],
				])
			: null;
		const deleteFamily =
			e.worktree && family.length > 0
				? this.clickable(top + 4, [
						[" │ ", null],
						[key("D", `all ${family.length + 1} + delete this worktree`), () => this.finishArchiving(true, true)],
					])
				: null;
		return [
			` ┌${"─".repeat(inner)}┐`,
			box(` ${family.length > 0 ? familyTally(family) : "Branch kept; clean worktree only"}`),
			`${truncateToWidth(choice, inner + 2, "…", true)}│`,
			...(deletion ? [`${truncateToWidth(deletion, inner + 2, "…", true)}│`] : []),
			...(deleteFamily ? [`${truncateToWidth(deleteFamily, inner + 2, "…", true)}│`] : []),
			` └${"─".repeat(inner)}┘`,
		];
	}

	/** Joins the parts into row y's line, recording where each clickable one lands. */
	clickable(y: number, parts: [string, (() => void) | null][]): string {
		let x = 0;
		let line = "";
		const p = this.pointer;
		for (const [text, act] of parts) {
			const w = visibleWidth(text);
			if (act) this.targets.push({ y, from: x, to: x + w, act });
			line += act && p?.y === y && p.x >= x && p.x < x + w ? cursorLine(text, true) : text;
			x += w;
		}
		return line;
	}

	/** The Stage's bar: its views and the shell toggle. A narrow Deck, which has no Peek, also states the session and its place. */
	detail(width: number, now: number, top: number): string[] {
		const e = this.cursorEntry() ?? (stage.staged === null ? null : (entries.get(stage.staged) ?? null));
		if (!e) return panes.narrow ? ["", "", ""] : [""];
		let tabs = "";
		if (stage.staged === e.id && e.open) {
			const parts: [string, (() => void) | null][] = [[" ", null]];
			for (const view of VIEWS) {
				// The first view is the session's own TUI, whichever harness that is.
				const label = ` ${view === "agent" ? e.harness : view} `;
				parts.push([view === panes.applied.view ? cursorLine(label, true) : gray(label), () => void showView(e, view)]);
			}
			// The shell is a toggle beside the views, not one of them.
			if (!panes.narrow)
				parts.push([gray(" · "), null], [panes.applied.shell ? cursorLine(" shell ", true) : gray(" shell "), () => void toggleShell()]);
			tabs = this.clickable(panes.narrow ? top + 2 : top, parts);
		}
		if (!panes.narrow) return [truncateToWidth(tabs, width, "…")];
		// The first tab names the harness; without tabs, the path line does.
		const where = `${tabs ? "" : `${e.harness} · `}${shortPath(e.cwd)}${e.branch ? ` ${magenta(`⎇ ${e.branch}`)}` : ""}`;
		return [` ${status(e)}${launchElapsed(e, now)}`, ` ${gray(where)}`, tabs].map((line) => truncateToWidth(line, width, "…"));
	}

	/** A toast, else the config error, which stays until the file is fixed and opens it on a click; y makes it clickable. */
	messageLine(now: number, y: number | null = null, withConfigError = true): string {
		toasts = toasts.filter((t) => t.until > now);
		const t = toasts.at(-1);
		if (!t && configError && withConfigError) {
			const error = configError;
			// Like a legend entry: the key that acts on it, then what's wrong.
			const text = `${bold("O")} ${red(`config.toml${error.line === null ? "" : `:${error.line}`}: ${error.problem}`)}`;
			return y === null
				? ` ${text}`
				: this.clickable(y, [
						[" ", null],
						[text, () => openConfig(error.line)],
					]);
		}
		if (!t) return snapshot && newer(snapshot.swbVersion, VERSION) ? ` ${red(`✗ swb ${snapshot.swbVersion} is in; reopen the Deck`)}` : "";
		return ` ${t.level === "error" ? red(`✗ ${t.text}`) : green(t.text)}`;
	}

	/** Each key in the legend is also a button. */
	hints(y: number, cols: number): string {
		// The archive prompt carries its own keys.
		if (this.archiving !== null) return "";
		if (this.filtering) return ` ${this.filter.render(Math.max(10, panes.rosterWidth() - 2))[0] ?? ""}`;
		if (this.naming) return ` ${this.naming.input.render(Math.max(10, panes.rosterWidth() - 2))[0] ?? ""}`;
		if (this.snoozing)
			return this.clickable(y, [
				[" ", null],
				[key("⏎", "snooze"), () => this.finishSnooze((SNOOZE_CHOICES[this.snoozing?.choice ?? 0] as { snooze: SnoozePreset }).snooze)],
				[" ", null],
				[key("esc", "cancel"), () => this.leave()],
			]);
		const drag = this.dragging;
		if (drag?.moved) {
			if (!drag.drop) return ` ${red("✗ not here")}`;
			return drag.drop.name === null ? ` ⇢ out of its Group` : ` ⇢ into ${bold(drag.drop.name)}`;
		}
		const help: Hint = ["?", "keys", () => void showHelp()];
		const newAtCursor: Hint = ["n", "new", () => this.newAt()];
		const enter = (label: string): Hint => ["⏎", label, () => this.activate(true)];
		const row = this.selected();
		let hints: Hint[];
		if (focus === "stage" && (panes.applied.target === placeholder || harnessStarting(panes.applied)))
			hints = [
				["esc", "list", () => void panes.showRoster(true)],
				[`${config.prefix} ?`, "keys", help[2]],
			];
		else if (focus === "stage")
			hints = [
				[`${config.prefix} h`, "list", () => void panes.showRoster(true)],
				[`${config.prefix} z`, "hide list", () => void panes.hideRoster()],
				[`${config.prefix} ?`, "keys", help[2]],
			];
		else if (!row) hints = [newAtCursor, help];
		else if (row.kind === "header" && row.group !== null)
			hints = [enter(row.collapsed ? "expand" : "collapse"), ["m", "rename", () => this.startNaming()], newAtCursor, help];
		else if (row.kind === "header") hints = [enter(row.collapsed ? "expand" : "collapse"), newAtCursor, help];
		else if (row.kind === "section" && row.key === "operators")
			hints = [enter(row.expanded ? "collapse" : "expand"), ["n", "new operator", () => this.newAt()], help];
		else if (row.kind === "section") hints = [enter(row.expanded ? "collapse" : "expand"), help];
		else if (!row.entry.open) hints = [enter("open"), ["a", "unarchive", () => this.toggleArchived()], help];
		else if (row.entry.snoozed)
			hints = [
				enter(row.entry.live ? "focus" : "wake"),
				["s", "unsnooze", () => this.toggleSnooze()],
				["a", "archive", () => this.toggleArchived()],
				help,
			];
		else hints = [enter(row.entry.live ? "focus" : "wake"), ["a", "archive", () => this.toggleArchived()], newAtCursor, help];
		// Settings joins the legend where it fits.
		const settings: Hint = [",", "settings", () => openSettings()];
		const width = (list: Hint[]) => list.reduce((n, [name, label]) => n + 1 + visibleWidth(key(name, label)), 0);
		// `[` and `]` as buttons, at the legend's right end, gray while there's nowhere to go.
		const arrow = (glyph: string, step: -1 | 1): [string, (() => void) | null] =>
			historyStep(step) === -1 ? [gray(glyph), null] : [bold(glyph), () => goHistory(step)];
		const arrows = " ‹ › ".length;
		if (focus === "roster" && width([...hints, settings]) + arrows <= panes.rosterWidth()) hints.push(settings);
		return this.clickable(y, [
			...hints.flatMap(([name, label, act]): [string, (() => void) | null][] => [
				[" ", null],
				[key(name, label), act],
			]),
			[" ".repeat(Math.max(1, cols - width(hints) - arrows + 1)), null],
			arrow("‹", -1),
			[" ", null],
			arrow("›", 1),
		]);
	}

	invalidate(): void {}
}

type Hint = [name: string, label: string, act: () => void];

type PickRow = { kind: "target"; target: Target; tree: TargetTree | null; context: boolean; score: number; at: number[] } | { kind: "add" };

/** The directory picker, `n` and `N`, which takes over the whole roster while it's open. */
type Choosing = {
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
type Menu = { query: string; cursor: number };

/** Every preset that can start, from the default. */
function pickerPresets(): Choice[] {
	return fromDefault(shortlist(config, catalog) ?? []).filter((c) => c.reason === null);
}

/** The chosen preset's index into pickerPresets, as long as there are any. */
function chosenPreset(choosing: Choosing): number {
	if (choosing.preset === null) return 0;
	return Math.max(0, presetLabels(pickerPresets().map((c) => c.preset)).indexOf(choosing.preset));
}

/** What the menu shows, as indexes into pickerPresets: a harness at a time, in the order they first appear, narrowed by `query`. */
function menuPresets(query: string): number[] {
	const presets = pickerPresets();
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const matches = (c: Choice) => {
		const p = c.preset;
		const text = `${p.harness} ${harnessName(p.harness)} ${p.provider ?? ""} ${p.model ?? ""} ${p.effort ?? ""} ${p.agent ?? ""} ${c.note}`;
		return words.every((w) => text.toLowerCase().includes(w));
	};
	return [...new Set(presets.map((c) => c.preset.harness))].flatMap((h) =>
		presets.flatMap((c, i) => (c.preset.harness === h && matches(c) ? [i] : [])),
	);
}

/**
 * What a session from the picker starts on: its preset, or with none that can, the default's harness on its own
 * defaults. Null until the harnesses are found, when the worker decides; a string says why nothing can start.
 */
function pickerTarget(choosing: Choosing): LaunchTarget | string | null {
	const chosen = pickerPresets()[chosenPreset(choosing)];
	if (chosen) return chosen.launch;
	if (catalog === null && config.presets === null) return null;
	return defaultLaunch(config, catalog, shortlist(config, catalog) ?? []);
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
	const word = [...lower.matchAll(/[-_./ ]/g)].map((m) => (m.index as number) + 1).find((i) => lower.startsWith(q, i));
	if (word !== undefined) return { score: 1, at: run(word) };
	const inside = lower.indexOf(q);
	return inside === -1 ? null : { score: 2, at: run(inside) };
}

function marked(name: string, at: number[]): string {
	return [...name].map((c, i) => (at.includes(i) ? cyan(c) : c)).join("");
}

/** The picker's list as the worker last found it; null until its first scan lands. */
let dirTrees: TargetTree[] | null = null;

/** A typed directory, ending in `/` or empty, is itself what Enter adds until a completion is highlighted. */
function typedChoice(typed: string): number {
	return typed === "" || typed.endsWith("/") ? -1 : 0;
}

function scanBase(): string {
	return expandHome(config.dirs.scan[0] ?? "~");
}

function pickLine(row: PickRow, width: number, cursor: boolean): string {
	if (row.kind === "add") return ` ${green("+ add a directory…")}`;
	const name = marked(targetName(row.target), row.at);
	const label = row.target.repo ? `   ${name}` : ` ${row.context ? dim(name) : bold(name)}`;
	if (!cursor || row.context) return label;
	return `${truncateToWidth(label, width - 3, "…", true)} ✕ `;
}

/** The remove prompt, boxed over the middle of the list; its buttons are click targets too. */
function overlayConfirm(
	out: string[],
	width: number,
	confirm: { name: string; worktrees: number },
	listY: number,
	answer: (yes: boolean) => void,
	targets: ClickTarget[],
): void {
	const inner = Math.min(width - 4, 34);
	const left = Math.floor((width - inner - 2) / 2);
	const pad = (text: string) => `${" ".repeat(left)}│${truncateToWidth(` ${text}`, inner, "…", true)}│`;
	const lines = [
		`${" ".repeat(left)}┌${"─".repeat(inner)}┐`,
		pad(`Remove ${bold(confirm.name)}`),
		pad(confirm.worktrees > 0 ? `and its ${confirm.worktrees} worktree${confirm.worktrees > 1 ? "s" : ""}` : ""),
		pad("from this list?"),
		pad(""),
		pad(`${key("y", "remove")}  ${key("n", "keep")}`),
		`${" ".repeat(left)}└${"─".repeat(inner)}┘`,
	];
	const top = Math.max(0, Math.floor((out.length - lines.length) / 3));
	lines.forEach((line, i) => {
		out[top + i] = line;
	});
	const y = listY + top + 5;
	targets.unshift(
		{ y, from: left + 2, to: left + 10, act: () => answer(true) },
		{ y, from: left + 12, to: left + 18, act: () => answer(false) },
	);
}

function rowLine(row: Row, width: number, now: number): string {
	if (row.kind === "header") {
		const count = gray(` (${row.count})`);
		const name = row.group === null ? bold(projectName(row.project)) : row.group;
		return `${" ".repeat(1 + row.depth * 2)}${row.collapsed ? "▸" : "▾"} ${name}${count}`;
	}
	if (row.kind === "section") return ` ${row.expanded ? "▾" : "▸"} ${row.label} ${gray(`(${row.count})`)}`;
	const e = row.entry;
	// Mid-drag, the session being carried is a hollow outline of itself.
	if (roster.dragging?.moved && roster.dragging.id === e.id) {
		const lead = `${gray("┆")}${rowLead(row)}`;
		return `${lead}${gray("◌")} ${gray(truncateToWidth(displayName(e), width - visibleWidth(lead) - 2, "…"))}`;
	}
	const mark = stage.staged === e.id ? (focus === "stage" ? cyan("▌") : "▌") : " ";
	const lead = `${mark}${rowLead(row)}`;
	// A snoozed row says when it wakes instead: ↘ for its next message. Mid-turn, the glyph already says it's active.
	const when = !e.open
		? age(archivedKey(e), now)
		: e.snoozed
			? e.snoozedUntil === null
				? "↘"
				: wakeAt(e.snoozedUntil, now)
			: e.activity !== "idle"
				? ""
				: age(e.activityAt, now);
	const worktree = e.cwd !== e.project ? magenta("⎇") : " ";
	const right = ` ${worktree} ${gray(when.padStart(3))} `;
	const hidden = row.folded ? ` ${foldedTally(row.family.map((p) => p.entry))}` : "";
	const titleWidth = width - visibleWidth(lead) - 2 - visibleWidth(hidden) - visibleWidth(right);
	const title = truncateToWidth(e.provisional ? gray(displayName(e)) : displayName(e), titleWidth, "…", true);
	return `${lead}${glyph(stateOf(e), now)} ${title}${hidden}${right}`;
}

/**
 * A session row's left edge, after the cursor's bar: a nested row hangs from its parent's glyph on its family's guides;
 * a family's root says who started it, if a session did, and has the family's fold.
 */
function rowLead(row: SessionRow): string {
	const indent = " ".repeat(row.depth * 2);
	const fold = row.family.length === 0 ? null : gray(row.folded ? "▸" : "▾");
	if (row.nest) {
		const guides = row.nest.continues.map((on) => (on ? "│  " : "   ")).join("");
		return `${indent}  ${gray(`${guides}${row.nest.last ? "└" : "├"}`)}${fold ?? gray("─")} `;
	}
	const from = origin(row.entry);
	return `${indent}${originMark(from)}${fold ?? " "}`;
}

function originMark(from: "session" | "operator" | null): string {
	return from === "operator" ? blue("⌁") : from === "session" ? "↳" : " ";
}

/** Where a row's fold is: the column a click on it folds or opens its family from. */
function foldColumn(row: SessionRow): number {
	return row.nest ? 4 + row.depth * 2 + 3 * row.nest.continues.length : 2 + row.depth * 2;
}

/** What a family is doing, by state; ○ is every one finished, idle or not running. */
function familyTally(family: Entry[]): string {
	const states = family.map(stateOf);
	const tally: [State[], string][] = [
		[["working", "loading"], cyan("◐")],
		[["blocked"], attention("◆")],
		[["cut-off", "errored"], red("⚠")],
		[["unseen"], green("●")],
		[["idle", "dormant"], "○"],
	];
	return tally
		.flatMap(([which, mark]) => {
			const n = states.filter((state) => which.includes(state)).length;
			return n > 0 ? [`${mark}${n}`] : [];
		})
		.join(" ");
}

/** How many sessions a fold hides, and of them, as the terminal's title counts them, those that need me. */
function foldedTally(hidden: Entry[]): string {
	const states = hidden.map(stateOf);
	const count = (state: State, mark: string) => {
		const n = states.filter((s) => s === state).length;
		return n > 0 ? ` ${mark}${n}` : "";
	};
	return `${gray(`+${hidden.length}`)}${count("blocked", attention("◆"))}${count("unseen", green("●"))}`;
}

// ── Peek ────────────────────────────────────────────────────────────────

// A Peek is a session's particulars and keys in an overlay beside its row (see overlay.ts): on the Stage, so it never
// covers the roster, or on a narrow Deck, which has no Stage beside the roster, over the roster's right edge. The UI
// server puts it away when the pointer leaves (see deck.ts).

const PEEK_COLS = 48;
/** Narrower than this, as the roster is for a moment while tmux zooms a pane over it, there is no Peek. */
const PEEK_MIN_COLS = 28;
/** The pointer rests this long on a row before its Peek opens. */
const PEEK_OPEN_MS = 80;
/** ...and this long before an open Peek follows it to another row, so a diagonal path into the Peek doesn't drag it along. */
const PEEK_SWITCH_MS = 150;
/** How long a Peek waits for its last turn and diff before opening without them. */
const PEEK_INFO_WAIT_MS = 200;
/** How long a session's last turn and diff stand before a Peek asks again. */
const PEEK_INFO_MS = 2000;
/** The most of a folded family a Peek lists. */
const PEEK_FOLD_ROWS = 8;

type PeekSpot = { id: string; source: "pointer" | "cursor"; y: number };

const peek = {
	/** Where the Peek is, once the pointer rested there and what it shows came in or stopped being waited for. */
	settled: null as PeekSpot | null,
	pending: null as { spot: PeekSpot; timer: Timer } | null,
	/** Where the last render wanted the Peek. */
	spot: null as PeekSpot | null,
	/** The Peek put away when the keyboard went to the Stage; it stays away until its row changes. */
	dismissed: null as string | null,
	/** Set by a navigation key: the cursor's row has a Peek while the roster has the keyboard. */
	byKeys: false,
	/** Whether the UI server reports the pointer leaving; it stops by itself when it reports. */
	watching: false,
	info: new Map<string, { info: PeekInfo; at: number }>(),
	asked: new Set<string>(),
	infoWaits: new Map<string, () => void>(),
};

const spotKey = (spot: PeekSpot | null | undefined) => (spot ? `${spot.id}@${spot.y}` : null);

function cancelPendingPeek(): void {
	if (peek.pending) clearTimeout(peek.pending.timer);
	peek.pending = null;
}

/** Where render wants a Peek, unless it was put away; asks for what it shows. */
function wantPeek(want: PeekSpot | null): PeekSpot | null {
	let spot = want;
	if (spot?.id !== peek.dismissed) peek.dismissed = null;
	else spot = null;
	peek.spot = spot;
	if (spot) askPeekInfo(spot.id);
	return spot;
}

/** Settles the Peek on `spot`: at once to close, after the pointer rests, and what it shows comes in, to open or move. */
function syncPeek(spot: PeekSpot | null): void {
	if (spotKey(peek.settled) === spotKey(spot)) {
		peek.settled = spot;
		cancelPendingPeek();
		return;
	}
	if (peek.pending && spotKey(peek.pending.spot) === spotKey(spot)) return;
	cancelPendingPeek();
	if (!spot) {
		peek.settled = null;
		return;
	}
	const pending = {
		spot,
		timer: setTimeout(
			async () => {
				if (!peek.info.has(spot.id))
					await Promise.race([new Promise<void>((resolve) => peek.infoWaits.set(spot.id, resolve)), Bun.sleep(PEEK_INFO_WAIT_MS)]);
				if (peek.pending !== pending) return;
				peek.pending = null;
				peek.settled = spot;
				tui.requestRender();
			},
			peek.settled ? PEEK_SWITCH_MS : PEEK_OPEN_MS,
		),
	};
	peek.pending = pending;
}

/** Whether the UI server reports the pointer leaving: while something under it is lit, or something leaves with it. */
function syncWatch(want: boolean): void {
	if (want === peek.watching) return;
	peek.watching = want;
	void tmuxAsync(UI, "set", "-t", deck, ...(want ? ["@swb_watch", "1"] : ["-u", "@swb_watch"])).catch((error: Error) =>
		toast(`peek: ${error.message}`, "error"),
	);
}

function askPeekInfo(id: string): void {
	const e = entries.get(id);
	const have = peek.info.get(id);
	if (!e || peek.asked.has(id) || (have && Date.now() - have.at < PEEK_INFO_MS)) return;
	peek.asked.add(id);
	post({ type: "peek", id, cwd: e.cwd, transcript: e.transcript, harness: e.harness });
}

function onPeekInfo(id: string, info: PeekInfo): void {
	peek.asked.delete(id);
	peek.info.set(id, { info, at: Date.now() });
	peek.infoWaits.get(id)?.();
	peek.infoWaits.delete(id);
	tui.requestRender();
}

/** The pointer or the keyboard went elsewhere, as the UI server saw it, and took the Peek with it. */
function pointerOut(): void {
	roster.hover = null;
	roster.pointer = null;
	peek.byKeys = false;
	// LEAVE unset both options as it ran.
	peek.watching = false;
	overlays.disarmed();
}

/**
 * The settled Peek, beside its row: on the Stage, opening onto the roster's border, or on a narrow Deck, which has no
 * Stage beside the roster, over the roster's right edge, leaving each row's glyph and the start of its title showing.
 * While the pointer is on it, it holds as if on its row.
 */
function peekOverlays(rows: Row[], width: number, height: number): Overlay[] {
	const spot = peek.settled;
	const row = spot && rows.find((r) => r.key === spot.id);
	if (!spot || row?.kind !== "session") return [];
	const w = panes.narrow ? Math.max(PEEK_MIN_COLS, Math.min(PEEK_COLS, width - 16)) : Math.min(PEEK_COLS, panes.width - width - 1);
	if (w < PEEK_MIN_COLS || width < PEEK_MIN_COLS) return [];
	const view = peekView(row, w, height, panes.narrow ? "right" : "left");
	const pointer = () => {
		cancelPendingPeek();
		if (roster.hover === spot.id) return;
		roster.hover = spot.id;
		tui.requestRender();
	};
	return [
		{
			id: "peek",
			about: spot.id,
			x: panes.narrow ? width - w : width + 1,
			y: Math.max(0, Math.min(spot.y - 1, height - view.lines.length)),
			width: w,
			view,
			leaves: true,
			pointer,
		},
	];
}

/**
 * A toast too long for the message line rises from it over the roster's bottom rows, under a rule, so none of it is
 * cut; the list beneath keeps its place.
 */
function toastOverlay(now: number, width: number, y: number): Overlay[] {
	const t = toasts.filter((t) => t.until > now).at(-1);
	if (!t) return [];
	const text = t.level === "error" ? `✗ ${t.text}` : t.text;
	if (visibleWidth(text) <= width - 1) return [];
	const paint = t.level === "error" ? red : green;
	const lines = [gray("─".repeat(width)), ...wrapTextWithAnsi(text, width - 1).map((line) => ` ${paint(line)}`)];
	return [{ id: "toast", about: t.text, x: 0, y: y - lines.length + 1, width, view: { lines, buttons: [] }, leaves: false, pointer: null }];
}

/** The launch card is as wide as this, or the Stage, whichever is narrower. */
const LAUNCH_COLS = 56;
/** The launch card's menu, no wider than this. */
const MENU_COLS = 52;

/** Whether the launch card goes on the Stage, which a narrow Deck doesn't have beside the roster. */
function launchOnStage(width: number): boolean {
	return !panes.narrow && Math.min(LAUNCH_COLS, panes.width - width - 1) >= PEEK_MIN_COLS;
}

/**
 * The launch card, on the Stage atop the roster's top row unless the roster draws it, and its menu hung from its field.
 * Both stay while the roster has the keyboard.
 */
function launchOverlays(choosing: Choosing, width: number, height: number): Overlay[] {
	if (focus !== "roster") return [];
	const want: Overlay[] = [];
	const onStage = launchOnStage(width);
	if (onStage) {
		const w = Math.min(LAUNCH_COLS, panes.width - width - 1);
		want.push({
			id: "launch",
			about: "launch",
			x: width + 1,
			y: 0,
			width: w,
			view: launchCard(choosing, w, "left"),
			leaves: false,
			pointer: null,
		});
	}
	if (choosing.menu) {
		const field = onStage ? { x: width + 1, y: 1 } : { x: 0, y: 2 };
		const w = Math.min(MENU_COLS, (onStage ? panes.width : width) - field.x - 4);
		const y = field.y + 1;
		const view = launchMenu(choosing, w, height - y);
		want.push({ id: "menu", about: "launch", x: field.x + 2, y, width: w, view, leaves: false, pointer: null });
	}
	return want;
}

/** A key a Peek's button runs, on its session. */
function peekKey(k: string, id: string): () => void {
	return () => void prefixKey(k, id).catch((error: Error) => toast(error.message, "error"));
}

/** A path too long for the Peek keeps its end, where the directories that tell sessions apart are. */
function tailOf(path: string, width: number): string {
	return visibleWidth(path) <= width ? path : `…${path.slice(path.length - width + 1)}`;
}

function ago(at: number, now: number): string {
	const a = age(at, now);
	return a === "now" ? "just now" : `${a} ago`;
}

/** A line of a Peek, or of the launch card, on its three framed sides: open to the left beside the roster, to the right in it. */
function peekFrame(open: "left" | "right", inner: number): (content: string) => string {
	return (content) =>
		open === "left"
			? ` ${truncateToWidth(content, inner, "…", true)} ${gray("│")}`
			: `${gray("│")} ${truncateToWidth(content, inner, "…", true)} `;
}

/** What a session from the picker starts on, as the launch card's field says it. */
function presetField(c: Choice): string {
	const p = c.preset;
	const what = p.agent ? `${p.agent} ${gray("agent")}` : `${p.model} ${gray(p.effort ?? "default")}`;
	return `${cyan(harnessName(p.harness))}  ${what}${p.provider ? gray(` · ${p.provider}`) : ""}`;
}

/**
 * The launch card: what a session from the picker starts on, its harness first, and the preset's note; its field opens
 * the menu. On the Stage it opens to the left, onto the roster's border; in a narrow Deck's roster, to the right.
 */
function launchCard(choosing: Choosing, width: number, open: "left" | "right"): OverlayView {
	const inner = width - 3;
	const presets = pickerPresets();
	const chosen = presets[chosenPreset(choosing)];
	const menu = choosing.menu;
	let value: string;
	if (menu && menu.query !== "") value = `${menu.query}▌`;
	else if (chosen) value = presetField(chosen);
	else {
		const target = pickerTarget(choosing);
		value =
			target === null
				? gray("finding harnesses…")
				: typeof target === "string"
					? red(target)
					: `${cyan(harnessName(target.harness))} ${gray("· its own defaults")}`;
	}
	const arrow = presets.length === 0 ? " " : menu ? "▴" : "▾";
	const field = `${truncateToWidth(value, inner - 2, "…", true)} ${gray(arrow)}`;
	const frame = peekFrame(open, inner);
	const edge = `─ starts ${"─".repeat(Math.max(0, width - 10))}`;
	const lines = [
		gray(open === "left" ? `${edge}╮` : `╭${edge}`),
		frame(field),
		// The open menu says the highlighted preset's note, and covers all but the edge of this one.
		frame(gray(menu ? "" : (chosen?.note ?? ""))),
		gray(open === "left" ? `${"─".repeat(width - 1)}╯` : `╰${"─".repeat(width - 1)}`),
	];
	const margin = open === "left" ? 1 : 2;
	return {
		lines,
		buttons:
			presets.length === 0
				? []
				: [{ y: 1, from: margin, to: margin + inner, act: () => roster.toggleMenu(), hot: frame(cursorLine(field, true)) }],
	};
}

/**
 * The launch card's menu, hung from its field: every preset, a harness at a time, numbered for one key to pick until
 * something's typed, and the highlighted one's note. Too long for the room it has, it scrolls to keep its highlight in view.
 */
function launchMenu(choosing: Choosing, width: number, maxHeight: number): OverlayView {
	const menu = choosing.menu as Menu;
	const inner = width - 4;
	const presets = pickerPresets();
	const chosen = chosenPreset(choosing);
	const shown = menuPresets(menu.query);
	const items: string[] = [];
	const itemAt: number[] = [];
	let harness: Harness | null = null;
	shown.forEach((index, n) => {
		const p = (presets[index] as Choice).preset;
		if (p.harness !== harness) {
			harness = p.harness;
			items.push(cyan(harnessName(harness)));
		}
		const name = p.agent ?? p.model ?? "";
		const pad = " ".repeat(Math.max(1, 21 - visibleWidth(name)));
		const effort = (p.agent ? "agent" : (p.effort ?? "default")).padEnd(8);
		itemAt.push(items.length);
		items.push(
			`${menu.query === "" && n < 9 ? cyan(String(n + 1)) : " "} ${p.default ? "★" : " "} ${index === chosen ? cyan(name) : name}${pad}${gray(effort)}${gray(p.provider ?? "")}`,
		);
	});
	if (shown.length === 0) items.push(gray("nothing matches"));
	// Its frame, and the rule and note under the list.
	const room = Math.max(1, maxHeight - 4);
	const from = Math.min(Math.max(0, (itemAt[menu.cursor] ?? 0) - room + 1), Math.max(0, items.length - room));
	let to = Math.min(items.length, from + room);
	// A harness's name at the foot of the window, with none of its presets under it, says nothing.
	if (to < items.length && !itemAt.includes(to - 1)) to--;
	const row = (content: string) => `${gray("│")} ${truncateToWidth(content, inner, "…", true)} ${gray("│")}`;
	const lines = [gray(`┌${"─".repeat(width - 2)}┐`)];
	const buttons: OverlayButton[] = [];
	items.slice(from, to).forEach((line, i) => {
		const n = itemAt.indexOf(from + i);
		const content = truncateToWidth(line, inner, "…", true);
		if (n !== -1) {
			const index = shown[n] as number;
			buttons.push({ y: lines.length, from: 2, to: 2 + inner, act: () => roster.choosePreset(index), hot: row(hoverLine(content)) });
		}
		lines.push(row(n === menu.cursor ? cursorLine(content, true) : content));
	});
	lines.push(
		gray(`├${"─".repeat(width - 2)}┤`),
		row(gray(presets[shown[menu.cursor] ?? -1]?.note ?? "")),
		gray(`└${"─".repeat(width - 2)}┘`),
	);
	return { lines, buttons };
}

/**
 * What a Peek shows, framed on three sides. Beside the roster it opens to the left, onto the roster's border; drawn by
 * the roster itself, at the terminal's right edge, it opens to the right. A Peek too short for everything loses the last
 * turn first.
 */
function peekView(row: SessionRow, width: number, maxHeight: number, open: "left" | "right"): OverlayView {
	const e = row.entry;
	const now = Date.now();
	const inner = width - 3;
	const rule = gray("─".repeat(inner));
	const head: string[] = [];
	const title = wrapTextWithAnsi(displayName(e), inner);
	const titleLines = title.length > 2 ? [title[0] as string, truncateToWidth(title.slice(1).join(" "), inner, "…")] : title;
	head.push(...titleLines.map((line) => bold(line)));
	head.push(...wrapTextWithAnsi(`${glyph(stateOf(e), now)} ${status(e)}${launchElapsed(e, now)}`, inner));
	head.push(
		gray(
			`created ${ago(e.createdAt, now)} · ${e.open ? `active ${e.activity !== "idle" ? "now" : ago(e.activityAt, now)}` : `archived ${ago(archivedKey(e), now)}`}`,
		),
	);
	head.push(rule, gray(tailOf(`${e.harness} · ${shortPath(e.cwd)}`, inner)));
	const info = peek.info.get(e.id)?.info;
	if (e.branch) {
		const diff = info?.diff;
		const changes = diff ? `  ${green(`+${diff.add}`)} ${red(`−${diff.del}`)}${gray(" uncommitted")}` : "";
		head.push(`${magenta(`⎇ ${e.branch}`)}${changes}`);
	}
	const group = groupOf(e);
	if (group !== null) head.push(`${gray("Group")} ${group}`);
	// Lines that are buttons: who started it, and on a fold, each session it hides.
	const links: { at: number; act: () => void }[] = [];
	const parent = parentOf(e);
	if (parent) {
		const label = `${gray("started by")} ${originMark(origin(e))} `;
		links.push({ at: head.length, act: peekKey("p", e.id) });
		head.push(`${label}${truncateToWidth(displayName(parent), inner - visibleWidth(label) - 2, "…", true)} ${dim("p")}`);
		if (parent.project !== e.project && !parent.operator)
			head.push(gray(`${" ".repeat(visibleWidth(label))}in ${projectName(parent.project)}`));
	}
	if (row.folded) {
		head.push(rule, `${gray("folded")} ${foldedTally(row.family.map((p) => p.entry))}`);
		for (const { entry, nest } of row.family.slice(0, PEEK_FOLD_ROWS)) {
			const guides = `${nest.continues.map((on) => (on ? "│  " : "   ")).join("")}${nest.last ? "└─ " : "├─ "}`;
			links.push({ at: head.length, act: () => reveal(entry.id) });
			head.push(`${gray(guides)}${glyph(stateOf(entry), now)} ${displayName(entry)}`);
		}
		const rest = row.family[PEEK_FOLD_ROWS];
		if (rest) {
			links.push({ at: head.length, act: () => reveal(rest.entry.id) });
			head.push(gray(`… ${row.family.length - PEEK_FOLD_ROWS} more`));
		}
	}
	if (e.schedules.length > 0) {
		head.push(rule, gray("Schedules"));
		// The soonest few, and always the last that ran, so it shows one ran however many are pending.
		const shown = [...e.schedules.filter((v) => v.nextAt !== null).slice(0, 3), ...e.schedules.filter((v) => v.nextAt === null)];
		for (const v of shown) {
			const line =
				v.nextAt === null
					? `${green("✓")} ${v.scheduleLabel}${gray(` · ran ${ago(v.lastFiredAt as number, now)}`)}`
					: v.cron
						? `${cyan("↻")} ${v.scheduleLabel}${gray(` · next ${wakeAt(v.nextAt, now)}${v.lastFiredAt === null ? "" : ` · last ${ago(v.lastFiredAt, now)}`}`)}`
						: `${gray("◷")} ${v.scheduleLabel}${gray(` · ${wakeAt(v.nextAt, now)}`)}`;
			head.push(truncateToWidth(` ${line}`, inner, "…"));
		}
	}
	const turn: string[] = [];
	if (info?.error) turn.push(rule, ...wrapTextWithAnsi(red(`✗ ${info.error}`), inner).slice(0, 3));
	else if (info?.last) {
		const label = `${(info.last.who === "you" ? "you" : e.harness).padEnd(Math.max(3, e.harness.length))} `;
		const pad = visibleWidth(label);
		const text = wrapTextWithAnsi(info.last.text.replace(/\s+/g, " ").trim(), inner - pad);
		const shown = text.length > 3 ? [...text.slice(0, 2), truncateToWidth(text.slice(2).join(" "), inner - pad, "…")] : text;
		turn.push(rule, ...shown.map((line, i) => `${gray(i === 0 ? label : " ".repeat(pad))}${line}`));
	}
	// The buttons, wrapped; each is the row's key, so the Peek teaches them too.
	const buttons: { y: number; from: number; to: number; key: string; text: string }[] = [];
	const buttonLines: string[] = [];
	let line = "";
	let x = 0;
	for (const [label, k] of peekButtons(row)) {
		const text = ` ${label} ${dim(k)} `;
		const w = visibleWidth(text);
		if (x > 0 && x + 1 + w > inner) {
			buttonLines.push(line);
			line = "";
			x = 0;
		}
		if (x > 0) {
			line += " ";
			x += 1;
		}
		buttons.push({ y: buttonLines.length, from: x, to: x + w, key: k, text });
		line += text;
		x += w;
	}
	if (line !== "") buttonLines.push(line);
	const body = [...head, ...(head.length + turn.length + 1 + buttonLines.length + 2 <= maxHeight ? turn : []), rule];
	const buttonsAt = body.length;
	body.push(...buttonLines);
	const frame = peekFrame(open, inner);
	const edge = "─".repeat(width - 1);
	const lines = [
		gray(open === "left" ? `${edge}╮` : `╭${edge}`),
		...body.slice(0, maxHeight - 2).map(frame),
		gray(open === "left" ? `${edge}╯` : `╰${edge}`),
	];
	const margin = open === "left" ? 1 : 2;
	return {
		lines,
		buttons: [
			...links
				.filter((link) => 1 + link.at < lines.length - 1)
				.map((link) => ({
					y: 1 + link.at,
					from: margin,
					to: margin + inner,
					act: link.act,
					hot: frame(cursorLine(truncateToWidth(body[link.at] as string, inner, "…", true), true)),
				})),
			...buttons
				.filter((b) => 1 + buttonsAt + b.y < lines.length - 1)
				.map((b) => {
					const y = 1 + buttonsAt + b.y;
					// The line again with this one button lit, for the pointer resting on it.
					const lit = (buttonLines[b.y] as string).replace(b.text, cursorLine(b.text, true));
					return { y, from: margin + b.from, to: margin + b.to, act: peekKey(b.key, e.id), hot: frame(lit) };
				}),
		],
	};
}

// ── Deck actions ────────────────────────────────────────────────────────

/**
 * The roster's own keys, from anywhere after the prefix. j and k step over headers, and the keyboard stays put. Given a
 * session, from a Peek's buttons, the key acts on that session's row instead of the cursor's.
 */
async function prefixKey(k: string, id: string | undefined): Promise<void> {
	const row = id === undefined ? roster.selected() : roster.rows().find((r) => r.key === id);
	if (id !== undefined && !row) throw new Error(`no session ${id} in the roster`);
	if (k === ",") {
		await panes.showRoster(true);
		openSettings();
		return;
	}
	// Session commands wait while Settings is open.
	if (roster.settings) return;
	if (k === "d") {
		roster.askRemove();
		return;
	}
	// Any other command abandons a prompt or picker left open, which would otherwise take the keys it brings back.
	roster.leave();
	if (k === "/") {
		await panes.showRoster(true);
		roster.enter({ kind: "filter" });
	} else if (k === "m") {
		await panes.showRoster(true);
		roster.startNaming(row);
	} else if (k === "J" || k === "K") roster.moveSession(k === "J" ? 1 : -1);
	else if (k === "n") {
		await panes.showRoster(true);
		roster.newAt(row);
	} else if (k === "N") {
		await panes.showRoster(true);
		roster.openPicker("add", null, null);
	} else if (k === "w") roster.wake(row);
	else if (k === "x") roster.stop(row);
	else if (k === "R") roster.reload(row);
	else if (k === "a") {
		// The cursor's session lingers once archived, and the keyboard goes to the roster to look it over or move on; so
		// does asking whether its family or worktree goes too.
		if (
			row?.kind === "session" &&
			row.entry.open &&
			(row.key === roster.selected()?.key || row.entry.worktree !== null || openDescendants(entries.values(), row.entry.id).length > 0)
		)
			await panes.showRoster(true);
		roster.toggleArchived(row);
	} else if (k === "p") roster.toParent(row);
	else if (k === "u") roster.toggleUnseen(row);
	else if (k === "[" || k === "]") goHistory(k === "[" ? -1 : 1);
	else if (k === "s" || k === "S") {
		// The menu takes the keyboard; unsnoozing needs none.
		if (!(row?.kind === "session" && row.entry.snoozed)) await panes.showRoster(true);
		roster.toggleSnooze(row);
	} else if (k === "y" || k === "Y") roster.copy(k === "y", row);
	else throw new Error(`unknown deck key ${k}`);
	roster.syncStage(true);
}

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
	const size = helpSize(config.prefix);
	const fit = ["-w", String(Math.min(size.width, Number(cols))), "-h", String(Math.min(size.height, Number(rows)))];
	await tmuxAsync(UI, "display-popup", "-c", client, "-E", ...fit, ...HELP_POPUP);
}

/** A Peek's buttons: each one's label and the roster key it runs. */
function peekButtons(row: Row): [label: string, key: string][] {
	if (row.kind === "section") return row.key === "operators" ? [["New Operator", "n"]] : [];
	if (row.kind === "header") {
		const items: [string, string][] = [["New session here", "n"]];
		if (row.group !== null) items.push(["Rename Group…", "m"]);
		return items;
	}
	const e = row.entry;
	const items: [string, string][] = [];
	if (!e.open) items.push(["Unarchive", "a"]);
	else {
		items.push(e.live ? ["Stop", "x"] : ["Wake", "w"]);
		if (!e.provisional) items.push(["Reload", "R"]);
		if (!e.provisional && !e.snoozed) items.push(e.markedUnseen ? ["Unmark Unseen", "u"] : ["Mark Unseen", "u"]);
		if (!e.provisional) items.push(e.snoozed ? ["Unsnooze", "s"] : ["Snooze…", "s"], ["Archive", "a"]);
		if (!e.operator) items.push(["Group…", "m"]);
		items.push([e.operator ? "New Operator" : "New session here", "n"]);
	}
	items.push(["Copy swb open <id>", "y"], ["Copy @session:<id>", "Y"]);
	return items;
}

process.stdout.on("resize", () => void panes.noteDrag());

function quit(): void {
	void tmuxAsync(UI, "kill-session", "-t", `=${deck}`);
}

/**
 * The worker's harness discovery runs each command in a session of its own, which neither the pane's SIGHUP nor this
 * process exiting reaches: a `pi --list-models` left running would outlive the Deck. Those sessions are the only
 * children here that lead their own process group.
 */
function stopDiscovery(): void {
	// biome-ignore lint/plugin: at exit, when nothing waits on the roster's keys any more.
	const children = Bun.spawnSync(["pgrep", "-P", String(process.pid)])
		.stdout.toString()
		.split("\n")
		.filter(Boolean);
	for (const pid of children) {
		try {
			process.kill(-Number(pid), "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
}

function cleanup(): never {
	roster.settings?.saveProse();
	overlays.closeAllNow();
	stopDiscovery();
	// biome-ignore-start lint/plugin: at exit, when nothing waits on the roster's keys any more.
	tmuxTry(SESSIONS, "kill-session", "-t", `=${placeholder}`);
	rmSync(sock, { force: true });
	// biome-ignore-end lint/plugin: exit
	ctl.close();
	process.exit(0);
}
process.on("SIGHUP", cleanup);
process.on("SIGTERM", cleanup);
// The pane gone, its terminal also reads as closed, or fails with EIO, and either can come before the SIGHUP.
process.stdin.on("close", cleanup);
process.stdin.on("error", (error: NodeJS.ErrnoException) => {
	if (error.code !== "EIO") throw error;
	cleanup();
});

let focusReads = Promise.resolve();

/**
 * The keyboard's pane, read afresh. The hook that reports a move, and a prefix key pressed just after it, each run in
 * the background and can land in either order.
 */
async function syncFocus(): Promise<void> {
	focusReads = focusReads.then(async () => {
		const pane = await tmuxAsync(UI, "display", "-p", "-t", deck, "#{pane_id}");
		if (pane !== focusedPane) focusMoves++;
		focusedPane = pane;
	});
	await focusReads;
	const was = focus;
	focus = focusedPane === rosterPane ? "roster" : "stage";
	// Moving to another pane, by ctrl-hjkl or the prefix, leaves Settings.
	if (focus === "stage" && roster.settings) closeSettings();
	if (focus === "roster") for (const launch of launches) launch.keyboard = false;
	// A drag released over another pane never reports its release here.
	else roster.dragging = null;
	// Moving onto a dormant session, by click or key, means to use it.
	const onView = stage.staged === null ? undefined : entries.get(stage.staged);
	if (focus === "roster") returning = false;
	if (was === "roster" && focus === "stage" && !returning && onView?.open && !onView.live) wake(onView.id, true);
	// Going to the Stage, by click or key, puts the Peek away: the pointer may still rest on the row it came from.
	if (was === "roster" && focus === "stage") {
		peek.dismissed = peek.spot?.id ?? null;
		peek.byKeys = false;
		if (roster.choosing) roster.choosing.menu = null;
	}
	syncStatus();
	apply();
}

async function handleCommand(cmd: string, argv: string[]): Promise<void> {
	switch (cmd) {
		case "focus":
			await syncFocus();
			break;
		case "terminal-focus": {
			const focused = argv[0] === "in";
			if (focused === terminalFocused) break;
			terminalFocused = focused;
			syncVisit();
			// Of several Decks, the one in use owns the colors every hosted program sees.
			if (focused && profile) post({ type: "colors", colors: profile });
			break;
		}
		case "layout":
			await panes.layout();
			break;
		case "view-swap":
		case "view-split":
			await syncFocus();
			if (!roster.settings) await changeView(cmd === "view-swap");
			break;
		case "roster":
			// Settings holds the roster beside the Stage; showing it, and with it the keyboard, still goes.
			if (argv[0] === "focus") await panes.showRoster(true);
			else if (argv[0] === "show") await panes.showRoster(false);
			else if (argv[0] === "hide") {
				if (!roster.settings) await panes.hideRoster();
			} else throw new Error(`roster: ${argv[0]}?`);
			break;
		case "stage":
			await panes.focusStage();
			break;
		case "shell":
			await syncFocus();
			if (!roster.settings) await toggleShell();
			break;
		case "key":
			await syncFocus();
			await prefixKey(argv[0] ?? "", argv[1]);
			break;
		case "help":
			await showHelp();
			break;
		// The UI server saw the pointer leave both the roster and its overlays, or a key typed elsewhere; it put away
		// what leaves with them, and stopped watching, on its way here.
		case "pointer-out":
			pointerOut();
			break;
		case "esc":
			for (const launch of launches) launch.keyboard = false;
			await panes.showRoster(true);
			apply();
			break;
		// The session on view taking me to another. One it launched a moment ago reaches this Deck with a later snapshot.
		case "show": {
			const [id = "", from, view] = argv;
			const deadline = Date.now() + 2000;
			while (!entries.has(id) && Date.now() < deadline) await Bun.sleep(50);
			const e = entries.get(id);
			if (!e) throw new Error(`no session ${id} on this Deck`);
			if (stage.staged !== from) throw new Error("the user has moved off this session; nothing switched");
			reveal(id);
			// Asking to be taken there means as much as clicking its row: a dormant one starts.
			roster.focusEntry(e);
			if (view !== undefined && view !== viewOf(e)) await showView(e, view as View);
			break;
		}
		// A key typed on a session's card, which only the keyboard on the Stage can type, means to use it.
		case "wake": {
			const { kind, id } = panes.applied;
			if (id !== null && (kind === "dormant" || kind === "exited" || kind === "failed")) wake(id, true);
			break;
		}
		default:
			throw new Error(`unknown deck command ${cmd}`);
	}
	tui.requestRender();
}

/** Shows or hides the shell beside, below, or in place of pi for the staged session's directory, and the keyboard follows it in and back out. */
async function toggleShell(): Promise<void> {
	const e = panes.applied.id === null ? undefined : entries.get(panes.applied.id);
	if (!e?.open) {
		toast("no open session on view", "info");
		return;
	}
	if (shellsAsked.delete(e.cwd)) return;
	if (shellsShown.delete(e.cwd)) {
		const inShell = focus === "stage" && focusedPane === shellShownIn();
		apply();
		if (inShell) await panes.focusStage();
		return;
	}
	if (snapshot?.shells[e.cwd]) showShell(e.cwd);
	else {
		const req = nextReq();
		shellsAsked.set(e.cwd, req);
		post({ type: "shell", req, dir: e.cwd });
	}
}

/** Shows a directory's shell, once it runs, with the keyboard in it. */
function showShell(dir: string): void {
	shellsShown.add(dir);
	apply();
	focusOnceShown(() => shellShownIn());
}

/** How many times the keyboard moved panes; a move asked for before the latest one is abandoned. */
let focusMoves = 0;

/**
 * Puts the keyboard on a pane once the Stage's pending changes have placed it, unless the keyboard moved meanwhile: a
 * key that went elsewhere after asking for this wins. Off a pane those changes closed, tmux moved it, not a key.
 */
function focusOnceShown(pane: () => string | null): void {
	const asked = focusMoves;
	const from = focusedPane;
	panes.queue(async () => {
		const target = pane();
		if (!target) return;
		if (
			asked !== focusMoves &&
			(await tmuxAsync(UI, "display", "-p", "-t", from, "#{pane_id}").then(
				() => true,
				() => false,
			))
		)
			return;
		await tmuxAsync(UI, "select-pane", ...(panes.narrow ? ["-Z"] : []), "-t", target).catch((error: Error) =>
			toast(`focus: ${error.message}`, "error"),
		);
	});
}

/**
 * `e` swaps pi and the Editor by what's showing, so an Editor that died comes back, and does nothing in split. `v` enters split with the keyboard on the Editor, and
 * leaves it for whichever pane had the keyboard.
 */
async function changeView(swap: boolean): Promise<void> {
	const e = panes.applied.id === null ? undefined : entries.get(panes.applied.id);
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
	else next = showing === "split" && focus === "stage" && focusedPane === stagePane ? "editor" : "agent";
	await showView(e, next);
}

/** The keyboard goes to the pane the view brought up, or stays in the shell; entering split, to the Editor, since that's what I split to look at. */
async function showView(e: Entry, next: View): Promise<void> {
	if (next !== "agent") {
		editorsAsked.delete(e.cwd);
		editorsLost.delete(e.cwd);
		if ((await requestEditor(e.cwd)) === null || panes.applied.id !== e.id) return;
	}
	if (next !== "editor" && !e.live) wake(e.id, focus === "stage");
	if (next === "split" && panes.width < SPLIT_FROM) toast(`split needs ${SPLIT_FROM} columns; showing ${harnessName(e.harness)}`, "info");
	// Leaving split from a shell replacing pi keeps the keyboard in the shell, wherever it lands.
	const inShell = next !== "split" && focus === "stage" && focusedPane === shellShownIn();
	const req = nextReq();
	localViews.set(e.id, { view: next, req });
	post({ type: "view", req, id: e.id, view: next });
	apply();
	focusOnceShown(() => (inShell && shellShownIn()) || stagePane);
}

// ── settings ────────────────────────────────────────────────────────────

/** Takes in a config read whole and valid: everything that reads config sees it at once, and the worker gets its copy. */
function applyLoaded(next: Loaded): void {
	const before = config;
	loaded = next;
	config = next.config;
	configError = null;
	post({ type: "config", config });
	if (JSON.stringify(before.rosterWidth) !== JSON.stringify(config.rosterWidth)) {
		// A new width is meant to show, over one dragged before it.
		panes.dragged = null;
		void panes.layout();
	}
	if (JSON.stringify(before.dirs) !== JSON.stringify(config.dirs)) post({ type: "dirs" });
	if (before.wakeOnHighlight !== config.wakeOnHighlight) scheduleHighlightWake();
	if (before.shellPosition !== config.shellPosition) apply();
	// biome-ignore lint/plugin: a Settings save, or a config.toml edit, writes it, once per change.
	if (before.operatorInstructions !== config.operatorInstructions) ensureOperatorDir(config.operatorInstructions);
	tui.requestRender();
}

/** config.toml again, after a change on disk: a valid one applies, an invalid one is reported and leaves the Deck as it was. */
function reloadConfig(): void {
	try {
		// biome-ignore lint/plugin: synchronous, so a Settings save can't land between this read and loaded.
		const next = readConfig();
		if (next.text === loaded.text && configError === null) return;
		applyLoaded(next);
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		configError = error;
		tui.requestRender();
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
		reloadConfig();
	}, 100);
});

/** config.toml in the Editor command, in a popup over the Deck, at a line. */
function openConfig(line: number | null): void {
	void deckClient().then(async (client) => {
		if (!client) return;
		const command = `exec ${config.editor} ${line === null ? "" : `+${line} `}${quote(configPath())}`;
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
	loaded: () => loaded,
	error: () => configError,
	save: (updated: Record<string, unknown>, reorder = false): string | null => {
		try {
			// biome-ignore lint/plugin: Settings shows what it saved on the frame after the key that saved it.
			applyLoaded(writeConfig(loaded, updated, reorder));
			return null;
		} catch (error) {
			if (error instanceof SwbError) return error.message;
			throw error;
		}
	},
	catalog: () => catalog,
	refresh: (models: boolean) => post({ type: "refresh", models }),
	open: openConfig,
	close: () => closeSettings(),
	help: () => void showHelp(),
	paint: { cursor: cursorLine, hover: hoverLine },
	message: (now: number, withConfigError: boolean) => roster.messageLine(now, null, withConfigError),
	requestRender: () => tui.requestRender(),
};

/** Settings fills the Deck: the roster zooms its own pane over the Stage, which keeps running underneath. */
function openSettings(): void {
	if (roster.settings) return;
	roster.dragging = null;
	if (stage.highlightTimer) clearTimeout(stage.highlightTimer);
	stage.highlightTimer = null;
	roster.enter({ kind: "settings", pane: new SettingsPane(settingsHost) });
	post({ type: "refresh", models: false });
	panes.zoomRoster(true);
	tui.requestRender();
}

function closeSettings(): void {
	if (!roster.settings) return;
	roster.leave();
	tui.requestRender();
}

/** A narrow Deck's roster is zoomed already, and stays so. */

// ── view state ──────────────────────────────────────────────────────────

function pickerState(): PickerState | null {
	const choosing = roster.choosing;
	if (!choosing) return null;
	const listed = roster.listed();
	const rows =
		choosing.mode === "pick"
			? roster
					.pickRows()
					.map((row) =>
						row.kind === "add"
							? { name: "+ add a directory…", path: null, worktree: false, dim: false }
							: { name: targetName(row.target), path: row.target.path, worktree: row.target.repo !== null, dim: row.context },
					)
			: roster.addRows().map((path) => ({ name: `${basename(path)}/`, path, worktree: false, dim: listed.has(path) }));
	return {
		mode: choosing.mode,
		input: (choosing.mode === "pick" ? roster.search : roster.path).getValue(),
		rows,
		choice: choosing.choice,
		confirm: choosing.confirm?.name ?? null,
		...(() => {
			const presets = pickerPresets();
			const labels = presetLabels(presets.map((c) => c.preset));
			const target = pickerTarget(choosing);
			const menu = choosing.menu;
			return {
				preset: labels[chosenPreset(choosing)] ?? null,
				harness: target !== null && typeof target !== "string" ? target.harness : null,
				presets: menuPresets("").map((i) => labels[i] as string),
				menu: menu && { query: menu.query, cursor: menu.cursor, shown: menuPresets(menu.query).map((i) => labels[i] as string) },
			};
		})(),
	};
}

/** An overlay as it's on screen, without its color: over the roster's lines, or floating. */
function overlayShown(id: string): { about: string; lines: string[] } | null {
	const o = roster.over.find((o) => o.id === id);
	return o ? { about: o.about, lines: o.view.lines.map((line) => Bun.stripANSI(line)) } : overlays.painted(id);
}

function viewState(): DeckState {
	const rows = roster.rows();
	const labels = new Map(rows.flatMap((row) => (row.kind === "header" && row.group !== null ? [[row.key, row.group]] : [])));
	const index = roster.resolveCursor(rows);
	const cursorRow = rows[index];
	const drop = roster.dragging?.moved ? roster.dragging.drop : null;
	const applied = panes.applied;
	const staged = applied.id === null ? undefined : entries.get(applied.id);
	return {
		deck,
		ready,
		terminalFocused,
		cursor: cursorRow?.kind === "session" ? cursorRow.entry.id : null,
		cursorRow: index,
		mode: roster.mode.kind,
		picker: pickerState(),
		archive: (() => {
			const e = roster.archiving === null ? undefined : entries.get(roster.archiving);
			if (!e) return null;
			const family = openDescendants(entries.values(), e.id);
			return { id: e.id, counts: Bun.stripANSI(familyTally(family)), all: family.length + 1 };
		})(),
		settings: roster.settings?.state() ?? null,
		configError: configError?.message ?? null,
		drop: drop ? { project: projectName(drop.header.project), group: drop.header.group } : null,
		filter: roster.query(),
		hover: roster.hover,
		peek: (() => {
			const shown = overlayShown("peek");
			return shown && peek.settled ? { id: shown.about, source: peek.settled.source, lines: shown.lines } : null;
		})(),
		launch: roster.choosing && {
			card: overlayShown("launch")?.lines ?? roster.card,
			menu: overlayShown("menu")?.lines ?? null,
		},
		focus:
			focus === "roster"
				? "roster"
				: focusedPane === shellShownIn()
					? "shell"
					: focusedPane === stagePane && editorShown(applied)
						? "editor"
						: "stage",
		staged: {
			id: applied.id,
			host: applied.host,
			kind: applied.kind,
			view: applied.view,
			savedView: staged ? viewOf(staged) : "agent",
		},
		layout: {
			width: panes.width,
			rosterOnly: panes.shownNarrow,
			split: panes.side !== null,
			shell: applied.shell?.at === "replace" ? "replace" : (panes.shellPane?.at ?? null),
			rosterHidden: panes.rosterHidden,
		},
		waking: launches.map((launch) => ({ id: launch.id, keyboardWaiting: launch.keyboard })),
		rows: rows.map((row) =>
			row.kind === "session"
				? {
						kind: "session",
						id: row.entry.id,
						title: displayName(row.entry),
						glyph: Bun.stripANSI(glyph(stateOf(row.entry), 0)),
						state: stateOf(row.entry),
						provisional: row.entry.provisional,
						group: labels.get(row.header) ?? null,
						level: levelOf(row.nest),
						origin: row.nest ? null : origin(row.entry),
						folded: row.folded,
						hidden: row.folded ? row.family.length : 0,
					}
				: row.kind === "header"
					? {
							kind: "header",
							project: projectName(row.project),
							group: row.group,
							expanded: !row.collapsed,
						}
					: { kind: "section", label: row.label, count: row.count, expanded: row.expanded },
		),
		colors,
		toasts: toasts.filter((t) => t.until > Date.now()).map((t) => ({ text: t.text, level: t.level })),
		perf: {
			render: perf.render.summary(),
			switchClient: perf.switchClient.summary(),
			keyToSwitch: perf.keyToSwitch.summary(),
			keyToFrame: perf.keyToFrame.summary(),
		},
	};
}

// ── main ────────────────────────────────────────────────────────────────

let frameKeyAt = 0;
const tui = new TuiAltScreen(new ProcessTerminal(), true, undefined, { mouse: true });
const roster = new Roster();
tui.setLayoutRoot(roster);
const overlays = new Overlays({
	pane: rosterPane,
	deck,
	failed: (message) => toast(message, "error"),
	left: () => {
		pointerOut();
		tui.requestRender();
	},
	changed: () => tui.requestRender(),
});
tui.setFocus(roster);
tui.start();
// Inside tmux pi-tui asks only for motion with a button down. The roster wants every motion, for the hover, the Peek,
// and the picker's highlight, and asking for it here is what makes tmux pass the pointer's motion to the UI server.
process.stdout.write("\x1b[?1003h");

// Like pi: query the colors, and again on every light/dark report (997). The roster starts before the Deck's
// client attaches, so the first query gets nothing; tmux sends a 997 on attach, and that query gets everything.
// The worker mirrors them into the sessions server, for the panes it hosts; see its mirror().
let profile: TerminalProfile | null = null;
async function queryColors(scheme: "light" | "dark" | null): Promise<void> {
	const { foreground, background, palette } = await tui.queryTerminalColors({ timeoutMs: 200 });
	cursorBg =
		background && foreground
			? {
					focused: mix(48, background, foreground, 0.2),
					unfocused: mix(48, background, foreground, 0.12),
					hover: mix(48, background, foreground, 0.06),
				}
			: null;
	const themeCyan = palette?.[6];
	breath =
		background && foreground && themeCyan ? { faint: lerp(background, themeCyan, 0.6), strong: lerp(themeCyan, foreground, 0.3) } : null;
	colors = { background: background ? hex(background as RgbColor) : null, scheme: scheme ?? colors.scheme };
	if (background && foreground) {
		// Before the terminal's first report, its scheme is guessed from the background, as tmux does.
		const guess = background.r + background.g + background.b > 382 ? "light" : "dark";
		profile = {
			foreground: hex(foreground),
			background: hex(background),
			palette: palette?.map(hex) ?? null,
			scheme: scheme ?? profile?.scheme ?? guess,
		};
		post({ type: "colors", colors: profile });
	}
	tui.requestRender();
}
tui.onTerminalColorSchemeChange((scheme) => void queryColors(scheme));
tui.setTerminalColorSchemeNotifications(true);
void queryColors(null);

// biome-ignore-start lint/plugin: before the roster's first frame, when nothing waits on its keys yet.
tmux(UI, "set", "-t", deck, "@swb_roster", rosterPane, ";", "set", "-p", "-t", rosterPane, "@swb_label", "swb");
focusedPane = rosterPane;
rmSync(sock, { force: true });
// biome-ignore-end lint/plugin: startup
// bun-types 1.4.4 leaves idleTimeout off unix servers, but Bun applies it to them, after 10 s by default.
// @ts-expect-error
Bun.serve({
	unix: sock,
	// The placeholder's card stream stays open, idle between cards, for as long as the Deck lives.
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname === "/state") return Response.json(viewState());
		if (req.method === "GET" && url.pathname === "/card") return cardStream();
		if (req.method === "POST" && url.pathname === "/cmd") {
			const body = await req.json();
			const { cmd, args: argv } = body;
			if (typeof cmd !== "string" || !Array.isArray(argv) || !argv.every((arg) => typeof arg === "string"))
				return new Response("expected {cmd: string, args: string[]}", { status: 400 });
			try {
				await handleCommand(cmd, argv);
			} catch (error) {
				return new Response((error as Error).message, { status: 400 });
			}
			return new Response("ok");
		}
		return new Response("not found", { status: 404 });
	},
});

post({ type: "init", deck, config, here });
post({ type: "dirs" });
if (args.new) newSession(args.new, null, null, args.harness ? asHarness(args.harness) : null);
void panes.layout();

function stageUp(ttys: string[]): void {
	panes.clientsUp(ttys);
	checkReady();
}

/** Ready once the first snapshot is in and the Stage's nested client is attached to the sessions server. */
function checkReady(): void {
	if (ready || snapshot === null || !panes.main.up) return;
	ready = true;
	mark("roster.ready");
	if (args.select) reveal(args.select);
	if (continueTo) roster.focusEntry(continueTo);
}

// Attached before it lists them, the control client hears every client that attaches after the list.
void ctl.run("list-clients -F '#{client_tty}'").then(
	(out) => stageUp(out.split("\n")),
	(error: Error) => toast(`stage: ${error.message}`, "error"),
);

let listingClients = false;
setInterval(() => {
	// The control client misses attaches while it respawns after the sessions server restarts.
	if (!listingClients && (!panes.main.up || (panes.side && !panes.side.up))) {
		listingClients = true;
		void ctl
			.run("list-clients -F '#{client_tty}'")
			.then(
				(out) => stageUp(out.split("\n")),
				() => {},
			)
			.finally(() => {
				listingClients = false;
			});
	}
	const now = Date.now();
	keepLayout(now);
	syncTitle();
	if (
		toasts.some((t) => t.until <= now) ||
		launches.length > 0 ||
		[...entries.values()].some((e) => e.activity === "blocked" || e.activity === "working")
	)
		tui.requestRender();
}, 100);
