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
import type { View } from "@swb/shared";
import { loadConfig } from "../config.ts";
import { displayName, projectName } from "../derive.ts";
import { UsageError } from "../errors.ts";
import { quote, SESSIONS, tmux, tmuxAsync, tmuxTry, UI } from "../tmux.ts";
import { Control } from "./control.ts";
import {
	deckEnv,
	deckPaths,
	HELP_POPUP,
	NARROW_BELOW,
	placeholderName,
	ROSTER_WIDTH,
	removeDeckFiles,
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
	spread,
} from "./style.ts";

const VISIT_MS = 1000;
const HOVER_MS = 500;
const TOAST_MS = 3500;

const { values: args } = parseArgs({
	args: process.argv.slice(3),
	options: {
		deck: { type: "string" },
		stage: { type: "string" },
		select: { type: "string" },
		new: { type: "string" },
		here: { type: "string" },
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
let terminalFocusedAt = Date.now();
let zoomed = false;
let narrow = false;
let deckWidth = 0;
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
	if (!e.unseen) return false;
	return !(piShown(stage.applied) && stage.applied.id === e.id && terminalFocused);
}

/** Views chosen in this Deck that the db doesn't reflect yet. */
const localViews = new Map<string, View>();

function viewOf(e: Entry): View {
	return localViews.get(e.id) ?? e.view;
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

const LABEL: Record<State, string> = {
	loading: cyan("starting"),
	blocked: attention("blocked"),
	working: cyan("working"),
	unseen: green("unseen"),
	idle: "idle",
	dormant: "idle",
	interrupted: red("interrupted"),
	archived: gray("archived"),
};

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
};

function onCard(kind: Applied["kind"], id: string | null, card: Card): Applied {
	return { kind, id, host: null, card, view: "pi", target: placeholder, side: null };
}

function piShown(a: Applied): boolean {
	return a.kind === "live" && a.view !== "editor";
}

/** A nested client of the sessions server in one of the Stage's panes. */
type StageClient = { pane: string; tty: string; up: boolean };
const main: StageClient = { pane: stagePane, tty: "", up: false };
let side: (StageClient & { target: string }) | null = null;

const EMPTY: Card = { tone: "empty", headline: "", title: "", path: "", lines: ["Nothing selected."], turns: [], keys: "", since: 0 };

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
	liveSince: 0,
	visited: false,
	visitTimer: null as Timer | null,
	hoverTimer: null as Timer | null,
	keyAt: 0,
};

function card(e: Entry, tone: Card["tone"], headline: string, lines: string[], keys: string, since = stage.stagedAt): Card {
	const transcript = transcripts.get(e.id);
	const extra = transcript?.error ? [red(transcript.error)] : [];
	return {
		tone,
		headline,
		title: displayName(e),
		path: shortPath(e.cwd),
		lines: [...lines, ...extra],
		turns: transcript ? (transcript.turns ?? []) : null,
		keys,
		since,
	};
}

function newLaunch(): Launch | undefined {
	return launches.find((launch) => launch.id === null);
}

/** The Stage as pi view would have it. */
function piStage(): Applied {
	const pending = newLaunch();
	if (stage.staged === null && pending) {
		const loading: Card = {
			tone: "loading",
			headline: "Starting pi…",
			title: "new session",
			path: "",
			lines: [pending.keyboard ? "The keyboard follows once it's up." : "Move away any time; it keeps starting."],
			turns: [],
			keys: pending.keyboard ? key("esc", "back to the list") : "",
			since: pending.since,
		};
		return onCard("loading", null, loading);
	}
	const e = stage.staged === null ? undefined : entries.get(stage.staged);
	if (!e) return onCard("empty", null, EMPTY);
	const wakeKeys = [key("w", "wake"), key("⏎", "focus")].join(gray(" · "));
	if (stage.ended?.id === e.id && e.open) {
		const failed = stage.ended.failed;
		const headline = failed ? "Failed to start" : "pi exited";
		const lines = failed ? ["pi quit before it was ready:", ...stage.ended.lines] : ["pi exited while it was on view."];
		return onCard(failed ? "failed" : "exited", e.id, card(e, failed ? "failed" : "exited", headline, lines, wakeKeys));
	}
	if (e.live && e.host) return { kind: "live", id: e.id, host: e.host, card: null, view: "pi", target: e.host, side: null };
	const launch = launchFor(e.id);
	if (launch) {
		const line = launch.keyboard ? "The keyboard follows once it's up." : "Move away any time; it keeps starting.";
		const keys = launch.keyboard ? key("esc", "back to the list") : "";
		return onCard("loading", e.id, card(e, "loading", "Starting pi…", [line], keys, launch.since));
	}
	if (!e.open) {
		const ago = age(e.archivedAt ?? 0, Date.now());
		const lines = [`Archived ${ago === "now" ? "just now" : `${ago} ago`}. A new prompt unarchives it.`];
		const keys = [wakeKeys, key("a", "unarchive")].join(gray(" · "));
		return onCard("dormant", e.id, card(e, "archived", "Archived", lines, keys));
	}
	if (e.interrupted) {
		const lines = ["pi exited mid-turn. Waking resumes it idle; the turn isn't continued."];
		return onCard("dormant", e.id, card(e, "interrupted", "⚠ Interrupted", lines, wakeKeys));
	}
	return onCard("dormant", e.id, card(e, "dormant", "Idle", [], wakeKeys));
}

/** The session's own view, as far as it can show: split needs pi live and a wide Deck, and both need the Editor. */
function desired(): Applied {
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

function apply(): void {
	const d = desired();
	if (d.card && d.target === placeholder) {
		const json = JSON.stringify(d.card);
		if (json !== stage.cardJson) {
			stage.cardJson = json;
			writeCard(paths, d.card);
		}
	}
	const prev = stage.applied;
	stage.applied = d;
	const was = piShown(prev) ? prev.id : null;
	const now = piShown(d) ? d.id : null;
	if (was !== now) {
		if (was) leaveLive(was);
		if (now) enterLive(now);
	}
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
	if (d.target === prev.target) return;
	writeAtomic(paths.target, d.target);
	switchStage(main, d.target, false);
}

function enterLive(id: string): void {
	stage.liveSince = Date.now();
	stage.visited = false;
	armVisit(id);
}

function leaveLive(id: string): void {
	if (stage.visitTimer) clearTimeout(stage.visitTimer);
	stage.visitTimer = null;
	if (stage.visited && terminalFocused) post({ type: "visit", id });
	stage.visited = false;
}

/** A Visit is a session live on a focused Deck's Stage for 1 s. The timer carries its id, so it never visits a later selection. */
function armVisit(id: string): void {
	if (stage.visitTimer) clearTimeout(stage.visitTimer);
	stage.visitTimer = null;
	if (!terminalFocused) return;
	const wait = Math.max(0, VISIT_MS - (Date.now() - Math.max(stage.liveSince, terminalFocusedAt)));
	stage.visitTimer = setTimeout(() => {
		stage.visitTimer = null;
		if (!piShown(stage.applied) || stage.applied.id !== id || !terminalFocused) return;
		stage.visited = true;
		post({ type: "visit", id });
		tui.requestRender();
	}, wait);
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

function newSession(cwd: string): void {
	if (newLaunch()) {
		toast("a new session is already starting", "info");
		return;
	}
	launches.push({ id: null, host: null, since: Date.now(), keyboard: true });
	stage.holdForNew = true;
	stage.staged = null;
	stage.ended = null;
	post({ type: "new", cwd });
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
		toast(lastWords.length > 0 ? `pi failed to start: ${lastWords.at(-1)}` : "pi failed to start", "error");
		if (launch.id !== null) {
			if (stage.staged === launch.id) stage.ended = { id: launch.id, failed: true, lines: lastWords };
		} else if (stage.staged === null) stage.staged = roster.cursorEntry()?.id ?? null;
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

function onSnapshot(next: Snapshot): void {
	snapshot = next;
	entries = new Map(next.entries.map((e) => [e.id, e]));
	for (const [id, view] of localViews) if (entries.get(id)?.view === view) localViews.delete(id);
	settleLaunches();
	followHost();
	roster.settlePin();
	const e = stage.staged === null ? undefined : entries.get(stage.staged);
	if (e && !e.live && e.transcript && !transcripts.has(e.id)) post({ type: "transcript", id: e.id, path: e.transcript });
	apply();
	roster.syncStage(false);
	// A turn that lands while I'm already watching is seen as it lands.
	const applied = stage.applied;
	if (piShown(applied) && applied.id && stage.visited && terminalFocused && entries.get(applied.id)?.unseen)
		post({ type: "visit", id: applied.id });
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
	else if (e.inactive && !launchFor(e.id)) {
		roster.expanded.add("inactive");
		roster.collapsed.delete(`inactive:${e.project}`);
	} else roster.collapsed.delete(`open:${e.project}`);
	roster.selectedKey = id;
	roster.syncStage(true);
}

type SectionKey = "inactive" | "archived";

type Row =
	| { kind: "header"; key: string; project: string; count: number; depth: number; collapsed: boolean }
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
	expanded = new Set<SectionKey>();
	filter = new Input({ prompt: "/ " });
	filtering = false;
	listTop = 2;
	listHeight = 0;

	constructor() {
		this.filter.onSubmit = () => {
			this.filtering = false;
		};
		this.filter.onEscape = () => {
			this.filter.setValue("");
			this.filtering = false;
		};
	}

	query(): string {
		return this.filter.getValue().trim().toLowerCase();
	}

	matches(e: Entry): boolean {
		const q = this.query();
		return q === "" || `${displayName(e)} ${projectName(e.project)} ${e.branch ?? ""}`.toLowerCase().includes(q);
	}

	rows(): Row[] {
		const rows: Row[] = [];
		const all = [...entries.values()].filter((e) => this.matches(e));
		const open = all.filter((e) => e.open);
		const pushGroups = (list: Entry[], depth: number, parent: string) => {
			for (const [project, group] of groupByProject(list)) {
				const key = `${parent}:${project}`;
				const collapsed = this.collapsed.has(key);
				rows.push({ kind: "header", key, project, count: group.length, depth, collapsed });
				if (collapsed) continue;
				for (const e of group) rows.push({ kind: "session", key: e.id, entry: e, depth, header: key });
			}
		};
		// A filter opens every section it has matches in, so a match is never hidden behind a caret.
		const section = (key: SectionKey, label: string, count: number) => {
			const expanded = this.expanded.has(key) || (this.query() !== "" && count > 0);
			rows.push({ kind: "section", key, label, count, expanded });
			return expanded;
		};
		const inactive = (e: Entry) => e.inactive && !launchFor(e.id);
		pushGroups(
			open.filter((e) => !inactive(e)),
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
			// Nothing chosen yet: land on the first session, and don't settle on a section before the first snapshot fills in.
			index = rows.findIndex((r) => r.kind === "session");
			if (index === -1) return 0;
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
		else if (k === "a") this.toggleArchived();
		else if (k === "y" || k === "Y") this.copy(k === "y");
		else if (k === "n") this.newHere();
		else if (k === "/") this.filtering = true;
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
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (event.y < this.listTop || event.y >= this.listTop + this.listHeight) return undefined;
		const rows = this.rows();
		const index = this.scrollTop + (event.y - this.listTop);
		const row = rows[index];
		if (!row) return undefined;
		this.selectedKey = row.key;
		this.lastIndex = index;
		stage.holdForNew = false;
		// Every click on a header toggles it; a session row needs a double-click to focus.
		if (isHeader(row)) this.toggle(row);
		else if ((event.clickCount ?? 1) >= 2) this.focusEntry(row.entry);
		this.syncStage(true);
		return { handled: true };
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

	newHere(): void {
		const row = this.selected();
		newSession(!row || row.kind === "section" ? here : row.kind === "session" ? row.entry.cwd : row.project);
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
		const detail = this.detail(width, now);
		const bodyHeight = Math.max(1, height - 5 - detail.length);
		const lines = [this.header(width), gray("─".repeat(width))];
		lines.push(...this.list(rows, index, width, bodyHeight, now));
		lines.push(gray("─".repeat(width)), ...detail, this.messageLine(now), this.hints());
		const out = lines.map((line) => truncateToWidth(line, width, "…", true));
		perf.render.add(performance.now() - t0);
		if (frameKeyAt > 0) {
			perf.keyToFrame.add(performance.now() - frameKeyAt);
			frameKeyAt = 0;
		}
		return out;
	}

	header(width: number): string {
		const all = [...entries.values()];
		const open = all.filter((e) => e.open && !e.inactive).length;
		const archived = all.filter((e) => !e.open).length;
		const tag = this.query() !== "" && !this.filtering ? ` ${magenta(`/${this.filter.getValue()}`)}` : "";
		return spread(` ${bold("swb")}${tag}`, gray(`${open} open · ${archived} arch `), width);
	}

	list(rows: Row[], index: number, width: number, height: number, now: number): string[] {
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
			out.push(this.scrollTop + i === index ? cursorLine(line, focus === "roster") : line);
		}
		if (rows.length === 0) out[0] = dim(snapshot ? (this.query() ? "   no matches" : "   no sessions yet · n new") : "   loading…");
		return out;
	}

	detail(width: number, now: number): string[] {
		const e = this.cursorEntry() ?? (stage.staged === null ? null : (entries.get(stage.staged) ?? null));
		if (!e) return ["", "", "", ""];
		const state = stateOf(e);
		const facts = [`${glyph(state, now)} ${LABEL[state]}`];
		if (state !== "loading" && state !== "archived") facts.push(e.live ? "live" : "not running");
		if (e.provisional) facts.push(gray("no prompt yet"));
		const where = `${shortPath(e.cwd)}${e.branch ? ` ${magenta(`⎇ ${e.branch}`)}` : ""}`;
		let onView = gray("not on view");
		if (stage.staged === e.id) {
			const kind = stage.applied.kind;
			const what = kind === "live" ? "" : kind === "loading" ? ": starting" : `: ${kind}`;
			const view = stage.applied.view === "pi" ? "" : ` · ${stage.applied.view}`;
			const focused = !terminalFocused ? gray(" · terminal unfocused") : focus === "stage" ? cyan(" · focused") : "";
			onView = `${focus === "stage" ? cyan("▌") : gray("▌")} on view${what}${view}${zoomed && !narrow ? " · zoomed" : ""}${focused}`;
		}
		return [` ${bold(displayName(e))}`, ` ${facts.join(gray(" · "))}`, ` ${gray(where)}`, ` ${onView}`].map((line) =>
			truncateToWidth(line, width, "…"),
		);
	}

	messageLine(now: number): string {
		toasts = toasts.filter((t) => t.until > now);
		const t = toasts.at(-1);
		if (!t) return "";
		return ` ${t.level === "error" ? red(`✗ ${t.text}`) : green(t.text)}`;
	}

	hints(): string {
		if (this.filtering) return ` ${this.filter.render(Math.max(10, ROSTER_WIDTH - 2))[0] ?? ""}`;
		if (focus === "stage")
			return ` ${[key(`${config.prefix} h`, "list"), key(`${config.prefix} z`, "zoom"), key(`${config.prefix} ?`, "keys")].join(" ")}`;
		const row = this.selected();
		if (row && isHeader(row)) return ` ${[key("⏎", "toggle"), key("n", "new"), key("?", "keys")].join(" ")}`;
		return ` ${[key("⏎", "focus"), key("w", "wake"), key("n", "new"), key("?", "keys")].join(" ")}`;
	}

	invalidate(): void {}
}

function rowLine(row: Row, width: number, now: number): string {
	if (row.kind === "header") {
		const count = row.collapsed ? gray(` (${row.count})`) : "";
		return `${" ".repeat(1 + row.depth * 2)}${row.collapsed ? "▸" : "▾"} ${bold(projectName(row.project))}${count}`;
	}
	if (row.kind === "section") return ` ${row.expanded ? "▾" : "▸"} ${row.label} ${gray(`(${row.count})`)}`;
	const e = row.entry;
	const mark = stage.staged === e.id ? (focus === "stage" ? cyan("▌") : "▌") : " ";
	const lead = `${mark}${" ".repeat(2 + row.depth * 2)}`;
	const when = e.open ? age(e.activityAt, now) : age(archivedKey(e), now);
	const worktree = e.cwd !== e.project ? magenta("⎇") : " ";
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
	await tmuxAsync(UI, "select-pane", ...(narrow ? ["-Z"] : []), "-t", rosterPane);
}

async function showHelp(): Promise<void> {
	const client = (await tmuxAsync(UI, "list-clients", "-t", `=${deck}`, "-F", "#{client_name}")).split("\n")[0];
	if (client) await tmuxAsync(UI, "display-popup", "-c", client, "-E", ...HELP_POPUP);
}

/** Below NARROW_BELOW columns the roster stands alone, and focus moves zoom along. */
async function layout(): Promise<void> {
	deckWidth = Number(await tmuxAsync(UI, "display", "-p", "-t", stagePane, "#{window_width}"));
	apply();
	await stageOps;
	const [zoomFlag, active] = (await tmuxAsync(UI, "display", "-p", "-t", stagePane, "#{window_zoomed_flag}\t#{pane_active}")).split("\t");
	const wasNarrow = narrow;
	narrow = deckWidth < NARROW_BELOW;
	if (narrow !== wasNarrow) {
		if (narrow) await tmuxAsync(UI, "set", "-t", deck, "@swb_narrow", "1");
		else await tmuxAsync(UI, "set", "-u", "-t", deck, "@swb_narrow");
		if (narrow && zoomFlag !== "1") await tmuxAsync(UI, "resize-pane", "-Z", "-t", active === "1" ? stagePane : rosterPane);
		if (!narrow && zoomFlag === "1") await tmuxAsync(UI, "resize-pane", "-Z", "-t", rosterPane);
	}
	zoomed = (await tmuxAsync(UI, "display", "-p", "-t", stagePane, "#{window_zoomed_flag}")) === "1";
}

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
		case "focus":
			focusedPane = argv[0] ?? "";
			focus = focusedPane === rosterPane ? "roster" : "stage";
			if (focus === "roster") for (const launch of launches) launch.keyboard = false;
			zoomed = (await tmuxAsync(UI, "display", "-p", "-t", stagePane, "#{window_zoomed_flag}")) === "1";
			apply();
			break;
		case "terminal-focus": {
			const focused = argv[0] === "in";
			if (focused === terminalFocused) break;
			terminalFocused = focused;
			if (focused) {
				terminalFocusedAt = Date.now();
				if (piShown(stage.applied) && stage.applied.id) armVisit(stage.applied.id);
			} else {
				if (stage.visitTimer) clearTimeout(stage.visitTimer);
				stage.visitTimer = null;
				if (piShown(stage.applied) && stage.applied.id && stage.visited) post({ type: "visit", id: stage.applied.id });
				stage.visited = false;
			}
			break;
		}
		case "layout":
			await layout();
			break;
		case "view-swap":
		case "view-split":
			await changeView(cmd === "view-swap");
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
	const onStage = focus === "stage";
	let next: View;
	if (swap) next = showing === "editor" ? "pi" : "editor";
	else if (saved !== "split") next = "split";
	else next = showing === "split" && onStage && focusedPane === stagePane ? "editor" : "pi";
	if (next !== "pi") {
		editorsAsked.delete(e.cwd);
		editorsLost.delete(e.cwd);
		if ((await requestEditor(e.cwd)) === null || stage.applied.id !== e.id) return;
	}
	if (next === "split" && deckWidth < SPLIT_FROM) toast(`split needs ${SPLIT_FROM} columns; showing pi`, "info");
	if (!narrow) await tmuxAsync(UI, "if", "-F", "#{window_zoomed_flag}", `resize-pane -Z -t ${quote(stagePane)}`);
	localViews.set(e.id, next);
	post({ type: "view", id: e.id, view: next });
	apply();
	await stageOps;
	if (onStage) {
		const pane = next === "split" && showing === "pi" && side ? side.pane : stagePane;
		await tmuxAsync(UI, "select-pane", ...(narrow ? ["-Z"] : []), "-t", pane);
	}
	zoomed = (await tmuxAsync(UI, "display", "-p", "-t", stagePane, "#{window_zoomed_flag}")) === "1";
}

// ── view state ──────────────────────────────────────────────────────────

function viewState(): DeckState {
	const rows = roster.rows();
	const index = roster.resolveCursor(rows);
	const cursorRow = rows[index];
	const applied = stage.applied;
	const staged = applied.id === null ? undefined : entries.get(applied.id);
	return {
		deck,
		ready,
		terminalFocused,
		cursor: cursorRow?.kind === "session" ? cursorRow.entry.id : null,
		cursorRow: index,
		mode: roster.filtering ? "filter" : "roster",
		filter: roster.query(),
		focus: focus === "roster" ? "roster" : focusedPane === stagePane && applied.view !== "pi" ? "editor" : "stage",
		staged: {
			id: applied.id,
			host: applied.host,
			kind: applied.kind,
			view: applied.view,
			savedView: staged ? viewOf(staged) : "pi",
		},
		layout: { width: deckWidth, rosterOnly: narrow, split: side !== null, zoomed },
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
					}
				: row.kind === "header"
					? { kind: "header", project: projectName(row.project), expanded: !row.collapsed }
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
async function queryColors(scheme: string | null): Promise<void> {
	const { foreground, background } = await tui.queryTerminalColors({ timeoutMs: 200 });
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

post({ type: "init", deck, paths, config });
if (args.new) newSession(args.new);
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
	const now = Date.now();
	if (toasts.some((t) => t.until <= now) || launches.length > 0 || [...entries.values()].some((e) => e.activity === "blocked"))
		tui.requestRender();
}, 100);
