import { rmSync } from "node:fs";
import { parseArgs } from "node:util";
import {
	type Component,
	decodeKittyPrintable,
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
} from "@earendil-works/pi-tui";
import { operatorDir, projectRoot, type View } from "@swb/shared";
import { loadConfig } from "../config.ts";
import { displayName, projectName } from "../derive.ts";
import { UsageError } from "../errors.ts";
import { newer, nvimEditor } from "../sessions.ts";
import type { DeckLayout } from "../store.ts";
import { quote, SESSIONS, tmux, tmuxAsync, tmuxTry, UI } from "../tmux.ts";
import { VERSION } from "../version.ts";
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
import type { Card, DeckState, Entry, FromWorker, Snapshot, State, StatSummary, ToWorker, Turn } from "./protocol.ts";
import {
	age,
	attention,
	bold,
	cyan,
	dim,
	flashOn,
	gray,
	green,
	hex,
	key,
	magenta,
	mix,
	red,
	sgrBg,
	shortPath,
	spinnerFrame,
} from "./style.ts";

const VISIT_MS = 1000;
const HOVER_MS = 500;
const TOAST_MS = 3500;
const DETAIL_LINES = 3;
const LAYOUT_SETTLE_MS = 500;
const VIEWS: View[] = ["pi", "editor", "split"];

const { values: args } = parseArgs({
	args: process.argv.slice(3),
	options: {
		deck: { type: "string" },
		stage: { type: "string" },
		select: { type: "string" },
		new: { type: "string" },
		here: { type: "string" },
		continue: { type: "boolean" },
	},
});
if (!args.deck || !args.stage || !args.here) throw new UsageError("__roster: --deck, --stage, and --here are required");
const deck = args.deck;
/** Where swb was run: `n` starts there from a section row, including in an empty Deck. */
const here = args.here;
const stagePane = args.stage;
if (!process.env.TMUX_PANE) throw new UsageError("__roster: runs only inside a Deck pane");
const rosterPane = process.env.TMUX_PANE;
const paths = deckPaths(deck);
const placeholder = placeholderName(deck);
const config = loadConfig();

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

const ctl = new Control();

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

const transcripts = new Map<string, { turns: Turn[] | null; error: string | null }>();

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

/** Where a session sits beneath its Project: its own Group, else its worktree's bucket when group_by asks for one. */
type Group = { kind: "custom"; name: string } | { kind: "worktree"; branch: string };

function groupOf(e: Entry): Group | null {
	if (e.operator) return null;
	const local = localGroups.get(e.id);
	const name = local !== undefined ? local : e.group;
	if (name !== null) return { kind: "custom", name };
	if (config.groupBy === "worktree" && e.branch !== null) return { kind: "worktree", branch: e.branch };
	return null;
}

function groupLabel(group: Group): string {
	return group.kind === "custom" ? group.name : `⎇ ${group.branch}`;
}

function setGroup(ids: string[], name: string | null): void {
	for (const id of ids) localGroups.set(id, name);
	post({ type: "group", ids, name });
}

function stateOf(e: Entry): State {
	if (launchFor(e.id) && !e.live) return "loading";
	if (!e.open) return "archived";
	if (!e.live) {
		if (e.interrupted) return "interrupted";
		return isUnseen(e) ? "unseen" : "dormant";
	}
	if (e.activity === "blocked") return "blocked";
	if (e.activity === "working") return "working";
	return isUnseen(e) ? "unseen" : "idle";
}

function glyph(state: State, now: number): string {
	switch (state) {
		case "loading":
			return cyan(spinnerFrame(now));
		case "blocked":
			return flashOn(now) ? bold(attention("◆")) : dim(attention("◆"));
		case "working":
			return cyan("◐");
		case "unseen":
			return green("●");
		case "idle":
			return "○";
		case "dormant":
			return gray("○");
		case "interrupted":
			return red("⚠");
		case "archived":
			return gray("✓");
	}
}

/** The one place a session's state is named; the row's glyph is where it's scanned. */
function status(e: Entry): string {
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
		case "interrupted":
			return `${red("interrupted")}${gray(" · waking resumes it idle")}`;
		case "archived":
			return gray("archived");
	}
}

const archivedKey = (e: Entry) => Math.max(e.activityAt, e.archivedAt ?? 0);

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
	return { kind, id, host: null, card, view: "pi", target: placeholder, side: null, below: null };
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

const EMPTY: Card = { head: [], lines: ["Nothing selected."], turns: [] };

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
	hoverTimer: null as Timer | null,
	keyAt: 0,
};

const rosterOffScreen = () => narrow || rosterHidden;

function card(e: Entry, lines: string[] = []): Card {
	const transcript = transcripts.get(e.id);
	const extra = transcript?.error ? [red(transcript.error)] : [];
	return {
		head: rosterOffScreen() ? [bold(displayName(e)), status(e), gray(shortPath(e.cwd))] : [],
		lines: [...lines, ...extra],
		turns: transcript ? (transcript.turns ?? []) : null,
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
		// A new session has no row yet, so its card is the only place that says it's starting.
		const lines = pending.keyboard && rosterOffScreen() ? [ESC_LINE] : [];
		return onCard("loading", null, { head: [cyan("starting a new session")], lines, turns: [] });
	}
	const e = stage.staged === null ? undefined : entries.get(stage.staged);
	if (!e) return onCard("empty", null, EMPTY);
	if (stage.ended?.id === e.id && e.open) {
		const failed = stage.ended.failed;
		return onCard(failed ? "failed" : "exited", e.id, card(e, failed ? ["pi quit before it was ready:", ...stage.ended.lines] : []));
	}
	if (e.live && e.host) return { kind: "live", id: e.id, host: e.host, card: null, view: "pi", target: e.host, side: null, below: null };
	const launch = launchFor(e.id);
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
	writeStageCard(d);
	const prev = stage.applied;
	stage.applied = d;
	syncVisit();
	const e = d.id === null ? undefined : entries.get(d.id);
	if (d.host && e?.open && viewOf(e) !== "pi" && snapshot && !snapshot.editors[e.cwd]) {
		if (!editorsAsked.has(e.cwd)) void requestEditor(e.cwd);
		else if (!editorWaits.has(e.cwd) && !editorsLost.has(e.cwd)) {
			editorsLost.add(e.cwd);
			toast(`editor for ${e.cwd} exited; showing pi`, "error");
		}
	}
	tui.requestRender();
	if (d.side !== prev.side || d.side !== (side?.target ?? null)) syncSide();
	if (d.below !== (below?.target ?? null) || d.side !== prev.side) syncBelow();
	if (nvimEditor(config.editor) && (d.view !== "pi") !== (prev.view !== "pi")) tagEditor(d.view !== "pi");
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
	if (e && !e.live && e.transcript) post({ type: "transcript", id, path: e.transcript });
	scheduleHover();
	apply();
}

function scheduleHover(): void {
	if (stage.hoverTimer) clearTimeout(stage.hoverTimer);
	stage.hoverTimer = null;
	const e = stage.staged === null ? undefined : entries.get(stage.staged);
	if (config.hover !== "eager" || !e || !e.open || e.live || launchFor(e.id) || stage.ended?.id === e.id) return;
	const id = e.id;
	stage.hoverTimer = setTimeout(() => {
		stage.hoverTimer = null;
		if (stage.staged === id) wake(id, false);
	}, HOVER_MS);
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

function newSession(cwd: string, group: string | null): void {
	if (newLaunch()) {
		toast("a new session is already starting", "info");
		return;
	}
	launches.push({ id: null, host: null, since: Date.now(), keyboard: true });
	stage.holdForNew = true;
	stage.staged = null;
	stage.ended = null;
	post({ type: "new", cwd, group });
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
		else toast(lastWords.length > 0 ? `pi failed to start: ${lastWords.at(-1)}` : "pi failed to start", "error");
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
	const open = [...entries.values()].filter((e) => e.open && !e.provisional);
	if (args.continue) {
		const root = projectRoot(here);
		const recent = open
			.filter((e) => e.project === root)
			.sort((a, b) => (b.visitedAt ?? 0) - (a.visitedAt ?? 0) || b.activityAt - a.activityAt)[0];
		if (!recent) {
			newSession(here, null);
			return;
		}
		reveal(recent.id);
		continueTo = recent;
		return;
	}
	if (restoredKey !== null && entries.get(restoredKey)?.open) {
		reveal(restoredKey);
		return;
	}
	if (restoredKey !== null && roster.rows().some((row) => row.key === restoredKey)) {
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
	if (e && !e.live && e.transcript && !transcripts.has(e.id)) post({ type: "transcript", id: e.id, path: e.transcript });
	apply();
	roster.syncStage(false);
	// A turn that lands while I'm already watching is seen as it lands.
	if (stage.watched && stage.visited && entries.get(stage.watched)?.unseen) post({ type: "visit", id: stage.watched });
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
			transcripts.set(message.id, { turns: message.turns, error: message.error });
			apply();
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

/** `swb open`: select a session wherever it is, opening the section and project that hide it. */
function reveal(id: string): void {
	const e = entries.get(id);
	if (!e) {
		toast(`no open or archived session ${id}`, "error");
		return;
	}
	if (!e.open) roster.expanded.add("archived");
	else if (e.operator) roster.expanded.add("operators");
	else {
		const parent = e.inactive && !launchFor(e.id) ? "inactive" : "open";
		if (parent === "inactive") roster.expanded.add("inactive");
		const group = groupOf(e);
		roster.collapsed.delete(`${parent}:${e.project}`);
		if (group) roster.collapsed.delete(`${parent}:${e.project}:${groupKey(group)}`);
	}
	roster.selectedKey = id;
	roster.syncStage(true);
}

type SectionKey = "operators" | "inactive" | "archived";
const SECTION_KEYS: SectionKey[] = ["operators", "inactive", "archived"];

/** A Project header has no group; a Group or worktree bucket beneath it does, and starts sessions in its newest member's cwd. */
type HeaderRow = {
	kind: "header";
	key: string;
	projectKey: string;
	project: string;
	group: Group | null;
	cwd: string;
	count: number;
	depth: number;
	collapsed: boolean;
};

type Row =
	| HeaderRow
	| { kind: "session"; key: string; entry: Entry; depth: number; header: string }
	| { kind: "section"; key: SectionKey; label: string; count: number; expanded: boolean };

const isHeader = (row: Row) => row.kind !== "session";
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

function groupKey(group: Group): string {
	return group.kind === "custom" ? `g:${group.name}` : `b:${group.branch}`;
}

/** Where a dragged session would land: a header to light up and the Group it would take, or nowhere. */
type Drop = { header: HeaderRow; name: string | null } | null;

// The cursor's background is mixed from the terminal's own background and foreground, as pi's system theme
// does. Until the terminal reports its colors, reverse video stands in.
let cursorBg: { focused: string; unfocused: string } | null = null;
let colors: { background: string | null; scheme: string | null } = { background: null, scheme: null };

function cursorLine(line: string, focused: boolean): string {
	if (!cursorBg) return focused ? sgrBg("7", line) : sgrBg("4", line);
	return sgrBg(focused ? cursorBg.focused : cursorBg.unfocused, line);
}

class Roster implements Component {
	selectedKey = "";
	lastIndex = 0;
	/** After `a`, the cursor keeps its index instead of chasing the session into its new section. */
	pin: { index: number; answered: boolean } | null = null;
	scrollTop = 0;
	collapsed = new Set<string>();
	expanded = new Set<SectionKey>(["operators"]);
	filter = new Input({ prompt: "/ " });
	filtering = false;
	name = new Input({ prompt: "> " });
	/** `m`'s picker: the sessions it moves, the Group header it started on, and the highlighted choice. */
	naming: { ids: string[]; header: HeaderRow | null; project: string; title: string; choice: number } | null = null;
	/** A session being dragged by the mouse; `moved` once the pointer has left its row. */
	dragging: { id: string; moved: boolean; drop: Drop } | null = null;
	listTop = 2;
	listHeight = 0;
	/** What a click does, by row and column range, as of the last render. */
	targets: { y: number; from: number; to: number; act: () => void }[] = [];
	pressed: { y: number; from: number; to: number; act: () => void } | null = null;

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
		const group = groupOf(e);
		const label = group ? groupLabel(group) : "";
		return q === "" || `${displayName(e)} ${projectName(e.project)} ${e.branch ?? ""} ${label}`.toLowerCase().includes(q);
	}

	rows(): Row[] {
		const rows: Row[] = [];
		const all = [...entries.values()].filter((e) => this.matches(e));
		const open = all.filter((e) => e.open);
		const pushGroups = (list: Entry[], depth: number, parent: string) => {
			for (const [project, members] of groupByProject(list)) {
				const key = `${parent}:${project}`;
				const collapsed = this.collapsed.has(key);
				rows.push({ kind: "header", key, projectKey: key, project, group: null, cwd: project, count: members.length, depth, collapsed });
				if (collapsed) continue;
				// Groups and worktree buckets are siblings beneath the Project, ahead of its ungrouped sessions.
				const buckets = new Map<string, { group: Group; members: Entry[] }>();
				const loose: Entry[] = [];
				for (const e of members) {
					const group = groupOf(e);
					if (!group) {
						loose.push(e);
						continue;
					}
					const bucket = buckets.get(groupKey(group)) ?? { group, members: [] };
					bucket.members.push(e);
					buckets.set(groupKey(group), bucket);
				}
				const sorted = [...buckets.entries()].sort(([, a], [, b]) => groupLabel(a.group).localeCompare(groupLabel(b.group)));
				for (const [sub, { group, members: inside }] of sorted) {
					const subKey = `${key}:${sub}`;
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
					if (subCollapsed) continue;
					for (const e of inside) rows.push({ kind: "session", key: e.id, entry: e, depth: depth + 1, header: subKey });
				}
				for (const e of loose) rows.push({ kind: "session", key: e.id, entry: e, depth, header: key });
			}
		};
		// A filter opens every section it has matches in, so a match is never hidden behind a caret.
		const section = (key: SectionKey, label: string, count: number) => {
			const expanded = this.expanded.has(key) || (this.query() !== "" && count > 0);
			rows.push({ kind: "section", key, label, count, expanded });
			return expanded;
		};
		const operators = open.filter((e) => e.operator).sort((a, b) => b.activityAt - a.activityAt);
		if (section("operators", "Operators", operators.length)) {
			for (const e of operators) rows.push({ kind: "session", key: e.id, entry: e, depth: 0, header: "operators" });
		}
		const inactive = (e: Entry) => e.inactive && !launchFor(e.id);
		pushGroups(
			open.filter((e) => !e.operator && !inactive(e)),
			0,
			"open",
		);
		const idle = open.filter(inactive);
		if (idle.length > 0 && section("inactive", "Inactive", idle.length)) pushGroups(idle, 1, "inactive");
		const archived = all.filter((e) => !e.open).sort((a, b) => archivedKey(b) - archivedKey(a));
		if (section("archived", "Archived", archived.length)) {
			for (const e of archived) rows.push({ kind: "session", key: e.id, entry: e, depth: 0, header: "archived" });
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
		stage.keyAt = performance.now();
		frameKeyAt = stage.keyAt;
		toasts = [];
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
		else if (k === "y" || k === "Y") this.copy(k === "y");
		else if (k === "n") this.newAtCursor();
		else if (k === "N") newSession(here, null);
		else if (k === "/") this.filtering = true;
		else if (k === "m") this.startNaming();
		else if (k === "?") void showHelp();
		this.syncStage(true);
		stage.keyAt = 0;
		tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
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
		this.selectedKey = row.key;
		this.lastIndex = this.scrollTop + (event.y - this.listTop);
		stage.holdForNew = false;
		if (isHeader(row)) this.toggle(row);
		else this.focusEntry(row.entry);
		this.syncStage(true);
		return { handled: true };
	}

	rowAt(y: number): Row | undefined {
		if (y < this.listTop || y >= this.listTop + this.listHeight) return undefined;
		return this.rows()[this.scrollTop + (y - this.listTop)];
	}

	move(delta: number): void {
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
		if (row.kind === "session") this.focusEntry(row.entry);
		else this.setExpanded(row, true);
	}

	left(): void {
		const row = this.selected();
		if (row && row.kind !== "session") this.setExpanded(row, false);
	}

	wake(): void {
		const e = this.cursorEntry();
		if (!e) return;
		if (e.live) toast("already running", "info");
		else wake(e.id, false);
	}

	/** x: the counterpart to w. Frees the process and keeps the session open; any unsent prompt is saved as a draft. */
	stop(): void {
		const e = this.cursorEntry();
		if (!e) return;
		if (!e.live) toast("not running", "info");
		else post({ type: "stop", id: e.id });
	}

	toggleArchived(): void {
		const row = this.selected();
		if (row?.kind !== "session" || this.pin) return;
		const e = row.entry;
		if (e.provisional) {
			toast("nothing to archive before the first prompt", "error");
			return;
		}
		this.pin = { index: this.resolveCursor(this.rows()), answered: false };
		post({ type: e.open ? "archive" : "unarchive", id: e.id });
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

	copy(command: boolean): void {
		const e = this.cursorEntry();
		if (!e) return;
		const text = command ? `swb open ${e.id}` : `@session:${e.id}`;
		void clip(text).then(
			() => toast(`copied ${text}`, "info"),
			(error: Error) => toast(`copy failed: ${error.message}`, "error"),
		);
	}

	/** n: in the cursor's directory, joining its Group: a Group header's newest session's directory, there being no other. */
	newAtCursor(): void {
		const row = this.selected();
		if ((row?.kind === "section" && row.key === "operators") || (row?.kind === "session" && row.entry.operator)) {
			newSession(operatorDir(), null);
			return;
		}
		if (!row || row.kind === "section") {
			newSession(here, null);
			return;
		}
		const group = row.kind === "session" ? groupOf(row.entry) : row.group;
		newSession(row.kind === "session" ? row.entry.cwd : row.cwd, group?.kind === "custom" ? group.name : null);
	}

	/**
	 * m: picks the Group for the session under the cursor, or for every session under the Group header it's on, which
	 * merges into an existing Group or renames to a new one.
	 */
	startNaming(): void {
		const row = this.selected();
		this.filtering = false;
		this.name.setValue("");
		if (row?.kind === "session" && row.entry.operator) toast("Operators don't take Groups", "info");
		else if (row?.kind === "session") {
			const group = groupOf(row.entry);
			const project = row.entry.project;
			this.naming = { ids: [row.entry.id], header: null, project, title: displayName(row.entry), choice: 0 };
			this.naming.choice = Math.max(
				0,
				this.choices().findIndex((c) => c.name === (group?.kind === "custom" ? group.name : null)),
			);
		} else if (row?.kind === "header" && row.group?.kind === "custom") {
			const name = row.group.name;
			const ids = [...entries.values()]
				.filter((e) => {
					const group = groupOf(e);
					return e.project === row.project && group?.kind === "custom" && group.name === name;
				})
				.map((e) => e.id);
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
			if (e.open && e.project === naming.project && group?.kind === "custom") groups.add(group.name);
		}
		const out: { label: string; name: string | null }[] = typed === "" ? [{ label: "(no Group)", name: null }] : [];
		for (const name of [...groups].sort((a, b) => a.localeCompare(b)))
			if (name.toLowerCase().includes(typed.toLowerCase())) out.push({ label: name, name });
		if (typed !== "" && !groups.has(typed)) out.push({ label: `+ new "${typed}"`, name: typed });
		return out;
	}

	/** The picker's rows, which the list gives up its bottom to; each choice is a button. */
	picker(width: number, height: number): [string, (() => void) | null][] {
		const naming = this.naming;
		if (!naming) return [];
		const choices = this.choices();
		const shown = Math.max(1, Math.min(choices.length, height - 4));
		const from = Math.max(0, Math.min(naming.choice - shown + 1, choices.length - shown));
		const title = ` ${naming.header ? "rename" : "Group for"} ${naming.title} `;
		const out: [string, (() => void) | null][] = [
			[gray(`─${truncateToWidth(title, width - 2, "…")}${"─".repeat(Math.max(0, width - 1 - visibleWidth(title)))}`), null],
		];
		for (let i = from; i < from + shown; i++) {
			const choice = choices[i] as { label: string; name: string | null };
			const label = choice.name === null ? dim(choice.label) : choice.label.startsWith("+ ") ? green(choice.label) : choice.label;
			const line = truncateToWidth(`   ${label}`, width, "…", true);
			out.push([i === naming.choice ? cursorLine(line, true) : line, () => this.finishNaming(choice.name)]);
		}
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
		if (header.group?.kind === "custom") return { header, name: header.group.name };
		if (header.group?.kind === "worktree" && header.group.branch !== e.branch) return null;
		return { header, name: null };
	}

	/** Lands a drag: into the Group under the pointer, out of any on its Project or worktree bucket, or nowhere. */
	finishDrag(y: number): void {
		const drag = this.dragging;
		this.dragging = null;
		const e = drag && entries.get(drag.id);
		if (!e || !drag.moved) return;
		const drop = this.dropAt(y, e);
		const group = groupOf(e);
		const current = group?.kind === "custom" ? group.name : null;
		if (!drop) toast("not a place for it; nothing moved", "info");
		else if (drop.name !== current) setGroup([e.id], drop.name);
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

	render(width: number): string[] {
		const t0 = performance.now();
		const height = tui.terminal.rows;
		const now = Date.now();
		const rows = this.rows();
		const index = this.resolveCursor(rows);
		this.targets = [];
		const bodyHeight = Math.max(1, height - 5 - DETAIL_LINES);
		const detail = this.detail(width, now, 3 + bodyHeight);
		const lines = [this.header(width), gray("─".repeat(width))];
		lines.push(...this.list(rows, index, width, bodyHeight, now));
		lines.push(gray("─".repeat(width)), ...detail, this.messageLine(now), this.hints(3 + bodyHeight + DETAIL_LINES + 1));
		const out = lines.map((line) => truncateToWidth(line, width, "…", true));
		perf.render.add(performance.now() - t0);
		if (frameKeyAt > 0) {
			perf.keyToFrame.add(performance.now() - frameKeyAt);
			frameKeyAt = 0;
		}
		return out;
	}

	header(width: number): string {
		const tag = this.query() !== "" && !this.filtering ? ` ${magenta(`/${this.filter.getValue()}`)}` : "";
		return truncateToWidth(` ${bold("swb")}${tag}`, width, "…");
	}

	list(rows: Row[], index: number, width: number, full: number, now: number): string[] {
		const picker = this.picker(width, full);
		const height = Math.max(1, full - picker.length);
		picker.forEach(([, act], i) => {
			if (act) this.targets.push({ y: this.listTop + height + i, from: 0, to: width, act });
		});
		if (index < this.scrollTop) this.scrollTop = index;
		if (index >= this.scrollTop + height) this.scrollTop = index - height + 1;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, rows.length - height)));
		this.listHeight = height;
		const out: string[] = [];
		for (let i = 0; i < height; i++) {
			const row = rows[this.scrollTop + i];
			if (!row) {
				out.push("");
				continue;
			}
			const line = truncateToWidth(rowLine(row, width, now), width, "…", true);
			if (this.dragging?.drop?.header.key === row.key) out.push(cursorLine(line, true));
			else out.push(this.scrollTop + i === index ? cursorLine(line, focus === "roster") : line);
		}
		if (rows.length === 0) out[0] = dim(snapshot ? (this.query() ? "   no matches" : "   no sessions yet · n new") : "   loading…");
		return [...out, ...picker.map(([line]) => line)];
	}

	/** Joins the parts into row y's line, recording where each clickable one lands. */
	clickable(y: number, parts: [string, (() => void) | null][]): string {
		let x = 0;
		let line = "";
		for (const [text, act] of parts) {
			const w = visibleWidth(text);
			if (act) this.targets.push({ y, from: x, to: x + w, act });
			line += text;
			x += w;
		}
		return line;
	}

	detail(width: number, now: number, top: number): string[] {
		const e = this.cursorEntry() ?? (stage.staged === null ? null : (entries.get(stage.staged) ?? null));
		if (!e) return ["", "", ""];
		const launch = launchFor(e.id);
		const elapsed = launch && !e.live ? gray(` ${((now - launch.since) / 1000).toFixed(1)} s`) : "";
		const where = `${shortPath(e.cwd)}${e.branch ? ` ${magenta(`⎇ ${e.branch}`)}` : ""}`;
		let tabs = "";
		if (stage.staged === e.id && e.open) {
			const parts: [string, (() => void) | null][] = [[" ", null]];
			for (const view of VIEWS) {
				const label = ` ${view} `;
				parts.push([view === stage.applied.view ? cursorLine(label, true) : gray(label), () => void showView(e, view)]);
			}
			tabs = this.clickable(top + 2, parts);
		}
		return [` ${status(e)}${elapsed}`, ` ${gray(where)}`, tabs].map((line) => truncateToWidth(line, width, "…"));
	}

	messageLine(now: number): string {
		toasts = toasts.filter((t) => t.until > now);
		const t = toasts.at(-1);
		if (!t) return snapshot && newer(snapshot.swbVersion, VERSION) ? ` ${red(`✗ swb ${snapshot.swbVersion} is in; reopen the Deck`)}` : "";
		return ` ${t.level === "error" ? red(`✗ ${t.text}`) : green(t.text)}`;
	}

	/** Each key in the legend is also a button. */
	hints(y: number): string {
		if (this.filtering) return ` ${this.filter.render(Math.max(10, rosterWidth() - 2))[0] ?? ""}`;
		if (this.naming) return ` ${this.name.render(Math.max(10, rosterWidth() - 2))[0] ?? ""}`;
		const drag = this.dragging;
		if (drag?.moved) {
			if (!drag.drop) return ` ${red("✗ not here")}`;
			const target = drag.drop.header.group;
			return drag.drop.name === null ? ` ⇢ out of its Group` : ` ⇢ into ${bold(target ? groupLabel(target) : "")}`;
		}
		const help: Hint = ["?", "keys", () => void showHelp()];
		const newAtCursor: Hint = ["n", "new", () => this.newAtCursor()];
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
		else if (row.kind === "header" && row.group?.kind === "custom")
			hints = [enter(row.collapsed ? "expand" : "collapse"), ["m", "rename", () => this.startNaming()], newAtCursor, help];
		else if (row.kind === "header") hints = [enter(row.collapsed ? "expand" : "collapse"), newAtCursor, help];
		else if (row.kind === "section" && row.key === "operators")
			hints = [enter(row.expanded ? "collapse" : "expand"), ["n", "new operator", () => this.newAtCursor()], help];
		else if (row.kind === "section") hints = [enter(row.expanded ? "collapse" : "expand"), help];
		else if (!row.entry.open) hints = [enter("open"), ["a", "unarchive", () => this.toggleArchived()], help];
		else hints = [enter(row.entry.live ? "focus" : "wake"), ["a", "archive", () => this.toggleArchived()], newAtCursor, help];
		return this.clickable(
			y,
			hints.flatMap(([name, label, act]): [string, (() => void) | null][] => [
				[" ", null],
				[key(name, label), act],
			]),
		);
	}

	invalidate(): void {}
}

type Hint = [name: string, label: string, act: () => void];

function rowLine(row: Row, width: number, now: number): string {
	if (row.kind === "header") {
		const count = gray(` (${row.count})`);
		const name =
			row.group === null ? bold(projectName(row.project)) : row.group.kind === "custom" ? row.group.name : magenta(groupLabel(row.group));
		return `${" ".repeat(1 + row.depth * 2)}${row.collapsed ? "▸" : "▾"} ${name}${count}`;
	}
	if (row.kind === "section") return ` ${row.expanded ? "▾" : "▸"} ${row.label} ${gray(`(${row.count})`)}`;
	const e = row.entry;
	// Mid-drag, the session being carried is a hollow outline of itself.
	if (roster.dragging?.moved && roster.dragging.id === e.id) {
		const lead = `${gray("┆")}${" ".repeat(2 + row.depth * 2)}`;
		return `${lead}${gray("◌")} ${gray(truncateToWidth(displayName(e), width - visibleWidth(lead) - 2, "…"))}`;
	}
	const mark = stage.staged === e.id ? (focus === "stage" ? cyan("▌") : "▌") : " ";
	const lead = `${mark}${" ".repeat(2 + row.depth * 2)}`;
	const when = e.open ? age(e.activityAt, now) : age(archivedKey(e), now);
	// A worktree bucket already names the worktree.
	const worktree = e.cwd !== e.project && groupOf(e)?.kind !== "worktree" ? magenta("⎇") : " ";
	const right = ` ${worktree} ${gray(when.padStart(3))} `;
	const titleWidth = width - visibleWidth(lead) - 2 - visibleWidth(right);
	const title = truncateToWidth(e.provisional ? gray(displayName(e)) : displayName(e), titleWidth, "…", true);
	return `${lead}${glyph(stateOf(e), now)} ${title}${right}`;
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
					await tmuxAsync(UI, ...join, ";", "select-window", "-t", rosterPane, ";", "select-pane", "-t", toRoster ? rosterPane : active);
				}
			} catch (error) {
				toast(`roster: ${(error as Error).message}`, "error");
			} finally {
				// A tmux sequence can fail halfway, so the windows say whether the roster is hidden.
				const [rosterWindow, stageWindow] = await Promise.all(
					[rosterPane, stagePane].map((pane) => tmuxAsync(UI, "display", "-p", "-t", pane, "#{window_id}")),
				);
				rosterHidden = rosterWindow !== stageWindow;
				// The card carries the title and state only while the roster is off-screen.
				writeStageCard(desired());
			}
		}),
	);
	return stageOps;
}

/** The roster's own keys, from anywhere after the prefix. j and k step over headers, and the keyboard stays put. */
async function prefixKey(k: string): Promise<void> {
	if (k === "/") {
		await focusRoster();
		roster.filtering = true;
	} else if (k === "m") {
		await focusRoster();
		roster.startNaming();
	} else if (k === "j" || k === "k") roster.moveSession(k === "j" ? 1 : -1);
	else if (k === "n") roster.newAtCursor();
	else if (k === "N") newSession(here, null);
	else if (k === "w") roster.wake();
	else if (k === "x") roster.stop();
	else if (k === "a") roster.toggleArchived();
	else if (k === "y" || k === "Y") roster.copy(k === "y");
	else throw new Error(`unknown deck key ${k}`);
	roster.syncStage(true);
}

async function showHelp(): Promise<void> {
	const client = (await tmuxAsync(UI, "list-clients", "-t", `=${deck}`, "-F", "#{client_name}")).split("\n")[0];
	if (client) await tmuxAsync(UI, "display-popup", "-c", client, "-E", ...HELP_POPUP);
}

/** Below NARROW_BELOW columns the roster stands alone, and focus moves zoom along. */
function layout(): Promise<void> {
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
		if (!narrow && !rosterHidden && zoomFlag !== "1") await tmuxAsync(UI, "resize-pane", "-t", rosterPane, "-x", String(rosterWidth()));
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

function cleanup(): never {
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
			if (focus === "roster") for (const launch of launches) launch.keyboard = false;
			// A drag released over another pane never reports its release here.
			else roster.dragging = null;
			// Moving onto a dormant session, by click or key, means to use it.
			const onView = stage.staged === null ? undefined : entries.get(stage.staged);
			if (was === "roster" && focus === "stage" && onView?.open && !onView.live) wake(onView.id, true);
			apply();
			break;
		}
		case "terminal-focus": {
			const focused = argv[0] === "in";
			if (focused === terminalFocused) break;
			terminalFocused = focused;
			syncVisit();
			break;
		}
		case "layout":
			await layout();
			break;
		case "view-swap":
		case "view-split":
			await changeView(cmd === "view-swap");
			break;
		case "roster":
			await syncRoster(argv[0] === "focus");
			break;
		case "stage":
			await focusStage();
			break;
		case "shell":
			await toggleShell();
			break;
		case "key":
			await prefixKey(argv[0] ?? "");
			break;
		case "esc":
			for (const launch of launches) launch.keyboard = false;
			await focusRoster();
			apply();
			break;
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
 * `e` swaps pi and the Editor by what's showing, so an Editor that died comes back, and does nothing in split. `v` enters split with the keyboard on the pane matching the
 * old view, and leaves it for whichever pane had the keyboard.
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
	if (swap) next = showing === "editor" ? "pi" : "editor";
	else if (saved !== "split") next = "split";
	else next = showing === "split" && focus === "stage" && focusedPane === stagePane ? "editor" : "pi";
	await showView(e, next);
}

/** The keyboard goes to the pane the view brought up; entering split, to the one matching what showed before. */
async function showView(e: Entry, next: View): Promise<void> {
	const showing = stage.applied.view;
	if (next !== "pi") {
		editorsAsked.delete(e.cwd);
		editorsLost.delete(e.cwd);
		if ((await requestEditor(e.cwd)) === null || stage.applied.id !== e.id) return;
	}
	if (next !== "editor" && !e.live) wake(e.id, focus === "stage");
	if (next === "split" && deckWidth < SPLIT_FROM) toast(`split needs ${SPLIT_FROM} columns; showing pi`, "info");
	localViews.set(e.id, next);
	post({ type: "view", id: e.id, view: next });
	apply();
	await stageOps;
	const pane = next === "split" && showing === "pi" && side ? side.pane : stagePane;
	await tmuxAsync(UI, "select-pane", ...(narrow ? ["-Z"] : []), "-t", pane);
}

// ── view state ──────────────────────────────────────────────────────────

function viewState(): DeckState {
	const rows = roster.rows();
	const labels = new Map(rows.flatMap((row) => (row.kind === "header" && row.group ? [[row.key, groupLabel(row.group)]] : [])));
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
		mode: roster.filtering ? "filter" : roster.naming ? "name" : "roster",
		drop: drop ? { project: projectName(drop.header.project), group: drop.header.group && groupLabel(drop.header.group) } : null,
		filter: roster.query(),
		focus:
			focus === "roster"
				? "roster"
				: focusedPane === below?.pane
					? "shell"
					: focusedPane === stagePane && applied.view !== "pi"
						? "editor"
						: "stage",
		staged: {
			id: applied.id,
			host: applied.host,
			kind: applied.kind,
			view: applied.view,
			savedView: staged ? viewOf(staged) : "pi",
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
					}
				: row.kind === "header"
					? {
							kind: "header",
							project: projectName(row.project),
							group: row.group && groupLabel(row.group),
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
const tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, { mouse: true });
const roster = new Roster();
tui.setLayoutRoot(roster);
tui.setFocus(roster);
tui.start();

// Like pi: query the colors, and again on every light/dark report (997). The roster starts before the Deck's
// client attaches, so the first query gets nothing; tmux sends a 997 on attach, and that query gets everything.
// pi asks for the palette once, at startup, usually with no client attached; tmux answers OSC 4 for a detached pane
// only from pane-colours, so mirror this terminal's palette onto the sessions server.
async function queryColors(scheme: string | null): Promise<void> {
	const { foreground, background, palette } = await tui.queryTerminalColors({ timeoutMs: 200 });
	if (palette) await tmuxAsync(SESSIONS, ...palette.flatMap((color, i) => [";", "set", "-g", `pane-colours[${i}]`, hex(color)]).slice(1));
	cursorBg = background && foreground ? { focused: mix(background, foreground, 0.2), unfocused: mix(background, foreground, 0.08) } : null;
	colors = { background: background ? hex(background as RgbColor) : null, scheme: scheme ?? colors.scheme };
	if (colors.background) post({ type: "background", color: colors.background });
	tui.requestRender();
}
tui.onTerminalColorSchemeChange((scheme) => void queryColors(scheme));
tui.setTerminalColorSchemeNotifications(true);
void queryColors(null);

main.tty = tmux(UI, "display", "-p", "-t", stagePane, "#{pane_tty}");
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
if (args.new) newSession(args.new, null);
void layout();

// Ready once the first snapshot is in and the Stage's nested client is attached to the sessions server.
setInterval(() => {
	if (!main.up || (side && !side.up)) {
		const clients = tmuxTry(SESSIONS, "list-clients", "-F", "#{client_tty}");
		const ttys = clients.ok ? clients.out.split("\n") : [];
		if (!main.up && ttys.includes(main.tty)) {
			main.up = true;
			switchStage(main, stage.applied.target, true);
		}
		if (side && !side.up && ttys.includes(side.tty)) {
			side.up = true;
			switchStage(side, side.target, true);
		}
	}
	const wasReady = ready;
	ready = snapshot !== null && main.up;
	if (ready && !wasReady && args.select) reveal(args.select);
	if (ready && !wasReady && continueTo) roster.focusEntry(continueTo);
	const now = Date.now();
	keepLayout(now);
	if (toasts.some((t) => t.until <= now) || launches.length > 0 || [...entries.values()].some((e) => e.activity === "blocked"))
		tui.requestRender();
}, 100);
