// PROTOTYPE, never ships. Wayfinding ticket 09: does the roster feel right in a real terminal?
// Fake in-memory data only. No db, no tmux, no Ghostty. See README.md.

import {
	type Component,
	decodeKittyPrintable,
	Input,
	isKeyRelease,
	matchesKey,
	type OverlayHandle,
	ProcessTerminal,
	Text,
	TuiAltScreen,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

// The A↔C switch. Tweak here, with SWB_BREAKPOINT=120, or live with [ and ].
const DEFAULT_BREAKPOINT = 110;
const UNDO_MS = 5000;
const TICK_MS = 3000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const INACTIVE_AFTER_MS = 72 * HOUR;

// ── ansi ────────────────────────────────────────────────────────────────

const sgr = (open: string, close: string) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
const bold = sgr("1", "22");
const dim = sgr("2", "22");
const red = sgr("31", "39");
const green = sgr("32", "39");
const yellow = sgr("33", "39");
const blue = sgr("34", "39");
const magenta = sgr("35", "39");
const cyan = sgr("36", "39");
const gray = sgr("90", "39");
const selectedBg = sgr("48;5;237", "49");
const protoBar = sgr("45;30", "49;39");

function fit(s: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(s, width, "…", true);
}

function spread(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap < 1) return fit(left, width);
	return left + " ".repeat(gap) + right;
}

// ── fake data ───────────────────────────────────────────────────────────

type Activity = "working" | "blocked" | "idle";
type State = "blocked" | "working" | "interrupted" | "unseen" | "dormant" | "idle";

interface Turn {
	who: "you" | "agent";
	at: number;
	text: string;
}

interface Session {
	id: string;
	uuid: string;
	title: string;
	project: string;
	branch: string | null;
	cwd: string;
	model: string;
	createdAt: number;
	live: boolean;
	// For a dormant session, the phase it was in when the process died.
	activity: Activity;
	activityAt: number;
	visitedAt: number;
	viewer: boolean;
	archivedAt: number | null;
	turns: Turn[];
}

let seed = 9;
function rand(): number {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function fakeUuid(): string {
	const hex = (n: number) =>
		Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
	return `019a${hex(4)}-${hex(4)}-7${hex(3)}-${hex(4)}-${hex(12)}`;
}

const PROJECT_DIRS: Record<string, string> = {
	ansiblonomicon: "~/code/personal/ansiblonomicon",
	"pi-sessions": "~/code/personal/pi-sessions",
	"harbor-deploy": "~/code/work/harbor-deploy",
	"agent-switchboard": "~/code/personal/agent-switchboard",
};

const START = Date.now();

interface Seed {
	title: string;
	project: string;
	branch?: string;
	live: boolean;
	activity: Activity;
	ago: number;
	seen: boolean;
	viewer?: boolean;
	archivedAgo?: number;
	you: string;
	agent: string;
}

function makeSession(s: Seed): Session {
	const uuid = fakeUuid();
	const activityAt = START - s.ago;
	const cwd = s.branch ? `${PROJECT_DIRS[s.project]}/.worktrees/${s.branch}` : PROJECT_DIRS[s.project]!;
	return {
		id: uuid.slice(-8),
		uuid,
		title: s.title,
		project: s.project,
		branch: s.branch ?? null,
		cwd,
		model: rand() < 0.7 ? "opus" : "sol",
		createdAt: activityAt - Math.floor(rand() * 6 * HOUR) - 20 * MINUTE,
		live: s.live,
		activity: s.activity,
		activityAt,
		visitedAt: s.seen ? activityAt : activityAt - 2 * MINUTE,
		viewer: s.viewer ?? false,
		archivedAt: s.archivedAgo === undefined ? null : START - s.archivedAgo,
		turns: [
			{ who: "you", at: activityAt - 2 * MINUTE, text: s.you },
			{ who: "agent", at: activityAt, text: s.agent },
		],
	};
}

const sessions: Session[] = [
	// open
	{ title: "Plan sessions v2 TUI", project: "ansiblonomicon", live: true, activity: "blocked", ago: 2 * MINUTE, seen: true, viewer: true, you: "grill me on the roster layout", agent: "Interview: sessions v2 — Round 2. Which mock should be the default?" },
	{ title: "Fix fnox host routing", project: "ansiblonomicon", live: true, activity: "working", ago: 0, seen: true, you: "fnox picks the wrong host on the work Mac, find out why", agent: "Reading fnox's host resolution order…" },
	{ title: "Retire uv.lock mask", project: "ansiblonomicon", branch: "uvlock", live: true, activity: "idle", ago: 14 * MINUTE, seen: false, you: "make the pull task handle the uv.lock mask on its own", agent: "Done. `mise run pull` now lifts the skip-worktree bit, checks out the lock, re-syncs, and re-masks." },
	{ title: "Ghostty quick terminal keybind for the dispatcher window and its focus-or-open fallback", project: "ansiblonomicon", live: true, activity: "idle", ago: 40 * MINUTE, seen: true, viewer: true, you: "bind the quick terminal to swb", agent: "Bound. The quick terminal now runs `swb` and focuses an existing instance." },
	{ title: "Pod042 herdr unit", project: "ansiblonomicon", live: false, activity: "idle", ago: 1 * DAY, seen: true, you: "write a systemd unit for herdr on pod042", agent: "Unit written and enabled. It restarts on failure with a 5 s backoff." },
	{ title: "Subagent report race when the parent compacts mid-handoff", project: "pi-sessions", live: false, activity: "working", ago: 3 * HOUR, seen: true, you: "reproduce the report race", agent: "Running the compaction scenario a third time with tracing on…" },
	{ title: "Search ranking relaxation for fuzzy titles", project: "pi-sessions", branch: "fuzzy-rank", live: true, activity: "working", ago: 6 * MINUTE, seen: true, you: "relax the title ranking so typos still match", agent: "Trying a trigram fallback after the exact-prefix pass." },
	{ title: "Canary rollback flag", project: "harbor-deploy", live: false, activity: "idle", ago: 2 * DAY, seen: true, you: "add a flag to roll back the canary", agent: "Added `--rollback-canary`. It reuses the previous release's values." },
	{ title: "Bump chart to 4.12 and regenerate the values schema for every environment overlay", project: "harbor-deploy", branch: "chart-4.12", live: false, activity: "idle", ago: 5 * HOUR, seen: false, you: "bump the chart and regenerate schemas", agent: "Bumped to 4.12. Regenerated 14 overlays; eu-central needed a manual fix for the new probe field." },
	{ title: "Flaky integration test in eu-west", project: "harbor-deploy", branch: "flaky-eu", live: true, activity: "blocked", ago: 25 * MINUTE, seen: true, you: "find out why the eu-west integration test flakes", agent: "Permission: run `kubectl delete pod` in the staging namespace?" },
	{ title: "Roster TUI prototype", project: "agent-switchboard", live: true, activity: "working", ago: 1 * MINUTE, seen: true, viewer: true, you: "build ticket 09's prototype", agent: "Rendering mock C beside mock A…" },
	{ title: "Recorder footer status", project: "agent-switchboard", branch: "recorder", live: true, activity: "idle", ago: 2 * HOUR, seen: true, you: "show a red footer when the recorder can't write", agent: "Done. A failed write sets `swb ✗ db locked` in pi's footer." },
	{ title: "GhosttyKit viewer seam spike", project: "agent-switchboard", live: false, activity: "idle", ago: 4 * DAY, seen: false, you: "spike the viewer seam over GhosttyKit", agent: "The seam works: new-tab and focus-terminal both round-trip in under 80 ms." },
	// inactive (72h+, never blocked or unseen)
	{ title: "Tailscale ACL audit", project: "ansiblonomicon", live: false, activity: "idle", ago: 5 * DAY, seen: true, you: "audit the tailnet ACLs", agent: "Two stale tags remain: tag:old-nas and tag:pod041." },
	{ title: "Handoff prompt template", project: "pi-sessions", branch: "handoff-v2", live: true, activity: "idle", ago: 4 * DAY, seen: true, you: "tighten the handoff prompt", agent: "Trimmed to 40 lines; the context block now comes first." },
	{ title: "Region failover runbook", project: "harbor-deploy", live: false, activity: "working", ago: 9 * DAY, seen: true, you: "draft the failover runbook", agent: "Drafting step 4 of 9: drain the primary region…" },
	// archived
	{ title: "Migrate UniFi provider fork", project: "ansiblonomicon", live: false, activity: "idle", ago: 5 * HOUR, archivedAgo: 3 * HOUR, seen: true, you: "move to the upstream provider", agent: "Migrated; the fork is no longer referenced." },
	{ title: "Search ranking relaxation", project: "pi-sessions", live: false, activity: "idle", ago: 1 * DAY, archivedAgo: 2 * DAY, seen: true, you: "first pass at ranking", agent: "Superseded by the fuzzy-rank worktree." },
	{ title: "fnox activation receipt", project: "ansiblonomicon", live: false, activity: "idle", ago: 3 * DAY, archivedAgo: 2 * DAY, seen: true, you: "print a receipt after activation", agent: "Added. It lists every exported key without values." },
	{ title: "Fix flaky canary test", project: "harbor-deploy", branch: "flaky", live: false, activity: "idle", ago: 4 * DAY, archivedAgo: 4 * DAY, seen: true, you: "fix the canary flake", agent: "Fixed: the test waited on the wrong readiness probe." },
	{ title: "Schema ticket grilling", project: "agent-switchboard", live: false, activity: "idle", ago: 6 * DAY, archivedAgo: 5 * DAY, seen: true, you: "grill the schema ticket", agent: "Three tables: sessions, runtimes, marks." },
	{ title: "Mise bootstrap on a clean HOME", project: "ansiblonomicon", live: false, activity: "idle", ago: 8 * DAY, archivedAgo: 7 * DAY, seen: true, you: "bootstrap from an empty HOME", agent: "Works once the pi shim is pinned to the real executable." },
	{ title: "Child bootstrap detection", project: "pi-sessions", branch: "child-boot", live: false, activity: "idle", ago: 10 * DAY, archivedAgo: 9 * DAY, seen: true, you: "detect subagents at startup", agent: "Detected through the durable child bootstrap entry." },
	{ title: "Values schema lint in CI", project: "harbor-deploy", live: false, activity: "idle", ago: 12 * DAY, archivedAgo: 11 * DAY, seen: true, you: "lint values against the schema in CI", agent: "Added a lint job; it fails on unknown keys." },
	{ title: "Ghostty AppleScript tab probe", project: "agent-switchboard", live: false, activity: "idle", ago: 13 * DAY, archivedAgo: 13 * DAY, seen: true, you: "probe Ghostty's scripting surface", agent: "1.3.1 creates a tab with cwd and command in one step." },
	{ title: "Pod042 restic schedule", project: "ansiblonomicon", live: false, activity: "idle", ago: 20 * DAY, archivedAgo: 15 * DAY, seen: true, you: "schedule restic on pod042", agent: "Nightly at 03:10 with a weekly prune." },
].map(makeSession);

// ── derived state ───────────────────────────────────────────────────────

function isUnseen(s: Session): boolean {
	return s.activity === "idle" && s.activityAt > s.visitedAt;
}

function stateOf(s: Session): State {
	if (!s.live) {
		if (s.activity !== "idle") return "interrupted";
		return isUnseen(s) ? "unseen" : "dormant";
	}
	if (s.activity === "blocked") return "blocked";
	if (s.activity === "working") return "working";
	return isUnseen(s) ? "unseen" : "idle";
}

const GLYPH: Record<State, string> = {
	blocked: bold(yellow("◆")),
	working: cyan("◐"),
	unseen: green("●"),
	idle: "○",
	dormant: gray("◌"),
	interrupted: red("⚠"),
};

const LABEL: Record<State, string> = {
	blocked: yellow("blocked"),
	working: cyan("working"),
	unseen: green("unseen"),
	idle: "idle",
	dormant: gray("dormant"),
	interrupted: red("interrupted"),
};

function isInactive(s: Session, now: number): boolean {
	const state = stateOf(s);
	if (state === "blocked" || state === "unseen") return false;
	return now - s.activityAt > INACTIVE_AFTER_MS;
}

function archivedSortKey(s: Session): number {
	return Math.max(s.activityAt, s.archivedAt!);
}

function age(at: number, now: number): string {
	const d = now - at;
	if (d < MINUTE) return "now";
	if (d < HOUR) return `${Math.floor(d / MINUTE)}m`;
	if (d < DAY) return `${Math.floor(d / HOUR)}h`;
	return `${Math.floor(d / DAY)}d`;
}

// ── activity tick ───────────────────────────────────────────────────────

const AGENT_FINISHES = [
	"Done. All checks pass.",
	"Finished. I left one TODO where the upstream API is unclear.",
	"Done; the diff is 3 files, +41 −12.",
];
const AGENT_ASKS = [
	"Permission: run `git push --force-with-lease`?",
	"Interview: which of two approaches should I take?",
	"Permission: write outside the workspace?",
];
const YOU_PROMPTS = ["looks good, now handle the error path", "try the other approach", "go ahead"];

function pick<T>(xs: readonly T[]): T {
	return xs[Math.floor(rand() * xs.length)]!;
}

function tick(): string {
	const now = Date.now();
	const live = sessions.filter((s) => s.archivedAt === null && s.live && !isInactive(s, now));
	const events = [
		{ from: "working", to: "idle", weight: 4 },
		{ from: "working", to: "blocked", weight: 1 },
		{ from: "blocked", to: "working", weight: 2 },
		{ from: "idle", to: "working", weight: 3 },
	].filter((e) => live.some((s) => s.activity === e.from));
	let r = rand() * events.reduce((sum, e) => sum + e.weight, 0);
	const event = events.find((e) => (r -= e.weight) < 0)!;
	const s = pick(live.filter((x) => x.activity === event.from));
	const before = GLYPH[stateOf(s)];
	if (event.to === "idle") {
		s.turns.push({ who: "agent", at: now, text: pick(AGENT_FINISHES) });
	} else if (event.to === "blocked") {
		s.turns.push({ who: "agent", at: now, text: pick(AGENT_ASKS) });
	} else {
		s.turns.push({ who: "you", at: now, text: event.from === "blocked" ? "yes" : pick(YOU_PROMPTS) });
		s.visitedAt = now;
	}
	s.activity = event.to as Activity;
	s.activityAt = now;
	return `${before}→${GLYPH[stateOf(s)]} ${s.title}`;
}

// ── roster model ────────────────────────────────────────────────────────

type Row =
	| { kind: "project"; key: string; project: string; count: number; depth: number; collapsed: boolean }
	| { kind: "session"; key: string; session: Session; depth: number }
	| { kind: "section"; key: "inactive" | "archived"; label: string; count: number; expanded: boolean };

type View = "main" | "archived";
type Layout = "A" | "C" | "D";

const VARIANTS = [
	{ key: "adaptive", name: "adaptive A↔C" },
	{ key: "forced-a", name: "forced A" },
	{ key: "forced-c", name: "forced C" },
	{ key: "stacked", name: "D stacked" },
] as const;

function groupByProject(list: Session[]): [string, Session[]][] {
	const groups = new Map<string, Session[]>();
	for (const s of [...list].sort((a, b) => b.activityAt - a.activityAt)) {
		const group = groups.get(s.project) ?? [];
		group.push(s);
		groups.set(s.project, group);
	}
	return [...groups.entries()];
}

function shortCwd(s: Session): string {
	const dir = PROJECT_DIRS[s.project]!;
	const parts = dir.split("/");
	const short = parts.map((p, i) => (i > 0 && i < parts.length - 1 ? p[0] : p)).join("/");
	return short + s.cwd.slice(dir.length);
}

class Roster implements Component {
	view: View = "main";
	variant = 0;
	breakpoint = Number(process.env.SWB_BREAKPOINT ?? DEFAULT_BREAKPOINT);
	tickOn = process.env.SWB_TICK !== "off";
	lastTick = "";
	selectedKey = "";
	lastIndex = 1;
	scrollTop = 0;
	collapsed = new Set<string>();
	inactiveExpanded = false;
	filter = new Input({ prompt: "/ " });
	filtering = false;
	pendingUndo: { id: string; until: number } | null = null;
	help: OverlayHandle | null = null;
	listHit = { top: 0, height: 0, width: 0 };

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
		if (q === "") return true;
		return `${s.title} ${s.project} ${s.branch ?? ""} ${s.id}`.toLowerCase().includes(q);
	}

	rows(): Row[] {
		const now = Date.now();
		const rows: Row[] = [];
		if (this.view === "archived") {
			const archived = sessions
				.filter((s) => s.archivedAt !== null && this.matches(s))
				.sort((a, b) => archivedSortKey(b) - archivedSortKey(a));
			for (const s of archived) rows.push({ kind: "session", key: s.id, session: s, depth: 0 });
			return rows;
		}
		const open = sessions.filter((s) => s.archivedAt === null && this.matches(s));
		const pushGroups = (list: Session[], depth: number, prefix: string) => {
			for (const [project, group] of groupByProject(list)) {
				const key = `${prefix}:${project}`;
				const collapsed = this.collapsed.has(key);
				rows.push({ kind: "project", key, project, count: group.length, depth, collapsed });
				if (collapsed) continue;
				for (const s of group) rows.push({ kind: "session", key: s.id, session: s, depth });
			}
		};
		pushGroups(open.filter((s) => !isInactive(s, now)), 0, "open");
		const inactive = open.filter((s) => isInactive(s, now));
		const inactiveExpanded = this.inactiveExpanded || (this.query() !== "" && inactive.length > 0);
		if (inactive.length > 0) {
			rows.push({ kind: "section", key: "inactive", label: "Inactive", count: inactive.length, expanded: inactiveExpanded });
			if (inactiveExpanded) pushGroups(inactive, 1, "inactive");
		}
		const archivedCount = sessions.filter((s) => s.archivedAt !== null && this.matches(s)).length;
		rows.push({ kind: "section", key: "archived", label: "Archived", count: archivedCount, expanded: false });
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

	layout(width: number): Layout {
		const key = VARIANTS[this.variant]!.key;
		if (key === "forced-a") return "A";
		if (key === "forced-c") return "C";
		if (key === "stacked") return "D";
		return width >= this.breakpoint ? "C" : "A";
	}

	selected(): Row | undefined {
		const rows = this.rows();
		return rows[this.resolveCursor(rows)];
	}

	// ── input ─────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (this.help) {
			this.help.hide();
			this.help = null;
			return;
		}
		if (this.filtering) {
			if (matchesKey(data, "up") || matchesKey(data, "down")) {
				this.move(matchesKey(data, "up") ? -1 : 1);
			} else {
				this.filter.handleInput(data);
			}
			this.tui.requestRender();
			return;
		}
		const key = decodeKittyPrintable(data) ?? data;
		if (matchesKey(data, "ctrl+c") || key === "q") {
			this.tui.stop();
			process.exit(0);
		}
		if (matchesKey(data, "down") || key === "j") this.move(1);
		else if (matchesKey(data, "up") || key === "k") this.move(-1);
		else if (key === "g") this.move(-Infinity);
		else if (key === "G") this.move(Infinity);
		else if (matchesKey(data, "enter") || key === " ") this.activate();
		else if (matchesKey(data, "right") || key === "l") this.setExpanded(true);
		else if (matchesKey(data, "left") || key === "h") this.setExpanded(false);
		else if (matchesKey(data, "escape")) this.back();
		else if (key === "a") this.archive();
		else if (key === "u") this.undo();
		else if (key === "U") this.unarchive();
		else if (key === "y") this.copyRow("cmd");
		else if (key === "Y") this.copyRow("ref");
		else if (key === "/") this.filtering = true;
		else if (key === "?") this.showHelp();
		else if (key === "t") this.tickOn = !this.tickOn;
		else if (key === ".") this.lastTick = tick();
		else if (key === "v") this.variant = (this.variant + 1) % VARIANTS.length;
		else if (key === "V") this.variant = (this.variant + VARIANTS.length - 1) % VARIANTS.length;
		else if (key === "]") this.breakpoint += 5;
		else if (key === "[") this.breakpoint -= 5;
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const { top, height, width } = this.listHit;
		if (event.type === "wheel") {
			this.move(Math.sign(event.wheelDelta ?? 0));
			return { handled: true };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (event.y < top || event.y >= top + height || event.x >= width) return undefined;
		const rows = this.rows();
		const index = this.scrollTop + (event.y - top);
		if (index >= rows.length) return undefined;
		this.selectedKey = rows[index]!.key;
		this.lastIndex = index;
		if ((event.clickCount ?? 1) >= 2) this.activate();
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
		if (row.kind === "session") {
			const s = row.session;
			s.visitedAt = Date.now();
			const note = s.archivedAt !== null ? " (unarchives on first turn)" : s.live ? "" : " (resumes it)";
			this.tui.flash(`would open ${s.id}${note}`, 2500);
		} else if (row.kind === "section" && row.key === "archived") {
			this.view = "archived";
			this.selectedKey = "";
			this.lastIndex = 0;
			this.scrollTop = 0;
		} else {
			this.setExpanded(row.kind === "project" ? row.collapsed : !row.expanded);
		}
	}

	setExpanded(expanded: boolean): void {
		const row = this.selected();
		if (!row) return;
		if (row.kind === "project") {
			if (expanded) this.collapsed.delete(row.key);
			else this.collapsed.add(row.key);
		} else if (row.kind === "section" && row.key === "inactive") {
			this.inactiveExpanded = expanded;
		}
	}

	back(): void {
		if (this.query() !== "") {
			this.filter.setValue("");
		} else if (this.view === "archived") {
			this.view = "main";
			this.selectedKey = "archived";
		}
	}

	archive(): void {
		const row = this.selected();
		if (row?.kind !== "session" || row.session.archivedAt !== null) return;
		row.session.archivedAt = Date.now();
		this.pendingUndo = { id: row.session.id, until: Date.now() + UNDO_MS };
	}

	undo(): void {
		const pending = this.pendingUndo;
		if (!pending || Date.now() > pending.until) return;
		sessions.find((s) => s.id === pending.id)!.archivedAt = null;
		this.pendingUndo = null;
		this.view = "main";
		this.selectedKey = pending.id;
	}

	unarchive(): void {
		const row = this.selected();
		if (row?.kind !== "session" || row.session.archivedAt === null) return;
		row.session.archivedAt = null;
		this.tui.flash(`unarchived ${row.session.id}`, 2500);
	}

	copyRow(what: "cmd" | "ref"): void {
		const row = this.selected();
		if (row?.kind !== "session") {
			this.tui.flash("nothing to copy: not a session", 2000);
			return;
		}
		const text = what === "cmd" ? `swb open ${row.session.id}` : `@session:${row.session.uuid}`;
		const result = Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(text) });
		if (result.exitCode !== 0) throw new Error(`pbcopy exited ${result.exitCode}: ${result.stderr}`);
		this.tui.flash(`copied ${text}`, 2500);
	}

	showHelp(): void {
		this.help = this.tui.showOverlay(new Text(HELP, 1, 1, (s) => `\x1b[48;5;235m${s}\x1b[49m`), {
			width: 62,
			nonCapturing: true,
		});
	}

	sweep(): void {
		if (this.pendingUndo && Date.now() > this.pendingUndo.until) this.pendingUndo = null;
	}

	invalidate(): void {}

	// ── render ────────────────────────────────────────────────────────

	render(width: number): string[] {
		const height = this.tui.terminal.rows;
		const now = Date.now();
		const layout = this.layout(width);
		const rows = this.rows();
		const index = this.resolveCursor(rows);
		const bodyHeight = Math.max(1, height - 5);

		const lines = [this.header(width, now), gray("─".repeat(width))];
		if (layout === "A") {
			lines.push(...this.list(rows, index, width, bodyHeight, now, 2, rowA));
		} else if (layout === "C") {
			const left = Math.max(34, Math.min(64, Math.round(width * 0.42)));
			const right = width - left - 3;
			const list = this.list(rows, index, left, bodyHeight, now, 2, rowC);
			const preview = this.preview(rows[index], right, bodyHeight, now);
			for (let i = 0; i < bodyHeight; i++) {
				lines.push(`${list[i]} ${gray("│")} ${fit(preview[i] ?? "", right)}`);
			}
		} else {
			const previewHeight = Math.max(8, Math.min(16, Math.floor(bodyHeight * 0.45)));
			const listHeight = bodyHeight - previewHeight - 1;
			lines.push(...this.list(rows, index, width, listHeight, now, 2, rowA));
			lines.push(gray("┄".repeat(width)));
			const preview = this.preview(rows[index], width - 2, previewHeight, now);
			for (let i = 0; i < previewHeight; i++) lines.push(` ${fit(preview[i] ?? "", width - 1)}`);
		}
		lines.push(this.messageRule(width, now), this.hints(width), this.prototypeBar(width, layout));
		return lines.map((l) => fit(l, width));
	}

	header(width: number, now: number): string {
		const archived = sessions.filter((s) => s.archivedAt !== null).length;
		const filterTag = this.query() !== "" && !this.filtering ? `  ${magenta(`/${this.filter.getValue()}`)} ${dim("(esc clears)")}` : "";
		if (this.view === "archived") {
			return spread(` ${bold("swb")} ${gray("›")} Archived${filterTag}`, gray(`${archived} `), width);
		}
		const open = sessions.filter((s) => s.archivedAt === null);
		const inactive = open.filter((s) => isInactive(s, now)).length;
		const counts = `${open.length - inactive} open · ${inactive} inactive · ${archived} archived `;
		return spread(` ${bold("swb")}${filterTag}`, gray(counts), width);
	}

	list(rows: Row[], index: number, width: number, height: number, now: number, top: number, row: RowRenderer): string[] {
		if (index < this.scrollTop) this.scrollTop = index;
		if (index >= this.scrollTop + height) this.scrollTop = index - height + 1;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, rows.length - height)));
		this.listHit = { top, height, width };
		const out: string[] = [];
		for (let i = 0; i < height; i++) {
			const r = rows[this.scrollTop + i];
			if (!r) {
				out.push(" ".repeat(width));
				continue;
			}
			const selected = this.scrollTop + i === index;
			const line = fit(row(r, selected, width, now), width);
			out.push(selected ? selectedBg(line) : line);
		}
		if (rows.length === 0) out[0] = fit(dim("   no matches"), width);
		const clip = (line: string) => truncateToWidth(line, width - 2, "", true);
		if (this.scrollTop > 0) out[0] = clip(out[0]!) + gray(" ↑");
		if (this.scrollTop + height < rows.length) out[height - 1] = clip(out[height - 1]!) + gray(" ↓");
		return out;
	}

	preview(row: Row | undefined, width: number, height: number, now: number): string[] {
		if (!row) return [];
		if (row.kind === "project") {
			const group = sessions.filter((s) => s.project === row.project && s.archivedAt === null);
			const counts = (["blocked", "working", "unseen", "interrupted", "idle", "dormant"] as State[])
				.map((st) => [st, group.filter((s) => stateOf(s) === st).length] as const)
				.filter(([, n]) => n > 0)
				.map(([st, n]) => `${GLYPH[st]} ${n} ${LABEL[st]}`);
			return [bold(row.project), dim(PROJECT_DIRS[row.project]!), "", ...counts, "", dim(row.collapsed ? "⏎ expand" : "⏎ collapse")];
		}
		if (row.kind === "section" && row.key === "inactive") {
			return [bold("Inactive"), dim("Open sessions with no activity for 72h."), dim("Blocked and unseen sessions never go inactive."), "", `${row.count} ${row.count === 1 ? "session" : "sessions"}`, "", dim(row.expanded ? "⏎ collapse" : "⏎ expand")];
		}
		if (row.kind === "section") {
			return [bold("Archived"), dim("Flat, newest first by max(activity, archived)."), dim("A new turn unarchives."), "", `${row.count} ${row.count === 1 ? "session" : "sessions"}`, "", dim("⏎ browse")];
		}
		const s = row.session;
		const state = stateOf(s);
		const out = wrapTextWithAnsi(bold(s.title), width).slice(0, 2);
		out.push(dim(shortCwd(s)));
		out.push(`${s.branch ? magenta(`⎇ ${s.branch}`) : gray("main")} ${gray("·")} pi ${gray("·")} ${s.model} ${gray("·")} ${age(s.createdAt, now)} old`);
		const runtime = s.live ? "live in tmux" : state === "interrupted" ? "died mid-turn, never auto-continued" : "resumes on open";
		const unseen = state !== "unseen" && isUnseen(s) ? ` ${gray("·")} ${green("unseen")}` : "";
		out.push(`${GLYPH[state]} ${LABEL[state]}${unseen} ${gray("·")} ${runtime} ${gray("·")} ${s.viewer ? blue("⧉ viewer open") : "no viewer"}`);
		if (s.archivedAt !== null) out.push(yellow(`archived ${age(s.archivedAt, now)} ago · unarchives on first turn`));
		out.push(gray(`${s.id} · @session:${s.uuid}`));
		out.push(gray("─".repeat(Math.min(width, 40))));
		// Newest turns that fit whole; if not even the newest fits, its head.
		const room = Math.max(0, height - out.length);
		let transcript: string[] = [];
		for (const turn of [...s.turns].reverse()) {
			const lines = [`${turn.who === "you" ? bold("you") : cyan("agent")} ${gray(age(turn.at, now))}`, ...wrapTextWithAnsi(turn.text, width)];
			if (transcript.length + lines.length > room) {
				if (transcript.length === 0) transcript = lines.slice(0, room);
				break;
			}
			transcript = [...lines, ...transcript];
		}
		return [...out, ...transcript];
	}

	messageRule(width: number, now: number): string {
		this.sweep();
		const pending = this.pendingUndo;
		if (!pending) return gray("─".repeat(width));
		const s = sessions.find((x) => x.id === pending.id)!;
		const left = Math.ceil((pending.until - now) / 1000);
		const message = ` archived “${truncateToWidth(s.title, 28, "…")}” · ${bold("u")} undo ${left}s `;
		const tail = Math.max(0, width - 3 - visibleWidth(message));
		return gray("──") + yellow(message) + gray("─".repeat(tail));
	}

	hints(width: number): string {
		if (this.filtering) {
			const input = this.filter.render(Math.max(10, width - 30))[0]!;
			return ` ${input}  ${dim("⏎ keep  esc clear  ↑↓ move")}`;
		}
		const k = (key: string, label: string) => `${bold(key)} ${dim(label)}`;
		if (this.view === "archived") {
			return ` ${[k("⏎", "open (unarchives on first turn)"), k("U", "unarchive"), k("esc", "back"), k("/", "filter"), k("?", "keys")].join("  ")}`;
		}
		return ` ${[k("⏎", "open"), k("a", "archive"), k("u", "undo"), k("y", "copy cmd"), k("Y", "copy @session"), k("/", "filter"), k("?", "keys")].join("  ")}`;
	}

	prototypeBar(width: number, layout: Layout): string {
		const v = VARIANTS[this.variant]!;
		const resolved = v.key === "adaptive" ? `→${layout}` : "";
		const bits = [
			` PROTOTYPE  ${this.variant + 1}/${VARIANTS.length} ${v.name}${resolved}`,
			`${width} cols, C≥${this.breakpoint}`,
			`tick ${this.tickOn ? "on" : "off"}`,
			this.lastTick === "" ? "v/V variant  ? keys" : `last ${this.lastTick}`,
		].filter((b) => b !== "");
		return protoBar(fit(bits.join("  ·  "), width));
	}
}

type RowRenderer = (row: Row, selected: boolean, width: number, now: number) => string;

function headerRow(row: Row, width: number): string {
	if (row.kind === "project") {
		const caret = row.collapsed ? "▸" : "▾";
		const count = row.collapsed ? gray(` (${row.count})`) : "";
		return fit(`${" ".repeat(1 + row.depth * 2)}${caret} ${bold(row.project)}${count}`, width);
	}
	if (row.kind === "section") {
		const caret = row.key === "archived" ? "›" : row.expanded ? "▾" : "▸";
		return fit(` ${caret} ${row.label} ${gray(`(${row.count})`)}`, width);
	}
	throw new Error("not a header");
}

// Past this, A's columns drift too far from the titles to read across.
const A_MAX_WIDTH = 104;

function rowA(row: Row, selected: boolean, fullWidth: number, now: number): string {
	const width = Math.min(fullWidth, A_MAX_WIDTH);
	if (row.kind !== "session") return headerRow(row, width);
	const s = row.session;
	const indent = 1 + row.depth * 2;
	const lead = `${" ".repeat(indent)}${selected ? "▸" : " "} `;
	if (s.archivedAt !== null) {
		const right = `  ${fit(s.project, 18)}  ${fit(s.branch ? magenta(`⎇ ${s.branch}`) : "", 12)}  ${age(archivedSortKey(s), now).padStart(4)} `;
		return lead + fit(s.title, width - visibleWidth(lead) - visibleWidth(right)) + right;
	}
	const state = stateOf(s);
	const right = `  ${fit(LABEL[state], 11)}  ${age(s.activityAt, now).padStart(4)}  ${s.viewer ? blue("⧉") : " "} `;
	const titleWidth = width - visibleWidth(lead) - 2 - visibleWidth(right);
	return `${lead}${GLYPH[state]} ${titleWithBranch(s, titleWidth)}${right}`;
}

function rowC(row: Row, selected: boolean, width: number, now: number): string {
	if (row.kind !== "session") return headerRow(row, width);
	const s = row.session;
	const indent = 1 + row.depth * 2;
	const lead = `${" ".repeat(indent)}${selected ? "▸" : " "} `;
	if (s.archivedAt !== null) {
		const right = ` ${gray(fit(s.project, 17))} ${age(archivedSortKey(s), now).padStart(4)}`;
		return lead + fit(s.title, width - visibleWidth(lead) - visibleWidth(right)) + right;
	}
	const state = stateOf(s);
	const right = ` ${gray(age(s.activityAt, now).padStart(4))} ${s.viewer ? blue("⧉") : " "}`;
	return `${lead}${GLYPH[state]} ${fit(s.title, width - visibleWidth(lead) - 2 - visibleWidth(right))}${right}`;
}

function titleWithBranch(s: Session, width: number): string {
	if (!s.branch || width < 24) return fit(s.title, width);
	const branch = magenta(`⎇ ${s.branch}`);
	const titleWidth = Math.min(visibleWidth(s.title), width - visibleWidth(branch) - 3);
	return fit(`${fit(s.title, titleWidth)}   ${branch}`, width);
}

const HELP = [
	bold("swb keys (prototype)"),
	"",
	"j/k ↑/↓   move          g/G   top / bottom",
	"⏎ space   open · toggle a group · browse Archived",
	"h/l ←/→   collapse / expand a group",
	"a         archive        u     undo (5 s)",
	"U         unarchive (in Archived)",
	"y         copy `swb open <id>`",
	"Y         copy `@session:<uuid>`",
	"/         filter         esc   clear filter · back",
	"q         quit",
	"",
	bold("prototype only"),
	"v/V       next / previous variant",
	"[ ]       breakpoint −5 / +5",
	"t         toggle activity tick   .  one tick now",
	"",
	dim("any key closes this"),
].join("\n");

// ── main ────────────────────────────────────────────────────────────────

const tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, { mouse: true });
const roster = new Roster(tui);
tui.setLayoutRoot(roster);
tui.setFocus(roster);
tui.start();

setInterval(() => tui.requestRender(), 250);
setInterval(() => {
	if (!roster.tickOn) return;
	roster.lastTick = tick();
	tui.requestRender();
}, TICK_MS);
