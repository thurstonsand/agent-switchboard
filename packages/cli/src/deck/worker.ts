/// <reference lib="webworker" />
import { statSync } from "node:fs";
import { bootId, type Db, type View } from "@swb/shared";
import type { Config } from "../config.ts";
import { derive, type RuntimeRecord, runtimeLive, runtimeRecords, type SessionRow, sessionRows, type World } from "../derive.ts";
import { archive, ensureEditor, ensureSessionsServer, launch, unarchive, wake } from "../sessions.ts";
import { markVisited, openStore, setView } from "../store.ts";
import { listSessions, quote, SESSIONS, tmuxTry } from "../tmux.ts";
import { ensurePlaceholder, placeholderName } from "./deck.ts";
import type { Entry, FromWorker, Snapshot, ToWorker, Turn } from "./protocol.ts";
import { readTranscript } from "./transcript.ts";

// The roster's worker owns the db and everything slow: a held writer lock or a 50 MB transcript stalls this
// thread, never the roster's cursor.

declare const self: Worker;

const TICK_MS = 250;

let deck = "";
let config: Config;
let db: Db;
const boot = bootId();
let lastJson = "";
let dataVersion = -1;
let rows: SessionRow[] = [];
let runtimes: RuntimeRecord[] = [];
let background: string | null = null;
let mirroredServer = "";
const transcripts = new Map<string, { mtimeMs: number; turns: Turn[] }>();
/** Hosts this Deck launched whose pi hasn't registered yet. */
const launched = new Set<string>();
const ORPHAN_DEAD_S = 10;

/** Views chosen before a session's first prompt, written once it has a row to mark. */
const pendingViews = new Map<string, View>();

function post(message: FromWorker): void {
	self.postMessage(message);
}

function readDb(): void {
	const version = db.dataVersion();
	if (version === dataVersion) return;
	dataVersion = version;
	rows = sessionRows(db);
	runtimes = runtimeRecords(db);
	for (const [id, view] of pendingViews) {
		if (!rows.some((row) => row.session_id === id)) continue;
		pendingViews.delete(id);
		setView(db, id, view);
		rows = sessionRows(db);
	}
}

type Polled = { snapshot: Snapshot; attached: Map<string, boolean>; names: Set<string>; serverPid: string };

function snapshot(): Polled {
	readDb();
	const listed = listSessions(
		SESSIONS,
		"#{@swb_kind}",
		"#{?session_attached,1,0}",
		"#{pid}",
		"#{@swb_dir}",
		"#{pane_dead}",
		"#{pane_dead_time}",
		"#{@swb_version}",
	);
	const died: Record<string, string[]> = {};
	for (const [name, kind, , , , dead, deadAt] of listed) {
		if (kind !== "pi" || dead !== "1") continue;
		const host = name as string;
		if (launched.has(host)) {
			launched.delete(host);
			const tail = tmuxTry(SESSIONS, "capture-pane", "-p", "-t", `=${host}:`);
			died[host] = tail.ok
				? tail.out
						.split("\n")
						.filter((line) => line.trim() !== "")
						.slice(-5)
				: [];
		} else if (Date.now() / 1000 - Number(deadAt) < ORPHAN_DEAD_S) continue;
		tmuxTry(SESSIONS, "kill-session", "-t", `=${host}`);
	}
	const alive = listed.filter(([, kind, , , , dead]) => kind === "pi" && dead !== "1");
	const attached = new Map(alive.map(([name, , count]) => [name as string, count === "1"]));
	const w: World = { now: Date.now(), bootId: boot, hosts: new Set(attached.keys()), inactiveAfterMs: config.inactiveAfterMs };
	const known = new Set(rows.map((row) => row.session_id));
	const entries: Entry[] = rows.map((row) => {
		const state = derive(row, w);
		return {
			...state,
			view: row.view ?? "pi",
			transcript: row.transcript,
			host: state.live ? (row.runtime?.tmux_session ?? null) : null,
			provisional: false,
		};
	});
	for (const runtime of runtimes) {
		if (known.has(runtime.session_id) || !runtimeLive(runtime, w.bootId, w.hosts)) continue;
		entries.push({
			id: runtime.session_id,
			title: null,
			project: runtime.project_root,
			cwd: runtime.cwd,
			branch: null,
			open: true,
			live: true,
			activity: "idle",
			unseen: false,
			interrupted: false,
			inactive: false,
			activityAt: runtime.started_at,
			archivedAt: null,
			view: "pi",
			transcript: null,
			host: runtime.tmux_session,
			provisional: true,
		});
	}
	return {
		snapshot: {
			entries,
			hosts: [...attached.keys()],
			editors: Object.fromEntries(listed.filter(([, kind]) => kind === "editor").map(([name, , , , dir]) => [dir, name])),
			died,
			serverUp: listed.length > 0,
			swbVersion: listed[0]?.[7] ?? "",
		},
		attached,
		names: new Set(listed.map(([name]) => name as string)),
		serverPid: listed[0]?.[3] ?? "",
	};
}

/**
 * An idle live pi nobody is viewing stops after reap_after. A freshly started one counts from its start, so a
 * background wake isn't reaped on the spot. The attached check runs inside tmux, so a Deck that attached since
 * this poll keeps it.
 */
function reap(snap: Snapshot, attached: Map<string, boolean>): void {
	const now = Date.now();
	const byId = new Map(rows.map((row) => [row.session_id, row]));
	for (const entry of snap.entries) {
		if (!entry.host || entry.activity !== "idle" || attached.get(entry.host)) continue;
		const row = byId.get(entry.id);
		const runtime = runtimes.find((r) => r.tmux_session === entry.host);
		const lastTouched = Math.max(row?.last_settled_at ?? 0, row?.visited_at ?? 0, runtime?.started_at ?? 0);
		if (now - lastTouched < config.reapAfterMs) continue;
		const target = quote(`=${entry.host}`);
		tmuxTry(SESSIONS, "if-shell", "-F", "-t", `=${entry.host}:`, "#{?session_attached,0,1}", `kill-session -t ${target}`);
	}
}

/** Unviewed panes have no terminal to ask, so the terminal's background is mirrored into the sessions server. */
function mirror(serverPid: string): void {
	if (background === null) return;
	const key = `${serverPid}:${background}`;
	if (key === mirroredServer) return;
	const style = `bg=${background}`;
	const result = tmuxTry(SESSIONS, "set", "-g", "window-style", style, ";", "set", "-g", "window-active-style", style);
	if (result.ok) mirroredServer = key;
}

function tick(): Set<string> {
	const { snapshot: snap, attached, names, serverPid } = snapshot();
	for (const runtime of runtimes) {
		if (!launched.has(runtime.tmux_session) || !runtimeLive(runtime, boot, new Set(snap.hosts))) continue;
		launched.delete(runtime.tmux_session);
		tmuxTry(SESSIONS, "set", "-p", "-u", "-t", `=${runtime.tmux_session}:`, "remain-on-exit");
	}
	// A Deck without its placeholder shows a blank Stage, so a killed sessions server comes straight back.
	if (!snap.serverUp) ensureSessionsServer();
	if (!names.has(placeholderName(deck))) ensurePlaceholder(deck);
	mirror(serverPid);
	reap(snap, attached);
	const json = JSON.stringify(snap);
	if (json === lastJson) return names;
	lastJson = json;
	post({ type: "snapshot", snapshot: snap });
	return names;
}

function transcript(id: string, path: string): void {
	try {
		const { mtimeMs } = statSync(path);
		const cached = transcripts.get(path);
		if (cached?.mtimeMs === mtimeMs) {
			post({ type: "transcript", id, turns: cached.turns, error: null });
			return;
		}
		const turns = readTranscript(path);
		transcripts.set(path, { mtimeMs, turns });
		post({ type: "transcript", id, turns, error: null });
	} catch (error) {
		post({ type: "transcript", id, turns: null, error: (error as Error).message });
	}
}

function handle(message: ToWorker): void {
	switch (message.type) {
		case "init":
			deck = message.deck;
			config = message.config;
			db = openStore();
			setInterval(tick, TICK_MS);
			break;
		case "wake":
			try {
				const host = wake(db, message.id);
				launched.add(host);
				post({ type: "woke", id: message.id, host });
			} catch (error) {
				post({ type: "launchFailed", id: message.id, text: (error as Error).message });
			}
			break;
		case "new":
			try {
				ensureSessionsServer();
				const host = launch(message.cwd, null, []);
				launched.add(host);
				post({ type: "created", host });
			} catch (error) {
				post({ type: "launchFailed", id: null, text: (error as Error).message });
			}
			break;
		case "visit":
			// A provisional session has no row to mark until its first prompt.
			readDb();
			if (rows.some((row) => row.session_id === message.id)) markVisited(db, message.id);
			break;
		case "archive":
		case "unarchive":
			try {
				(message.type === "archive" ? archive : unarchive)(db, message.id);
				post({ type: "toggled", error: null });
			} catch (error) {
				post({ type: "toggled", error: (error as Error).message });
			}
			break;
		case "transcript":
			transcript(message.id, message.path);
			return;
		case "background":
			background = message.color;
			break;
		case "view":
			try {
				readDb();
				if (rows.some((row) => row.session_id === message.id)) setView(db, message.id, message.view);
				else pendingViews.set(message.id, message.view);
			} catch (error) {
				post({ type: "viewFailed", id: message.id, text: (error as Error).message });
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
	}
	// A launch settles only against a snapshot taken after it, so one always follows, changed or not. Writes on
	// this connection don't move data_version, so that snapshot re-reads the db.
	lastJson = "";
	dataVersion = -1;
	tick();
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
	try {
		handle(event.data);
	} catch (error) {
		post({ type: "error", text: (error as Error).message });
	}
};
