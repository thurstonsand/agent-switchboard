/// <reference lib="webworker" />
import { statSync } from "node:fs";
import { bootId, type Harness, linkedWorktreeAsync, operatorDir, type View } from "@swb/shared";
import { span } from "@swb/shared/trace";
import type { Config } from "../config.ts";
import { deriveSessions, type RuntimeRecord, runtimeLive, runtimeRecords, type SessionRow, sessionRows, type World } from "../derive.ts";
import { addDir, removeDir, targets } from "../dirs.ts";
import { type Catalog, discover, launchFlags, readCatalog, resolveLaunch, shortlist, writeGuide } from "../harnesses.ts";
import { type Pending, pendingBySession, type ScheduleView, schedulesBySession, snooze } from "../schedules.ts";
import {
	archive,
	archiveWorktree,
	beingStopped,
	ensureEditor,
	ensureSessionsServer,
	ensureShell,
	lastWords,
	launch,
	restart,
	stillRunning,
	stop,
	unarchive,
	wake,
} from "../sessions.ts";
import { loadLayout, markUnseen, markVisited, openStore, saveLayout, setGroup, setView } from "../store.ts";
import { hostPane, killHome, listPanes, SESSIONS, tmux, tmuxTry } from "../tmux.ts";
import { locateTranscript } from "../transcripts/read.ts";
import { applyPrefix, DECK, PLACEHOLDER } from "./conf.ts";
import { ensurePlaceholder } from "./deck.ts";
import type { Diff, Entry, FromWorker, NewSession, Snapshot, TerminalProfile, ToWorker, Transcript, Turn } from "./protocol.ts";
import { readTranscript } from "./transcript.ts";

// The roster's worker owns the db and everything slow: a held writer lock or a 50 MB transcript stalls this
// thread, never the roster's cursor.

declare const self: Worker;

const TICK_MS = 250;

/** Whether the roster has said it listens, so the placeholder can follow its cards. */
let listening = false;
let config: Config;
const db = openStore();
const boot = bootId();
let lastJson = "";
let dataVersion = -1;
let rows: SessionRow[] = [];
let runtimes: RuntimeRecord[] = [];
/** The linked worktree each open session's directory is, or null, as git answered; asked once per directory. */
const worktrees = new Map<string, string | null>();
/**
 * Directories git is still answering for, all asked at once. No snapshot goes out meanwhile: one that took a worktree
 * for none would let archive skip offering to delete it.
 */
const asking = new Set<string>();
let schedules = new Map<string, ScheduleView[]>();
let pending = new Map<string, Pending[]>();
/** What each launch left for the first session its process records, by tmux session, until that session takes it. */
let launches = new Map<string, { parentId: string | null; group: string | null }>();
let profile: TerminalProfile | null = null;
/** The server this Deck last mirrored its terminal's background into, by pid: a new one is mirrored again. */
let mirroredServer = "";
const transcripts = new Map<string, { mtimeMs: number; transcript: Transcript }>();
/** Hosts this Deck launched whose pi hasn't registered yet. */
const launched = new Set<string>();
const ORPHAN_DEAD_S = 10;
const REAP_GRACE_MS = 10_000;
/** Reaped hosts this Deck has sent SIGKILL, until their tmux session is gone. */
const killed = new Set<string>();

/** Model lists older than this are fetched again when the Deck starts. */
const MODELS_STALE_MS = 24 * 3_600_000;

/** What the harnesses can start, as last found; the cache from before this Deck until this Deck's own lands. */
let catalog: Catalog | null = readCatalog();
let discovering = false;
/** Settles once this Deck has asked the harnesses: a launch that names no preset waits for it. */
const { promise: found, resolve: foundNow } = Promise.withResolvers<void>();
/** Settles once the roster has its first snapshot. */
const { promise: posted, resolve: postedNow } = Promise.withResolvers<void>();

function done(req: number, error: string | null): void {
	post({ type: "done", req, error });
}

/** Tells the roster, and every line's session_launch, what the shortlist now holds. */
function announce(): void {
	if (!catalog) return;
	post({ type: "catalog", catalog });
	writeGuide(shortlist(config, catalog));
}

/** The model lists asked for while a refresh runs that may not fetch them: they're fetched once it ends. */
let modelsAgain = false;

function refresh(models: boolean): void {
	if (discovering) {
		modelsAgain ||= models;
		return;
	}
	discovering = true;
	const stale = catalog === null || Date.now() - catalog.at > MODELS_STALE_MS;
	// With no catalog yet, the provisional one has no model lists, so a launch waits for the lists.
	const first = catalog === null;
	discover(catalog, models || stale, (provisional) => {
		catalog = provisional;
		if (!first) foundNow();
		announce();
	})
		.then((done) => {
			catalog = done;
			announce();
		})
		.catch((error: Error) => post({ type: "error", text: `harnesses: ${error.message}` }))
		.finally(() => {
			discovering = false;
			foundNow();
			if (modelsAgain) {
				modelsAgain = false;
				refresh(true);
			}
		});
}

/** Starts a new session: on its target, or, with none, once the harnesses are found, on the preset a launch defaults to. */
async function startNew(message: NewSession): Promise<void> {
	try {
		let target = message.target;
		if (target === null) {
			await found;
			target = resolveLaunch(
				config,
				catalog as Catalog,
				shortlist(config, catalog) ?? [],
				{
					harness: message.harness,
					model: null,
					effort: null,
					agent: null,
				},
				null,
			);
		}
		ensureSessionsServer();
		const host = db.tx(() => launch(db, { ...launchFlags(target), cwd: message.cwd, resume: null, group: message.group, trust: false }));
		launched.add(host);
		post({ type: "launched", req: message.req, host });
	} catch (error) {
		post({ type: "launchFailed", req: message.req, text: (error as Error).message });
	}
	lastJson = "";
	dataVersion = -1;
	tick();
}

/** Views chosen before a session's first prompt, written once it has a row to mark. */
const pendingViews = new Map<string, View>();
/** Likewise for Groups. */
const pendingGroups = new Map<string, string | null>();

function post(message: FromWorker): void {
	self.postMessage(message);
}

function readDb(): void {
	const version = db.dataVersion();
	if (version === dataVersion) return;
	dataVersion = version;
	rows = sessionRows(db);
	runtimes = runtimeRecords(db);
	schedules = schedulesBySession(db);
	pending = pendingBySession(db);
	launches = new Map(
		db
			.all("SELECT tmux_session, parent_id, group_name FROM launches")
			.map((row) => [row.tmux_session as string, { parentId: row.parent_id as string | null, group: row.group_name as string | null }]),
	);
	for (const [id, view] of pendingViews) {
		if (!rows.some((row) => row.session_id === id)) continue;
		pendingViews.delete(id);
		setView(db, id, view);
		rows = sessionRows(db);
	}
	for (const [id, name] of pendingGroups) {
		if (!rows.some((row) => row.session_id === id)) continue;
		pendingGroups.delete(id);
		setGroup(db, [id], name);
		rows = sessionRows(db);
	}
}

/** At its Project's root, an open session is in the main checkout or no repository at all; only one below it asks git. */
function worktreeOf(row: SessionRow): string | null {
	const { cwd } = row;
	if (!row.open || cwd === row.project_root) return null;
	if (!worktrees.has(cwd) && !asking.has(cwd)) {
		asking.add(cwd);
		void linkedWorktreeAsync(cwd).then((tree) => {
			worktrees.set(cwd, tree?.path ?? null);
			asking.delete(cwd);
			// Before init, its own tick posts the first snapshot.
			if (asking.size === 0 && listening) poll();
		});
	}
	return worktrees.get(cwd) ?? null;
}

/** The kinds of session whose own pane the Stage can show. */
const OWN_PANE = new Set(["harness", "editor", "shell", "placeholder"]);

type Polled = {
	snapshot: Snapshot;
	staged: Map<string, boolean>;
	reaped: Map<string, number>;
	names: Set<string>;
	serverPid: string;
	/** Each running session's pane, its program's modes, and the colors last mirrored onto it. */
	colorless: string[][];
};

function snapshot(): Polled {
	readDb();
	// One listing for the whole server: every session has a pane, and harnesses are found by theirs.
	const panes = listPanes(
		SESSIONS,
		"#{session_name}",
		"#{@swb_kind}",
		"#{@swb_dir}",
		"#{pid}",
		"#{@swb_version}",
		"#{@swb_host}",
		`#{?#{==:#{session_name},${DECK}},1,0}`,
		"#{pane_dead}",
		"#{pane_dead_time}",
		"#{@swb_reaped}",
		"#{@swb_stopping}",
		"#{@swb_home}",
		"#{@swb_starting}",
		"#{pane_id}",
		"#{pane_private_modes}",
		"#{@swb_colors}",
	);
	const listed = [...new Map(panes.map((row) => [row[0] as string, row])).values()];
	// An Editor or a shell whose program exited, wherever the Stage has its pane, goes with its session.
	const ended = new Set(panes.filter((row) => row[11] !== "" && row[5] === "" && row[7] === "1").map((row) => row[11] as string));
	for (const home of ended) killHome(home);
	// A session whose own pane closed outright while the Stage showed it is left holding a stand-in, which nothing else ends.
	const homes = new Set(panes.map((row) => row[11]));
	for (const [name, kind] of listed)
		if (OWN_PANE.has(kind as string) && !homes.has(name)) tmuxTry(SESSIONS, "kill-session", "-t", `=${name}`);
	const harnesses = panes.filter((row) => row[5] !== "");
	const died: Record<string, string[]> = {};
	for (const [, , , , , host, , dead, deadAt, , , , starting] of harnesses) {
		if (dead !== "1") continue;
		// One that registered was kept only because it died on the Deck's Stage, and goes at once; its stand-in takes its slot back.
		if (starting !== "") {
			if (launched.has(host as string)) {
				launched.delete(host as string);
				died[host as string] = lastWords(host as string);
			} else if (Date.now() / 1000 - Number(deadAt) < ORPHAN_DEAD_S) continue;
		}
		killHome(host as string);
	}
	const alive = harnesses.filter((row) => row[7] !== "1");
	const staged = new Map(alive.map((row) => [row[5] as string, row[6] === "1"]));
	const reaped = new Map(alive.filter((row) => row[9]).map((row) => [row[5] as string, Number(row[9])]));
	// A harness some swb is stopping reads as gone already: its session shows dormant, and its wake waits for it.
	const quitting = new Set(alive.filter((row) => row[10]).map((row) => row[5] as string));
	const w: World = {
		now: Date.now(),
		bootId: boot,
		hosts: new Set([...staged.keys()].filter((host) => !quitting.has(host))),
		inactiveAfterMs: config.inactiveAfterMs,
	};
	const known = new Set(rows.map((row) => row.session_id));
	const entries: Entry[] = deriveSessions(rows, w).map((state, i) => {
		const row = rows[i] as SessionRow;
		return {
			...state,
			view: row.view ?? "agent",
			transcript: row.transcript,
			host: state.live ? (row.runtime?.tmux_session ?? null) : null,
			provisional: false,
			worktree: worktreeOf(row),
			schedules: schedules.get(row.session_id) ?? [],
			pending: pending.get(row.session_id) ?? [],
		};
	});
	for (const runtime of runtimes) {
		if (known.has(runtime.session_id) || !runtimeLive(runtime, w.bootId, w.hosts)) continue;
		const launch = launches.get(runtime.tmux_session);
		entries.push({
			id: runtime.session_id,
			harness: runtime.harness,
			parentId: launch?.parentId ?? null,
			title: null,
			project: runtime.project_root,
			cwd: runtime.cwd,
			branch: null,
			group: pendingGroups.has(runtime.session_id) ? (pendingGroups.get(runtime.session_id) ?? null) : (launch?.group ?? null),
			operator: runtime.cwd === operatorDir(),
			open: true,
			live: true,
			activity: "idle",
			unseen: false,
			markedUnseen: false,
			cutOff: null,
			errored: false,
			inactive: false,
			snoozed: false,
			snoozedUntil: null,
			reload: null,
			createdAt: runtime.started_at,
			activityAt: runtime.started_at,
			visitedAt: null,
			archivedAt: null,
			view: "agent",
			transcript: null,
			host: runtime.tmux_session,
			provisional: true,
			worktree: null,
			schedules: [],
			pending: [],
		});
	}
	return {
		snapshot: {
			entries,
			hosts: [...staged.keys()],
			editors: Object.fromEntries(
				listed.filter(([name, kind]) => kind === "editor" && !ended.has(name as string)).map(([name, , dir]) => [dir, name]),
			),
			shells: Object.fromEntries(
				listed.filter(([name, kind]) => kind === "shell" && !ended.has(name as string)).map(([name, , dir]) => [dir, name]),
			),
			died,
			serverUp: listed.length > 0,
			swbVersion: listed[0]?.[4] ?? "",
		},
		staged,
		reaped,
		names: new Set(listed.map(([name]) => name as string)),
		serverPid: listed[0]?.[3] ?? "",
		colorless: panes.filter((row) => row[11] !== "" && row[7] !== "1").map((row) => row.slice(13, 16)),
	};
}

/** A failed run-shell draws its status over some other session's harness, and a lost race to exit isn't news. */
function quietKill(signal: "TERM" | "KILL", pid: number): string {
	return `kill -${signal} ${pid} 2>/dev/null || :`;
}

/**
 * An idle live pi the Deck's Stage doesn't show stops after reap_after, whether or not a terminal is on the Deck. A
 * freshly started one counts from its start, so a background wake isn't reaped on the spot. The Stage check runs inside
 * tmux, so a pane the Stage took since this poll keeps it.
 *
 * A process gets one SIGTERM, from whichever roster's worker gets there first, as one replaces another: tmux marks its
 * pane @swb_reaped as it sends it. pi shuts down once and ignores every later SIGTERM, and the SIGHUP of a closed pane too, so a shutdown hook
 * that hangs would keep it forever; one still there REAP_GRACE_MS after its SIGTERM gets SIGKILL.
 */
function reap(snap: Snapshot, staged: Map<string, boolean>, reaped: Map<string, number>): void {
	const now = Date.now();
	for (const host of killed) if (!reaped.has(host)) killed.delete(host);
	const byId = new Map(rows.map((row) => [row.session_id, row]));
	for (const entry of snap.entries) {
		if (!entry.host) continue;
		const runtime = runtimes.find((r) => r.tmux_session === entry.host);
		if (!runtime) continue;
		// Past its SIGTERM it's shutting down, whatever a message that just arrived did to its phase.
		const termed = reaped.get(entry.host);
		if (termed !== undefined) {
			if (now - termed < REAP_GRACE_MS || killed.has(entry.host)) continue;
			killed.add(entry.host);
			tmuxTry(SESSIONS, "run-shell", "-b", quietKill("KILL", runtime.pid));
			continue;
		}
		if (entry.activity !== "idle" || staged.get(entry.host)) continue;
		const row = byId.get(entry.id);
		const lastTouched = Math.max(row?.last_settled_at ?? 0, row?.visited_at ?? 0, runtime.started_at);
		if (now - lastTouched < config.reapAfterMs) continue;
		const pane = hostPane(entry.host);
		if (!pane) continue;
		// SIGTERM rather than closing the pane, so pi's and Claude's lines save any draft; Codex's is lost. See stopPis.
		tmuxTry(
			SESSIONS,
			"if-shell",
			"-F",
			"-t",
			pane,
			`#{!=:#{session_name},${DECK}}`,
			`set -p -t ${pane} @swb_reaped ${now} ; run-shell -b '${quietKill("TERM", runtime.pid)}'`,
		);
	}
}

function colorKey({ foreground, background, scheme, palette }: TerminalProfile): string {
	return [foreground, background, scheme, ...(palette ?? [])].join(" ");
}

/**
 * A pane off the Deck has no terminal to ask, so tmux answers its color queries from window-style and pane-colours: the
 * Deck's terminal is mirrored into them. The background goes in the server's window-style, which the Deck's own windows
 * override. The palette goes on each session's own pane, which takes it along onto the Deck: set for the server, it
 * would answer the roster's own palette query too, and the roster would never see the terminal's change again. It's
 * also kept in server options, which a new pane's palette is seeded from as it's created (seedPalette).
 *
 * Then each of those programs subscribed to light/dark reports (mode 2031) gets one, so its next query sees the new
 * colors: tmux sends its own only to the panes a terminal shows, and only when the scheme flips. paste-buffer -S
 * writes straight to the program, even under copy mode, where send-keys would drive copy mode. pane_private_modes reads
 * the program's modes, not copy mode's.
 */
function mirror(colors: TerminalProfile, stale: string[][], serverPid: string): void {
	const { foreground, background, palette, scheme } = colors;
	const key = colorKey(colors);
	if (serverPid !== mirroredServer) {
		mirroredServer = serverPid;
		const style = `bg=${background},fg=${foreground}`;
		const seeds = Array.from({ length: 16 }, (_, i) =>
			palette ? [";", "set", "-g", `@swb_palette_${i}`, palette[i] as string] : [";", "set", "-gu", `@swb_palette_${i}`],
		).flat();
		tmux(SESSIONS, "set", "-g", "window-style", style, ";", "set", "-g", "window-active-style", style, ...seeds);
	}
	if (stale.length === 0) return;
	const report = `\x1b[?997;${scheme === "dark" ? 1 : 2}n`;
	tmux(SESSIONS, "set-buffer", "-b", "swb-theme", report);
	// One command per pane: a pane that exits in between fails only its own.
	for (const [pane, modes] of stale) {
		const colours = palette
			? palette.flatMap((color, i) => [";", "set", "-p", "-t", pane as string, `pane-colours[${i}]`, color])
			: [";", "set", "-pu", "-t", pane as string, "pane-colours"];
		const told = modes?.split(",").includes("2031") ? [";", "paste-buffer", "-S", "-b", "swb-theme", "-t", pane as string] : [];
		tmuxTry(SESSIONS, ...[...colours, ";", "set", "-p", "-t", pane as string, "@swb_colors", key, ...told].slice(1));
	}
	tmux(SESSIONS, "delete-buffer", "-b", "swb-theme");
}

function tick(): Set<string> {
	const { snapshot: snap, staged, reaped, names, serverPid, colorless } = snapshot();
	for (const runtime of runtimes) {
		if (!launched.has(runtime.tmux_session) || !runtimeLive(runtime, boot, new Set(snap.hosts))) continue;
		launched.delete(runtime.tmux_session);
	}
	// A Deck without its placeholder shows a blank Stage, so a killed sessions server comes straight back.
	if (!snap.serverUp) ensureSessionsServer();
	if (!names.has(PLACEHOLDER)) ensurePlaceholder(false);
	if (profile) {
		const key = colorKey(profile);
		try {
			mirror(
				profile,
				colorless.filter(([, , colors]) => colors !== key),
				serverPid,
			);
		} catch (error) {
			post({ type: "error", text: (error as Error).message });
		}
	}
	reap(snap, staged, reaped);
	if (asking.size > 0) return names;
	const json = JSON.stringify(snap);
	if (json === lastJson) return names;
	lastJson = json;
	post({ type: "snapshot", snapshot: snap });
	postedNow();
	return names;
}

/** As with a message, a tick that fails says so, and the next one tries again. */
function poll(): void {
	try {
		span("worker.tick", tick);
	} catch (error) {
		post({ type: "error", text: (error as Error).message });
	}
}

/** A transcript, read again only once it has changed on disk. */
function transcriptOf(recorded: string, harness: Harness): Transcript {
	const path = locateTranscript(recorded, harness);
	const { mtimeMs } = statSync(path);
	const cached = transcripts.get(path);
	if (cached?.mtimeMs === mtimeMs) return cached.transcript;
	const transcript = readTranscript(path, harness);
	transcripts.set(path, { mtimeMs, transcript });
	return transcript;
}

function transcript(id: string, recorded: string, harness: Harness): void {
	try {
		post({ type: "transcript", id, transcript: span("worker.transcript", () => transcriptOf(recorded, harness)), error: null });
	} catch (error) {
		post({ type: "transcript", id, transcript: null, error: (error as Error).message });
	}
}

const DIFF_MS = 2000;
const diffs = new Map<string, { at: number; diff: Promise<Diff | null> }>();

/** `git diff --shortstat HEAD` in a directory, at most once per DIFF_MS; null outside git or with nothing changed. */
function diffOf(cwd: string): Promise<Diff | null> {
	const cached = diffs.get(cwd);
	if (cached && Date.now() - cached.at < DIFF_MS) return cached.diff;
	const diff = (async () => {
		const git = Bun.spawn(["git", "-C", cwd, "diff", "--shortstat", "HEAD"], { stdout: "pipe", stderr: "ignore" });
		const out = await new Response(git.stdout).text();
		if ((await git.exited) !== 0) return null;
		const count = (re: RegExp) => Number(re.exec(out)?.[1] ?? 0);
		const files = count(/(\d+) files? changed/);
		return files === 0 ? null : { files, add: count(/(\d+) insertions?/), del: count(/(\d+) deletions?/) };
	})();
	diffs.set(cwd, { at: Date.now(), diff });
	return diff;
}

/** A Peek's extras. A transcript that won't read says so in place of the last turn, and the rest still shows. */
async function peek(id: string, cwd: string, path: string | null, harness: Harness): Promise<void> {
	let last: Turn | null = null;
	let error: string | null = null;
	try {
		if (path) last = transcriptOf(path, harness).turns.at(-1) ?? null;
	} catch (e) {
		error = (e as Error).message;
	}
	post({ type: "peek", id, info: { last, diff: await diffOf(cwd), error } });
}

async function handle(message: ToWorker): Promise<void> {
	switch (message.type) {
		case "init":
			listening = true;
			// Only now: the placeholder follows the roster's card stream, and the roster posts init once its socket listens.
			// One left by the roster before this one follows that one's stream, on that one's swb.
			ensurePlaceholder(true);
			config = message.config;
			post({ type: "restore", layout: loadLayout(db) });
			setInterval(poll, TICK_MS);
			if (catalog) post({ type: "catalog", catalog });
			// The roster shows "loading…" until its first snapshot, which shouldn't wait on refresh spawning every harness.
			void posted.then(() => refresh(false));
			break;
		case "config": {
			if (message.config.prefix !== config.prefix) tmux(SESSIONS, ...applyPrefix(message.config.prefix, config.prefix));
			config = message.config;
			announce();
			break;
		}
		case "refresh":
			refresh(message.models);
			return;
		case "layout":
			saveLayout(db, message.layout);
			return;
		case "wake":
			if (afterStop(message)) return;
			try {
				const host = wake(db, message.id, "resume");
				launched.add(host);
				post({ type: "launched", req: message.req, host });
			} catch (error) {
				post({ type: "launchFailed", req: message.req, text: (error as Error).message });
			}
			break;
		case "reload":
			try {
				const host = restart(db, message.id, "continue");
				launched.add(host);
				post({ type: "launched", req: message.req, host });
			} catch (error) {
				post({ type: "launchFailed", req: message.req, text: (error as Error).message });
			}
			break;
		case "new":
			void startNew(message);
			return;
		case "visit":
			// A provisional session has no row to mark until its first prompt.
			readDb();
			if (rows.some((row) => row.session_id === message.id)) markVisited(db, message.id);
			break;
		case "markUnseen":
			markUnseen(db, message.id, message.marked);
			break;
		case "archive":
			try {
				if (message.deleteWorktreeFor) {
					await archiveWorktree(db, message.deleteWorktreeFor, message.ids, null);
					worktrees.clear();
					done(message.req, null);
				} else {
					const { refused, stopped } = archive(db, message.ids);
					done(message.req, refused?.message ?? null);
					stopped.catch((error: Error) => post({ type: "stopFailed", text: error.message }));
				}
			} catch (error) {
				done(message.req, (error as Error).message);
			}
			break;
		case "unarchive":
			if (afterStop(message)) return;
			try {
				unarchive(db, message.id);
				done(message.req, null);
			} catch (error) {
				done(message.req, (error as Error).message);
			}
			break;
		case "snooze":
			try {
				snooze(db, null, message.id, message.snooze);
				done(message.req, null);
			} catch (error) {
				done(message.req, (error as Error).message);
			}
			break;
		case "stop":
			try {
				stop(db, message.id);
				done(message.req, null);
			} catch (error) {
				done(message.req, (error as Error).message);
			}
			break;
		case "transcript":
			transcript(message.id, message.path, message.harness);
			break;
		case "peek":
			void peek(message.id, message.cwd, message.transcript, message.harness);
			return;
		case "colors":
			profile = message.colors;
			tmux(SESSIONS, "set", "-w", "-t", `=${DECK}:`, "@swb_scheme", profile.scheme);
			mirroredServer = "";
			break;
		case "view":
			try {
				readDb();
				if (rows.some((row) => row.session_id === message.id)) setView(db, message.id, message.view);
				else pendingViews.set(message.id, message.view);
				done(message.req, null);
			} catch (error) {
				done(message.req, `view: ${(error as Error).message}`);
			}
			break;
		case "group":
			try {
				readDb();
				const known = new Set(rows.map((row) => row.session_id));
				setGroup(
					db,
					message.ids.filter((id) => known.has(id)),
					message.name,
				);
				for (const id of message.ids) if (!known.has(id)) pendingGroups.set(id, message.name);
				done(message.req, null);
			} catch (error) {
				done(message.req, `group: ${(error as Error).message}`);
			}
			break;
		case "editor": {
			let name: string;
			try {
				name = ensureEditor(db, message.dir, config.editor);
			} catch (error) {
				post({ type: "editor", dir: message.dir, name: null, text: (error as Error).message });
				break;
			}
			lastJson = "";
			dataVersion = -1;
			const up = tick().has(name);
			post({ type: "editor", dir: message.dir, name: up ? name : null, text: up ? null : `${config.editor} exited at once` });
			return;
		}
		case "dirs":
		case "addDir":
		case "removeDir":
			try {
				if (message.type === "addDir") addDir(db, message.path);
				if (message.type === "removeDir") removeDir(db, message.path);
				post({ type: "dirs", trees: targets(db, config.dirs) });
			} catch (error) {
				post({ type: "error", text: `directories: ${(error as Error).message}` });
			}
			return;
		case "shell": {
			let name: string;
			try {
				name = ensureShell(db, message.dir);
			} catch (error) {
				post({ type: "shell", req: message.req, dir: message.dir, name: null, text: (error as Error).message });
				break;
			}
			lastJson = "";
			dataVersion = -1;
			const up = tick().has(name);
			post({ type: "shell", req: message.req, dir: message.dir, name: up ? name : null, text: up ? null : "the shell exited at once" });
			return;
		}
	}
	// A launch settles only against a snapshot taken after it, so one always follows, changed or not. Writes on
	// this connection don't move data_version, so that snapshot re-reads the db.
	lastJson = "";
	dataVersion = -1;
	tick();
}

/**
 * Puts off a wake or an unarchive while its session's harness is quitting, whichever swb stops it, and does it once
 * the harness is gone or its stopper's deadline passes. Waiting here keeps the worker free meanwhile.
 */
function afterStop(message: { type: "wake"; req: number; id: string } | { type: "unarchive"; req: number; id: string }): boolean {
	const stop = beingStopped(db, message.id);
	// Past its deadline, the wake closes what its stopper didn't.
	if (!stop || Date.now() >= stop.deadline) return false;
	void (async () => {
		while (Date.now() < stop.deadline && stillRunning([stop.host]).length > 0) await Bun.sleep(50);
		await receive(message);
	})();
	return true;
}

async function receive(message: ToWorker): Promise<void> {
	try {
		await handle(message);
	} catch (error) {
		post({ type: "error", text: (error as Error).message });
	}
}

self.onmessage = (event: MessageEvent<ToWorker>) => void receive(event.data);

// The roster sends init only once its socket listens; git answers for the open sessions' worktrees meanwhile.
readDb();
for (const row of rows) worktreeOf(row);
