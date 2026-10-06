// PROTOTYPE, never ships. The Deck's roster pane: a pi-tui app that drives the Stage pane beside it.
// Runs inside the mock UI server; launched by deck.ts. See README.md.
//
// It talks to the sessions server over one tmux control-mode client (commands and %sessions-changed
// notifications), reads fake-pi runtime files for activity, and serves its view state on a unix socket.

import { appendFileSync, existsSync, readdirSync, rmSync, watch } from "node:fs";
import { basename } from "node:path";
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
import type { StageCard } from "./placeholder.ts";
import {
	type Activity,
	age,
	attention,
	bold,
	cyan,
	DIR,
	dim,
	flashOn,
	gray,
	green,
	HOVER_MS,
	HOUR,
	hex4,
	type Marks,
	magenta,
	paths,
	placeholderSession,
	type Runtime,
	readJson,
	red,
	type SeedSession,
	SESSIONS_SERVER,
	STATE,
	shortPath,
	spinnerFrame,
	type Turn,
	UI_SERVER,
	UNDO_MS,
	VISIT_MS,
	writeJsonAtomic,
	yellow,
} from "./shared.ts";

const deck = process.env.SWB_DECK_ID!;
const stagePane = process.env.SWB_STAGE_PANE!;
const rosterPane = process.env.TMUX_PANE!;
const placeholder = placeholderSession(deck);
const fakepiTui = process.env.FAKEPI_TUI === "regular" ? "regular" : "fullscreen";
const INACTIVE_AFTER_MS = 72 * HOUR;

const env = { ...process.env };
delete env.TMUX;
delete env.TMUX_PANE;

const log = (msg: string) => appendFileSync(paths.deckLog(deck), `${new Date().toISOString()} ${msg}\n`);

// ── perf ────────────────────────────────────────────────────────────────

class Stat {
	n = 0;
	last = 0;
	sum = 0;
	max = 0;
	add(ms: number): void {
		this.n++;
		this.last = ms;
		this.sum += ms;
		this.max = Math.max(this.max, ms);
	}
	toJSON() {
		const r = (x: number) => Math.round(x * 100) / 100;
		return { n: this.n, lastMs: r(this.last), avgMs: r(this.n ? this.sum / this.n : 0), maxMs: r(this.max) };
	}
}
const perf = {
	switchClient: new Stat(),
	keyToSwitch: new Stat(),
	render: new Stat(),
	newSession: new Stat(),
	startToReady: new Stat(),
	uiCommand: new Stat(),
	// Rows that differ from the previous frame, on frames the 100 ms ticker drew (flash, spinner, countdowns).
	tickRowsChanged: new Stat(),
	// Bytes pi-tui wrote to the roster's tty per write: its line diff only rewrites rows that changed.
	tickWriteBytes: new Stat(),
};
// Set by the ticker, cleared by the frame it requested (or by a keypress, whose frame comes first).
let ticking = false;

// ── tmux ────────────────────────────────────────────────────────────────

// One control-mode client on the sessions server. Every command is one line; every reply is one %begin/%end block.
class TmuxControl {
	private pending: { resolve: (out: string) => void; reject: (e: Error) => void }[] = [];
	private block: { flags: number; lines: string[] } | null = null;
	private proc: Bun.Subprocess<"pipe", "pipe", "pipe">;

	constructor(server: string, session: string, readonly onNotify: (line: string) => void) {
		this.proc = Bun.spawn(["tmux", "-L", server, "-C", "attach", "-f", "ignore-size,no-output", "-t", `=${session}`], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		void this.read();
	}

	private async read(): Promise<void> {
		const decoder = new TextDecoder();
		let buf = "";
		for await (const chunk of this.proc.stdout) {
			buf += decoder.decode(chunk, { stream: true });
			let nl = buf.indexOf("\n");
			while (nl !== -1) {
				this.line(buf.slice(0, nl));
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
			}
		}
		log("control client exited");
	}

	private line(line: string): void {
		if (this.block) {
			if (line.startsWith("%end ") || line.startsWith("%error ")) {
				const { flags, lines } = this.block;
				this.block = null;
				if ((flags & 1) === 0) return;
				const p = this.pending.shift()!;
				if (line.startsWith("%end ")) p.resolve(lines.join("\n"));
				else p.reject(new Error(lines.join("\n")));
			} else {
				this.block.lines.push(line);
			}
			return;
		}
		if (line.startsWith("%begin ")) {
			this.block = { flags: Number(line.split(" ")[3]), lines: [] };
			return;
		}
		if (line.startsWith("%")) this.onNotify(line);
	}

	run(command: string): Promise<string> {
		return new Promise((resolve, reject) => {
			this.pending.push({ resolve, reject });
			this.proc.stdin.write(`${command}\n`);
			this.proc.stdin.flush();
		});
	}
}

function q(s: string): string {
	if (s.includes("'")) throw new Error(`can't quote ${s}`);
	return `'${s}'`;
}

async function ui(...args: string[]): Promise<string> {
	const t0 = performance.now();
	const p = Bun.spawn(["tmux", "-L", UI_SERVER, ...args], { env, stdout: "pipe", stderr: "pipe" });
	const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
	perf.uiCommand.add(performance.now() - t0);
	if (code !== 0) throw new Error(`tmux -L ${UI_SERVER} ${args.join(" ")}: ${err.trim()}`);
	return out.trim();
}

function uiSync(...args: string[]): string {
	const r = Bun.spawnSync(["tmux", "-L", UI_SERVER, ...args], { env });
	if (r.exitCode !== 0) throw new Error(`tmux -L ${UI_SERVER} ${args.join(" ")}: ${r.stderr.toString().trim()}`);
	return r.stdout.toString().trim();
}

// ── model ───────────────────────────────────────────────────────────────

interface Session extends SeedSession {}

const sessions: Session[] = readJson<SeedSession[]>(paths.seed);
if (existsSync(paths.marks)) {
	const marks = readJson<Marks>(paths.marks);
	for (const s of sessions) {
		const m = marks[s.id];
		if (m) {
			s.archivedAt = m.archivedAt;
			s.visitedAt = m.visitedAt;
		}
	}
}
function saveMarks(): void {
	const marks: Marks = {};
	for (const s of sessions) marks[s.id] = { archivedAt: s.archivedAt, visitedAt: s.visitedAt };
	writeJsonAtomic(paths.marks, marks);
}
const byId = (id: string) => sessions.find((s) => s.id === id)!;

const runtimes = new Map<string, Runtime>();
const piSessions = new Map<string, string>(); // session id → tmux session name
const editors = new Map<string, string>(); // cwd → tmux session name
const starting = new Map<string, number>(); // session id → start requested at
const archiving = new Set<string>();

function loadRuntime(file: string): void {
	if (!file.endsWith(".json")) return;
	let rt: Runtime;
	try {
		rt = readJson<Runtime>(`${paths.rt}/${file}`);
	} catch {
		return; // a rename in flight
	}
	runtimes.set(rt.id, rt);
	const s = sessions.find((x) => x.id === rt.id);
	if (!s) return;
	const requested = starting.get(rt.id);
	if (rt.ready && requested !== undefined && piSessions.get(rt.id) === rt.tmux) {
		perf.startToReady.add(Date.now() - requested);
		starting.delete(rt.id);
	}
	if (s.archivedAt !== null && rt.lastPromptAt > s.archivedAt) {
		s.archivedAt = null;
		saveMarks();
		toast(`a prompt unarchived “${s.title}”`, "info");
	}
}

type State = "loading" | "blocked" | "working" | "unseen" | "idle" | "dormant" | "interrupted";

const isLive = (s: Session) => piSessions.has(s.id);
const isReady = (s: Session) => isLive(s) && runtimes.get(s.id)?.ready === true && runtimes.get(s.id)?.tmux === piSessions.get(s.id);
const isLoading = (s: Session) => starting.has(s.id) || (isLive(s) && !isReady(s));
const activityOf = (s: Session): Activity => runtimes.get(s.id)?.activity ?? s.activity;
const activityAtOf = (s: Session): number => runtimes.get(s.id)?.activityAt ?? s.activityAt;
const isInterrupted = (s: Session) => !isLive(s) && !starting.has(s.id) && activityOf(s) !== "idle";

function isUnseen(s: Session): boolean {
	if (activityOf(s) !== "idle" || activityAtOf(s) <= s.visitedAt) return false;
	return !(stage.applied.kind === "session" && stage.applied.id === s.id && deckFocused);
}

function stateOf(s: Session): State {
	if (isLoading(s)) return "loading";
	if (!isLive(s)) {
		if (isInterrupted(s)) return "interrupted";
		return isUnseen(s) ? "unseen" : "dormant";
	}
	const a = activityOf(s);
	if (a === "blocked") return "blocked";
	if (a === "working") return "working";
	return isUnseen(s) ? "unseen" : "idle";
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
};

function isInactive(s: Session, now: number): boolean {
	const state = stateOf(s);
	if (state === "blocked" || state === "unseen" || state === "loading") return false;
	return now - activityAtOf(s) > INACTIVE_AFTER_MS;
}

const archivedSortKey = (s: Session) => Math.max(activityAtOf(s), s.archivedAt!);

// ── toasts ──────────────────────────────────────────────────────────────

interface Toast {
	text: string;
	tone: "info" | "error";
	until: number;
}
let toasts: Toast[] = [];
function toast(text: string, tone: Toast["tone"]): void {
	toasts.push({ text, tone, until: Date.now() + 3500 });
	log(`toast ${tone}: ${text}`);
	tui.requestRender();
}

// ── Deck focus ──────────────────────────────────────────────────────────

let focus: "roster" | "stage" = "roster";
// No focus event has arrived yet when the Deck starts; assume the terminal that just launched it is focused.
let deckFocused = true;
let deckFocusedAt = Date.now();
let zoomed = false;

// ── stage ───────────────────────────────────────────────────────────────

type Applied =
	| { kind: "session"; id: string; target: string }
	| { kind: "editor"; id: string; target: string }
	| { kind: "card"; id: string | null; target: string; card: StageCard };

const EMPTY_CARD: StageCard = { tone: "empty", headline: "", title: "", path: "", lines: [], excerpts: null, keys: "", since: 0 };

const stage = {
	staged: null as string | null,
	mode: "session" as "session" | "editor",
	notRunning: null as string | null,
	stagedAt: 0,
	liveSince: 0,
	visited: false,
	applied: { kind: "card", id: null, target: placeholder, card: EMPTY_CARD } as Applied,
	cardJson: "",
	keyAt: 0,
	hover: null as { id: string; firesAt: number; timer: Timer } | null,
	// ⏎ on a session that isn't up yet: focus moves to it once pi is ready, if it's still the one on view.
	pendingFocus: null as string | null,
	tty: "",
};

function lastTurns(s: Session): StageCard["excerpts"] {
	const turns: Turn[] = existsSync(paths.transcript(s.id)) ? readJson<Turn[]>(paths.transcript(s.id)) : s.history;
	const prompt = turns.findLast((t) => t.who === "you");
	const reply = turns.findLast((t) => t.who === "agent");
	if (!prompt && !reply) return null;
	return { prompt: prompt?.text ?? "", reply: reply?.text ?? "" };
}

function card(s: Session, tone: StageCard["tone"], headline: string, lines: string[], keys: string, since = stage.stagedAt): StageCard {
	return { tone, headline, title: s.title, path: shortPath(s.cwd), lines, excerpts: lastTurns(s), keys, since };
}

const k = (key: string, label: string) => `${bold(key)} ${dim(label)}`;

function desired(): Applied {
	const s = stage.staged === null ? null : byId(stage.staged);
	if (!s) return { kind: "card", id: null, target: placeholder, card: { ...EMPTY_CARD, lines: ["Nothing selected."] } };
	if (stage.mode === "editor") {
		const name = editors.get(s.cwd);
		if (name) return { kind: "editor", id: s.id, target: name };
		stage.mode = "session";
	}
	const target = placeholder;
	const wakeKeys = [k("w", "wake"), k("⏎", "focus")];
	const keys = (s.archivedAt !== null ? [...wakeKeys, k("a", "unarchive")] : wakeKeys).join(gray(" · "));
	const countdown = hoverMode === "eager" && s.archivedAt === null && stage.hover?.id === s.id ? [`Starting in ${HOVER_MS} ms.`] : [];
	if (stage.notRunning === s.id) return { kind: "card", id: s.id, target, card: card(s, "not-running", "Not running", ["pi exited while it was on view."], keys) };
	if (isReady(s)) return { kind: "session", id: s.id, target: piSessions.get(s.id)! };
	if (isLoading(s)) {
		const line = stage.pendingFocus === s.id ? "Focus follows once it's up." : "Move away any time; it keeps starting.";
		return { kind: "card", id: s.id, target, card: card(s, "loading", "Starting pi…", [line], "", starting.get(s.id) ?? Date.now()) };
	}
	if (s.archivedAt !== null) {
		return { kind: "card", id: s.id, target, card: card(s, "archived", "Archived", [`Archived ${age(s.archivedAt, Date.now())} ago. A new prompt unarchives it.`], keys) };
	}
	if (isInterrupted(s)) {
		return { kind: "card", id: s.id, target, card: card(s, "interrupted", "⚠ Interrupted", ["pi exited mid-turn. Waking resumes it idle; the turn isn't continued.", ...countdown], keys) };
	}
	return { kind: "card", id: s.id, target, card: card(s, "idle", "Idle", countdown, keys) };
}

let applying = Promise.resolve();
function apply(): void {
	const d = desired();
	if (d.kind === "card") {
		const json = JSON.stringify(d.card);
		if (json !== stage.cardJson) {
			stage.cardJson = json;
			writeJsonAtomic(paths.deckStage(deck), d.card);
		}
	}
	const prev = stage.applied;
	stage.applied = d;
	const same = d.kind === "session" && prev.kind === "session" && prev.id === d.id;
	// A Visit when pi leaves a focused Stage (cursor moved, editor swapped in, pi quit), if it had been there 1 s.
	if (prev.kind === "session" && !same && stage.visited && deckFocused) visit(byId(prev.id));
	if (d.kind === "session" && !same) {
		stage.liveSince = Date.now();
		stage.visited = false;
	}
	if (d.kind === "session" && stage.pendingFocus === d.id) {
		stage.pendingFocus = null;
		void focusStage();
	}
	tui.requestRender();
	if (d.target === prev.target) return;
	Bun.write(paths.deckTarget(deck), d.target);
	const keyAt = stage.keyAt;
	stage.keyAt = 0;
	applying = applying.then(async () => {
		const t0 = performance.now();
		try {
			await ctl.run(`switch-client -c ${stage.tty} -t =${d.target}`);
			perf.switchClient.add(performance.now() - t0);
			if (keyAt > 0) {
				const ms = performance.now() - keyAt;
				perf.keyToSwitch.add(ms);
				if (ms > 50) log(`slow key → switch ${ms.toFixed(0)} ms (switch-client itself ${(performance.now() - t0).toFixed(0)} ms) to ${d.target}`);
			}
		} catch (e) {
			log(`switch-client ${d.target}: ${(e as Error).message}`); // the Stage client re-attaches to the target file
		}
	});
}

function stageSession(id: string): void {
	if (stage.staged === id) return;
	stage.staged = id;
	stage.pendingFocus = null;
	stage.mode = "session";
	stage.notRunning = null;
	stage.stagedAt = Date.now();
	scheduleHover();
	apply();
}

function scheduleHover(): void {
	if (stage.hover) clearTimeout(stage.hover.timer);
	stage.hover = null;
	const s = stage.staged === null ? null : byId(stage.staged);
	if (!s || hoverMode !== "eager" || s.archivedAt !== null || isLive(s) || starting.has(s.id) || stage.notRunning === s.id) return;
	const id = s.id;
	stage.hover = {
		id,
		firesAt: Date.now() + HOVER_MS,
		timer: setTimeout(() => {
			stage.hover = null;
			if (stage.staged === id) start(byId(id), "hover");
		}, HOVER_MS),
	};
}

function start(s: Session, why: string): void {
	if (isLive(s) || starting.has(s.id)) return;
	const name = `${s.project}-${hex4()}`;
	starting.set(s.id, Date.now());
	piSessions.set(s.id, name);
	log(`start ${s.title} as ${name} (${why})`);
	const t0 = performance.now();
	const cmd = `env -u TMUX -u TMUX_PANE SWB_MOCK_STATE=${STATE} FAKEPI_TUI=${fakepiTui} bun ${DIR}/fakepi.ts ${s.id}`;
	void ctl.run(`new-session -d -s ${name} -c ${q(s.cwd)} -e SWB_TMUX_NAME=${name} ${q(cmd)}`).then(() => perf.newSession.add(performance.now() - t0));
	void ctl.run(`set-option -t =${name}: @swb_id ${s.id}`);
	apply();
}

function visit(s: Session): void {
	s.visitedAt = Date.now();
	saveMarks();
	log(`visit ${s.title}`);
}

async function refreshSessions(): Promise<void> {
	const out = await ctl.run(`list-sessions -F '#{session_name}|#{@swb_id}|#{@swb_editor_dir}'`);
	const wasLive = new Set(piSessions.keys());
	const pi = new Map<string, string>();
	editors.clear();
	for (const line of out.split("\n").filter(Boolean)) {
		const [name, id, dir] = line.split("|") as [string, string, string];
		if (id) pi.set(id, name);
		else if (dir) editors.set(dir, name);
	}
	// Starts whose @swb_id is still in flight stay live.
	for (const [id, name] of piSessions) if (starting.has(id) && !pi.has(id)) pi.set(id, name);
	piSessions.clear();
	for (const [id, name] of pi) piSessions.set(id, name);
	for (const id of wasLive) {
		if (piSessions.has(id)) continue;
		starting.delete(id);
		if (archiving.delete(id)) continue;
		if (stage.staged === id && stage.mode === "session") {
			stage.notRunning = id;
			log(`not running: ${byId(id).title}`);
			// The card can't take keys, so focus goes back to where ⏎ restarts it.
			if (focus === "stage") void ui("select-pane", "-t", rosterPane);
		}
	}
	apply();
}

const ctl = new TmuxControl(SESSIONS_SERVER, placeholder, (line) => {
	if (line.startsWith("%sessions-changed")) void refreshSessions();
	else if (line.startsWith("%exit")) log(`control: ${line}`);
});

// ── roster ──────────────────────────────────────────────────────────────

let hoverMode: "eager" | "lazy" = process.env.SWB_HOVER === "eager" ? "eager" : "lazy";

type SectionKey = "inactive" | "archived";

type Row =
	| { kind: "project"; key: string; project: string; count: number; depth: number; collapsed: boolean; parent: SectionKey | null }
	| { kind: "session"; key: string; session: Session; depth: number; header: string }
	| { kind: "section"; key: SectionKey; label: string; count: number; expanded: boolean };

const isHeader = (row: Row) => row.kind !== "session";
const isCollapsed = (row: Row) => (row.kind === "project" ? row.collapsed : row.kind === "section" ? !row.expanded : false);

function groupByProject(list: Session[]): [string, Session[]][] {
	const groups = new Map<string, Session[]>();
	for (const s of [...list].sort((a, b) => activityAtOf(b) - activityAtOf(a))) {
		const group = groups.get(s.project) ?? [];
		group.push(s);
		groups.set(s.project, group);
	}
	return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

class Roster implements Component {
	selectedKey = "";
	lastIndex = 1;
	scrollTop = 0;
	collapsed = new Set<string>();
	expanded = new Set<SectionKey>();
	filter = new Input({ prompt: "/ " });
	filtering = false;
	pendingUndo: { id: string; until: number } | null = null;
	listHit = { top: 0, height: 0 };
	lastLines: string[] = [];

	constructor(readonly tui: TuiAltScreen) {
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

	matches(s: Session): boolean {
		const q = this.query();
		return q === "" || `${s.title} ${s.project} ${s.branch ?? ""}`.toLowerCase().includes(q);
	}

	rows(): Row[] {
		const now = Date.now();
		const rows: Row[] = [];
		const open = sessions.filter((s) => s.archivedAt === null && this.matches(s));
		const pushGroups = (list: Session[], depth: number, parent: SectionKey | null) => {
			for (const [project, group] of groupByProject(list)) {
				const key = `${parent ?? "open"}:${project}`;
				const collapsed = this.collapsed.has(key);
				rows.push({ kind: "project", key, project, count: group.length, depth, collapsed, parent });
				if (collapsed) continue;
				for (const s of group) rows.push({ kind: "session", key: s.id, session: s, depth, header: key });
			}
		};
		// A filter opens every section it has matches in, so a match is never hidden behind a caret.
		const section = (key: SectionKey, label: string, count: number) => {
			const expanded = this.expanded.has(key) || (this.query() !== "" && count > 0);
			rows.push({ kind: "section", key, label, count, expanded });
			return expanded;
		};
		pushGroups(open.filter((s) => !isInactive(s, now)), 0, null);
		const inactive = open.filter((s) => isInactive(s, now));
		if (inactive.length > 0 && section("inactive", "Inactive", inactive.length)) pushGroups(inactive, 1, "inactive");
		const archived = sessions.filter((s) => s.archivedAt !== null && this.matches(s)).sort((a, b) => archivedSortKey(b) - archivedSortKey(a));
		if (section("archived", "Archived", archived.length)) {
			for (const s of archived) rows.push({ kind: "session", key: s.id, session: s, depth: 0, header: "archived" });
		}
		return rows;
	}

	// The cursor follows the selected key through reorders; if that row vanished, it stays at the same index.
	resolveCursor(rows: Row[]): number {
		if (rows.length === 0) return -1;
		let index = rows.findIndex((r) => r.key === this.selectedKey);
		if (index === -1) index = Math.min(this.lastIndex, rows.length - 1);
		this.selectedKey = rows[index]!.key;
		this.lastIndex = index;
		return index;
	}

	selected(): Row | undefined {
		const rows = this.rows();
		return rows[this.resolveCursor(rows)];
	}

	cursorSession(): Session | null {
		const row = this.selected();
		return row?.kind === "session" ? row.session : null;
	}

	// The right pane follows the cursor onto session rows, and stays put while the cursor is on a header.
	syncStage(): void {
		const s = this.cursorSession();
		// Focus-once-up only holds while the cursor stays on that session.
		if (stage.pendingFocus !== null && s?.id !== stage.pendingFocus) stage.pendingFocus = null;
		if (s && s.id !== stage.staged) stageSession(s.id);
		else apply();
	}

	// ── input ─────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		ticking = false;
		tickFrame = false;
		stage.keyAt = performance.now();
		toasts = []; // the next keypress dismisses a message
		if (this.filtering) {
			if (matchesKey(data, "up") || matchesKey(data, "down")) this.move(matchesKey(data, "up") ? -1 : 1);
			else {
				this.filter.handleInput(data);
				// Typing a filter selects the first match unless the cursor's session still matches.
				const rows = this.rows();
				const first = rows.find((r) => r.kind === "session");
				if (first && !rows.some((r) => r.kind === "session" && r.key === this.selectedKey)) this.selectedKey = first.key;
			}
			this.syncStage();
			stage.keyAt = 0;
			this.tui.requestRender();
			return;
		}
		const key = decodeKittyPrintable(data) ?? data;
		if (matchesKey(data, "ctrl+c") || key === "q") return quit();
		if (matchesKey(data, "down") || key === "j") this.move(1);
		else if (matchesKey(data, "up") || key === "k") this.move(-1);
		else if (key === "g") this.move(-Infinity);
		else if (key === "G") this.move(Infinity);
		else if (matchesKey(data, "enter") || key === " ") this.activate();
		else if (matchesKey(data, "right") || key === "l") this.right();
		else if (matchesKey(data, "left") || key === "h") this.left();
		else if (matchesKey(data, "escape")) this.filter.setValue("");
		else if (key === "w") this.wake();
		else if (key === "a") this.toggleArchive();
		else if (key === "u") this.undo();
		else if (key === "/") this.filtering = true;
		else if (key === "?") void showHelp();
		else if (key === "H") toggleHover();
		this.syncStage();
		stage.keyAt = 0;
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const { top, height } = this.listHit;
		if (event.type === "wheel") {
			this.move(Math.sign(event.wheelDelta ?? 0));
			this.syncStage();
			return { handled: true };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (event.y < top || event.y >= top + height) return undefined;
		const rows = this.rows();
		const index = this.scrollTop + (event.y - top);
		if (index >= rows.length) return undefined;
		const row = rows[index]!;
		this.selectedKey = row.key;
		this.lastIndex = index;
		log(`click ${row.kind} ${row.key} x${event.clickCount ?? 1}`);
		// Every click on a header toggles it; a session row needs a double-click to focus.
		if (isHeader(row)) this.toggle(row);
		else if ((event.clickCount ?? 1) >= 2) this.activate();
		this.syncStage();
		return { handled: true };
	}

	move(delta: number): void {
		const rows = this.rows();
		const index = this.resolveCursor(rows);
		const next = Math.max(0, Math.min(rows.length - 1, index + delta));
		this.selectedKey = rows[next]!.key;
		this.lastIndex = next;
	}

	activate(): void {
		const row = this.selected();
		if (!row) return;
		if (row.kind === "session") this.focusSession(row.session);
		else this.toggle(row);
	}

	// ⏎ and l: wake it if needed, then focus it. A session that isn't up yet keeps the keyboard here until it is.
	focusSession(s: Session): void {
		stageSession(s.id);
		if (stage.notRunning === s.id) stage.notRunning = null;
		start(s, "enter");
		if (isReady(s)) void focusStage();
		else stage.pendingFocus = s.id;
		apply();
	}

	right(): void {
		const row = this.selected();
		if (!row) return;
		if (row.kind === "session") this.focusSession(row.session);
		else this.setExpanded(row, true);
	}

	left(): void {
		const row = this.selected();
		if (!row) return;
		if (row.kind === "session") this.selectedKey = row.header;
		else this.setExpanded(row, false);
	}

	wake(): void {
		const s = this.cursorSession();
		if (!s) return;
		if (stage.notRunning === s.id) stage.notRunning = null;
		if (isLive(s)) toast("already running", "info");
		start(s, "w");
	}

	toggle(row: Row): void {
		this.setExpanded(row, isCollapsed(row));
	}

	setExpanded(row: Row, expanded: boolean): void {
		if (row.kind === "project") {
			if (expanded) this.collapsed.delete(row.key);
			else this.collapsed.add(row.key);
		} else if (row.kind === "section") {
			if (expanded) this.expanded.add(row.key);
			else this.expanded.delete(row.key);
		}
	}

	toggleArchive(): void {
		const s = this.cursorSession();
		if (!s) return;
		if (s.archivedAt !== null) return this.unarchive(s);
		if (isLive(s) && activityOf(s) !== "idle") {
			toast("turn running: wait for it to complete", "error");
			return;
		}
		this.keepCursorInPlace();
		s.archivedAt = Date.now();
		saveMarks();
		this.pendingUndo = { id: s.id, until: Date.now() + UNDO_MS };
		const killed: string[] = [];
		const name = piSessions.get(s.id);
		if (name) {
			archiving.add(s.id);
			void ctl.run(`kill-session -t =${name}`);
			killed.push("pi");
		}
		const sharing = sessions.some((x) => x.id !== s.id && x.archivedAt === null && x.cwd === s.cwd);
		const editor = editors.get(s.cwd);
		if (editor && !sharing) {
			void ctl.run(`kill-session -t =${editor}`);
			killed.push("its directory's editor");
		}
		log(`archive ${s.title}; killed ${killed.join(" + ") || "nothing"}${editor && sharing ? "; editor kept (directory shared)" : ""}`);
	}

	unarchive(s: Session): void {
		this.keepCursorInPlace();
		s.archivedAt = null;
		saveMarks();
		log(`unarchive ${s.title}`);
		toast(`unarchived “${s.title}”`, "info");
	}

	// Archiving or unarchiving moves the row to another section. The cursor stays where it was, on the row that
	// followed it, instead of chasing the session across the roster.
	keepCursorInPlace(): void {
		const rows = this.rows();
		const index = this.resolveCursor(rows);
		this.selectedKey = (rows[index + 1] ?? rows[index - 1])?.key ?? "";
	}

	undo(): void {
		const pending = this.pendingUndo;
		if (!pending || Date.now() > pending.until) return;
		byId(pending.id).archivedAt = null;
		saveMarks();
		this.pendingUndo = null;
		this.selectedKey = pending.id;
	}

	// ── render ────────────────────────────────────────────────────────

	render(width: number): string[] {
		const t0 = performance.now();
		const height = this.tui.terminal.rows;
		const now = Date.now();
		const rows = this.rows();
		const index = this.resolveCursor(rows);
		const detail = this.detail(width, now);
		const bodyHeight = Math.max(1, height - 6 - detail.length);
		const lines = [this.header(width, now), gray("─".repeat(width))];
		lines.push(...this.list(rows, index, width, bodyHeight, now, 2));
		lines.push(gray("─".repeat(width)), ...detail, this.messageLine(width, now), this.hints(width), this.prototypeBar(width));
		const out = lines.map((l) => truncateToWidth(l, width, "…", true));
		perf.render.add(performance.now() - t0);
		if (ticking) perf.tickRowsChanged.add(out.filter((l, i) => l !== this.lastLines[i]).length);
		tickFrame = ticking;
		ticking = false;
		this.lastLines = out;
		return out;
	}

	header(width: number, now: number): string {
		const archived = sessions.filter((s) => s.archivedAt !== null).length;
		const filterTag = this.query() !== "" && !this.filtering ? ` ${magenta(`/${this.filter.getValue()}`)}` : "";
		const open = sessions.filter((s) => s.archivedAt === null);
		const inactive = open.filter((s) => isInactive(s, now)).length;
		const counts = width >= 40 ? `${open.length - inactive} open · ${archived} archived ` : `${open.length - inactive} open `;
		return spread(` ${bold("swb")}${filterTag}`, gray(counts), width);
	}

	list(rows: Row[], index: number, width: number, height: number, now: number, top: number): string[] {
		if (index < this.scrollTop) this.scrollTop = index;
		if (index >= this.scrollTop + height) this.scrollTop = index - height + 1;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, rows.length - height)));
		this.listHit = { top, height };
		const out: string[] = [];
		for (let i = 0; i < height; i++) {
			const r = rows[this.scrollTop + i];
			if (!r) {
				out.push(" ".repeat(width));
				continue;
			}
			const selected = this.scrollTop + i === index;
			const line = truncateToWidth(rowLine(r, width, now), width, "…", true);
			out.push(selected ? cursorLine(line, focus === "roster") : line);
		}
		if (rows.length === 0) out[0] = dim("   no matches");
		return out;
	}

	// The state label column from round 1's mock A moved here: one place for the four facts of the cursor's session.
	detail(width: number, now: number): string[] {
		const s = this.cursorSession() ?? (stage.staged === null ? null : byId(stage.staged));
		if (!s) return [" ", " ", " ", " "];
		const state = stateOf(s);
		const facts = [`${glyph(state, now)} ${LABEL[state]}`];
		if (state !== "loading") facts.push(isLive(s) ? "live" : "not running");
		if (s.archivedAt !== null) facts.push(yellow("archived"));
		const where = `${shortPath(s.cwd)}${s.branch ? ` ${magenta(`⎇ ${s.branch}`)}` : ""}`;
		let onView = gray("not on view");
		if (stage.staged === s.id) {
			const a = stage.applied;
			const what =
				a.kind === "session" ? "" : a.kind === "editor" ? `: editor (${process.env.EDITOR ?? "nvim"})` : a.card.tone === "loading" ? ": starting" : a.card.tone === "not-running" ? ": not running" : ": summary";
			const focused = !deckFocused ? gray(" · terminal unfocused") : focus === "stage" ? cyan(" · focused") : stage.pendingFocus === s.id ? cyan(" · focus when up") : "";
			onView = `${focus === "stage" ? cyan("▌") : gray("▌")} on view${what}${zoomed ? " · zoomed" : ""}${focused}`;
		}
		return [` ${bold(s.title)}`, ` ${facts.join(gray(" · "))}`, ` ${gray(where)}`, ` ${onView}`].map((l) => truncateToWidth(l, width, "…"));
	}

	messageLine(width: number, now: number): string {
		toasts = toasts.filter((t) => t.until > now);
		const t = toasts.at(-1);
		if (t) return ` ${t.tone === "error" ? red(`✗ ${t.text}`) : green(t.text)}`;
		if (this.pendingUndo && now > this.pendingUndo.until) this.pendingUndo = null;
		const pending = this.pendingUndo;
		if (!pending) return "";
		const left = Math.ceil((pending.until - now) / 1000);
		return ` ${yellow(`archived “${truncateToWidth(byId(pending.id).title, Math.max(8, width - 22), "…")}”`)} ${bold("u")} ${dim(`undo ${left}s`)}`;
	}

	hints(width: number): string {
		if (this.filtering) return ` ${this.filter.render(Math.max(10, width - 2))[0]!}`;
		if (focus === "stage") return ` ${[k("M-a h", "roster"), k("M-a e", "editor"), k("M-a z", "zoom"), k("M-a ?", "keys")].join(" ")}`;
		const row = this.selected();
		if (row && isHeader(row)) return ` ${[k("⏎", "toggle"), k("h/l", "fold"), k("?", "keys")].join(" ")}`;
		const archived = row?.kind === "session" && row.session.archivedAt !== null;
		return ` ${[k("⏎", "focus"), k("w", "wake"), k("a", archived ? "unarchive" : "archive"), k("?", "keys")].join(" ")}`;
	}

	prototypeBar(width: number): string {
		const bits = [` PROTO hover:${hoverMode} (H)`, `switch ${perf.switchClient.last.toFixed(1)}ms`, `render ${perf.render.last.toFixed(2)}ms`];
		return sgrBg("45;30", truncateToWidth(bits.join(" · "), width, "…", true));
	}

	invalidate(): void {}
}

// The cursor's background is mixed from the terminal's own background and foreground, as pi's system theme
// does, so it follows any theme. Until (or unless) the terminal reports its colors, reverse video stands in.
let cursorBg: { focused: string; unfocused: string } | null = null;
let terminalReport: { foreground: RgbColor | null; background: RgbColor | null; palette: number } | null = null;

function mix(a: RgbColor, b: RgbColor, t: number): string {
	const ch = (x: number, y: number) => Math.round(x + (y - x) * t);
	return `48;2;${ch(a.r, b.r)};${ch(a.g, b.g)};${ch(a.b, b.b)}`;
}

function cursorLine(line: string, focused: boolean): string {
	if (!cursorBg) return focused ? sgrBg("7", line) : sgrBg("4", line);
	return sgrBg(focused ? cursorBg.focused : cursorBg.unfocused, line);
}

function sgrBg(code: string, s: string): string {
	const open = `\x1b[${code}m`;
	return `${open}${s.replaceAll("\x1b[0m", `\x1b[0m${open}`).replaceAll("\x1b[49m", open)}\x1b[0m`;
}

function spread(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap < 1) return truncateToWidth(left, width, "…");
	return left + " ".repeat(gap) + right;
}

function rowLine(row: Row, width: number, now: number): string {
	if (row.kind === "project") {
		const caret = row.collapsed ? "▸" : "▾";
		const count = row.collapsed ? gray(` (${row.count})`) : "";
		return `${" ".repeat(1 + row.depth * 2)}${caret} ${bold(row.project)}${count}`;
	}
	if (row.kind === "section") {
		return ` ${row.expanded ? "▾" : "▸"} ${row.label} ${gray(`(${row.count})`)}`;
	}
	const s = row.session;
	const staged = stage.staged === s.id;
	const mark = staged ? (focus === "stage" ? cyan("▌") : "▌") : " ";
	const lead = `${mark}${" ".repeat(2 + row.depth * 2)}`;
	const when = s.archivedAt !== null ? age(archivedSortKey(s), now) : age(activityAtOf(s), now);
	const right = ` ${s.branch ? magenta("⎇") : " "} ${gray(when.padStart(3))} `;
	const titleWidth = width - visibleWidth(lead) - 2 - visibleWidth(right);
	const title = truncateToWidth(s.title, titleWidth, "…", true);
	const g = s.archivedAt !== null ? gray("✓") : glyph(stateOf(s), now);
	return `${lead}${g} ${title}${right}`;
}

// ── Deck actions ────────────────────────────────────────────────────────

async function focusStage(): Promise<void> {
	await ui("select-pane", "-t", stagePane);
}

async function zoom(): Promise<void> {
	if (!zoomed) await ui("select-pane", "-t", stagePane);
	await ui("resize-pane", "-Z", "-t", stagePane);
	await refreshZoom();
}

async function refreshZoom(): Promise<void> {
	zoomed = (await ui("display", "-p", "-t", stagePane, "#{window_zoomed_flag}")) === "1";
	tui.requestRender();
}

async function toggleEditor(): Promise<void> {
	const s = stage.staged === null ? null : byId(stage.staged);
	if (!s) return toast("nothing on view", "error");
	if (stage.mode === "editor") {
		stage.mode = "session";
		return apply();
	}
	if (!editors.has(s.cwd)) {
		const name = `${basename(s.cwd)}-edit-${hex4()}`;
		const editor = process.env.EDITOR ?? "nvim";
		editors.set(s.cwd, name);
		log(`editor ${name} for ${s.cwd}`);
		// Both lines go out before any %sessions-changed refresh can queue its list-sessions between them.
		const created = ctl.run(`new-session -d -s ${name} -c ${q(s.cwd)} ${q(`env -u TMUX -u TMUX_PANE ${editor}`)}`);
		const tagged = ctl.run(`set-option -t =${name}: @swb_editor_dir ${q(s.cwd)}`);
		await Promise.all([created, tagged]);
	}
	stage.mode = "editor";
	apply();
}

async function showHelp(): Promise<void> {
	const client = (await ui("list-clients", "-t", `=deck-${deck}`, "-F", "#{client_name}")).split("\n")[0];
	if (!client) return;
	await ui("display-popup", "-c", client, "-E", "-w", "66", "-h", "26", "-T", " swb keys ", `bash -c 'cat ${paths.help}; read -rsn1'`);
}

function toggleHover(): void {
	hoverMode = hoverMode === "eager" ? "lazy" : "eager";
	toast(`hover: ${hoverMode}`, "info");
	scheduleHover();
}

function quit(): void {
	void ui("kill-session", "-t", `=deck-${deck}`);
}

function cleanup(): never {
	Bun.spawnSync(["tmux", "-L", SESSIONS_SERVER, "kill-session", "-t", `=${placeholder}`], { env });
	rmSync(paths.deckSock(deck), { force: true });
	process.exit(0);
}
process.on("SIGHUP", cleanup);
process.on("SIGTERM", cleanup);

// ── view state ──────────────────────────────────────────────────────────

function stageKind(): string {
	const a = stage.applied;
	if (a.kind === "session") return "live";
	if (a.kind === "editor") return "editor";
	return a.card.tone;
}

function viewState() {
	const now = Date.now();
	const row = roster.selected();
	const titleOf = (id: string | null) => (id === null ? null : byId(id).title);
	return {
		deck,
		size: { cols: tui.terminal.columns, rows: tui.terminal.rows },
		focus,
		deckFocused,
		zoomed,
		filter: roster.query() === "" ? null : roster.query(),
		hover: {
			mode: hoverMode,
			pending: stage.hover ? { title: titleOf(stage.hover.id), firesInMs: Math.max(0, stage.hover.firesAt - now) } : null,
		},
		cursor: row ? { kind: row.kind, title: row.kind === "session" ? row.session.title : row.kind === "project" ? row.project : row.label } : null,
		stage: {
			title: titleOf(stage.staged),
			mode: stage.mode,
			kind: stageKind(),
			notRunning: stage.notRunning !== null,
			onStageMs: stage.staged === null ? 0 : now - stage.stagedAt,
			pendingFocus: titleOf(stage.pendingFocus),
			tmuxTarget: stage.applied.target,
		},
		toasts: toasts.filter((t) => t.until > now).map((t) => ({ text: t.text, tone: t.tone })),
		undo: roster.pendingUndo && roster.pendingUndo.until > now ? { title: titleOf(roster.pendingUndo.id), inMs: roster.pendingUndo.until - now } : null,
		rows: roster.rows().map((r) =>
			r.kind === "session"
				? { kind: "session", title: r.session.title, state: stateOf(r.session), archived: r.session.archivedAt !== null, staged: stage.staged === r.session.id }
				: r.kind === "project"
					? { kind: "project", title: r.project, collapsed: r.collapsed }
					: { kind: "section", title: r.label, count: r.count, expanded: r.expanded },
		),
		sessions: sessions.map((s) => ({
			title: s.title,
			state: stateOf(s),
			live: isLive(s),
			ready: isReady(s),
			activity: activityOf(s),
			unseen: isUnseen(s),
			archived: s.archivedAt !== null,
			cwd: shortPath(s.cwd),
			theme: isLive(s) ? (runtimes.get(s.id)?.theme ?? null) : null,
		})),
		editors: [...editors.keys()].map(shortPath),
		terminalColors: terminalReport,
		perf,
	};
}

// ── main ────────────────────────────────────────────────────────────────

stage.tty = uiSync("display", "-p", "-t", stagePane, "#{pane_tty}");
const terminal = new ProcessTerminal();
const write = terminal.write.bind(terminal);
let tickFrame = false;
terminal.write = (data: string) => {
	if (tickFrame && data.length > 0) {
		perf.tickWriteBytes.add(Buffer.byteLength(data));
		tickFrame = false;
	}
	write(data);
};
const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
const roster = new Roster(tui);
tui.setLayoutRoot(roster);
tui.setFocus(roster);
tui.start();
// Like pi: query the colors, and again on every light/dark report (997). The roster starts before the Deck's
// client attaches, so the first query gets nothing; tmux sends a 997 on attach, and that query gets everything.
async function queryColors(why: string): Promise<void> {
	const { foreground, background, palette } = await tui.queryTerminalColors({ timeoutMs: 100 });
	log(`terminal colors (${why}): fg ${JSON.stringify(foreground)} bg ${JSON.stringify(background)} palette ${palette ? "16/16" : "none"}`);
	terminalReport = { foreground: foreground ?? null, background: background ?? null, palette: palette?.length ?? 0 };
	cursorBg = background && foreground ? { focused: mix(background, foreground, 0.2), unfocused: mix(background, foreground, 0.08) } : null;
	tui.requestRender();
}
tui.onTerminalColorSchemeChange((scheme) => void queryColors(`997 ${scheme}`));
tui.setTerminalColorSchemeNotifications(true);
void queryColors("start");

rmSync(paths.deckSock(deck), { force: true });
Bun.serve({
	unix: paths.deckSock(deck),
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname;
		if (path === "/state") return Response.json(viewState());
		if (path === "/cmd/editor") await toggleEditor();
		else if (path === "/cmd/zoom") await zoom();
		else if (path === "/ev/pane") {
			focus = `%${url.searchParams.get("id")}` === stagePane ? "stage" : "roster";
			await refreshZoom();
		} else if (path === "/ev/client-focus") {
			deckFocused = url.searchParams.get("in") === "1";
			if (deckFocused) deckFocusedAt = Date.now();
			const a = stage.applied;
			if (!deckFocused && a.kind === "session" && stage.visited) visit(byId(a.id));
		} else if (path === "/ev/resized") {
			const w = Number(await ui("display", "-p", "-t", stagePane, "#{window_width}"));
			await ui("resize-pane", "-t", rosterPane, "-x", String(Math.max(32, Math.min(44, Math.round(w * 0.3)))));
		} else return new Response("not found", { status: 404 });
		tui.requestRender();
		return new Response("ok");
	},
});

for (const f of readdirSync(paths.rt)) loadRuntime(f);
// Data changes only re-apply the Stage; only input moves it (roster.syncStage).
watch(paths.rt, (_event, file) => {
	if (file === null) return;
	loadRuntime(file);
	apply();
});

await refreshSessions();
roster.syncStage();

setInterval(() => {
	const a = stage.applied;
	if (a.kind === "session" && deckFocused && !stage.visited && Date.now() - Math.max(stage.liveSince, deckFocusedAt) >= VISIT_MS) {
		stage.visited = true;
		visit(byId(a.id));
	}
	ticking = true;
	tui.requestRender();
}, 100);
log(`deck ${deck} up; stage client ${stage.tty}`);
