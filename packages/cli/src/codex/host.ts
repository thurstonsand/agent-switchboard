import { existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { type Db, stateDir } from "@swb/shared";
import { frame, listen, markDelivered, pendingFor } from "@swb/shared/mailbox";
import {
	endHosting,
	markArchived,
	pendingTitle,
	recordTx,
	setPhase,
	setTitle,
	settle,
	startHosting,
	startTurn,
	turnErrored,
} from "@swb/shared/record";
import { mark, now, since } from "@swb/shared/trace";
import { readTranscript } from "../deck/transcript.ts";
import { SwbError, UsageError } from "../errors.ts";
import { CODEX_PLUGIN, writeCodexLine } from "../lines.ts";
import { codexOperatorConfig } from "../operator.ts";
import { SWB } from "../sessions.ts";
import { openStore } from "../store.ts";
import { SESSIONS, tmuxTry } from "../tmux.ts";
import { archivedInCodex } from "../transcripts/codex.ts";
import { CodexClient, type Notification } from "./client.ts";

// A Codex session's host: the process in its tmux pane. It owns a private app-server, runs the real Codex TUI
// against it on this pane's tty, and is the Codex line: it learns which thread the TUI shows from the pane title,
// records that thread's lifecycle from the server's notifications, and delivers its messages with turn/start.

type Thread = { id: string; cwd: string; path: string | null; name: string | null; ephemeral: boolean; parentThreadId: string | null };
type Status = { type: string; activeFlags?: string[] };

const POLL_MS = 250;

/**
 * The shell between this host and its app-server, which ends the server however the host ends. An app-server
 * listening on a socket ignores its parent, and the hangup a dying host's group gets only has it finish its running
 * turns first, with no limit. The host holds the other end of this shell's stdin, which closes even when the host is
 * SIGKILLed. Then a first SIGTERM has Codex drain and a second stops it, skipping cleanup it doesn't always finish;
 * its tools run in process groups of their own, found while it's still their parent, before the first signal and
 * again after it, and killed once it's gone. The shell reaps the server whenever it likes, freeing its pid, so it's
 * signalled only while it's still this shell's running app-server. A shell, not swb, because one runs beside every
 * Codex session: about 1 MB against Bun's 29.
 */
const APP_SERVER_GUARD = `
socket=$1
shift
trap '' HUP
trap 'host_gone=1' USR1
exec 3<&0 </dev/null
"$@" 3<&- &
server=$!
(cat <&3 >/dev/null; kill -USR1 $$) &
watcher=$!
exec 3<&-
wait "$server"
status=$?
running() {
	ps -o ppid= -o stat= -o args= -p "$server" | awk -v guard=$$ '$1 == guard && $2 !~ /^Z/ && /app-server/ { up = 1 } END { exit !up }'
}
tool_groups() {
	running && ps -A -o pid= -o ppid= -o pgid= | awk -v root="$server" -v own="$(ps -o pgid= -p $$)" '
		{ parent[$1] = $2; group[$1] = $3 }
		END {
			for (p in parent) {
				for (q = parent[p]; (q in parent) && q != root; q = parent[q]) {}
				if (q == root && group[p] + 0 != own + 0) print group[p]
			}
		}'
}
if [ -n "$host_gone" ]; then
	groups=$(tool_groups)
	running && kill -TERM "$server"
	sleep 0.2
	groups=$(printf '%s\n' $groups $(tool_groups) | sort -u)
	running && kill -TERM "$server"
	i=0
	while [ "$i" -lt 50 ] && running; do sleep 0.1; i=$((i + 1)); done
	running && kill -KILL "$server"
	for group in $groups; do kill -s KILL -- "-$group" 2>/dev/null; done
	wait "$server"
fi
kill "$watcher" 2>/dev/null
wait "$watcher"
rm -f "$socket"
exit "$status"
`;

/** The private app-server of the Codex session in a tmux session. */
export function codexSocket(host: string): string {
	return join(stateDir(), "codex", `${host}.sock`);
}

export async function codexHost(args: string[], updated = false): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			host: { type: "string" },
			resume: { type: "string" },
			model: { type: "string" },
			effort: { type: "string" },
			prompt: { type: "string" },
			continue: { type: "boolean" },
			operator: { type: "boolean" },
		},
	});
	const host = values.host;
	if (!host) throw new UsageError("__codex: --host is required");
	const codex = Bun.which("codex");
	if (!codex) throw new SwbError("codex not found on PATH");
	for (const name of ["SWB_MANAGED", "SWB_DB", "SWB_TMUX_SESSION", "SWB_BIN"]) delete process.env[name];

	writeCodexLine(SWB);
	// Both read config: the server for the model's instructions and tools, the TUI for its trust check.
	const operator = values.operator ? codexOperatorConfig().flatMap((value) => ["-c", value]) : [];
	const socket = codexSocket(host);
	const dir = dirname(socket);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	rmSync(socket, { force: true });
	const starting = now();
	const server = Bun.spawn(
		[
			"/bin/sh",
			"-c",
			APP_SERVER_GUARD,
			"sh",
			socket,
			codex,
			"app-server",
			"--listen",
			`unix://${socket}`,
			"-c",
			"features.plugins=true",
			"-c",
			`plugins.${CODEX_PLUGIN}.enabled=true`,
			...operator,
		],
		{ stdin: "pipe", stdout: "ignore", stderr: openSync(join(dir, `${host}.log`), "w") },
	);
	const deadline = Date.now() + 15_000;
	while (!existsSync(socket)) {
		if (server.exitCode !== null) throw new SwbError(`codex app-server exited ${server.exitCode}; see ${join(dir, `${host}.log`)}`);
		if (Date.now() > deadline) throw new SwbError("codex app-server didn't start within 15 s");
		await Bun.sleep(50);
	}
	since("codex.app-server", starting);
	const client = await CodexClient.connect(socket, "swb");
	const db = openStore();
	// Archived in Codex behind swb's back, by `codex archive` or another client: swb opening it means it's open.
	const transcript = values.resume
		? (db.get("SELECT transcript FROM sessions WHERE session_id = ?", values.resume)?.transcript as string)
		: null;
	if (values.resume && transcript && archivedInCodex(transcript)) await client.request("thread/unarchive", { threadId: values.resume });

	const tui = Bun.spawn(
		[
			codex,
			...(values.resume ? ["resume", values.resume] : []),
			"--remote",
			`unix://${socket}`,
			"-c",
			'tui.terminal_title=["session-id","status"]',
			...operator,
			...(values.model ? ["--model", values.model] : []),
			...(values.effort ? ["-c", `model_reasoning_effort="${values.effort}"`] : []),
			...(values.prompt ? [values.prompt] : []),
		],
		{ stdin: "inherit", stdout: "inherit", stderr: "inherit" },
	);
	let stopped = false;
	const stopTui = () => {
		stopped = true;
		if (tui.exitCode === null) tui.kill("SIGTERM");
	};
	// The TUI owns the terminal; a stop from swb reaches this process and goes on to the TUI.
	const ignoreInterrupt = () => {};
	process.on("SIGINT", ignoreInterrupt);
	process.on("SIGHUP", stopTui);
	process.on("SIGTERM", stopTui);

	const line = new CodexLine(db, client, host, values.continue ? (values.resume ?? null) : null, stopTui);
	client.onNotification((note) => line.notify(note));
	const timer = setInterval(() => void line.poll(), POLL_MS);
	const doorbell = listen(db, (id) => {
		if (id === line.bound?.id) void line.poll();
	});

	// The TUI would only wait to reconnect to a dead app-server, so the session ends with it.
	const code = await Promise.race([tui.exited, server.exited.then(() => null)]);
	clearInterval(timer);
	doorbell.close();
	if (code === null) {
		// A dead app-server is a killed harness, recorded as one: its runtime row stays behind.
		stopTui();
		await tui.exited;
	} else line.end();
	client.close();
	server.stdin.end();
	await server.exited;
	db.close();
	process.off("SIGINT", ignoreInterrupt);
	process.off("SIGHUP", stopTui);
	process.off("SIGTERM", stopTui);
	// Codex's startup updater exits 0, just like quitting. Retry once only if no conversation opened and
	// the installed version actually changed. Restart the server too, keeping it on the TUI's new version.
	if (
		!updated &&
		code === 0 &&
		!stopped &&
		!line.bound &&
		client.serverVersion !== null &&
		codexVersion() !== `codex-cli ${client.serverVersion}`
	)
		return codexHost(args, true);
	process.exit(code ?? 1);
}

function codexVersion(): string {
	const result = Bun.spawnSync(["codex", "--version"], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new SwbError(`codex --version: ${result.stderr.toString().trim()}`);
	return result.stdout.toString().trim();
}

const UNREAD_GRACE_MS = 5000;

/** The threadSource that marks a thread as session_ask's reader. */
export const READER_SOURCE = "swb_reader";

class CodexLine {
	/** The thread the TUI shows. */
	bound: Thread | null = null;
	readonly statuses = new Map<string, Status>();
	/** Threads that are never sessions, such as session_ask's readers. */
	readonly ephemeral = new Set<string>();
	/** session_ask's readers, and whether each is mid-turn. */
	readonly readers = new Map<string, boolean>();
	busy = false;
	blocked = false;
	stopping = false;
	seenVersion = -1;
	polling = false;
	/** When reading the shown thread first failed, while it still does. */
	unreadSince: number | null = null;

	constructor(
		readonly db: Db,
		readonly client: CodexClient,
		readonly host: string,
		/** A resumed thread whose cut-off turn picks back up once the TUI shows it. */
		public continuing: string | null,
		readonly stop: () => void,
	) {}

	notify({ method, params }: Notification): void {
		if (method === "thread/started") {
			const thread = params.thread as Thread & { threadSource: string | null };
			if (thread.ephemeral) this.ephemeral.add(thread.id);
			if (thread.ephemeral && thread.threadSource === READER_SOURCE) this.readers.set(thread.id, false);
		}
		const threadId = params.threadId as string | undefined;
		if (threadId && this.ephemeral.has(threadId)) {
			if (method === "thread/closed") {
				this.ephemeral.delete(threadId);
				this.readers.delete(threadId);
			}
			if (method === "thread/status/changed" && this.readers.has(threadId)) {
				this.readers.set(threadId, (params.status as Status).type === "active");
				this.reap();
			}
			return;
		}
		const bound = this.bound?.id;
		if (method === "thread/status/changed" && threadId) {
			this.statuses.set(threadId, params.status as Status);
			if (threadId === this.bound?.id) this.apply(params.status as Status);
			this.reap();
		} else if (method === "thread/name/updated" && this.bound && threadId === bound) {
			// Codex's own title after the first turn, or a /rename; kept on the thread too, which settle records.
			const thread = this.bound;
			thread.name = (params.threadName as string | undefined) ?? null;
			this.guard(() => setTitle(this.db, thread.id, thread.name));
		} else if (method === "thread/reverted" && this.bound && threadId === bound) {
			// A revert goes on in a new rollout, which the thread reads from now on.
			const thread = this.bound;
			void this.client.request<{ thread: { path: string | null } }>("thread/read", { threadId: thread.id }).then(
				({ thread: { path } }) => {
					thread.path = path;
					this.guard(() =>
						startHosting(this.db, {
							host: this.host,
							harness: "codex",
							sessionId: thread.id,
							cwd: thread.cwd,
							transcript: path ?? "",
							pid: process.pid,
							idle: !this.busy,
						}),
					);
				},
				(error: Error) => console.error(`swb: not recording: ${error.message}`),
			);
		} else if (method === "thread/archived" && bound && threadId === bound) {
			// Codex's own /archive: archived in swb too, and the TUI stops before it moves to another conversation.
			this.stopping = true;
			this.guard(() => recordTx(this.db, () => markArchived(this.db, bound)));
			this.stop();
		}
	}

	/**
	 * A reader only answers a call in some session's running turn. swb mcp stops its own, but if it died first the
	 * reader would run on, so once no session here is mid-turn, any reader still running is interrupted.
	 */
	reap(): void {
		if ([...this.statuses.values()].some((status) => status.type === "active")) return;
		for (const [threadId, active] of this.readers) {
			if (!active) continue;
			this.readers.set(threadId, false);
			// An empty turn id interrupts whatever turn is running.
			void this.client
				.request("turn/interrupt", { threadId, turnId: "" })
				.then(() => this.client.request("thread/backgroundTerminals/clean", { threadId }))
				.catch((error: Error) => console.error(`swb: reader ${threadId} not stopped: ${error.message}`));
		}
	}

	/** A thread's status, as swb's phases: a turn starts, blocks on the person, resumes, or settles. */
	apply(status: Status): void {
		const thread = this.bound;
		if (!thread) return;
		if (status.type === "active") {
			if (!this.busy) {
				this.busy = true;
				this.guard(() => this.startTurn(thread));
			}
			const blocked = (status.activeFlags ?? []).length > 0;
			if (blocked !== this.blocked) {
				this.blocked = blocked;
				this.guard(() => setPhase(this.db, thread.id, blocked ? "blocked" : "working"));
			}
		} else if (this.busy) {
			this.busy = false;
			this.blocked = false;
			this.guard(() => {
				const { quit } = settle(this.db, { host: this.host, sessionId: thread.id, cwd: thread.cwd, title: thread.name });
				if (quit) {
					this.stopping = true;
					this.stop();
				}
			});
			// Only the TUI's connection hears turn/completed; this one asks how the turn ended.
			void this.client
				.request<{ data: { status: string }[] }>("thread/turns/list", { threadId: thread.id, limit: 1, sortDirection: "desc" })
				.then(
					({ data }) => {
						if (data[0]?.status === "failed") this.guard(() => turnErrored(this.db, thread.id));
					},
					(error: Error) => console.error(`swb: not recording: ${error.message}`),
				);
		}
	}

	startTurn(thread: Thread): void {
		startTurn(this.db, {
			harness: "codex",
			sessionId: thread.id,
			cwd: thread.cwd,
			transcript: thread.path ?? "",
			title: thread.name,
			host: this.host,
		});
	}

	/** Recording failures show in the pane's title-less log; the session carries on. */
	guard(body: () => void): void {
		try {
			body();
		} catch (error) {
			console.error(`swb: not recording: ${(error as Error).message}`);
		}
	}

	async poll(): Promise<void> {
		if (this.polling || this.stopping) return;
		this.polling = true;
		try {
			await this.bind();
			if (this.bound && this.bound.id === this.continuing) {
				this.continuing = null;
				// No input: Codex goes on from its own history, as T3 Code continues a Codex turn.
				await this.client.request("turn/start", { threadId: this.bound.id, input: [] });
			}
			await this.deliver();
		} catch (error) {
			console.error(`swb: ${(error as Error).message}`);
		} finally {
			this.polling = false;
		}
	}

	/** The pane title starts with the shown thread's id, cut to 29 characters; it's resolved on this server. */
	async bind(): Promise<void> {
		const title = tmuxTry(SESSIONS, "display", "-p", "-t", `=${this.host}:`, "#{pane_title}");
		const prefix = title.ok ? /^([0-9a-f-]{8,})/.exec(title.out)?.[1] : undefined;
		if (!prefix || this.bound?.id.startsWith(prefix)) return;
		const { data } = await this.client.request<{ data: string[] }>("thread/loaded/list", {});
		const matches = data.filter((id) => id.startsWith(prefix));
		if (matches.length !== 1) return;
		let thread: Thread & { path: string | null };
		try {
			({ thread } = await this.client.request<{ thread: Thread & { path: string | null } }>("thread/read", { threadId: matches[0] }));
			this.unreadSince = null;
		} catch (error) {
			// A thread just started has no metadata in its rollout yet; only a failure that outlasts that is worth saying.
			this.unreadSince ??= Date.now();
			if (Date.now() - this.unreadSince < UNREAD_GRACE_MS) return;
			throw error;
		}
		if (thread.ephemeral || thread.parentThreadId) return;
		this.bound = { id: thread.id, cwd: thread.cwd, path: thread.path, name: thread.name, ephemeral: false, parentThreadId: null };
		this.busy = false;
		this.blocked = false;
		this.seenVersion = -1;
		const bound = this.bound;
		mark("codex.bound");
		this.guard(() => {
			startHosting(this.db, {
				host: this.host,
				harness: "codex",
				sessionId: bound.id,
				cwd: bound.cwd,
				transcript: bound.path ?? "",
				pid: process.pid,
				idle: true,
			});
			// A turn that ran before the title named its thread still makes the session's row.
			if (!this.db.get("SELECT 1 FROM sessions WHERE session_id = ?", bound.id) && bound.path && hasTurns(bound.path)) {
				this.startTurn(bound);
				settle(this.db, { host: this.host, sessionId: bound.id, cwd: bound.cwd, title: bound.name });
			}
		});
		const status = this.statuses.get(bound.id);
		if (status) this.apply(status);
	}

	/** Messages for the shown thread: turn/start starts an idle thread's turn and steers a running one. */
	async deliver(): Promise<void> {
		const thread = this.bound;
		if (!thread) return;
		const version = this.db.dataVersion();
		if (version === this.seenVersion) return;
		for (const m of pendingFor(this.db, thread.id)) {
			if (m.kind === "cancel") {
				// Only the TUI is subscribed to its turns, so the running one is looked up.
				const { data } = await this.client.request<{ data: { id: string; status: string }[] }>("thread/turns/list", {
					threadId: thread.id,
					limit: 5,
					sortDirection: "desc",
				});
				const running = data.find((turn) => turn.status === "inProgress");
				if (running) await this.client.request("turn/interrupt", { threadId: thread.id, turnId: running.id });
			} else {
				await this.client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: frame(this.db, m) }] });
			}
			recordTx(this.db, () => markDelivered(this.db, m.id));
		}
		// A title set through swb becomes the thread's own name, which thread/name/updated records back.
		const title = pendingTitle(this.db, thread.id);
		if (title !== null && title !== thread.name) await this.client.request("thread/name/set", { threadId: thread.id, name: title });
		// Seen only once all of it went through: a turn/start Codex refuses, as mid-compaction, retries on the next poll instead of waiting for another write.
		this.seenVersion = version;
	}

	end(): void {
		this.guard(() => endHosting(this.db, this.host));
	}
}

/** Codex writes a thread's rollout with its first turn. */
function hasTurns(path: string): boolean {
	return existsSync(path) && readTranscript(path, "codex").turns.length > 0;
}
