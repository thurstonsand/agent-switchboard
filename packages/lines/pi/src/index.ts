import { spawn } from "node:child_process";
import type { FSWatcher } from "node:fs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Db, operatorDir } from "@swb/shared";
import { frame, listen, markDelivered, pendingFor, sender } from "@swb/shared/mailbox";
import {
	markArchived as archiveMark,
	endHosting,
	hostOfTranscript,
	recordTx,
	setPhase,
	setTitle,
	settle,
	startHosting,
	startTurn,
} from "@swb/shared/record";
import { TOOLS, type ToolName, type ToolResult } from "@swb/shared/tools";
import { mark, span } from "@swb/shared/trace";

type Launch = { readonly db: string; readonly tmuxSession: string; readonly bin: string };
// Outlives /reload, which re-imports this module with a fresh module cache.
type Process = {
	launch: Launch;
	failure?: string;
	db?: Db;
	attention: Set<string>;
	/** The session that launched this process, until the first session it hosts has recorded it. */
	parent?: string;
	inbox?: NodeJS.Timeout;
	doorbell?: FSWatcher;
};
type Ui = ExtensionContext["ui"];

const KEY = Symbol.for("agent-switchboard.recorder");
const store = globalThis as { [KEY]?: Process };
const MESSAGE = "swb.message";
const LINEAGE = "pi-sessions.lineage";

function claim(): Process | undefined {
	const env = process.env;
	if (env.SWB_MANAGED === "1" && env.SWB_DB && env.SWB_TMUX_SESSION) {
		store[KEY] = {
			launch: Object.freeze({ db: env.SWB_DB, tmuxSession: env.SWB_TMUX_SESSION, bin: env.SWB_BIN ?? "" }),
			attention: new Set(),
			...(env.SWB_PARENT ? { parent: env.SWB_PARENT } : {}),
			...(env.SWB_BIN ? {} : { failure: "started by an swb older than this line; upgrade swb" }),
		};
	}
	// Consumed so no child process (subagents, handoffs, bash) inherits management.
	delete env.SWB_MANAGED;
	delete env.SWB_DB;
	delete env.SWB_TMUX_SESSION;
	delete env.SWB_BIN;
	delete env.SWB_PARENT;
	return store[KEY];
}

/** Runs swb, feeding it stdin, and parses the tool result it prints; its stderr is the error. */
function swb(bin: string, args: string[], stdin = ""): Promise<ToolResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(JSON.parse(out) as ToolResult);
			else reject(new Error(err.trim().replace(/^swb: /, "") || `swb ${args[0]} exited ${code}`));
		});
		child.stdin.end(stdin);
	});
}

type IncomingDetails = { from: string; title: string; body: string };

export default function (pi: ExtensionAPI) {
	mark("pi-line.load");
	// swb writes the Operator folder's extension itself; without this, every new Operator would stop on pi's trust prompt.
	pi.on("project_trust", (event) => ({ trusted: event.cwd === operatorDir() ? "yes" : "undecided" }));
	const claimed = claim();
	if (!claimed) return;
	const proc: Process = claimed;
	let ui: Ui | undefined;
	let ctxNow: ExtensionContext | undefined;

	// swb owns coordination between sessions, so pi-sessions keeps only its subagent tools.
	pi.events.on("pi-sessions:hosts", (request) => (request as { register(host: unknown): void }).register({ name: "swb", peers: true }));

	const showFailure = () => ui?.setStatus("swb", ui.theme.fg("error", `swb: not recording: ${proc.failure}`));

	const connect = (): Db => {
		proc.db ??= new Db(proc.launch.db, { create: false });
		return proc.db;
	};

	const fail = (error: unknown) => {
		proc.failure = error instanceof Error ? error.message : String(error);
		showFailure();
		ui?.notify(`swb: not recording: ${proc.failure}`, "error");
	};

	const write = (sessionId: string, body: (db: Db, sessionId: string) => void): void => {
		if (proc.failure) {
			showFailure();
			return;
		}
		try {
			body(connect(), sessionId);
		} catch (error) {
			fail(error);
		}
	};

	const writeFor = (ctx: ExtensionContext, body: (db: Db, sessionId: string) => void): void => {
		ui = ctx.ui;
		write(ctx.sessionManager.getSessionId(), body);
	};

	let current: string | undefined;
	/** The session that recorded its launcher, once its first turn makes its row. */
	let launchedBy: { sessionId: string; parent: string } | undefined;

	pi.on("session_before_switch", (event, ctx) => {
		if (event.reason !== "resume" || !event.targetSessionFile || proc.failure) return;
		ui = ctx.ui;
		let host: string | undefined;
		try {
			host = hostOfTranscript(connect(), event.targetSessionFile, proc.launch.tmuxSession);
		} catch (error) {
			fail(error);
			return;
		}
		if (!host) return;
		ctx.ui.notify(`swb: that session is already open in another pi (${host})`, "error");
		return { cancel: true };
	});

	const draftPath = (id: string) => join(dirname(proc.launch.db), "drafts", id);

	/** The prompt being typed when swb stopped this pi, put back when the session next starts. */
	const restoreDraft = (ctx: ExtensionContext, id: string) => {
		let draft: string;
		try {
			draft = readFileSync(draftPath(id), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (!ctx.ui.getEditorText()) ctx.ui.setEditorText(draft);
		rmSync(draftPath(id));
	};

	// Messages from other sessions: steered into a running turn, or starting one when idle.
	let seenVersion = -1;
	const deliver = () => {
		const ctx = ctxNow;
		if (!ctx || !current || proc.failure) return;
		try {
			const db = connect();
			const version = db.dataVersion();
			if (version === seenVersion) return;
			seenVersion = version;
			for (const m of pendingFor(db, current)) {
				if (m.kind === "cancel") {
					if (!ctx.isIdle()) ctx.abort();
				} else {
					const details: IncomingDetails = { from: m.sourceId, title: sender(db, m.sourceId).title, body: m.body };
					pi.sendMessage(
						{ customType: MESSAGE, content: frame(db, m), display: true, details },
						ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" },
					);
				}
				markDelivered(db, m.id);
			}
		} catch (error) {
			fail(error);
		}
	};

	pi.registerMessageRenderer(MESSAGE, (message, _options, theme) => {
		const details = message.details as IncomingDetails;
		return new Text(`${theme.fg("accent", `↘ ${details.title}`)}\n${details.body}`, 0, 0);
	});

	pi.on("session_start", (event, ctx) => {
		current = ctx.sessionManager.getSessionId();
		ctxNow = ctx;
		seenVersion = -1;
		if (event.reason !== "reload") restoreDraft(ctx, current);
		proc.attention.clear();
		if (proc.parent) {
			// The launcher's lineage, in the transcript too, so pi-sessions sees it after the session leaves swb.
			launchedBy = { sessionId: current, parent: proc.parent };
			if (!ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === LINEAGE))
				pi.appendEntry(LINEAGE, { parentSessionId: proc.parent });
			delete proc.parent;
		}
		span("pi-line.start-hosting", () =>
			writeFor(ctx, (db, id) => {
				const transcript = ctx.sessionManager.getSessionFile();
				if (!transcript) throw new Error("pi is running without a session file");
				startHosting(db, {
					host: proc.launch.tmuxSession,
					harness: "pi",
					sessionId: id,
					cwd: ctx.cwd,
					transcript,
					pid: process.pid,
					idle: ctx.isIdle(),
				});
			}),
		);
		if (proc.inbox) clearInterval(proc.inbox);
		proc.inbox = setInterval(deliver, 250);
		proc.inbox.unref();
		proc.doorbell?.close();
		write(current, (db) => {
			proc.doorbell = listen(db, (id) => {
				if (id === current) deliver();
			});
		});
	});

	// Not the user message_start: a launched session's first turn starts with its goal as a message.
	// pi re-emits agent_start for retries, compaction, and queued messages within one turn; only a turn
	// that starts from idle moves last_prompt_at, so swb_update_session can't be undone by its own turn.
	pi.on("agent_start", (_event, ctx) => {
		writeFor(ctx, (db, id) => {
			const transcript = ctx.sessionManager.getSessionFile();
			if (!transcript) throw new Error("pi is running without a session file");
			const title = ctx.sessionManager.getSessionName() ?? null;
			const parentId = launchedBy?.sessionId === id ? launchedBy.parent : null;
			startTurn(db, { harness: "pi", sessionId: id, cwd: ctx.cwd, transcript, title, parentId });
		});
	});

	const attention = (open: boolean) => (data: unknown) => {
		const attentionId = (data as { attentionId?: unknown }).attentionId;
		if (typeof attentionId !== "string" || !current) return;
		if (open) proc.attention.add(attentionId);
		else proc.attention.delete(attentionId);
		const phase = proc.attention.size > 0 ? "blocked" : "working";
		write(current, (db, id) => setPhase(db, id, phase));
	};
	pi.events.on("glimpseui:attention:request", attention(true));
	pi.events.on("glimpseui:attention:resolve", attention(false));

	pi.on("agent_settled", (_event, ctx) => {
		proc.attention.clear();
		writeFor(ctx, (db, id) => {
			const { archived } = settle(db, {
				host: proc.launch.tmuxSession,
				sessionId: id,
				cwd: ctx.cwd,
				title: ctx.sessionManager.getSessionName() ?? null,
			});
			// Archived during its own turn, by swb_update_session or `swb archive` from a shell: it quits now.
			if (archived) ctx.shutdown();
		});
	});

	pi.on("session_info_changed", (event, ctx) => {
		writeFor(ctx, (db, id) => setTitle(db, id, event.name ?? null));
	});

	const markArchived = (ctx: ExtensionContext): boolean => {
		let archived = false;
		writeFor(ctx, (db, id) => {
			archived = recordTx(db, () => archiveMark(db, id));
		});
		return archived;
	};

	pi.registerCommand("archive", {
		description: "Archive this session in swb and quit",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("swb: turn running: wait for it to complete", "error");
				return;
			}
			if (markArchived(ctx)) ctx.shutdown();
			else if (!proc.failure) ctx.ui.notify("swb: nothing to archive before the first prompt", "error");
		},
	});

	const tool = (
		name: ToolName,
		label: string,
		target: (args: Record<string, unknown>) => string,
		run: (args: never, ctx: ExtensionContext, toolCallId: string) => Promise<ToolResult>,
	) =>
		pi.registerTool({
			name,
			label,
			description: TOOLS[name].description,
			promptSnippet: TOOLS[name].description,
			promptGuidelines: TOOLS[name].guidelines,
			parameters: TOOLS[name].parameters,
			renderCall(args, theme) {
				const what = target(args as Record<string, unknown>);
				return new Text(`${theme.fg("toolTitle", theme.bold(label))}${what ? ` · ${theme.fg("accent", what)}` : ""}`, 0, 0);
			},
			renderResult(result, _options, theme, context) {
				const output = result.content.find((item) => item.type === "text")?.text ?? "";
				return new Text(context.isError ? theme.fg("error", output) : theme.fg("dim", output), 0, 0);
			},
			async execute(toolCallId, params, _signal, _onUpdate, ctx) {
				if (proc.failure) throw new Error(`swb: not recording: ${proc.failure}`);
				const result = await run(params as never, ctx, toolCallId);
				return { content: [{ type: "text", text: result.text }], details: result.details };
			},
		});

	const self = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
	/** A session id as the roster names it, for a tool call's line. */
	const titleOf = (id: unknown) =>
		typeof id === "string" ? ((connect().get("SELECT title FROM sessions WHERE session_id = ?", id)?.title as string | null) ?? id) : "";

	tool(
		"session_reachable",
		"Reachable sessions",
		() => "",
		(_args, ctx) => swb(proc.launch.bin, ["reachable", "--from", self(ctx)]),
	);

	tool(
		"session_send_message",
		"Message",
		(args) => titleOf(args.session),
		(args: { session: string; message: string; requestResponse: boolean }, ctx, toolCallId) =>
			swb(
				proc.launch.bin,
				[
					"send",
					"--from",
					self(ctx),
					"--to",
					args.session,
					"--request-id",
					toolCallId,
					...(args.requestResponse ? ["--request-response"] : []),
				],
				args.message,
			),
	);

	tool(
		"session_cancel",
		"Cancel",
		(args) => titleOf(args.session),
		(args: { session: string }, ctx) => swb(proc.launch.bin, ["send", "--from", self(ctx), "--to", args.session, "--cancel"]),
	);

	tool(
		"session_launch",
		"Launch",
		(args) => `${args.harness} · ${args.title}`,
		(args: { harness: string; goal: string; cwd?: string; title: string; requestResponse: boolean }, ctx) =>
			swb(
				proc.launch.bin,
				[
					"launch",
					"--harness",
					args.harness,
					"--from",
					self(ctx),
					"--cwd",
					args.cwd ?? ctx.cwd,
					"--title",
					args.title,
					...(args.requestResponse ? ["--request-response"] : []),
				],
				args.goal,
			),
	);

	tool(
		"session_schedule",
		"Schedule",
		(args) =>
			`${args.launch ? `new ${(args.launch as { title: string }).title}` : args.session ? titleOf(args.session) : "this session"} · ${args.label}${args.snooze ? " · snooze" : ""}`,
		(
			args: {
				message: string;
				at?: string;
				cron?: string;
				label: string;
				session?: string;
				launch?: { harness: string; cwd?: string; title: string };
				requestResponse?: boolean;
				snooze?: boolean;
			},
			ctx,
			toolCallId,
		) =>
			swb(
				proc.launch.bin,
				[
					"schedule",
					"--from",
					self(ctx),
					"--label",
					args.label,
					"--request-id",
					toolCallId,
					...(args.at !== undefined ? ["--at", args.at] : []),
					...(args.cron !== undefined ? ["--cron", args.cron] : []),
					...(args.session !== undefined ? ["--to", args.session] : []),
					...(args.launch
						? ["--launch-harness", args.launch.harness, "--launch-title", args.launch.title, "--launch-cwd", args.launch.cwd ?? ctx.cwd]
						: []),
					...(args.requestResponse ? ["--request-response"] : []),
					...(args.snooze ? ["--snooze"] : []),
				],
				args.message,
			),
	);

	tool(
		"session_schedules",
		"Schedules",
		() => "",
		(_args, ctx) => swb(proc.launch.bin, ["schedules", "--from", self(ctx)]),
	);

	tool(
		"session_unschedule",
		"Unschedule",
		(args) => String(args.id),
		(args: { id: string }, ctx) => swb(proc.launch.bin, ["unschedule", args.id, "--from", self(ctx)]),
	);

	type Snooze = string | { until: string };
	const snoozeText = (snooze: Snooze) => (typeof snooze === "string" ? snooze : snooze.until);

	tool(
		"swb_update_session",
		"Update session",
		(args) => {
			const what = args.snooze !== undefined ? `snooze ${snoozeText(args.snooze as Snooze)}` : args.archived ? "archive" : "unarchive";
			return `${what} ${args.session ? titleOf(args.session) : "this session"}`;
		},
		async (args: { session?: string; archived?: boolean; snooze?: Snooze }, ctx) => {
			const id = self(ctx);
			if ((args.archived === undefined) === (args.snooze === undefined)) throw new Error("give archived or snooze: one of them");
			if (args.snooze !== undefined) return swb(proc.launch.bin, ["snooze", args.session ?? id, snoozeText(args.snooze), "--from", id]);
			if (!args.session || args.session === id) {
				if (!args.archived) throw new Error("this session is already open");
				if (!markArchived(ctx)) throw new Error(proc.failure ? `swb: not recording: ${proc.failure}` : "swb: no session recorded yet");
				ctx.shutdown();
				return { text: "Archived. pi quits when this turn ends.", details: { id, archived: true } };
			}
			return swb(proc.launch.bin, [args.archived ? "archive" : "unarchive", args.session, "--from", id]);
		},
	);

	pi.on("session_shutdown", (event, ctx) => {
		if (proc.inbox) clearInterval(proc.inbox);
		proc.inbox = undefined;
		proc.doorbell?.close();
		proc.doorbell = undefined;
		ctxNow = undefined;
		if (event.reason !== "quit") return;
		const draft = ctx.ui.getEditorText();
		if (draft.trim()) {
			const path = draftPath(ctx.sessionManager.getSessionId());
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			writeFileSync(path, draft, { mode: 0o600 });
		}
		writeFor(ctx, (db) => endHosting(db, proc.launch.tmuxSession));
	});
}
