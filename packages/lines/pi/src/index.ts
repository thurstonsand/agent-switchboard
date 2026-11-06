import { spawn } from "node:child_process";
import type { FSWatcher } from "node:fs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Db, describeTool, launchGuide, linkedWorktree, operatorDir } from "@swb/shared";
import { frame, listen, markDelivered, pendingFor, sender, unmarkDelivered } from "@swb/shared/mailbox";
import {
	markArchived as archiveMark,
	endHosting,
	hostOfTranscript,
	pendingTitle,
	Recorder,
	titleOf as recordedTitle,
	recordTx,
	setPhase,
	setTitle,
	settle,
	startHosting,
	startTurn,
	turnErrored,
} from "@swb/shared/record";
import { READER_PROMPT, READER_TOOLS, TOOLS, type ToolName, type ToolResult, toolParameters } from "@swb/shared/tools";
import { mark, span } from "@swb/shared/trace";

type Launch = { readonly db: string; readonly tmuxSession: string; readonly bin: string };
// Outlives /reload, which re-imports this module with a fresh module cache.
type Process = {
	launch: Launch;
	recoveryNotice: string | null;
	failure?: string;
	db?: Db;
	attention: Set<string>;
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
			recoveryNotice: env.SWB_RECOVERY_NOTICE ?? null,
			attention: new Set(),
			...(env.SWB_BIN ? {} : { failure: "started by an swb older than this line; upgrade swb" }),
		};
	}
	// Consumed so no child process (subagents, handoffs, bash) inherits management.
	delete env.SWB_MANAGED;
	delete env.SWB_DB;
	delete env.SWB_TMUX_SESSION;
	delete env.SWB_BIN;
	delete env.SWB_RECOVERY_NOTICE;
	return store[KEY];
}

/** A launch's Group as swb's flags take it: omitted, named, or none. */
function groupFlags(group: string | null | undefined): string[] {
	if (group === undefined) return [];
	return group === null ? ["--no-group"] : ["--group", group];
}

/** Runs swb, feeding it stdin, and parses the tool result it prints; its stderr is the error. */
function swb(bin: string, args: string[], stdin = "", signal?: AbortSignal): Promise<ToolResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], signal });
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

	// swb owns coordination between sessions and recall of them, so pi-sessions keeps only its subagent tools.
	pi.events.on("pi-sessions:hosts", (request) =>
		(request as { register(host: unknown): void }).register({ name: "swb", peers: true, recall: true }),
	);

	const failureText = () => {
		const mismatch = proc.failure?.match(/db schema is v(\d+), this line writes v(\d+)/);
		return mismatch ? `Versions ${mismatch[1]}/${mismatch[2]}. Install matching swb + pi integration; R reload in swb.` : proc.failure;
	};
	const showFailure = () => ui?.setStatus("swb", `${ui.theme.fg("error", ui.theme.bold("swb: not recording"))}: ${failureText()}`);

	const connect = (): Db => {
		proc.db ??= new Db(proc.launch.db, { create: false });
		return proc.db;
	};

	const fail = (error: unknown) => {
		proc.failure = error instanceof Error ? error.message : String(error);
		showFailure();
		ui?.notify(`swb: session tracking stopped. ${failureText()} Pi's transcript is still saved.`, "error");
	};

	// A busy db holds pi's writes for a later try, and says so; any other failure stops the line recording.
	const recorder = new Recorder(fail, (waiting) => {
		if (proc.failure) return;
		ui?.setStatus("swb", waiting > 0 ? ui.theme.fg("warning", `swb: db busy, ${waiting} record(s) waiting`) : undefined);
	});

	const write = (sessionId: string, body: (db: Db, sessionId: string) => void): void => {
		if (proc.failure) {
			showFailure();
			return;
		}
		recorder.write(() => {
			if (!proc.failure) body(connect(), sessionId);
		});
	};

	const writeFor = (ctx: ExtensionContext, body: (db: Db, sessionId: string) => void): void => {
		ui = ctx.ui;
		write(ctx.sessionManager.getSessionId(), body);
	};

	let current: string | undefined;

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

	// Messages from other sessions: steered into a running turn, or starting one when idle. A pass waits behind any
	// write a busy db holds, and the version counts as seen only once the whole pass went through.
	let seenVersion = -1;
	const deliver = () => {
		const ctx = ctxNow;
		const session = current;
		if (!ctx || !session || proc.failure || recorder.waiting > 0) return;
		write(session, (db) => {
			if (ctxNow !== ctx || current !== session) return;
			const version = db.dataVersion();
			if (version === seenVersion) return;
			for (const m of pendingFor(db, session)) {
				recordTx(db, () => markDelivered(db, m.id));
				try {
					if (m.kind === "cancel") {
						if (!ctx.isIdle()) ctx.abort();
					} else {
						const details: IncomingDetails = { from: m.sourceId, title: sender(db, m.sourceId).title, body: m.body };
						pi.sendMessage(
							{ customType: MESSAGE, content: frame(db, m), display: true, details },
							ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" },
						);
					}
				} catch (error) {
					recordTx(db, () => unmarkDelivered(db, m.id));
					throw error;
				}
			}
			// A title set through swb becomes pi's own name, which session_info_changed records back.
			const title = pendingTitle(db, session);
			if (title !== null && title !== ctx.sessionManager.getSessionName()) pi.setSessionName(title);
			seenVersion = version;
		});
	};

	pi.registerMessageRenderer(MESSAGE, (message, _options, theme) => {
		const details = message.details as IncomingDetails;
		return {
			invalidate() {},
			render(width: number) {
				return [
					...wrapTextWithAnsi(theme.fg("accent", `↘ ${details.title}`), Math.max(1, width - 1)).map((line) => ` ${line}`),
					...wrapTextWithAnsi(details.body, Math.max(1, width - 3)).map((line) => `   ${line}`),
				];
			},
		};
	});

	pi.on("session_start", (event, ctx) => {
		current = ctx.sessionManager.getSessionId();
		ctxNow = ctx;
		seenVersion = -1;
		if (event.reason !== "reload") restoreDraft(ctx, current);
		proc.attention.clear();
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
		if (proc.recoveryNotice) {
			pi.sendMessage({ customType: "swb.recovery", content: proc.recoveryNotice, display: true }, { triggerTurn: false });
			proc.recoveryNotice = null;
		}
	});

	// Not the user message_start: a launched session's first turn starts with its briefing as a message.
	// pi re-emits agent_start for retries, compaction, and queued messages within one turn; only a turn
	// that starts from idle moves last_prompt_at, so swb_update_session can't be undone by its own turn.
	pi.on("agent_start", (_event, ctx) => {
		writeFor(ctx, (db, id) => {
			const transcript = ctx.sessionManager.getSessionFile();
			if (!transcript) throw new Error("pi is running without a session file");
			const title = ctx.sessionManager.getSessionName() ?? null;
			const parentId = startTurn(db, { harness: "pi", host: proc.launch.tmuxSession, sessionId: id, cwd: ctx.cwd, transcript, title });
			// The launcher's lineage, in the transcript too, so pi-sessions sees it after the session leaves swb.
			if (parentId) pi.appendEntry(LINEAGE, { parentSessionId: parentId });
		});
	});

	/** Blocked while anything waits on the person: a dialog through ctx.ui, or a Glimpse attention span. */
	const waiting = (key: string, open: boolean) => {
		if (!current) return;
		if (open) proc.attention.add(key);
		else proc.attention.delete(key);
		const phase = proc.attention.size > 0 ? "blocked" : "working";
		write(current, (db, id) => setPhase(db, id, phase));
	};
	const attention = (open: boolean) => (data: unknown) => {
		const attentionId = (data as { attentionId?: unknown }).attentionId;
		if (typeof attentionId === "string") waiting(`glimpse:${attentionId}`, open);
	};
	pi.events.on("glimpseui:attention:request", attention(true));
	pi.events.on("glimpseui:attention:resolve", attention(false));
	// pi reports only the outermost of nested dialogs, so one key covers them all.
	pi.on("ui_prompt_start", () => waiting("ui-prompt", true));
	pi.on("ui_prompt_end", () => waiting("ui-prompt", false));

	// The last reply's stop, read when the run settles: a retry that succeeds replaces an error before then.
	let stopReason: string | undefined;
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") stopReason = event.message.stopReason;
	});

	pi.on("agent_settled", (event, ctx) => {
		proc.attention.clear();
		writeFor(ctx, (db, id) => {
			if (stopReason === "error" && !event.aborted) turnErrored(db, id);
			const { quit } = settle(db, {
				host: proc.launch.tmuxSession,
				sessionId: id,
				cwd: ctx.cwd,
				title: ctx.sessionManager.getSessionName() ?? null,
			});
			// Archived during its own turn, by swb_update_session or `swb archive` from a shell, or reloading: it quits now.
			if (quit) ctx.shutdown();
		});
	});

	pi.on("session_info_changed", (event, ctx) => {
		writeFor(ctx, (db, id) => setTitle(db, id, event.name ?? null));
	});

	pi.registerCommand("archive", {
		description: "Archive this session in swb and quit",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("swb: turn running: wait for it to complete", "error");
				return;
			}
			writeFor(ctx, (db, id) => {
				if (recordTx(db, () => archiveMark(db, id))) ctx.shutdown();
				else ctx.ui.notify("swb: nothing to archive before the first prompt", "error");
			});
		},
	});

	const guide = launchGuide();
	const tool = (
		name: ToolName,
		target: (args: Record<string, unknown>) => string,
		run: (args: never, ctx: ExtensionContext, toolCallId: string, signal?: AbortSignal) => Promise<ToolResult>,
	) => {
		const register = (cwd: string) =>
			pi.registerTool({
				name,
				label: TOOLS[name].label,
				description: describeTool(name, TOOLS[name].description, guide),
				promptGuidelines: TOOLS[name].guidelines,
				parameters: toolParameters(name, name === "swb_update_session" && linkedWorktree(cwd) !== null),
				renderCall(args, theme, context) {
					const what = target(args as Record<string, unknown>);
					const call = new Text(
						`${theme.fg("toolTitle", theme.bold(TOOLS[name].label))}${what ? ` · ${theme.fg("accent", what)}` : ""}`,
						0,
						0,
					);
					return name === "session_send_message"
						? { invalidate() {}, render: (width: number) => (context.state.receipt ? [] : call.render(width)) }
						: call;
				},
				// Collapsed, a call reads as swb's summary, or the text's first line; expanded, as the text the model read.
				renderResult(result, options, theme, context) {
					const output = (result.content.find((item) => item.type === "text")?.text ?? "").trim();
					if (context.isError) return new Text(theme.fg("error", output), 0, 0);
					if (name === "session_send_message") {
						context.state.receipt = true;
						const details = result.details as { delivered: boolean; target: { id: string; title: string | null } };
						const label = details.target.title ?? details.target.id;
						const heading = `${theme.bold("Message")} → ${label} · ${details.delivered ? "delivered" : "queued"}`;
						return new Text(options.expanded ? `${heading}\n${output}` : heading, 0, 0);
					}
					if (options.expanded) return new Text(theme.fg("dim", output), 0, 0);
					if (name === "session_list") {
						const { sessions } = result.details as { sessions: { id: string; title: string | null }[] };
						if (sessions.length > 0)
							return {
								invalidate() {},
								render: (width: number) => [
									...sessions.map((s) => `  ${truncateToWidth(s.title ?? s.id, Math.max(1, width - 2), "…")}`),
									`  ${theme.fg("muted", context.keyHint("app.tools.expand", "details"))}`,
								],
							};
					}
					const lines = output.split("\n");
					const { summary } = result.details as { summary?: string };
					const hidden = summary === undefined ? lines.length - 1 : lines.length;
					const more =
						hidden > 0
							? `${theme.fg("muted", ` (${hidden} more ${hidden === 1 ? "line" : "lines"}, `)}${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
							: "";
					return new Text(`${theme.fg("dim", summary ?? (lines[0] as string))}${more}`, 0, 0);
				},
				async execute(toolCallId, params, signal, _onUpdate, ctx) {
					if (proc.failure) throw new Error(`swb: not recording: ${proc.failure}`);
					const result = await run(params as never, ctx, toolCallId, signal);
					return { content: [{ type: "text", text: result.text }], details: { ...result.details, summary: result.summary } };
				},
			});
		register(process.cwd());
		if (name === "swb_update_session") pi.on("session_start", (_event, ctx) => register(ctx.cwd));
	};

	const self = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
	/** A session id as the roster names it, for a tool call's line. */
	const titleOf = (id: unknown) => (typeof id === "string" ? (recordedTitle(connect(), id) ?? id) : "");

	tool(
		"session_list",
		() => "",
		(_args, ctx) => swb(proc.launch.bin, ["list", "--from", self(ctx)]),
	);

	tool(
		"session_search",
		(args) => String(args.query ?? ""),
		(args: { query: string; limit?: number }, ctx, _toolCallId, signal) =>
			swb(proc.launch.bin, ["search", "--from", self(ctx), ...(args.limit ? ["--limit", String(args.limit)] : [])], args.query, signal),
	);

	tool(
		"session_recall",
		(args) => titleOf(args.session),
		async (args: { session: string; question: string }, ctx, _toolCallId, signal) => {
			signal?.throwIfAborted();
			if (!ctx.model) throw new Error("No active model is available for session_recall");
			const first = await swb(proc.launch.bin, ["recall", "begin", args.session], JSON.stringify({ question: args.question }), signal);
			const { createAgentSession, DefaultResourceLoader, defineTool, getAgentDir, ModelRuntime, SessionManager } = await import(
				"@earendil-works/pi-coding-agent"
			);
			// Pi exposes the registry facade, not its runtime (earendil-works/pi#8791).
			const modelRuntime: unknown = Reflect.get(ctx.modelRegistry, "runtime");
			if (!(modelRuntime instanceof ModelRuntime)) throw new Error("swb cannot reach Pi's model runtime through ModelRegistry.runtime");
			const resourceLoader = new DefaultResourceLoader({
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				appendSystemPromptOverride: (base) => [...base, READER_PROMPT],
			});
			await resourceLoader.reload();
			signal?.throwIfAborted();
			const { session } = await createAgentSession({
				cwd: ctx.cwd,
				model: ctx.model,
				modelRuntime,
				thinkingLevel: pi.getThinkingLevel(),
				resourceLoader,
				sessionManager: SessionManager.inMemory(ctx.cwd),
				tools: ["read", "grep", "find", "ls", "recall_search", "recall_read"],
				customTools: [
					defineTool({
						name: "recall_search",
						label: READER_TOOLS.recall_search.label,
						description: [READER_TOOLS.recall_search.description, ...READER_TOOLS.recall_search.guidelines].join("\n"),
						parameters: READER_TOOLS.recall_search.parameters,
						async execute(_id, params, signal) {
							const result = await swb(proc.launch.bin, ["recall", "search", args.session], JSON.stringify(params), signal);
							return { content: [{ type: "text", text: result.text }], details: { ...result.details, summary: result.summary } };
						},
					}),
					defineTool({
						name: "recall_read",
						label: READER_TOOLS.recall_read.label,
						description: READER_TOOLS.recall_read.description,
						parameters: READER_TOOLS.recall_read.parameters,
						async execute(_id, params, signal) {
							const result = await swb(proc.launch.bin, ["recall", "read", args.session], JSON.stringify(params), signal);
							return { content: [{ type: "text", text: result.text }], details: { ...result.details, summary: result.summary } };
						},
					}),
				],
			});
			let aborting: Promise<void> | undefined;
			const abort = () => {
				aborting ??= session.abort();
			};
			try {
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
				signal?.throwIfAborted();
				await session.prompt(first.text);
				signal?.throwIfAborted();
				const last = session.messages.findLast((message) => message.role === "assistant");
				if (last?.role !== "assistant") throw new Error("Reader returned no assistant message");
				if (last.stopReason === "error") throw new Error(last.errorMessage || "Reader failed");
				const answer = last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
				if (!answer.trim()) throw new Error("Reader returned no answer");
				return { text: answer, details: { session: args.session } };
			} finally {
				signal?.removeEventListener("abort", abort);
				try {
					if (aborting) await aborting;
				} finally {
					session.dispose();
				}
			}
		},
	);

	tool(
		"session_send_message",
		(args) => titleOf(args.session),
		(args: { session: string; message: string; report_back: boolean }, ctx, toolCallId) =>
			swb(
				proc.launch.bin,
				["send", "--from", self(ctx), "--to", args.session, "--request-id", toolCallId, ...(args.report_back ? ["--report-back"] : [])],
				args.message,
			),
	);

	tool(
		"session_launch",
		(args) =>
			`${[args.harness, args.agent, args.model].filter(Boolean).join(" ") || "default"} · ${args.title}${args.schedule_label ? ` · ${args.schedule_label}` : ""}`,
		(
			args: {
				harness?: string;
				model?: string;
				effort?: string;
				agent?: string;
				briefing: string;
				cwd?: string;
				title: string;
				group?: string | null;
				report_back: boolean;
				at?: string;
				cron?: string;
				schedule_label?: string;
			},
			ctx,
			toolCallId,
		) =>
			swb(
				proc.launch.bin,
				[
					"launch",
					...(["harness", "model", "effort", "agent"] as const).flatMap((k) => (args[k] ? [`--${k}`, args[k]] : [])),
					"--from",
					self(ctx),
					"--cwd",
					args.cwd ?? ctx.cwd,
					"--title",
					args.title,
					...groupFlags(args.group),
					...(args.report_back ? ["--report-back"] : []),
					...(args.at !== undefined ? ["--at", args.at] : []),
					...(args.cron !== undefined ? ["--cron", args.cron] : []),
					...(args.schedule_label !== undefined ? ["--schedule-label", args.schedule_label] : []),
					"--request-id",
					toolCallId,
				],
				args.briefing,
			),
	);

	tool(
		"session_schedule",
		(args) => `${args.session ? titleOf(args.session) : "this session"} · ${args.schedule_label}${args.snooze ? " · snooze" : ""}`,
		(
			args: {
				message: string;
				at?: string;
				cron?: string;
				schedule_label: string;
				session?: string;
				report_back?: boolean;
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
					"--schedule-label",
					args.schedule_label,
					"--request-id",
					toolCallId,
					...(args.at !== undefined ? ["--at", args.at] : []),
					...(args.cron !== undefined ? ["--cron", args.cron] : []),
					...(args.session !== undefined ? ["--to", args.session] : []),
					...(args.report_back ? ["--report-back"] : []),
					...(args.snooze ? ["--snooze"] : []),
				],
				args.message,
			),
	);

	tool(
		"session_list_schedules",
		() => "",
		(_args, ctx) => swb(proc.launch.bin, ["list-schedules", "--from", self(ctx)]),
	);

	tool(
		"session_unschedule",
		(args) => String(args.schedule ?? ""),
		(args: { schedule: string }, ctx) => swb(proc.launch.bin, ["unschedule", args.schedule, "--from", self(ctx)]),
	);

	tool(
		"swb_show_session",
		(args) => `${titleOf(args.session)}${args.view ? ` · ${args.view}` : ""}`,
		(args: { session: string; view?: string }, ctx) =>
			swb(proc.launch.bin, ["show", args.session, "--from", self(ctx), ...(args.view ? ["--view", args.view] : [])]),
	);

	type Snooze = string | { until: string };
	const snoozeText = (snooze: Snooze) => (typeof snooze === "string" ? snooze : snooze.until);

	tool(
		"swb_update_session",
		(args) => {
			const parts = [
				args.archived === true ? `archive${args.family ? " family" : ""}${args.cancel_turns ? " · cancel turns" : ""}` : "",
				args.archived === false ? "unarchive" : "",
				args.cancel ? "cancel turn" : "",
				args.snooze !== undefined ? `snooze ${snoozeText(args.snooze as Snooze)}` : "",
				args.group === null ? "ungroup" : args.group !== undefined ? `group ${args.group}` : "",
				args.title !== undefined ? `retitle as "${args.title}"` : "",
				args.reload !== undefined ? `reload · ${args.reload}` : "",
			].filter(Boolean);
			// Rendered after the call, when a retitled target already carries its new title.
			if (args.title !== undefined) return parts.join(" · ");
			return `${parts.join(" · ")} ${args.session ? titleOf(args.session) : "this session"}`;
		},
		// Archived or reloaded during its own turn, pi quits once the turn settles.
		(args: Record<string, unknown>, ctx) => swb(proc.launch.bin, ["update", "--from", self(ctx)], JSON.stringify(args)),
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
		recorder.flush();
	});
}
