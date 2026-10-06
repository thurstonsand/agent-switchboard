// PROTOTYPE, never ships. Shared constants, fake data, and file formats for the Deck mock. See README.md.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DIR = import.meta.dir;
export const STATE = process.env.SWB_MOCK_STATE ?? "/tmp/swb-mock-PROTOTYPE";
export const CODE = join(STATE, "code");

export const SESSIONS_SERVER = "swb-mock";
export const UI_SERVER = "swb-mock-ui";
export const DRIVE_SERVER = "swb-mock-drive";

export const STARTUP_DELAY_MS = 1500;
export const HOVER_MS = 500;
export const VISIT_MS = 1000;
export const UNDO_MS = 5000;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const paths = {
	seed: join(STATE, "seed.json"),
	marks: join(STATE, "marks.json"),
	rt: join(STATE, "rt"),
	transcripts: join(STATE, "transcripts"),
	help: join(STATE, "help.txt"),
	uiConf: join(STATE, "ui.conf"),
	overlay: join(STATE, "sessions-overlay.conf"),
	hooksLog: join(STATE, "sessions-hooks.log"),
	deckSock: (deck: string) => join(STATE, `deck-${deck}.sock`),
	deckTarget: (deck: string) => join(STATE, `deck-${deck}.target`),
	deckStage: (deck: string) => join(STATE, `deck-${deck}.stage.json`),
	deckLog: (deck: string) => join(STATE, `deck-${deck}.log`),
	runtime: (id: string) => join(STATE, "rt", `${id}.json`),
	transcript: (id: string) => join(STATE, "transcripts", `${id}.json`),
};

export const placeholderSession = (deck: string) => `__stage-${deck}`;

export function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2));
	renameSync(tmp, path);
}

export function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function hex4(): string {
	return Math.floor(Math.random() * 0x10000)
		.toString(16)
		.padStart(4, "0");
}

// ── ansi ────────────────────────────────────────────────────────────────

const sgr = (open: string, close: string) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
export const bold = sgr("1", "22");
export const dim = sgr("2", "22");
export const italic = sgr("3", "23");
export const red = sgr("31", "39");
export const green = sgr("32", "39");
export const yellow = sgr("33", "39");
export const blue = sgr("34", "39");
export const magenta = sgr("35", "39");
export const cyan = sgr("36", "39");
export const gray = sgr("90", "39");
// The glimpse companion's attention dot (`--attention-dot`), so a blocked session reads the same everywhere.
export const attention = sgr("38;2;192;132;252", "39");
export const FLASH_MS = 500;
export const flashOn = (now: number) => Math.floor(now / FLASH_MS) % 2 === 0;
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinnerFrame = (now: number) => SPINNER[Math.floor(now / 80) % SPINNER.length]!;

// ── fake data ───────────────────────────────────────────────────────────

export type Activity = "working" | "blocked" | "idle";

export interface Turn {
	who: "you" | "agent" | "tool";
	text: string;
}

export interface SeedSession {
	id: string;
	title: string;
	project: string;
	cwd: string;
	branch: string | null;
	model: string;
	activity: Activity;
	activityAt: number;
	visitedAt: number;
	archivedAt: number | null;
	// Already running when the mock sessions server first comes up, as if it survived from an earlier Deck.
	prestart: Activity | null;
	history: Turn[];
	replies: string[];
}

// What the fake pi writes for the Deck, standing in for the recorder's runtimes row.
export interface Runtime {
	id: string;
	tmux: string;
	pid: number;
	ready: boolean;
	activity: Activity;
	activityAt: number;
	lastPromptAt: number;
	// How the fake pi themed itself, for the driver: pi's system theme only shows this as colors.
	theme: { appearance: "dark" | "light"; source: "background+palette" | "background" | "2031" | "COLORFGBG" | "default"; background: string | null } | null;
}

export interface Marks {
	[id: string]: { archivedAt: number | null; visitedAt: number };
}

const PROJECTS = ["agent-switchboard", "ansiblonomicon", "harbor-deploy", "pi-sessions"];

interface SeedSpec {
	title: string;
	project: string;
	worktree?: string;
	activity?: Activity;
	ago: number;
	seen: boolean;
	archivedAgo?: number;
	prestart?: Activity;
	history: Turn[];
	replies?: string[];
}

const SPECS: SeedSpec[] = [
	{
		title: "Deck mock round 2",
		project: "agent-switchboard",
		ago: 0,
		seen: true,
		activity: "working",
		prestart: "working",
		history: [
			{ who: "you", text: "build round 2 of the Deck mocks, then run the whole e2e suite against it" },
			{ who: "agent", text: "Starting with the harness: a hidden tmux server, `drive keys`, and `drive capture`." },
			{ who: "tool", text: "$ bun run drive start --size 140x40\nDeck ready in 412 ms" },
		],
	},
	{
		title: "Schema v1 grilling",
		project: "agent-switchboard",
		ago: 2 * HOUR,
		seen: false,
		history: [
			{ who: "you", text: "grill me on the runtimes table" },
			{ who: "agent", text: "Three questions left. First: should `runtimes.tmux_session` survive a reboot, or be cleared at boot?" },
			{ who: "you", text: "cleared at boot" },
			{ who: "agent", text: "Done. Updated ticket 03: the recorder truncates runtimes on its first write after boot. Two questions remain for next round." },
		],
	},
	{
		title: "Recorder footer status",
		project: "agent-switchboard",
		worktree: "recorder",
		ago: 1 * DAY,
		seen: true,
		history: [
			{ who: "you", text: "show a red footer when the recorder can't write" },
			{ who: "tool", text: "$ rg -n setStatus packages/pi/src\npackages/pi/src/recorder.ts:88:  ctx.ui.setStatus(\"swb\", status)" },
			{ who: "agent", text: "Done. A failed write sets `swb ✗ db locked` in pi's footer, and the next good write clears it." },
		],
	},
	{
		title: "Fix fnox host routing",
		project: "ansiblonomicon",
		ago: 12 * MINUTE,
		seen: false,
		prestart: "idle",
		history: [
			{ who: "you", text: "fnox picks the wrong host on the work Mac, find out why" },
			{ who: "tool", text: "$ fnox doctor --verbose\nhost: personal (matched by hostname glob 'ML-*')" },
			{ who: "agent", text: "Found it. The `ML-*` glob in `fnox.toml` matches the work Mac before the explicit work entry. I moved the explicit entry first; `fnox doctor` now reports `host: work`." },
		],
	},
	{
		title: "Retire uv.lock mask",
		project: "ansiblonomicon",
		ago: 5 * HOUR,
		seen: true,
		history: [
			{ who: "you", text: "make the pull task handle the uv.lock mask on its own" },
			{ who: "agent", text: "Done. `mise run pull` now lifts the skip-worktree bit, checks out the lock, re-syncs, and re-masks." },
		],
	},
	{
		title: "Pod042 herdr unit",
		project: "ansiblonomicon",
		activity: "working",
		ago: 7 * HOUR,
		seen: true,
		history: [
			{ who: "you", text: "write a systemd unit for herdr on pod042" },
			{ who: "agent", text: "Writing the unit, then I'll enable it and tail the journal…" },
			{ who: "tool", text: "$ ssh pod042 systemctl --user enable --now herdr\nCreated symlink …/herdr.service" },
		],
	},
	{
		title: "Flaky integration test in eu-west",
		project: "harbor-deploy",
		ago: 25 * MINUTE,
		seen: true,
		activity: "blocked",
		prestart: "blocked",
		history: [
			{ who: "you", text: "find out why the eu-west integration test flakes" },
			{ who: "tool", text: "$ kubectl -n staging get pods\nintegration-eu-west-7c9  0/1  CrashLoopBackOff  14" },
			{ who: "agent", text: "The pod is stuck in CrashLoopBackOff with a stale config map. Deleting it lets the deployment recreate it." },
		],
	},
	{
		title: "Canary rollback flag",
		project: "harbor-deploy",
		ago: 2 * DAY,
		seen: true,
		history: [
			{ who: "you", text: "add a flag to roll back the canary" },
			{ who: "agent", text: "Added `--rollback-canary`. It reuses the previous release's values." },
		],
	},
	{
		title: "Region failover runbook",
		project: "harbor-deploy",
		ago: 9 * DAY,
		seen: true,
		history: [
			{ who: "you", text: "draft the failover runbook" },
			{ who: "agent", text: "Drafted all 9 steps. Step 4 (drain the primary) needs a human to confirm the traffic numbers." },
		],
	},
	{
		title: "Search ranking relaxation for fuzzy titles",
		project: "pi-sessions",
		ago: 40 * MINUTE,
		seen: true,
		history: [
			{ who: "you", text: "relax the title ranking so typos still match" },
			{ who: "agent", text: "Added a trigram fallback after the exact-prefix pass. `deck mokc` now finds “Deck mock round 2”." },
		],
	},
	{
		title: "Subagent report race when the parent compacts mid-handoff",
		project: "pi-sessions",
		ago: 3 * HOUR,
		seen: true,
		history: [
			{ who: "you", text: "reproduce the report race" },
			{ who: "agent", text: "Reproduced 3 of 10 runs. The report lands while compaction holds the session lock; it needs a retry queue." },
		],
	},
	// archived
	{
		title: "Migrate UniFi provider fork",
		project: "ansiblonomicon",
		ago: 5 * HOUR,
		archivedAgo: 3 * HOUR,
		seen: true,
		history: [
			{ who: "you", text: "move to the upstream provider" },
			{ who: "agent", text: "Migrated; the fork is no longer referenced." },
		],
	},
	{
		title: "Ghostty AppleScript tab probe",
		project: "agent-switchboard",
		ago: 13 * DAY,
		archivedAgo: 12 * DAY,
		seen: true,
		history: [
			{ who: "you", text: "probe Ghostty's scripting surface" },
			{ who: "agent", text: "1.3.1 creates a tab with cwd and command in one step." },
		],
	},
	{
		title: "Values schema lint in CI",
		project: "harbor-deploy",
		ago: 12 * DAY,
		archivedAgo: 11 * DAY,
		seen: true,
		history: [
			{ who: "you", text: "lint values against the schema in CI" },
			{ who: "agent", text: "Added a lint job; it fails on unknown keys." },
		],
	},
];

const DEFAULT_REPLIES = [
	"Done. I read the three files that matter and left the diff unstaged for you to review: +24 −9.",
	"Good catch. I traced it to the ordering of the two hooks; swapping them fixes it, and the e2e run is green.",
	"I'd keep it simple: one function, no new flag. Want me to apply that?",
];

function uuidv7ish(at: number): string {
	const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
	const t = at.toString(16).padStart(12, "0");
	return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${hex(3)}-${hex(4)}-${hex(12)}`;
}

export function makeSeed(now: number): SeedSession[] {
	return SPECS.map((s) => {
		const activityAt = now - s.ago;
		const root = join(CODE, s.project);
		return {
			id: uuidv7ish(activityAt - HOUR),
			title: s.title,
			project: s.project,
			cwd: s.worktree ? join(root, ".worktrees", s.worktree) : root,
			branch: s.worktree ?? null,
			model: s.project === "harbor-deploy" ? "gpt-5.6-sol" : "claude-opus-5",
			activity: s.activity ?? "idle",
			activityAt,
			visitedAt: s.seen ? activityAt + 1 : activityAt - 2 * MINUTE,
			archivedAt: s.archivedAgo === undefined ? null : now - s.archivedAgo,
			prestart: s.prestart ?? null,
			history: s.history,
			replies: s.replies ?? DEFAULT_REPLIES,
		};
	});
}

// Scratch git repos for every project, plus one worktree, so nvim and the per-directory editor rule have real directories.
export function ensureScratchDirs(seed: SeedSession[]): void {
	for (const project of PROJECTS) {
		const root = join(CODE, project);
		if (existsSync(join(root, ".git"))) continue;
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "README.md"), `# ${project}\n\nPROTOTYPE scratch repo for the Deck mock. Wipe me.\n`);
		writeFileSync(join(root, "src", "main.ts"), `// ${project}\nexport function main(): void {\n\tconsole.log("hello from ${project}");\n}\n`);
		const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, ...args], { stdout: "ignore", stderr: "ignore" });
		git("init", "-q", "-b", "main");
		git("add", ".");
		git("-c", "user.name=mock", "-c", "user.email=mock@example.com", "commit", "-qm", "scratch");
	}
	for (const s of seed) {
		if (!s.branch || existsSync(s.cwd)) continue;
		Bun.spawnSync(["git", "-C", join(CODE, s.project), "worktree", "add", "-q", "-b", s.branch, s.cwd], { stdout: "ignore", stderr: "ignore" });
	}
}

export function shortPath(cwd: string): string {
	return cwd.startsWith(CODE) ? `~mock${cwd.slice(CODE.length)}` : cwd;
}

export function age(at: number, now: number): string {
	const d = now - at;
	if (d < MINUTE) return "now";
	if (d < HOUR) return `${Math.floor(d / MINUTE)}m`;
	if (d < DAY) return `${Math.floor(d / HOUR)}h`;
	return `${Math.floor(d / DAY)}d`;
}

// ── tmux config ─────────────────────────────────────────────────────────

// Ticket 08's overlay on top of the user's config. Appended hooks re-assert `status off`, because the user's
// own pane-focus-in hook turns the status bar back on for every non-nvim pane.
export function sessionsOverlay(): string {
	const log = (event: string) => `run-shell -b "echo ${event} #{client_name} #{session_name} >> ${paths.hooksLog}"`;
	return [
		"set -g status off",
		"set -g pane-border-status off",
		"set -g set-titles off",
		"set -g focus-events on",
		"set -g remain-on-exit off",
		"set -g destroy-unattached off",
		"set -g exit-unattached off",
		"set -s exit-empty off",
		"set -g detach-on-destroy on",
		"set -s extended-keys always",
		"set -g extended-keys-format csi-u",
		// Your gruvbox conf paints window-style bg=#f9f5d7, which tmux then answers OSC 11 with: a background frozen
		// at server start, mismatched with the live fg and palette after a light/dark switch, and it suppresses the
		// 997 theme reports that make pi re-query. With the default style, tmux answers from the real terminal.
		"set -g window-style default",
		"set -g window-active-style default",
		`set-hook -ga client-focus-in '${log("focus-in")}'`,
		`set-hook -ga client-focus-out '${log("focus-out")}'`,
		`set-hook -ga client-detached '${log("detached")}'`,
		"set-hook -ga pane-focus-in 'set status off'",
		"set-hook -ga after-select-pane 'set status off'",
		"set-hook -ga after-select-window 'set status off'",
		"set-hook -ga client-session-changed 'set status off'",
		"",
	].join("\n");
}

// The UI server is owned entirely by swb. Hooks and prefix bindings report to the Deck's socket.
export function uiConf(prefix: string): string {
	const curl = (path: string) => `run-shell -b "curl -s -m 2 -X POST --unix-socket ${STATE}/#{session_name}.sock http://deck${path} >/dev/null 2>&1 || true"`;
	return [
		"set -g default-terminal tmux-256color",
		"set -s extended-keys always",
		"set -g extended-keys-format csi-u",
		"set -as terminal-features ',*:extkeys:RGB:hyperlinks'",
		"set -g allow-passthrough all",
		"set -s escape-time 0",
		"set -g focus-events on",
		"set -g status off",
		"set -g mouse on",
		// Relays OSC 52 from the right pane's nested client to the terminal: a tmux copy-mode selection on the
		// sessions server (regular-mode pi) reaches the clipboard. The default, external, drops it here.
		"set -s set-clipboard on",
		// A Deck is created detached, so destroy-unattached only switches on once its first client attaches.
		"set-hook -g client-attached 'set destroy-unattached on'",
		"set -g history-limit 0",
		"set -g pane-border-status off",
		"set -g pane-border-lines single",
		"set -g pane-border-style fg=brightblack",
		"set -g pane-active-border-style fg=cyan",
		"set -g set-titles on",
		"set -g set-titles-string swb",
		"set -g display-time 1500",
		`set -g prefix ${prefix}`,
		"set -g prefix2 None",
		"unbind -a -T prefix",
		"bind Tab select-pane -t :.+",
		"bind h select-pane -t :.0",
		"bind l select-pane -t :.1",
		`bind e ${curl("/cmd/editor")}`,
		`bind z ${curl("/cmd/zoom")}`,
		`bind ? display-popup -E -w 66 -h 26 -T ' swb keys ' "bash -c 'cat ${paths.help}; read -rsn1'"`,
		`bind ${prefix} send-keys ${prefix}`,
		`set-hook -g window-pane-changed '${curl("/ev/pane?id=#{s/%//:pane_id}")}'`,
		`set-hook -g client-focus-in '${curl("/ev/client-focus?in=1")}'`,
		`set-hook -g client-focus-out '${curl("/ev/client-focus?in=0")}'`,
		`set-hook -g window-resized '${curl("/ev/resized")}'`,
		"",
	].join("\n");
}

export const HELP = [
	"Roster (bare keys)",
	"  j/k ↑/↓     move; the right side follows instantly",
	"  g/G         top / bottom",
	"  ⏎ or l      focus the session (wakes it, focuses once up)",
	"  h           jump to the session's header",
	"  on a header: h/l collapse / expand, ⏎ space click toggle",
	"  w           wake (start) the session in the background",
	"  a           archive; on an archived row, unarchive",
	"  u           undo the last archive (5 s)",
	"  /           filter        esc  clear",
	"  H           toggle hover: lazy ↔ eager (prototype)",
	"  q           quit the Deck (sessions keep running)",
	"",
	"Deck prefix M-a (works from either pane)",
	"  M-a h / l   focus the roster / the session",
	"  M-a Tab     toggle focus roster ↔ session",
	"  M-a e       swap the session ↔ its directory's editor",
	"  M-a z       zoom the session (focus mode)",
	"  M-a ?       this help",
	"  M-a M-a     send a literal M-a through",
	"",
	"Any key closes this.",
].join("\n");
