import { existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { type Db, stateDir } from "@swb/shared";
import { frame, markDelivered, pendingFor } from "@swb/shared/mailbox";
import { endHosting, markArchived, recordTx, setPhase, setTitle, settle, startHosting, startTurn } from "@swb/shared/record";
import { archivedInCodex, readTranscript } from "../deck/transcript.ts";
import { SwbError, UsageError } from "../errors.ts";
import { CODEX_PLUGIN, writeCodexLine } from "../lines.ts";
import { codexOperatorConfig } from "../operator.ts";
import { SWB } from "../sessions.ts";
import { openStore } from "../store.ts";
import { SESSIONS, tmuxTry } from "../tmux.ts";
import { CodexClient, type Notification } from "./client.ts";

// A Codex session's host: the process in its tmux pane. It owns a private app-server, runs the real Codex TUI
// against it on this pane's tty, and is the Codex line: it learns which thread the TUI shows from the pane title,
// records that thread's lifecycle from the server's notifications, and delivers its messages with turn/start.

type Thread = { id: string; cwd: string; path: string | null; name: string | null; ephemeral: boolean; parentThreadId: string | null };
type Status = { type: string; activeFlags?: string[] };

const POLL_MS = 250;

/** The private app-server of the Codex session in a tmux session. */
export function codexSocket(host: string): string {
	return join(stateDir(), "codex", `${host}.sock`);
}

export async function codexHost(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			host: { type: "string" },
			resume: { type: "string" },
			model: { type: "string" },
			prompt: { type: "string" },
			operator: { type: "boolean" },
		},
	});
	const host = values.host;
	if (!host) throw new UsageError("__codex: --host is required");
	const codex = Bun.which("codex");
	if (!codex) throw new SwbError("codex not found on PATH");
	const parent = process.env.SWB_PARENT || null;
	for (const name of ["SWB_MANAGED", "SWB_DB", "SWB_TMUX_SESSION", "SWB_BIN", "SWB_PARENT"]) delete process.env[name];

	writeCodexLine(SWB);
	// Both read config: the server for the model's instructions and tools, the TUI for its trust check.
	const operator = values.operator ? codexOperatorConfig().flatMap((value) => ["-c", value]) : [];
	const socket = codexSocket(host);
	const dir = dirname(socket);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	rmSync(socket, { force: true });
	const server = Bun.spawn(
		[
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
		{ stdin: "ignore", stdout: "ignore", stderr: openSync(join(dir, `${host}.log`), "w") },
	);
	const deadline = Date.now() + 15_000;
	while (!existsSync(socket)) {
		if (server.exitCode !== null) throw new SwbError(`codex app-server exited ${server.exitCode}; see ${join(dir, `${host}.log`)}`);
		if (Date.now() > deadline) throw new SwbError("codex app-server didn't start within 15 s");
		await Bun.sleep(50);
	}
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
			...(values.prompt ? [values.prompt] : []),
		],
		{ stdin: "inherit", stdout: "inherit", stderr: "inherit" },
	);
	const stopTui = () => {
		if (tui.exitCode === null) tui.kill("SIGTERM");
	};
	// The TUI owns the terminal; a stop from swb reaches this process and goes on to the TUI.
	process.on("SIGINT", () => {});
	process.on("SIGHUP", stopTui);
	process.on("SIGTERM", stopTui);

	const line = new CodexLine(db, client, host, parent, stopTui);
	client.onNotification((note) => line.notify(note));
	const timer = setInterval(() => void line.poll(), POLL_MS);

	const code = await tui.exited;
	clearInterval(timer);
	line.end();
	client.close();
	server.kill("SIGTERM");
	await Promise.race([server.exited, Bun.sleep(3000)]);
	if (server.exitCode === null) server.kill("SIGKILL");
	rmSync(socket, { force: true });
	process.exit(code);
}

class CodexLine {
	/** The thread the TUI shows. */
	bound: Thread | null = null;
	readonly statuses = new Map<string, Status>();
	busy = false;
	blocked = false;
	stopping = false;
	seenVersion = -1;
	polling = false;

	constructor(
		readonly db: Db,
		readonly client: CodexClient,
		readonly host: string,
		/** The launcher, recorded with the first turn. */
		public parent: string | null,
		readonly stop: () => void,
	) {}

	notify({ method, params }: Notification): void {
		const threadId = params.threadId as string | undefined;
		const bound = this.bound?.id;
		if (method === "thread/status/changed" && threadId) {
			this.statuses.set(threadId, params.status as Status);
			if (threadId === this.bound?.id) this.apply(params.status as Status);
		} else if (method === "thread/name/updated" && this.bound && threadId === bound) {
			// Codex's own title after the first turn, or a /rename; kept on the thread too, which settle records.
			const thread = this.bound;
			thread.name = (params.threadName as string | undefined) ?? null;
			this.guard(() => setTitle(this.db, thread.id, thread.name));
		} else if (method === "thread/archived" && bound && threadId === bound) {
			// Codex's own /archive: archived in swb too, and the TUI stops before it moves to another conversation.
			this.stopping = true;
			this.guard(() => recordTx(this.db, () => markArchived(this.db, bound)));
			this.stop();
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
				const { archived } = settle(this.db, { host: this.host, sessionId: thread.id, cwd: thread.cwd, title: thread.name });
				if (archived) {
					this.stopping = true;
					this.stop();
				}
			});
		}
	}

	startTurn(thread: Thread): void {
		startTurn(this.db, {
			harness: "codex",
			sessionId: thread.id,
			cwd: thread.cwd,
			transcript: thread.path ?? "",
			title: thread.name,
			parentId: this.parent,
		});
		this.parent = null;
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
		const { thread } = await this.client.request<{ thread: Thread & { path: string | null } }>("thread/read", { threadId: matches[0] });
		if (thread.ephemeral || thread.parentThreadId) return;
		this.bound = { id: thread.id, cwd: thread.cwd, path: thread.path, name: thread.name, ephemeral: false, parentThreadId: null };
		this.busy = false;
		this.blocked = false;
		this.seenVersion = -1;
		const bound = this.bound;
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
		this.seenVersion = version;
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
	}

	end(): void {
		this.guard(() => endHosting(this.db, this.host));
	}
}

/** Codex writes a thread's rollout with its first turn. */
function hasTurns(path: string): boolean {
	return existsSync(path) && readTranscript(path, "codex").length > 0;
}
