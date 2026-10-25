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
	TuiAltScreen,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { harness as asHarness, configDir, type Harness, operatorDir, projectRoot, type SnoozePreset, VIEWS, type View } from "@swb/shared";
import { harnessName } from "@swb/shared/mailbox";
import { mark, span } from "@swb/shared/trace";
import type { Subprocess } from "bun";
import { ConfigError, configPath, type Loaded, readConfig } from "../config.ts";
import { type CutOff, displayName, openDescendants, projectName } from "../derive.ts";
import { completions, expandHome, type Target, type TargetTree, targetName } from "../dirs.ts";
import { SwbError, UsageError } from "../errors.ts";
import { type Catalog, type Choice, defaultLaunch, fromDefault, type LaunchTarget, presetLabels, shortlist } from "../harnesses.ts";
import { ensureOperatorDir } from "../operator.ts";
import { presetUntil } from "../schedules.ts";
import { loginShell, newer, nvimEditor, SWB } from "../sessions.ts";
import type { DeckLayout } from "../store.ts";
import { CLIENT_CWD, cleanEnv, quote, SESSIONS, tmux, tmuxAsync, tmuxBin, tmuxTry, UI } from "../tmux.ts";
import { VERSION } from "../version.ts";
import { writeConfig } from "../write-config.ts";
import { Control } from "./control.ts";
import {
	deckEnv,
	deckPaths,
	HELP_POPUP,
	NARROW_BELOW,
	placeholderName,
	removeDeckFiles,
	rosterCols,
	SPLIT_FROM,
	stageScript,
	writeAtomic,
	writeCard,
} from "./deck.ts";
import type {
	Card,
	DeckState,
	Entry,
	FromWorker,
	PeekInfo,
	PeekView,
	PickerState,
	Snapshot,
	State,
	StatSummary,
	TerminalProfile,
	ToWorker,
	Transcript,
} from "./protocol.ts";
import { SettingsPane } from "./settings.ts";
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
const [stagePane, stageTty] = tmux(UI, "display", "-p", "-t", rosterPane, "#{P:#{?#{==:#{pane_id},#{@swb_stage}},#{pane_id} #{pane_tty},}}")
	.trim()
	.split(" ") as [string, string];
if (!stagePane || !stageTty) throw new UsageError("__roster: its window names no Stage");
const paths = deckPaths(deck);
const placeholder = placeholderName(deck);
/** config.toml as this Deck last applied it; a file that fails to read leaves it be, and says so. */
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
	const [kind, tty] = line.split(" ");
	if (kind === "%client-session-changed" && tty) stageUp([tty]);
});

// ── model ───────────────────────────────────────────────────────────────

let snapshot: Snapshot | null = null;
let entries = new Map<string, Entry>();

/** A wake or new-session request: it resolves once a live entry is hosted by its tmux session. */
type Launch = { id: string | null; host: string | null; since: number; keyboard: boolean };
const launches: Launch[] = [];

let focus: "roster" | "stage" = "roster";
// No focus event has arrived when the Deck starts; the terminal that just launched it is assumed focused.
let terminalFocused = true;
/** A wide Deck's roster, broken out of the Stage's window so the Stage fills the terminal. */
let rosterHidden = false;
let narrow = false;
let deckWidth = 0;
/** A roster width set by dragging its border, which window resizes keep instead of roster_width. */
let draggedCols: number | null = null;
/** While swb itself moves or sizes the roster, its resizes aren't drags; sizings counts each start and end. */
let sizing = 0;
let sizings = 0;

async function sizingRoster(work: () => Promise<void>): Promise<void> {
	sizing++;
	sizings++;
	try {
		await work();
	} finally {
		sizing--;
		sizings++;
	}
}

function rosterWidth(): number {
	// A width dragged in a wider terminal, restored into this one, still leaves the Stage room.
	if (draggedCols !== null) return Math.max(20, Math.min(draggedCols, deckWidth - 21));
	return rosterCols(config.rosterWidth, deckWidth);
}
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

function launchFor(id: string): Launch | undefined {
	return launches.find((launch) => launch.id === id);
}

function isUnseen(e: Entry): boolean {
	return e.unseen && stage.watched !== e.id;
}

/** Views chosen in this Deck that the db doesn't reflect yet. */
const localViews = new Map<string, View>();

function viewOf(e: Entry): View {
	return localViews.get(e.id) ?? e.view;
}

/** Groups set here and not yet back in a snapshot; null is ungrouped. */
const localGroups = new Map<string, string | null>();

/** The Group a session carries, as set here or in the db; Operators take none. */
function groupOf(e: Entry): string | null {
	if (e.operator) return null;
	const local = localGroups.get(e.id);
	return local !== undefined ? local : e.group;
}

function setGroup(ids: string[], name: string | null): void {
	for (const id of ids) localGroups.set(id, name);
	post({ type: "group", ids, name });
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
	const base = phaseStatus(e);
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

type Applied = {
	kind: "live" | "loading" | "dormant" | "exited" | "failed" | "empty";
	id: string | null;
	/** pi's tmux session, when live. */
	host: string | null;
	/** What the Stage shows when pi isn't live. */
	card: Card | null;
	/** What is showing, which can differ from the session's saved view. */
	view: View;
	/** The Stage's first pane. */
	target: string;
	/** The Stage's second pane, which only split has. */
	side: string | null;
	/** The directory's shell, under pi. */
	below: string | null;
};

function onCard(kind: Applied["kind"], id: string | null, card: Card): Applied {
	return { kind, id, host: null, card, view: "agent", target: placeholder, side: null, below: null };
}

/** A pi still starting, on view so whatever it asks before it registers (a missing cwd, project trust) can be answered. */
function starting(id: string | null, host: string): Applied {
	return { kind: "loading", id, host: null, card: null, view: "agent", target: host, side: null, below: null };
}

function piShown(a: Applied): boolean {
	return a.kind === "live" && a.view !== "editor";
}

/** A nested client of the sessions server in one of the Stage's panes. */
type StageClient = { pane: string; tty: string; up: boolean };
const main: StageClient = { pane: stagePane, tty: "", up: false };
let side: (StageClient & { target: string }) | null = null;
/** The shell's pane, under whichever pane holds pi. It closes with its shell, so it needs no client tracking. */
let below: { pane: string; target: string; parent: string } | null = null;

const EMPTY: Card = { head: [], lines: ["Nothing selected."], turns: [], tail: [], ending: null, agent: "" };

const stage = {
	/** The session on the Stage, or the pending new session (id null) when `new` is starting. */
	staged: null as string | null,
	stagedAt: 0,
	/** A session whose pi quit or failed while on view: a card until `w` or Enter. */
	ended: null as { id: string; failed: boolean; lines: string[] } | null,
	/** While `new` starts, the Stage holds on its loading card until the cursor is moved. */
	holdForNew: false,
	applied: onCard("empty", null, EMPTY),
	cardJson: "",
	watched: null as string | null,
	visited: false,
	visitTimer: null as Timer | null,
	highlightTimer: null as Timer | null,
	keyAt: 0,
};

const rosterOffScreen = () => narrow || rosterHidden;

let statusShown = false;
let statusOps = Promise.resolve();
/** While the Stage fills the Deck, its status line carries the click that brings the roster back. */
function syncStatus(): void {
	const want = rosterHidden || (narrow && focus === "stage");
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
	if (e.live && e.host) return { kind: "live", id: e.id, host: e.host, card: null, view: "agent", target: e.host, side: null, below: null };
	const launch = launchFor(e.id);
	if (launch?.host) return starting(e.id, launch.host);
	if (launch) return onCard("loading", e.id, card(e, launch.keyboard && rosterOffScreen() ? [ESC_LINE] : []));
	return onCard("dormant", e.id, card(e));
}

/** The session's own view, as far as it can show, and its directory's shell when this Deck shows it. */
function desired(): Applied {
	const d = viewed();
	const e = d.id === null ? undefined : entries.get(d.id);
	const shell = e?.open && !narrow && shellsShown.has(e.cwd) ? snapshot?.shells[e.cwd] : undefined;
	return shell ? { ...d, below: shell } : d;
}

/** Directories whose shell this Deck shows; a shell that exits leaves the set. */
const shellsShown = new Set<string>();
const shellWaits = new Map<string, (name: string | null) => void>();

function requestShell(dir: string): Promise<string | null> {
	const existing = snapshot?.shells[dir];
	if (existing) return Promise.resolve(existing);
	return new Promise((resolve) => {
		shellWaits.set(dir, resolve);
		post({ type: "shell", dir });
	});
}

/** Split needs pi live and a wide Deck, and both need the Editor. */
function viewed(): Applied {
	const d = piStage();
	const e = d.id === null ? undefined : entries.get(d.id);
	const editor = e?.open ? snapshot?.editors[e.cwd] : undefined;
	if (!e || !editor) return d;
	const view = viewOf(e);
	if (view === "editor") return { ...d, view, target: editor };
	if (view === "split" && d.host && deckWidth >= SPLIT_FROM) return { ...d, view, target: editor, side: d.host };
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

/** Every change to the Stage's panes and clients, in order. */
let stageOps = Promise.resolve();
let focusReads = Promise.resolve();

function switchStage(client: StageClient, target: string, force: boolean): void {
	const keyAt = stage.keyAt;
	stage.keyAt = 0;
	stageOps = stageOps.then(async () => {
		if (!client.up && !force) return;
		const t0 = performance.now();
		try {
			await ctl.run(`switch-client -c ${quote(client.tty)} -t ${quote(`=${target}`)}`);
			perf.switchClient.add(performance.now() - t0);
			if (keyAt > 0) perf.keyToSwitch.add(performance.now() - keyAt);
		} catch {
			// A Stage client re-attaches to its target file whenever it drops.
		}
	});
}

/** Creates, retargets, or kills the Stage's second pane to match what is applied. Leaving it keeps the keyboard on the Stage. */
function syncSide(): void {
	stageOps = stageOps.then(async () => {
		const want = stage.applied.side;
		try {
			if (want === null) {
				if (!side) return;
				const { pane } = side;
				side = null;
				await tmuxAsync(UI, "kill-pane", "-t", pane);
				if (focusedPane === pane) await tmuxAsync(UI, "select-pane", "-t", stagePane);
				return;
			}
			if (side?.target === want) return;
			writeAtomic(paths.side, want);
			if (side) {
				side.target = want;
				if (side.up) await ctl.run(`switch-client -c ${quote(side.tty)} -t ${quote(`=${want}`)}`);
				return;
			}
			const created = await tmuxAsync(
				UI,
				...["split-window", "-h", "-d", "-l", "35%", "-t", stagePane, "-P", "-F", "#{pane_id}\t#{pane_tty}"],
				...deckEnv(),
				stageScript(deck, paths.side),
			);
			const [pane, tty] = created.split("\t") as [string, string];
			side = { pane, tty, up: false, target: want };
		} catch (error) {
			toast(`split: ${(error as Error).message}`, "error");
		}
	});
}

/** Creates or kills the shell's pane to match what is applied, under pi's pane; leaving it keeps the keyboard where it is. */
function syncBelow(): void {
	stageOps = stageOps.then(async () => {
		const want = stage.applied.below;
		const parent = side?.pane ?? stagePane;
		try {
			if (below && (want !== below.target || parent !== below.parent)) {
				const { pane } = below;
				below = null;
				// Ctrl-D in the shell already closed it.
				await tmuxAsync(UI, "kill-pane", "-t", pane).catch(() => {});
				if (focusedPane === pane) await tmuxAsync(UI, "select-pane", "-t", parent);
			}
			if (want === null || below) return;
			writeAtomic(paths.below, want);
			const created = await tmuxAsync(
				UI,
				...["split-window", "-v", "-d", "-l", "50%", "-t", parent, "-P", "-F", "#{pane_id}"],
				...deckEnv(),
				stageScript(deck, paths.below, true),
			);
			below = { pane: created, target: want, parent };
		} catch (error) {
			toast(`shell: ${(error as Error).message}`, "error");
		}
	});
}

/** The labels the Stage's panes wear on their top edges, as last set. */
let labels = "";

/** Names each of the Stage's panes after what it shows, once any pane split or killed ahead of it is in place. */
function syncLabels(): void {
	const a = stage.applied;
	let harness: string = newLaunch() ? "new" : "empty";
	if (a.id !== null) {
		const e = entries.get(a.id);
		if (!e) throw new Error(`the Stage applied ${a.id}, which has no entry`);
		harness = e.harness;
	}
	stageOps = stageOps.then(async () => {
		const want: [string, string][] = [[stagePane, a.view === "agent" ? harness : "editor"]];
		if (side) want.push([side.pane, harness]);
		if (below) want.push([below.pane, "shell"]);
		const key = JSON.stringify(want);
		if (key === labels) return;
		// One command per pane: a shell's pane closes with its shell, ahead of the apply that forgets it.
		const results = await Promise.allSettled(want.map(([pane, label]) => tmuxAsync(UI, "set", "-p", "-t", pane, "@swb_label", label)));
		const failed = results.flatMap((r) => (r.status === "rejected" && !String(r.reason).includes("can't find pane") ? [r.reason] : []));
		// Only labels that took are remembered, so the next apply tries the rest again.
		labels = failed.length === 0 ? key : "";
		for (const error of failed) toast(`label: ${(error as Error).message}`, "error");
	});
}

/** Ctrl-hjkl reach an nvim Editor in the pane showing it; nvim hands moves off its own edge back through `swb __nav`. */
function tagEditor(on: boolean): void {
	stageOps = stageOps.then(() =>
		tmuxAsync(UI, "set", "-p", "-t", stagePane, ...(on ? ["@swb_editor", "1"] : ["-u", "@swb_editor"])).then(
			() => {},
			(error: Error) => toast(`editor: ${error.message}`, "error"),
		),
	);
}

function writeStageCard(d: Applied): void {
	if (!d.card || d.target !== placeholder) return;
	const json = JSON.stringify(d.card);
	if (json === stage.cardJson) return;
	stage.cardJson = json;
	writeCard(paths, d.card);
}

function apply(): void {
	const d = desired();
	span("roster.card", () => writeStageCard(d));
	const prev = stage.applied;
	stage.applied = d;
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
	// A pane coming or going moves the Stage's panes out from under the Peek; render puts it back.
	if (d.side !== prev.side || d.below !== prev.below) closePeek();
	if (d.side !== prev.side || d.side !== (side?.target ?? null)) syncSide();
	if (d.below !== (below?.target ?? null) || d.side !== prev.side) syncBelow();
	if (nvimEditor(config.editor) && (d.view !== "agent") !== (prev.view !== "agent")) tagEditor(d.view !== "agent");
	syncLabels();
	if (d.target === prev.target) return;
	writeAtomic(paths.target, d.target);
	switchStage(main, d.target, false);
}

function watching(): string | null {
	const a = stage.applied;
	if (!terminalFocused || focus !== "stage" || !piShown(a)) return null;
	if (a.view === "split" && focusedPane === stagePane) return null;
	return a.id;
}

/** A Visit is pi focused on a focused Deck's Stage for 1 s; passing over a session in the roster isn't one. */
function syncVisit(): void {
	const id = watching();
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
		tui.requestRender();
	}, VISIT_MS);
}

function stageSession(id: string): void {
	if (stage.staged === id) return;
	stage.staged = id;
	stage.stagedAt = Date.now();
	if (stage.ended?.id !== id) stage.ended = null;
	editorsAsked.clear();
	editorsLost.clear();
	const e = entries.get(id);
	if (e && !e.live && e.transcript) post({ type: "transcript", id, path: e.transcript, harness: e.harness });
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
	launches.push({ id, host: null, since: Date.now(), keyboard });
	post({ type: "wake", id });
	apply();
}

/** A new session on `target`; with none, the worker picks `harness`'s first preset, or the default, once it knows what can start. */
function newSession(cwd: string, group: string | null, target: LaunchTarget | null, harness: Harness | null = null): void {
	if (newLaunch()) {
		toast("a new session is already starting", "info");
		return;
	}
	launches.push({ id: null, host: null, since: Date.now(), keyboard: true });
	stage.holdForNew = true;
	stage.staged = null;
	stage.ended = null;
	post({ type: "new", cwd, group, target, harness });
	apply();
	void focusStage();
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
		launches.splice(launches.indexOf(launch), 1);
		const lastWords = snapshot.died[launch.host] ?? [];
		if (launch.id !== null && stage.staged === launch.id) stage.ended = { id: launch.id, failed: true, lines: lastWords };
		else toast(lastWords.length > 0 ? `the session failed to start: ${lastWords.at(-1)}` : "the session failed to start", "error");
		if (launch.id === null && stage.staged === null) stage.staged = roster.cursorEntry()?.id ?? null;
		if (focus === "stage") void focusRoster();
	}
}

/** Whatever the Stage's host now runs is what's selected: `/new` or `/resume` inside pi moves the selection with it. */
function followHost(): void {
	const { id, host } = stage.applied;
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
	stage.ended = { id, failed: false, lines: [] };
	if (focus === "stage") void focusRoster();
}

/** The cursor the last Deck in this Project left, until the first snapshot places it. */
let restoredKey: string | null = null;
let started = false;
/** `-c`: the session whose pi takes the keyboard once the Stage is up. */
let continueTo: Entry | null = null;

/**
 * Where the first snapshot puts the cursor: `swb open`'s session, `-c`'s most recent session here, where the last Deck in
 * this Project left it, else the session I last visited. Only `-c` takes the keyboard.
 */
function startCursor(): void {
	started = true;
	if (args.select || args.new) return;
	// A snoozed session is out of the way until it wakes: neither -c nor the last visit lands on one.
	const open = [...entries.values()].filter((e) => e.open && !e.provisional && !e.snoozed);
	if (args.continue) {
		const root = projectRoot(here);
		const recent = open
			.filter((e) => e.project === root)
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
		rosterCols: draggedCols,
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
	for (const [id, view] of localViews) if (entries.get(id)?.view === view) localViews.delete(id);
	for (const [id, name] of localGroups) {
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
	if (e && !e.live && e.transcript && !transcripts.has(e.id))
		post({ type: "transcript", id: e.id, path: e.transcript, harness: e.harness });
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
			if (message.layout) {
				roster.collapsed = new Set(message.layout.collapsed);
				roster.expanded = new Set(message.layout.expanded.flatMap((saved) => SECTION_KEYS.filter((key) => key === saved)));
				draggedCols = message.layout.rosterCols;
				restoredKey = message.layout.selectedKey;
				void layout();
			}
			break;
		case "snapshot":
			onSnapshot(message.snapshot);
			break;
		case "woke": {
			const launch = launchFor(message.id);
			if (launch) launch.host = message.host;
			apply();
			break;
		}
		case "created": {
			const launch = newLaunch();
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
		case "toggled":
			if (message.error === null) {
				if (roster.pin) roster.pin.answered = true;
				break;
			}
			roster.pin = null;
			toast(message.error, "error");
			break;
		case "stopped":
			if (message.error !== null) toast(message.error, "error");
			break;
		case "launchFailed": {
			const index = launches.findIndex((launch) => launch.id === message.id && launch.host === null);
			if (index !== -1) launches.splice(index, 1);
			toast(message.text, "error");
			apply();
			break;
		}
		case "editor":
			settleEditorWaits(message.dir, message.name);
			if (message.text) toast(`editor: ${message.text}`, "error");
			break;
		case "shell":
			shellWaits.get(message.dir)?.(message.name);
			shellWaits.delete(message.dir);
			if (message.text) toast(`shell: ${message.text}`, "error");
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
		case "groupFailed":
			localGroups.clear();
			toast(`group: ${message.text}`, "error");
			apply();
			break;
		case "viewFailed":
			localViews.delete(message.id);
			toast(`view: ${message.text}`, "error");
			apply();
			break;
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

const ARCHIVE_PROMPT_LINES = 4;

class Roster implements Component, Focusable {
	selectedKey = "";
	lastIndex = 0;
	/** After `a`, the cursor keeps its index instead of chasing the session into its new section. */
	pin: { index: number; answered: boolean } | null = null;
	/** The session whose archive prompt is open beneath its row: it started others still open. */
	archiving: string | null = null;
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
		for (const input of [this.filter, this.name, this.search, this.path]) input.focused = on;
	}
	filter = new Input({ prompt: "/ " });
	filtering = false;
	name = new Input({ prompt: "> " });
	/** `m`'s picker: the sessions it moves, the Group header it started on, and the highlighted choice. */
	naming: { ids: string[]; header: HeaderRow | null; project: string; title: string; choice: number } | null = null;
	/** `s`'s menu for a session: how long to snooze it. */
	snoozing: { id: string; title: string; choice: number } | null = null;
	/** The directory picker, `n` and `N`, which takes over the whole roster while it's open. */
	choosing: Choosing | null = null;
	/** Settings, which takes over the whole Deck while it's open. */
	settings: SettingsPane | null = null;
	search = new Input({ prompt: "/ " });
	pickerTop = 0;
	completed: { typed: string; rows: string[] } | null = null;
	path = new Input({ prompt: "" });
	/** A session being dragged by the mouse; `moved` once the pointer has left its row. */
	dragging: { id: string; moved: boolean; drop: Drop } | null = null;
	/** The session row under the pointer. A key clears it until the pointer moves again, and so does the pointer leaving. */
	hover: string | null = null;
	/** Where the pointer rests, which lights the control under it; null after a key or once it leaves. */
	pointer: { x: number; y: number } | null = null;
	/** A narrow Deck's Peek, as the last render drew it. */
	inline: InlinePeek | null = null;
	listTop = 0;
	listHeight = 0;
	/** What a click does, by row and column range, as of the last render. */
	targets: ClickTarget[] = [];
	pressed: ClickTarget | null = null;

	constructor() {
		this.filter.onSubmit = () => {
			this.filtering = false;
		};
		this.filter.onEscape = () => {
			this.filter.setValue("");
			this.filtering = false;
		};
		this.name.onEscape = () => {
			this.naming = null;
		};
	}

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
		const open = all.filter((e) => e.open);
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
			open.filter((e) => sectionOf(e) === "open"),
			0,
			"open",
		);
		const idle = open.filter((e) => sectionOf(e) === "inactive");
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
		const archived = all.filter((e) => !e.open).sort((a, b) => archivedKey(b) - archivedKey(a));
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
		stage.keyAt = performance.now();
		frameKeyAt = stage.keyAt;
		toasts = [];
		if (this.settings) {
			this.settings.handleInput(data);
			stage.keyAt = 0;
			tui.requestRender();
			return;
		}
		if (this.choosing) {
			this.pickerInput(data);
			stage.keyAt = 0;
			tui.requestRender();
			return;
		}
		if (this.snoozing) {
			const k = decodeKittyPrintable(data) ?? data;
			if (matchesKey(data, "up") || k === "k") this.snoozing.choice = Math.max(0, this.snoozing.choice - 1);
			else if (matchesKey(data, "down") || k === "j") this.snoozing.choice = Math.min(SNOOZE_CHOICES.length - 1, this.snoozing.choice + 1);
			else if (matchesKey(data, "enter")) this.finishSnooze((SNOOZE_CHOICES[this.snoozing.choice] as { snooze: SnoozePreset }).snooze);
			else if (matchesKey(data, "escape") || k === "q" || k === "s") this.snoozing = null;
			stage.keyAt = 0;
			tui.requestRender();
			return;
		}
		if (this.archiving !== null) {
			const k = decodeKittyPrintable(data) ?? data;
			if (k === "a" || k === "A") this.finishArchiving(k === "A");
			else if (matchesKey(data, "escape")) this.finishArchiving(null);
			stage.keyAt = 0;
			tui.requestRender();
			return;
		}
		if (this.naming) {
			const choices = this.choices();
			if (matchesKey(data, "up") || matchesKey(data, "down")) {
				const step = matchesKey(data, "up") ? -1 : 1;
				this.naming.choice = Math.max(0, Math.min(choices.length - 1, this.naming.choice + step));
			} else if (matchesKey(data, "enter")) {
				const choice = choices[this.naming.choice];
				if (choice) this.finishNaming(choice.name);
			} else {
				this.name.handleInput(data);
				if (this.naming) this.naming.choice = 0;
			}
			stage.keyAt = 0;
			tui.requestRender();
			return;
		}
		if (this.filtering) {
			if (matchesKey(data, "up") || matchesKey(data, "down")) this.move(matchesKey(data, "up") ? -1 : 1);
			else {
				this.filter.handleInput(data);
				const rows = this.rows();
				const first = rows.find((r) => r.kind === "session");
				if (first && !rows.some((r) => r.kind === "session" && r.key === this.selectedKey)) this.selectedKey = first.key;
			}
			this.syncStage(true);
			stage.keyAt = 0;
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
		else if (k === "a") this.toggleArchived();
		else if (k === "s") this.toggleSnooze();
		else if (k === "p") this.toParent();
		else if (k === "y" || k === "Y") this.copy(k === "y");
		else if (k === "n") this.newAt();
		else if (k === "N") this.openPicker("add", null, null);
		else if (k === "/") this.filtering = true;
		else if (k === "m") this.startNaming();
		else if (k === ",") openSettings();
		else if (k === "O" && configError) openConfig(configError.line);
		else if (k === "?") void showHelp();
		this.syncStage(true);
		stage.keyAt = 0;
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
			const listRow = this.pickerTop + event.y - PICKER_TOP;
			if (event.type === "move") {
				if (this.choosing.confirm || event.y < PICKER_TOP || event.y >= PICKER_TOP + this.listHeight)
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
				target?.act();
			}
			return { handled: true, render: true };
		}
		if (event.type === "move") {
			const inline = this.inline;
			// On a narrow Deck's Peek, the pointer is still on the Peek's row.
			const onPeek = inline && event.x >= inline.left && event.y >= inline.top && event.y < inline.top + inline.view.lines.length;
			const row = this.rowAt(event.y);
			const hover = onPeek ? inline.id : row?.kind === "session" ? row.key : null;
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
		this.filtering = false;
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
			rosterHidden ||
			(narrow && focus !== "roster") ||
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

	/**
	 * A narrow Deck's Peek, drawn over the roster's own lines at the right edge, as out of the way as it can be. Its
	 * buttons are click targets ahead of everything beneath it, and the rest of it swallows clicks.
	 */
	drawPeek(lines: string[], rows: Row[], spot: PeekSpot, width: number, height: number): InlinePeek | null {
		const row = rows.find((r) => r.key === spot.id);
		if (row?.kind !== "session" || width < PEEK_MIN_COLS) return null;
		const w = Math.max(PEEK_MIN_COLS, Math.min(PEEK_COLS, width - 16));
		const view = peekView(row, w, height, "right");
		const top = Math.max(0, Math.min(spot.y - 1, height - view.lines.length));
		const left = width - w;
		const p = this.pointer;
		const hot = view.buttons.find((b) => p?.y === top + b.y && p.x >= left + b.from && p.x < left + b.to);
		view.lines.forEach((line, i) => {
			lines[top + i] = `${truncateToWidth(lines[top + i] ?? "", left, "", true)}\x1b[0m${hot && hot.y === i ? hot.hot : line}`;
		});
		this.targets.unshift(
			...view.buttons.map((b) => ({ y: top + b.y, from: left + b.from, to: left + b.to, act: () => void prefixKey(b.key, b.id) })),
			...view.lines.map((_, i) => ({ y: top + i, from: left, to: width, act: () => {} })),
		);
		return { ...spot, view, top, left };
	}

	rowAt(y: number): Row | undefined {
		if (y < this.listTop || y >= this.listTop + this.listHeight) return undefined;
		return this.rows()[this.scrollTop + (y - this.listTop)];
	}

	move(delta: number): void {
		peek.byKeys = true;
		const rows = this.rows();
		if (rows.length === 0) return;
		const index = this.resolveCursor(rows);
		const next = Math.max(0, Math.min(rows.length - 1, index + delta));
		this.selectedKey = (rows[next] as Row).key;
		this.lastIndex = next;
		stage.holdForNew = false;
	}

	/** Moves to the next session row in that direction, if there is one. */
	moveSession(delta: number): void {
		const rows = this.rows();
		for (let i = this.resolveCursor(rows) + delta; i >= 0 && i < rows.length; i += delta) {
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
		void focusStage();
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

	/** x: the counterpart to w. Frees the process and keeps the session open; any unsent prompt is saved as a draft. */
	stop(row = this.selected()): void {
		const e = row?.kind === "session" ? row.entry : null;
		if (!e) return;
		if (!e.live) toast("not running", "info");
		else post({ type: "stop", id: e.id });
	}

	/** a: archives or unarchives the session; one that started others still open asks first whether they go too. */
	toggleArchived(row = this.selected()): void {
		if (row?.kind !== "session" || this.pin) return;
		const e = row.entry;
		if (e.provisional) {
			toast("nothing to archive before the first prompt", "error");
			return;
		}
		if (e.open && openDescendants(entries.values(), e.id).length > 0) {
			this.selectedKey = e.id;
			this.hover = null;
			this.archiving = e.id;
			return;
		}
		// Only the cursor's own row moving takes the cursor along.
		if (row.key === this.selected()?.key) this.pin = { index: this.resolveCursor(this.rows()), answered: false };
		post(e.open ? { type: "archive", ids: [e.id] } : { type: "unarchive", id: e.id });
	}

	/** The archive prompt's answer: the session alone, all it started besides, or (null) neither. */
	finishArchiving(all: boolean | null): void {
		const e = this.archiving === null ? undefined : entries.get(this.archiving);
		this.archiving = null;
		if (!e || all === null) return;
		this.pin = { index: this.resolveCursor(this.rows()), answered: false };
		post({ type: "archive", ids: [e.id, ...(all ? openDescendants(entries.values(), e.id).map((d) => d.id) : [])] });
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

	/** s: unsnoozes a snoozed session, or asks how long to snooze an open one. */
	toggleSnooze(row = this.selected()): void {
		if (row?.kind !== "session" || this.pin) return;
		const e = row.entry;
		if (!e.open) toast("archived; unarchive it first", "info");
		else if (e.provisional) toast("nothing to snooze before the first prompt", "error");
		else if (e.snoozed) {
			if (row.key === this.selected()?.key) this.pin = { index: this.resolveCursor(this.rows()), answered: false };
			post({ type: "snooze", id: e.id, snooze: "off" });
		} else {
			this.filtering = false;
			this.naming = null;
			this.snoozing = { id: e.id, title: displayName(e), choice: 0 };
		}
	}

	finishSnooze(snooze: SnoozePreset): void {
		const snoozing = this.snoozing;
		this.snoozing = null;
		if (!snoozing) return;
		// As with archive, the cursor keeps its place rather than following the row into Snoozed.
		if (this.selected()?.key === snoozing.id) this.pin = { index: this.resolveCursor(this.rows()), answered: false };
		post({ type: "snooze", id: snoozing.id, snooze });
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
		this.filtering = false;
		this.name.setValue("");
		if (row?.kind === "session" && row.entry.operator) toast("Operators don't take Groups", "info");
		else if (row?.kind === "session") {
			const group = groupOf(row.entry);
			const project = row.entry.project;
			this.naming = { ids: [row.entry.id], header: null, project, title: displayName(row.entry), choice: 0 };
			this.naming.choice = Math.max(
				0,
				this.choices().findIndex((c) => c.name === group),
			);
		} else if (row?.kind === "header" && row.group !== null) {
			const name = row.group;
			const ids = [...entries.values()].filter((e) => e.project === row.project && groupOf(e) === name).map((e) => e.id);
			this.naming = { ids, header: row, project: row.project, title: name, choice: 0 };
			this.naming.choice = Math.max(
				0,
				this.choices().findIndex((c) => c.name === name),
			);
		} else toast("m picks a session's Group, or renames a Group", "info");
	}

	/** No Group when nothing is typed, then the Project's Groups matching what is, then a new one unless one matches exactly. */
	choices(): { label: string; name: string | null }[] {
		const naming = this.naming;
		if (!naming) return [];
		const typed = this.name.getValue().trim();
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
		const title = ` ${naming.header ? "rename" : "Group for"} ${naming.title} `;
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
		this.naming = null;
		if (!naming) return;
		setGroup(naming.ids, name);
		// A renamed Group's header moves to its new key, and the cursor goes with it.
		if (naming.header) this.selectedKey = name === null ? naming.header.projectKey : `${naming.header.projectKey}:g:${name}`;
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
		this.filtering = false;
		this.search.setValue("");
		this.path.setValue("");
		this.pickerTop = 0;
		this.completed = null;
		this.choosing = {
			mode,
			opened: mode,
			choice: mode === "add" ? typedChoice("") : 0,
			from,
			group,
			pin: from,
			confirm: null,
			preset: 0,
		};
		// The last list shows at once; the worker's fresh one replaces it when its scan lands.
		post({ type: "dirs" });
		if (mode === "pick")
			this.choosing.choice = Math.max(
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
		this.choosing = null;
	}

	pickerInput(data: string): void {
		const choosing = this.choosing as Choosing;
		if (choosing.confirm) {
			const k = decodeKittyPrintable(data) ?? data;
			if (k === "y" || matchesKey(data, "enter")) this.finishRemove(true);
			else if (k === "n" || matchesKey(data, "escape")) this.finishRemove(false);
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
			// Tab picks what runs the new session; in add mode it completes the path instead.
			const step = matchesKey(data, "shift+tab") ? -1 : 1;
			const count = pickerPresets().length;
			if (count > 0) choosing.preset = (((choosing.preset + step) % count) + count) % count;
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
		// The picker's detail is its path and two blank lines.
		const bodyHeight = Math.max(1, height - 10);
		const lines = [
			` ${bold(adding ? "add a directory" : "new session in")}`,
			this.presetRow(1, width),
			` ${input}`,
			gray("─".repeat(width)),
		];
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
			// The remove prompt is modal: only its own answers are buttons.
			if (!act || choosing.confirm) return;
			const y = PICKER_TOP + i;
			// The cursor row's ✕, at its right edge, removes it.
			if (!adding && top + i === choosing.choice && this.pickRows()[choosing.choice]?.kind === "target")
				this.targets.push({ y, from: width - 3, to: width, act: () => this.askRemove() });
			this.targets.push({ y, from: 0, to: width, act });
		});
		const out = shown.map(([line]) => line);
		while (out.length < bodyHeight) out.push("");
		if (choosing.confirm) overlayConfirm(out, width, choosing.confirm, (yes) => this.finishRemove(yes), this.targets);
		lines.push(...out, gray("─".repeat(width)), detail, "", "", this.messageLine(Date.now()));
		// The remove prompt carries its own keys.
		const hints: Hint[] = choosing.confirm
			? []
			: adding
				? [
						["⇥", "complete", () => this.pickerInput("\t")],
						["⏎", "start", () => this.pickerInput("\r")],
						["esc", choosing.opened === "pick" ? "back" : "cancel", () => this.pickerInput("\x1b")],
					]
				: [
						["⏎", "start", () => this.pickerInput("\r")],
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
			this.inline = null;
			return this.settings.render(width, height);
		}
		if (this.choosing) {
			syncPeek(wantPeek(null));
			this.inline = null;
			return this.renderPicker(width, height);
		}
		const now = Date.now();
		const rows = this.rows();
		const index = this.resolveCursor(rows);
		this.targets = [];
		// A wide Deck's Peek says what the session is; the narrow one's roster has no Stage beside it to show one.
		const detailLines = narrow ? 3 : 1;
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
			this.hints(this.listTop + bodyHeight + 1 + detailLines + 1),
		);
		// A wide Deck's Peek is a popup over the Stage; a narrow Deck has no Stage beside the roster, so the roster draws it.
		const spot = wantPeek(this.peekSpot(rows, index));
		syncPeek(narrow ? null : spot);
		this.inline = narrow && spot ? this.drawPeek(lines, rows, spot, width, height) : null;
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
				act: () => {
					this.naming = null;
					this.snoozing = null;
				},
			});
		// The archive prompt opens beneath its row, pushing the rows after it down; its row is the cursor's.
		const asking = this.archiving === null ? -1 : rows.findIndex((r) => r.key === this.archiving);
		if (asking === -1) this.archiving = null;
		const prompt = asking === -1 ? 0 : ARCHIVE_PROMPT_LINES;
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

	/** The archive prompt, under the row of a session that started others still open: what they're doing, then the choice. */
	archivePrompt(e: Entry, width: number, top: number): string[] {
		const inner = Math.max(1, width - 4);
		const family = openDescendants(entries.values(), e.id);
		const box = (text: string) => ` │${truncateToWidth(text, inner, "…", true)}│`;
		const choice = this.clickable(top + 2, [
			[" │ Archive  ", null],
			[key("a", "this"), () => this.finishArchiving(false)],
			["  ", null],
			[key("A", `all ${family.length + 1}`), () => this.finishArchiving(true)],
			["  ", null],
			[key("esc", "abort"), () => this.finishArchiving(null)],
		]);
		return [
			` ┌${"─".repeat(inner)}┐`,
			box(` ${familyTally(family)}`),
			`${truncateToWidth(choice, inner + 2, "…", true)}│`,
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
		if (!e) return narrow ? ["", "", ""] : [""];
		let tabs = "";
		if (stage.staged === e.id && e.open) {
			const parts: [string, (() => void) | null][] = [[" ", null]];
			for (const view of VIEWS) {
				// The first view is the session's own TUI, whichever harness that is.
				const label = ` ${view === "agent" ? e.harness : view} `;
				parts.push([view === stage.applied.view ? cursorLine(label, true) : gray(label), () => void showView(e, view)]);
			}
			// The shell is a toggle beside the views, not one of them.
			if (!narrow)
				parts.push([gray(" · "), null], [stage.applied.below ? cursorLine(" shell ", true) : gray(" shell "), () => void toggleShell()]);
			tabs = this.clickable(narrow ? top + 2 : top, parts);
		}
		if (!narrow) return [truncateToWidth(tabs, width, "…")];
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
	hints(y: number): string {
		// The archive prompt carries its own keys.
		if (this.archiving !== null) return "";
		if (this.filtering) return ` ${this.filter.render(Math.max(10, rosterWidth() - 2))[0] ?? ""}`;
		if (this.naming) return ` ${this.name.render(Math.max(10, rosterWidth() - 2))[0] ?? ""}`;
		if (this.snoozing)
			return this.clickable(y, [
				[" ", null],
				[key("⏎", "snooze"), () => this.finishSnooze((SNOOZE_CHOICES[this.snoozing?.choice ?? 0] as { snooze: SnoozePreset }).snooze)],
				[" ", null],
				[
					key("esc", "cancel"),
					() => {
						this.snoozing = null;
					},
				],
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
		if (focus === "stage" && stage.applied.target === placeholder)
			hints = [
				["esc", "list", () => void focusRoster()],
				[`${config.prefix} ?`, "keys", help[2]],
			];
		else if (focus === "stage")
			hints = [
				[`${config.prefix} h`, "list", () => void focusRoster()],
				[`${config.prefix} z`, "hide list", () => void setRosterHidden(true)],
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
		if (focus === "roster" && width([...hints, settings]) <= rosterWidth()) hints.push(settings);
		return this.clickable(
			y,
			hints.flatMap(([name, label, act]): [string, (() => void) | null][] => [
				[" ", null],
				[key(name, label), act],
			]),
		);
	}

	/** n's presets, in a row of their own: the current one bright, the rest dim, scrolled to keep it in view. Each is a button. */
	presetRow(y: number, width: number): string {
		const choosing = this.choosing as Choosing;
		const presets = pickerPresets();
		if (presets.length === 0) {
			const target = pickerTarget(choosing);
			const text =
				target === null
					? gray("finding harnesses…")
					: typeof target === "string"
						? red(target)
						: `${cyan(target.harness)} ${gray("· its own defaults")}`;
			return truncateToWidth(` ${text}`, width, "…");
		}
		const labels = presetLabels(presets.map((c) => c.preset));
		const at = Math.min(choosing.preset, labels.length - 1);
		const sep = gray(" · ");
		// Room left by the ‹ before and the › ⇥ after.
		const room = width - 6;
		// The widest run of labels around the current one that fits.
		let from = at;
		let to = at + 1;
		const runWidth = () => labels.slice(from, to).reduce((n, l) => n + visibleWidth(l), 0) + (to - from - 1) * 3;
		for (let grew = true; grew; ) {
			grew = false;
			if (to < labels.length) {
				to++;
				if (runWidth() > room) to--;
				else grew = true;
			}
			if (from > 0) {
				from--;
				if (runWidth() > room) from++;
				else grew = true;
			}
		}
		const step = (by: number) => () => {
			choosing.preset = (((at + by) % labels.length) + labels.length) % labels.length;
		};
		const parts: [string, (() => void) | null][] = [from > 0 ? [gray("‹"), step(-1)] : [" ", null]];
		labels.slice(from, to).forEach((label, i) => {
			const index = from + i;
			if (i > 0) parts.push([sep, null]);
			parts.push([
				index === at ? bold(cyan(label)) : gray(label),
				() => {
					choosing.preset = index;
				},
			]);
		});
		parts.push(to < labels.length ? [gray(" ›"), step(1)] : ["  ", null], [gray(" ⇥"), step(1)]);
		return truncateToWidth(this.clickable(y, parts), width, "…");
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
	/** What the new session runs in: an index into pickerPresets. */
	preset: number;
};

const PICKER_TOP = 4;

/** What n's Tab steps through: every preset that can start, from the default. */
function pickerPresets(): Choice[] {
	return fromDefault(shortlist(config, catalog) ?? []).filter((c) => c.reason === null);
}

/**
 * What a session from the picker starts on: its preset, or with none that can, the default's harness on its own
 * defaults. Null until the harnesses are found, when the worker decides; a string says why nothing can start.
 */
function pickerTarget(choosing: Choosing): LaunchTarget | string | null {
	const presets = pickerPresets();
	const chosen = presets[Math.min(choosing.preset, presets.length - 1)];
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
	const y = PICKER_TOP + top + 5;
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

// A Peek is a session's particulars and keys in a popup beside its row: a tmux popup on the Stage's own nested client,
// so it never covers the roster and never takes the roster's keyboard. The UI server's bindings close it when the
// pointer leaves (see deck.ts); `swb __peek` draws it from paths.peek and posts its buttons back as keys.

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
type InlinePeek = PeekSpot & { view: PeekView; top: number; left: number };
type ShownPeek = PeekSpot & { proc: Subprocess; tty: string; width: number; maxHeight: number; json: string; view: PeekView };

const peek = {
	shown: null as ShownPeek | null,
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
	ops: Promise.resolve(),
};

const spotKey = (spot: PeekSpot | null | undefined) => (spot ? `${spot.id}@${spot.y}` : null);

function cancelPendingPeek(): void {
	if (peek.pending) clearTimeout(peek.pending.timer);
	peek.pending = null;
}

/** Where render wants a Peek, unless it was put away; asks for what it shows, and for word of the pointer leaving. */
function wantPeek(want: PeekSpot | null): PeekSpot | null {
	let spot = want;
	if (spot?.id !== peek.dismissed) peek.dismissed = null;
	else spot = null;
	peek.spot = spot;
	// Anything the pointer lights, a row, a control, or the Peek, goes out when the pointer leaves the roster.
	syncWatch(roster.pointer !== null || spot !== null);
	if (spot) askPeekInfo(spot.id);
	return spot;
}

/** Brings the popup Peek to `spot`: at once to close, after the pointer rests to open or move. */
function syncPeek(spot: PeekSpot | null): void {
	const shown = peek.shown;
	if (shown && spot && spotKey(shown) === spotKey(spot)) {
		shown.source = spot.source;
		cancelPendingPeek();
		refreshPeek(shown);
		return;
	}
	if (peek.pending && spotKey(peek.pending.spot) === spotKey(spot)) return;
	cancelPendingPeek();
	if (!spot) {
		closePeek();
		return;
	}
	const target = spot;
	const timer = setTimeout(
		() => {
			peek.pending = null;
			openPeek(target);
		},
		shown ? PEEK_SWITCH_MS : PEEK_OPEN_MS,
	);
	peek.pending = { spot: target, timer };
}

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

/** Opens the Peek at `spot`, closing the one shown in the same tmux command; a later render may have moved on already. */
function openPeek(spot: PeekSpot): void {
	peek.ops = peek.ops.then(async () => {
		try {
			if (spotKey(peek.spot) !== spotKey(spot)) return;
			if (!peek.info.has(spot.id))
				await Promise.race([new Promise<void>((resolve) => peek.infoWaits.set(spot.id, resolve)), Bun.sleep(PEEK_INFO_WAIT_MS)]);
			const panes = (
				await tmuxAsync(
					UI,
					"list-panes",
					"-t",
					stagePane,
					"-F",
					"#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_tty}",
				)
			)
				.split("\n")
				.map((line) => {
					const [id, left, top, width, height, tty] = line.split("\t") as [string, string, string, string, string, string];
					return { id, left: Number(left), top: Number(top), width: Number(width), height: Number(height), tty };
				});
			// The spot is a roster row; the panes' tops are the window's, below each pane's label. A roster hidden since has no Peek.
			const rosterTop = panes.find((pane) => pane.id === rosterPane)?.top;
			if (rosterTop === undefined) return;
			const y = spot.y + rosterTop;
			const stagePanes = panes.filter((pane) => pane.id !== rosterPane);
			// The Stage's panes against the roster's edge: pi's, and the shell's under it.
			const edge = Math.min(...stagePanes.map((pane) => pane.left));
			const host = stagePanes.find((pane) => pane.left === edge && y >= pane.top && y < pane.top + pane.height);
			const row = roster.rows().find((r) => r.key === spot.id);
			if (!host || host.width < PEEK_MIN_COLS || row?.kind !== "session" || spotKey(peek.spot) !== spotKey(spot)) return;
			const width = Math.min(PEEK_COLS, host.width);
			const view = peekView(row, width, host.height, "left");
			const height = view.lines.length;
			// Its title, under the top edge, level with the row.
			const top = Math.max(0, Math.min(y - host.top - 1, host.height - height));
			const json = JSON.stringify(view);
			writeAtomic(paths.peek, json);
			const close = `${quote(tmuxBin())} -L ${quote(SESSIONS)} display-popup -C -c ${quote(host.tty)} >/dev/null 2>&1`;
			const set = (name: string, value: string | number) => ["set", "-t", deck, name, String(value)];
			await tmuxAsync(
				UI,
				...[set("@swb_peek_pane", host.id), set("@swb_peek_t", top), set("@swb_peek_b", top + height), set("@swb_peek_r", width)].flatMap(
					(command) => [...command, ";"],
				),
				...set("@swb_peek_close", close),
			);
			const old = peek.shown;
			// display-popup waits for its popup to close; -y is the popup's bottom edge.
			const proc = Bun.spawn(
				[
					tmuxBin(),
					"-L",
					SESSIONS,
					...(old ? ["display-popup", "-C", "-c", old.tty, ";"] : []),
					...["display-popup", "-B", "-c", host.tty, "-x", "0", "-y", String(top + height), "-w", String(width), "-h", String(height)],
					`exec ${[SWB, "__peek", "--file", paths.peek, "--sock", paths.sock].map(quote).join(" ")}`,
				],
				{ cwd: CLIENT_CWD, env: cleanEnv(), stdout: "ignore", stderr: "pipe" },
			);
			const shown: ShownPeek = { ...spot, proc, tty: host.tty, width, maxHeight: host.height, json, view };
			peek.shown = shown;
			// A popup closed by -C ends its display-popup with status 1; only something said on stderr is a failure.
			void proc.exited.then(async () => {
				const error = (await new Response(proc.stderr).text()).trim();
				if (error) toast(`peek: ${error}`, "error");
				if (peek.shown !== shown) return;
				peek.shown = null;
				tui.requestRender();
			});
		} catch (error) {
			toast(`peek: ${(error as Error).message}`, "error");
		}
		tui.requestRender();
	});
}

/** Rewrites what an open Peek shows; one that changed height reopens in its place. */
function refreshPeek(shown: ShownPeek): void {
	const row = roster.rows().find((r) => r.key === shown.id);
	if (row?.kind !== "session") return;
	const view = peekView(row, shown.width, shown.maxHeight, "left");
	const json = JSON.stringify(view);
	if (json === shown.json) return;
	const resized = view.lines.length !== shown.view.lines.length;
	shown.json = json;
	shown.view = view;
	if (resized) openPeek(shown);
	else writeAtomic(paths.peek, json);
}

function closePeek(): void {
	const shown = peek.shown;
	cancelPendingPeek();
	if (!shown) return;
	peek.shown = null;
	peek.ops = peek.ops.then(async () => {
		try {
			await tmuxAsync(UI, "set", "-u", "-t", deck, "@swb_peek_pane");
			await tmuxAsync(SESSIONS, "display-popup", "-C", "-c", shown.tty);
		} catch (error) {
			toast(`peek: ${(error as Error).message}`, "error");
		}
	});
}

/** A path too long for the Peek keeps its end, where the directories that tell sessions apart are. */
function tailOf(path: string, width: number): string {
	return visibleWidth(path) <= width ? path : `…${path.slice(path.length - width + 1)}`;
}

function ago(at: number, now: number): string {
	const a = age(at, now);
	return a === "now" ? "just now" : `${a} ago`;
}

/**
 * What a Peek shows, framed on three sides. Beside the roster it opens to the left, onto the roster's border; drawn by
 * the roster itself, at the terminal's right edge, it opens to the right. A Peek too short for everything loses the last
 * turn first.
 */
function peekView(row: SessionRow, width: number, maxHeight: number, open: "left" | "right"): PeekView {
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
	const links: { at: number; key: string; id: string }[] = [];
	const parent = parentOf(e);
	if (parent) {
		const label = `${gray("started by")} ${originMark(origin(e))} `;
		links.push({ at: head.length, key: "p", id: e.id });
		head.push(`${label}${truncateToWidth(displayName(parent), inner - visibleWidth(label) - 2, "…", true)} ${dim("p")}`);
		if (parent.project !== e.project && !parent.operator)
			head.push(gray(`${" ".repeat(visibleWidth(label))}in ${projectName(parent.project)}`));
	}
	if (row.folded) {
		head.push(rule, `${gray("folded")} ${foldedTally(row.family.map((p) => p.entry))}`);
		for (const { entry, nest } of row.family.slice(0, PEEK_FOLD_ROWS)) {
			const guides = `${nest.continues.map((on) => (on ? "│  " : "   ")).join("")}${nest.last ? "└─ " : "├─ "}`;
			links.push({ at: head.length, key: "open", id: entry.id });
			head.push(`${gray(guides)}${glyph(stateOf(entry), now)} ${displayName(entry)}`);
		}
		const rest = row.family[PEEK_FOLD_ROWS];
		if (rest) {
			links.push({ at: head.length, key: "open", id: rest.entry.id });
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
					? `${green("✓")} ${v.label}${gray(` · ran ${ago(v.lastFiredAt as number, now)}`)}`
					: v.cron
						? `${cyan("↻")} ${v.label}${gray(` · next ${wakeAt(v.nextAt, now)}${v.lastFiredAt === null ? "" : ` · last ${ago(v.lastFiredAt, now)}`}`)}`
						: `${gray("◷")} ${v.label}${gray(` · ${wakeAt(v.nextAt, now)}`)}`;
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
	const frame = (content: string) =>
		open === "left"
			? ` ${truncateToWidth(content, inner, "…", true)} ${gray("│")}`
			: `${gray("│")} ${truncateToWidth(content, inner, "…", true)} `;
	const edge = "─".repeat(width - 1);
	const lines = [
		gray(open === "left" ? `${edge}╮` : `╭${edge}`),
		...body.slice(0, maxHeight - 2).map(frame),
		gray(open === "left" ? `${edge}╯` : `╰${edge}`),
	];
	const margin = open === "left" ? 1 : 2;
	return {
		id: e.id,
		lines,
		buttons: [
			...links
				.filter((link) => 1 + link.at < lines.length - 1)
				.map((link) => ({
					y: 1 + link.at,
					from: margin,
					to: margin + inner,
					key: link.key,
					id: link.id,
					hot: frame(cursorLine(truncateToWidth(body[link.at] as string, inner, "…", true), true)),
				})),
			...buttons
				.filter((b) => 1 + buttonsAt + b.y < lines.length - 1)
				.map((b) => {
					const y = 1 + buttonsAt + b.y;
					// The line again with this one button lit, for the pointer resting on it.
					const lit = (buttonLines[b.y] as string).replace(b.text, cursorLine(b.text, true));
					return { y, from: margin + b.from, to: margin + b.to, key: b.key, id: e.id, hot: frame(lit) };
				}),
		],
	};
}

// ── Deck actions ────────────────────────────────────────────────────────

/** In split, the keyboard goes to pi. */
async function focusStage(): Promise<void> {
	await stageOps;
	await tmuxAsync(UI, "select-pane", ...(narrow ? ["-Z"] : []), "-t", side?.pane ?? stagePane);
}

async function focusRoster(): Promise<void> {
	await tmuxAsync(UI, "set", "-u", "-t", deck, "@swb_hidden");
	await syncRoster(true);
}

async function setRosterHidden(hidden: boolean): Promise<void> {
	await tmuxAsync(UI, "set", ...(hidden ? [] : ["-u"]), "-t", deck, "@swb_hidden", ...(hidden ? ["1"] : []));
	await syncRoster(false);
}

/**
 * Brings the roster in line with @swb_hidden. Hiding breaks it out to a window of its own; showing joins the Stage's
 * panes back into that window, because join-pane appends to the pane list and the bindings count on the roster being
 * pane 0.
 */
function syncRoster(toRoster: boolean): Promise<void> {
	stageOps = stageOps.then(() =>
		sizingRoster(async () => {
			const raw = await tmuxAsync(UI, "show", "-qv", "-t", deck, "@swb_hidden");
			if (narrow && raw === "1") await tmuxAsync(UI, "set", "-u", "-t", deck, "@swb_hidden");
			const want = !narrow && raw === "1";
			if (want === rosterHidden) {
				if (toRoster && !want) await tmuxAsync(UI, "select-pane", ...(narrow ? ["-Z"] : []), "-t", rosterPane);
				return;
			}
			try {
				if (want) {
					// Focus moves first: breaking the active roster away hands focus to the window's last pane, and that pane's
					// focus hook can land after pi's.
					const focusPi = focusedPane === rosterPane ? ["select-pane", "-t", side?.pane ?? stagePane, ";"] : [];
					await tmuxAsync(UI, ...focusPi, "break-pane", "-d", "-s", rosterPane);
				} else {
					const active = await tmuxAsync(UI, "list-panes", "-t", stagePane, "-f", "#{pane_active}", "-F", "#{pane_id}");
					const join = [
						"join-pane",
						"-h",
						"-d",
						"-l",
						String(Math.max(1, deckWidth - rosterWidth() - 1)),
						"-s",
						stagePane,
						"-t",
						rosterPane,
					];
					if (side) {
						const width = await tmuxAsync(UI, "display", "-p", "-t", side.pane, "#{pane_width}");
						join.push(";", "join-pane", "-h", "-d", "-l", width, "-s", side.pane, "-t", stagePane);
					}
					if (below) {
						const height = await tmuxAsync(UI, "display", "-p", "-t", below.pane, "#{pane_height}");
						join.push(";", "join-pane", "-v", "-d", "-l", height, "-s", below.pane, "-t", below.parent);
					}
					// The roster's window began empty when it broke away, so it has no last pane: the Stage pane goes first, for
					// l and Tab to return to.
					const back = toRoster ? [";", "select-pane", "-t", rosterPane] : [];
					await tmuxAsync(UI, ...join, ";", "select-window", "-t", rosterPane, ";", "select-pane", "-t", active, ...back);
				}
			} catch (error) {
				toast(`roster: ${(error as Error).message}`, "error");
			} finally {
				// A tmux sequence can fail halfway, so the windows say whether the roster is hidden.
				const [rosterWindow, stageWindow] = await Promise.all(
					[rosterPane, stagePane].map((pane) => tmuxAsync(UI, "display", "-p", "-t", pane, "#{window_id}")),
				);
				rosterHidden = rosterWindow !== stageWindow;
				syncStatus();
				// The card carries the title and state only while the roster is off-screen.
				writeStageCard(desired());
			}
		}),
	);
	return stageOps;
}

/**
 * The roster's own keys, from anywhere after the prefix. j and k step over headers, and the keyboard stays put. Given a
 * session, from a Peek's buttons, the key acts on that session's row instead of the cursor's.
 */
async function prefixKey(k: string, id: string | undefined): Promise<void> {
	// A Peek lists the family a fold hides; one of them, chosen there, has no row of its own yet.
	if (k === "open" && id !== undefined) {
		reveal(id);
		return;
	}
	const row = id === undefined ? roster.selected() : roster.rows().find((r) => r.key === id);
	if (id !== undefined && !row) throw new Error(`no session ${id} in the roster`);
	if (k === ",") {
		await focusRoster();
		openSettings();
		return;
	}
	// Session commands wait while Settings is open.
	if (roster.settings) return;
	if (k === "/") {
		await focusRoster();
		roster.filtering = true;
	} else if (k === "m") {
		await focusRoster();
		roster.startNaming(row);
	} else if (k === "J" || k === "K") roster.moveSession(k === "J" ? 1 : -1);
	else if (k === "n") {
		await focusRoster();
		roster.newAt(row);
	} else if (k === "N") {
		await focusRoster();
		roster.openPicker("add", null, null);
	} else if (k === "d") roster.askRemove();
	else if (k === "w") roster.wake(row);
	else if (k === "x") roster.stop(row);
	else if (k === "a") {
		// Asking whether the family goes too needs the keyboard where the question is.
		if (row?.kind === "session" && row.entry.open && openDescendants(entries.values(), row.entry.id).length > 0) await focusRoster();
		roster.toggleArchived(row);
	} else if (k === "p") roster.toParent(row);
	else if (k === "s" || k === "S") {
		// The menu takes the keyboard; unsnoozing needs none.
		if (!(row?.kind === "session" && row.entry.snoozed)) await focusRoster();
		roster.toggleSnooze(row);
	} else if (k === "y" || k === "Y") roster.copy(k === "y", row);
	else throw new Error(`unknown deck key ${k}`);
	roster.syncStage(true);
}

async function deckClient(): Promise<string | undefined> {
	return (await tmuxAsync(UI, "list-clients", "-t", `=${deck}`, "-F", "#{client_name}")).split("\n")[0] || undefined;
}

async function showHelp(): Promise<void> {
	const client = await deckClient();
	if (client) await tmuxAsync(UI, "display-popup", "-c", client, "-E", ...HELP_POPUP);
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
		if (!e.provisional) items.push(e.snoozed ? ["Unsnooze", "s"] : ["Snooze…", "s"], ["Archive", "a"]);
		if (!e.operator) items.push(["Group…", "m"]);
		items.push([e.operator ? "New Operator" : "New session here", "n"]);
	}
	items.push(["Copy swb open <id>", "y"], ["Copy @session:<id>", "Y"]);
	return items;
}

/** Below NARROW_BELOW columns the roster stands alone, and focus moves zoom along. */
function layout(): Promise<void> {
	closePeek();
	return sizingRoster(async () => {
		deckWidth = Number(await tmuxAsync(UI, "display", "-p", "-t", stagePane, "#{window_width}"));
		apply();
		await stageOps;
		const [zoomFlag, active] = (await tmuxAsync(UI, "display", "-p", "-t", stagePane, "#{window_zoomed_flag}\t#{pane_active}")).split("\t");
		const wasNarrow = narrow;
		narrow = deckWidth < NARROW_BELOW;
		if (narrow) await syncRoster(false);
		if (narrow !== wasNarrow) {
			if (narrow) await tmuxAsync(UI, "set", "-t", deck, "@swb_narrow", "1");
			else await tmuxAsync(UI, "set", "-u", "-t", deck, "@swb_narrow");
			if (narrow && zoomFlag !== "1") await tmuxAsync(UI, "resize-pane", "-Z", "-t", active === "1" ? stagePane : rosterPane);
			if (!narrow && zoomFlag === "1") await tmuxAsync(UI, "resize-pane", "-Z", "-t", rosterPane);
		}
		// tmux scales every pane with the window; the roster keeps its configured or dragged width instead.
		const zoomed = (await tmuxAsync(UI, "display", "-p", "-t", stagePane, "#{window_zoomed_flag}")) === "1";
		if (!narrow && !rosterHidden && !zoomed) {
			if (roster.settings) await tmuxAsync(UI, "resize-pane", "-Z", "-t", rosterPane);
			else await tmuxAsync(UI, "resize-pane", "-t", rosterPane, "-x", String(rosterWidth()));
		}
		syncStatus();
		if (narrow !== wasNarrow) writeStageCard(desired());
	});
}

/** The roster resized while the window didn't, and swb didn't do it: someone dragged its border. */
async function noteDrag(): Promise<void> {
	const before = sizings;
	if (sizing > 0 || narrow || rosterHidden) return;
	const sizes = await tmuxAsync(UI, "display", "-p", "-t", rosterPane, "#{window_width}\t#{pane_width}\t#{window_zoomed_flag}");
	const [window, pane, zoomed] = sizes.split("\t").map(Number) as [number, number, number];
	if (sizing > 0 || sizings !== before || window !== deckWidth || zoomed === 1 || pane === rosterWidth()) return;
	draggedCols = pane;
}
process.stdout.on("resize", () => void noteDrag());

function quit(): void {
	void tmuxAsync(UI, "kill-session", "-t", `=${deck}`);
}

/**
 * The worker's harness discovery runs each command in a session of its own, which neither the pane's SIGHUP nor this
 * process exiting reaches: a `pi --list-models` left running would outlive the Deck. Those sessions are the only
 * children here that lead their own process group.
 */
function stopDiscovery(): void {
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
	stopDiscovery();
	tmuxTry(SESSIONS, "kill-session", "-t", `=${placeholder}`);
	removeDeckFiles(deck);
	ctl.close();
	process.exit(0);
}
process.on("SIGHUP", cleanup);
process.on("SIGTERM", cleanup);

async function handleCommand(cmd: string, argv: string[]): Promise<void> {
	switch (cmd) {
		case "focus": {
			// Hooks run in the background and can land out of order, so each one rereads which pane is active.
			focusReads = focusReads.then(async () => {
				focusedPane = await tmuxAsync(UI, "display", "-p", "-t", deck, "#{pane_id}");
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
			if (was === "roster" && focus === "stage" && onView?.open && !onView.live) wake(onView.id, true);
			// Going to the Stage, by click or key, puts the Peek away: the pointer may still rest on the row it came from.
			if (was === "roster" && focus === "stage") {
				peek.dismissed = peek.spot?.id ?? null;
				peek.byKeys = false;
			}
			syncStatus();
			apply();
			break;
		}
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
			await layout();
			break;
		case "view-swap":
		case "view-split":
			if (!roster.settings) await changeView(cmd === "view-swap");
			break;
		case "roster":
			if (!roster.settings || argv[0] === "focus") await syncRoster(argv[0] === "focus");
			break;
		case "stage":
			await focusStage();
			break;
		case "shell":
			if (!roster.settings) await toggleShell();
			break;
		case "key":
			await prefixKey(argv[0] ?? "", argv[1]);
			break;
		// The UI server saw the pointer leave both the roster and the Peek, or a key typed elsewhere; it closed the
		// Peek, and stopped watching, on its way here.
		case "pointer-out":
			roster.hover = null;
			roster.pointer = null;
			peek.byKeys = false;
			peek.watching = false;
			break;
		// The pointer came into the Peek: it holds the Peek where it is, as if it were still on the Peek's row.
		case "peek-in":
			if (argv[0] !== undefined && peek.shown?.id === argv[0]) {
				cancelPendingPeek();
				roster.hover = argv[0];
			}
			break;
		case "esc":
			for (const launch of launches) launch.keyboard = false;
			await focusRoster();
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
			const { kind, id } = stage.applied;
			if (id !== null && (kind === "dormant" || kind === "exited" || kind === "failed")) wake(id, true);
			break;
		}
		default:
			throw new Error(`unknown deck command ${cmd}`);
	}
	tui.requestRender();
}

/** Shows or hides the shell under pi for the staged session's directory, and the keyboard follows it in and back out. */
async function toggleShell(): Promise<void> {
	const e = stage.applied.id === null ? undefined : entries.get(stage.applied.id);
	if (!e?.open) {
		toast("no open session on view", "info");
		return;
	}
	if (narrow) {
		toast(`the shell needs ${NARROW_BELOW} columns`, "info");
		return;
	}
	if (shellsShown.delete(e.cwd)) {
		const inShell = below !== null && focusedPane === below.pane;
		apply();
		if (inShell) await focusStage();
		return;
	}
	if ((await requestShell(e.cwd)) === null) return;
	shellsShown.add(e.cwd);
	apply();
	await stageOps;
	if (below) await tmuxAsync(UI, "select-pane", "-t", below.pane);
}

/**
 * `e` swaps pi and the Editor by what's showing, so an Editor that died comes back, and does nothing in split. `v` enters split with the keyboard on the Editor, and
 * leaves it for whichever pane had the keyboard.
 */
async function changeView(swap: boolean): Promise<void> {
	const e = stage.applied.id === null ? undefined : entries.get(stage.applied.id);
	if (!e?.open) {
		toast("no open session on view", "info");
		return;
	}
	const saved = viewOf(e);
	if (swap && saved === "split") return;
	const showing = stage.applied.view;
	let next: View;
	if (swap) next = showing === "editor" ? "agent" : "editor";
	else if (saved !== "split") next = "split";
	else next = showing === "split" && focus === "stage" && focusedPane === stagePane ? "editor" : "agent";
	await showView(e, next);
}

/** The keyboard goes to the pane the view brought up; entering split, to the Editor, since that's what I split to look at. */
async function showView(e: Entry, next: View): Promise<void> {
	if (next !== "agent") {
		editorsAsked.delete(e.cwd);
		editorsLost.delete(e.cwd);
		if ((await requestEditor(e.cwd)) === null || stage.applied.id !== e.id) return;
	}
	if (next !== "editor" && !e.live) wake(e.id, focus === "stage");
	if (next === "split" && deckWidth < SPLIT_FROM) toast(`split needs ${SPLIT_FROM} columns; showing ${harnessName(e.harness)}`, "info");
	localViews.set(e.id, next);
	post({ type: "view", id: e.id, view: next });
	apply();
	await stageOps;
	await tmuxAsync(UI, "select-pane", ...(narrow ? ["-Z"] : []), "-t", stagePane);
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
		draggedCols = null;
		void layout();
	}
	if (JSON.stringify(before.dirs) !== JSON.stringify(config.dirs)) post({ type: "dirs" });
	if (before.wakeOnHighlight !== config.wakeOnHighlight) scheduleHighlightWake();
	if (before.operatorInstructions !== config.operatorInstructions) ensureOperatorDir(config.operatorInstructions);
	tui.requestRender();
}

/** config.toml again, after a change on disk: a valid one applies, an invalid one is reported and leaves the Deck as it was. */
function reloadConfig(): void {
	try {
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
	roster.choosing = null;
	roster.naming = null;
	roster.filtering = false;
	roster.dragging = null;
	closePeek();
	if (stage.highlightTimer) clearTimeout(stage.highlightTimer);
	stage.highlightTimer = null;
	roster.settings = new SettingsPane(settingsHost);
	post({ type: "refresh", models: false });
	zoomRoster(true);
	tui.requestRender();
}

function closeSettings(): void {
	if (!roster.settings) return;
	roster.settings.saveProse();
	roster.settings = null;
	zoomRoster(false);
	tui.requestRender();
}

/** A narrow Deck's roster is zoomed already, and stays so. */
function zoomRoster(on: boolean): void {
	stageOps = stageOps.then(() =>
		sizingRoster(async () => {
			if (narrow || rosterHidden) return;
			const zoomed = (await tmuxAsync(UI, "display", "-p", "-t", rosterPane, "#{window_zoomed_flag}")) === "1";
			if (on !== zoomed) await tmuxAsync(UI, "resize-pane", "-Z", "-t", rosterPane);
			// Back beside the Stage, at whatever width Settings left it.
			if (!on) await tmuxAsync(UI, "resize-pane", "-t", rosterPane, "-x", String(rosterWidth()));
			// Bun's stdout keeps the size from before a zoom until a SIGWINCH reads it again; tmux's own one can land first.
			process.kill(process.pid, "SIGWINCH");
		}).catch((error: Error) => toast(`settings: ${error.message}`, "error")),
	);
}

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
			const at = Math.min(choosing.preset, labels.length - 1);
			return {
				preset: labels[at] ?? null,
				harness: target !== null && typeof target !== "string" ? target.harness : null,
				presets: labels,
			};
		})(),
	};
}

function viewState(): DeckState {
	const rows = roster.rows();
	const labels = new Map(rows.flatMap((row) => (row.kind === "header" && row.group !== null ? [[row.key, row.group]] : [])));
	const index = roster.resolveCursor(rows);
	const cursorRow = rows[index];
	const drop = roster.dragging?.moved ? roster.dragging.drop : null;
	const applied = stage.applied;
	const staged = applied.id === null ? undefined : entries.get(applied.id);
	return {
		deck,
		ready,
		terminalFocused,
		cursor: cursorRow?.kind === "session" ? cursorRow.entry.id : null,
		cursorRow: index,
		mode: roster.settings
			? "settings"
			: roster.choosing
				? "picker"
				: roster.archiving !== null
					? "archive"
					: roster.filtering
						? "filter"
						: roster.naming
							? "name"
							: roster.snoozing
								? "snooze"
								: "roster",
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
			const shown = peek.shown ?? roster.inline;
			return shown ? { id: shown.id, source: shown.source, lines: shown.view.lines.map((line) => Bun.stripANSI(line)) } : null;
		})(),
		focus:
			focus === "roster"
				? "roster"
				: focusedPane === below?.pane
					? "shell"
					: focusedPane === stagePane && applied.view !== "agent"
						? "editor"
						: "stage",
		staged: {
			id: applied.id,
			host: applied.host,
			kind: applied.kind,
			view: applied.view,
			savedView: staged ? viewOf(staged) : "agent",
		},
		layout: { width: deckWidth, rosterOnly: narrow, split: side !== null, shell: below !== null, rosterHidden },
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

main.tty = stageTty;
tmux(
	UI,
	"set",
	"-t",
	deck,
	"@swb_roster",
	rosterPane,
	";",
	"set",
	"-t",
	deck,
	"@swb_peek_close",
	"true",
	";",
	"set",
	"-p",
	"-t",
	rosterPane,
	"@swb_label",
	"swb",
);
focusedPane = rosterPane;
rmSync(paths.sock, { force: true });
Bun.serve({
	unix: paths.sock,
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname === "/state") return Response.json(viewState());
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

post({ type: "init", deck, paths, config, here });
post({ type: "dirs" });
if (args.new) newSession(args.new, null, null, args.harness ? asHarness(args.harness) : null);
void layout();

/** A Stage's nested client is up once it attaches to the sessions server, which the control client hears. */
function stageUp(ttys: string[]): void {
	if (!main.up && ttys.includes(main.tty)) {
		main.up = true;
		switchStage(main, stage.applied.target, true);
	}
	if (side && !side.up && ttys.includes(side.tty)) {
		side.up = true;
		switchStage(side, side.target, true);
	}
	checkReady();
}

/** Ready once the first snapshot is in and the Stage's nested client is attached to the sessions server. */
function checkReady(): void {
	if (ready || snapshot === null || !main.up) return;
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

setInterval(() => {
	// The control client misses attaches while it respawns after the sessions server restarts.
	if (!main.up || (side && !side.up)) {
		const clients = tmuxTry(SESSIONS, "list-clients", "-F", "#{client_tty}");
		stageUp(clients.ok ? clients.out.split("\n") : []);
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
