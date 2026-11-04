// Agent Switchboard's Claude Code line, written by swb into its state directory and loaded with --plugin-dir.
// It records this session's lifecycle, gives Claude the switchboard's coordination tools, and delivers messages from
// other sessions: mid-turn as context on the next tool result, or as a new turn when idle.
//
// claude plugin validate only accepts `$` passed to top-level functions, so every call goes through one.
import { LABELS, READER_PROMPT, READER_TOOLS, TOOLS } from "./tools.js";

// What Claude calls the tools of this plugin's swb mcp server, every swb tool among them.
const PREFIX = "mcp__plugin_swb_swb__";

/** What a call's row names after its label, from its arguments alone: drawing can't wait on swb for a title. */
function target(name, args) {
	switch (name) {
		case "session_search":
			return args.query;
		case "session_recall":
			return args.question;
		case "session_send_message":
			return args.message;
		case "session_launch":
			return `${[args.harness, args.agent, args.model].filter(Boolean).join(" ") || "default"} · ${args.title}${args.schedule_label ? ` · ${args.schedule_label}` : ""}`;
		case "session_schedule":
			return `${args.session ? "another session" : "this session"} · ${args.schedule_label}${args.snooze ? " · snooze" : ""}`;
		case "session_unschedule":
			return args.schedule;
		case "swb_show_session":
			return args.view ?? "";
		case "swb_update_session":
			return [
				args.archived === true ? `archive${args.family ? " family" : ""}${args.cancel_turns ? " · cancel turns" : ""}` : "",
				args.archived === false ? "unarchive" : "",
				args.cancel ? "cancel turn" : "",
				args.snooze !== undefined ? `snooze ${typeof args.snooze === "string" ? args.snooze : args.snooze.until}` : "",
				args.group === null ? "ungroup" : args.group !== undefined ? `group ${args.group}` : "",
				args.title !== undefined ? `retitle as "${args.title}"` : "",
				args.reload !== undefined ? `reload · ${args.reload}` : "",
			]
				.filter(Boolean)
				.join(" · ");
		default:
			return "";
	}
}

/**
 * swb's summary of each call that has one, by tool_use_id: what a person reads in place of the text's first line, which
 * is for the model. The transcript stores only the text, since an MCP tool's result is all read by the model, so these
 * last as long as this process; a row drawn again after a restart shows the first line.
 */
const summaries = new Map();

/**
 * Claude Code folds MCP calls into one `Called plugin:swb:swb` line, which only ctrl+o opens. A run of nothing but swb
 * calls draws a row for each instead, as pi's line does: its label and target, then what it answered, or the
 * error in red. A call with no answer yet is running: isRunning stays false while a hook answers it.
 */
function drawCalls($, e) {
	const { Box, Text } = $.ui.resolve(e);
	return Box({
		flexDirection: "column",
		children: e.props.calls.map((call) => {
			const name = call.tool.slice(PREFIX.length);
			// While the model still writes a call, its input lacks fields; the row names only the label until they arrive.
			const { required = [] } = TOOLS.find((tool) => tool.name === name).inputSchema;
			// Each row shows one line of the transcript's width, and Claude Code notes any text past 100,000 characters.
			const what = required.every((key) => key in call.input) ? target(name, call.input).replace(/\s+/g, " ").slice(0, 500) : "";
			const answer = (
				call.isInterrupted
					? "Interrupted"
					: call.output === undefined
						? "Running…"
						: ((call.isErrored ? undefined : summaries.get(call.tool_use_id)) ?? String(call.output).trim().split("\n")[0])
			).slice(0, 500);
			return Box({
				key: call.tool_use_id,
				flexDirection: "column",
				children: [
					Text({
						wrap: "truncate-end",
						children: [
							"  ",
							Text({ bold: true, children: [LABELS[name]] }),
							what ? Text({ dimColor: true, children: [` · ${what}`] }) : "",
						],
					}),
					answer
						? Text({
								wrap: "truncate-end",
								...(call.isErrored ? { color: "error" } : { dimColor: true }),
								children: [`  ⎿  ${answer}`],
							})
						: "",
				],
			});
		}),
	});
}

async function registerReader($) {
	await $.agent.register({
		name: "reader",
		description: "Answer a question about a switchboard session's conversation.",
		prompt: READER_PROMPT,
		tools: [...READER_TOOLS.map((tool) => `${PREFIX}${tool.name}`), "Read", "Grep", "Glob"],
		model: "inherit",
	});
}

// Readers session_recall started, by agentId, each with the session it reads: only they may read transcripts, and each
// one's turn.complete ends its wait.
const readers = new Map();

/**
 * Starts a reader and returns its final answer. $.tool.call refuses the Agent tool, and $.agent.spawn resolves once the
 * reader starts. A hook's 10s budget stops only while a $ call is in flight, so the hook waits on a child that writes
 * nothing: the reader's turn.complete ends it, and Esc kills it.
 *
 * HACK: the idle child, and the timer that stops a reader after Esc, stand in for an API the mods SDK lacks: a way to
 * await a spawned agent's answer and stop it from the hook that spawned it. Replace both once Claude Code offers one,
 * such as $.agent.wait, or lets $.tool.call run the Agent tool.
 */
async function ask($, e) {
	const first = JSON.parse(await swb($, ["recall", "begin", e.session], JSON.stringify({ question: e.question })));
	const { agentId, deny } = await $.agent.spawn({
		subagentType: "swb:reader",
		prompt: first.text,
		description: "Read session conversation",
	});
	if (deny) throw new Error(deny);
	if (!agentId) throw new Error("Claude did not start a reader");
	const reader = { session: e.session, answer: undefined, wait: $.process.spawn({ argv: ["tail", "-f", "/dev/null"] }) };
	readers.set(agentId, reader);
	try {
		for await (const _ of reader.wait);
	} finally {
		readers.delete(agentId);
		// Esc leaves a spawned agent running, and denies a tool call from the aborted hook; a timer's isn't the hook's.
		if (reader.answer === undefined) $.clock.after(0, () => stopReader($, agentId));
	}
	if (reader.answer === undefined) throw new Error("session_recall's reader stopped waiting");
	return reader.answer;
}

/** A reader's tool, on the session it reads, with the arguments its schema names. */
async function readerTool($, tool, e) {
	const reader = readers.get(e.agentId);
	if (!reader) return { deny: `${tool.name} is only available to session_recall's reader` };
	const args = Object.fromEntries(Object.keys(tool.inputSchema.properties).flatMap((key) => (e[key] === undefined ? [] : [[key, e[key]]])));
	try {
		return { result: JSON.parse(await swb($, ["recall", tool.name.replace("recall_", ""), reader.session], JSON.stringify(args))).text };
	} catch (error) {
		return { deny: error.message };
	}
}

async function stopReader($, agentId) {
	try {
		const stopped = await $.tool.call({ tool: "TaskStop", task_id: agentId });
		if (stopped.deny || stopped.isError) throw new Error(stopped.deny ?? stopped.text);
	} catch (error) {
		$.ui.log(`swb: session_recall's reader didn't stop: ${error.message}`);
	}
}

const line = {
	managed: false,
	started: false,
	recovered: false,
	bin: "",
	host: "",
	session: "",
	cwd: "",
	/** The session whose start swb has recorded, so a late environment records it once. */
	recorded: "",
	busy: false,
	turnId: "",
	blocked: false,
	draft: "",
	pending: [],
	/** A title set through swb, { target, title }, that Claude Code takes as its own with the next prompt. */
	title: null,
	/** The model and effort of this session's last model request recorded, so only a change is recorded again. */
	request: "",
	/** The last record in flight; each waits for the one before, so swb sees them in order. */
	recording: Promise.resolve(""),
};

async function env($, name) {
	if (name === "SWB_BIN") return (await $.env.get("SWB_BIN")) ?? "";
	if (name === "SWB_TMUX_SESSION") return (await $.env.get("SWB_TMUX_SESSION")) ?? "";
	return (await $.env.get("SWB_DB")) ?? "";
}

/** Runs swb; a failure carries its stderr, which is what the model or the person should read. */
async function swb($, args, stdin) {
	// The last turn still has to settle after archive-and-delete removes the session's directory.
	const result = await $.process.run([line.bin, ...args], {
		...(args[0] === "__record" ? { cwd: "/" } : {}),
		...(stdin === undefined ? {} : { stdin }),
		timeoutMs: 90000,
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.trim().replace(/^swb: /, "") || `swb ${args[0]} exited ${result.exitCode}`);
	return result.stdout;
}

/**
 * Records in order, after any still in flight. A turn's hooks don't wait for theirs: each is an swb process to boot,
 * which Claude's next model request would wait out.
 */
function record($, args) {
	line.recording = line.recording.then(() => recordNow($, args));
	return line.recording;
}

/** Recording never fails a hook: it says so where the person looks, and Claude carries on. */
async function recordNow($, args) {
	try {
		return await swb($, ["__record", ...args, "--host", line.host]);
	} catch (error) {
		$.ui.toast(`swb: not recording: ${error.message}`);
		$.ui.log(`swb: not recording: ${error.message}`, { to: "debug" });
		return "";
	}
}

async function ack($, ids) {
	if (ids.length > 0) await swb($, ["__ack", ...ids]);
}

/**
 * The only trace of a message delivered mid-turn: it rides as context on a tool result, which the transcript doesn't show.
 * One that starts a turn shows as that turn's prompt.
 */
function receipt($, m) {
	// Claude Code draws a log's trailing newline as �.
	const body = m.body.trim();
	$.ui.log(`↘ ${m.title} (mid-turn): ${body.length > 200 ? `${body.slice(0, 200)}…` : body}`);
}

/** The held messages for the session this process shows now; any others wait for theirs. */
function take() {
	const batch = line.pending.filter((m) => m.target === line.session);
	line.pending = line.pending.filter((m) => m.target !== line.session);
	return batch;
}

/**
 * Starts a turn with what arrived while idle. submit resolves once that turn starts, which is when the batch is
 * delivered; awaited inside a hook that runs while Claude works, it never would, so callers don't await this.
 */
async function submitPending($) {
	if (line.busy || !line.session) return;
	const batch = take();
	if (batch.length === 0) return;
	try {
		await $.prompt.submit({ text: batch.map((m) => m.text).join("\n\n---\n\n") });
	} catch (error) {
		line.pending.unshift(...batch);
		$.ui.log(`swb: couldn't start a turn for ${batch.length} message(s): ${error.message}`);
		return;
	}
	await ack(
		$,
		batch.map((m) => m.id),
	);
}

/** Keeps swb's inbox for this session running for the session's life, and says so when it fails. */
async function pump($) {
	for (;;) {
		try {
			const ended = await drain($);
			// A signal means the session is ending, and the line with it; anything else is worth saying.
			if (ended?.signal) return;
			$.ui.log(`swb: inbox stopped (exit ${ended?.code}); restarting`);
		} catch (error) {
			$.ui.log(`swb: inbox failed: ${error.message}; restarting`);
		}
		await $.clock.sleep(1000);
	}
}

async function drain($) {
	const inbox = $.process.spawn({ argv: [line.bin, "__inbox", "--host", line.host] });
	let buffer = "";
	const iterator = inbox[Symbol.asyncIterator]();
	for (;;) {
		const { done, value } = await iterator.next();
		if (done) return value;
		const { stream, text } = value;
		if (stream !== "stdout") {
			$.ui.log(`swb inbox: ${text}`);
			continue;
		}
		buffer += text;
		for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
			const raw = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (!raw.trim()) continue;
			const m = JSON.parse(raw);
			if (m.kind === "title") line.title = m;
			else if (m.kind === "cancel") {
				if (line.busy && line.turnId) await $.turn.abort({ turnId: line.turnId });
				await ack($, [m.id]);
			} else {
				line.pending.push(m);
				void submitPending($);
			}
		}
	}
}

/** A launch's Group as swb's flags take it: omitted, named, or none. */
function groupFlags(group) {
	if (group === undefined) return [];
	return group === null ? ["--no-group"] : ["--group", group];
}

async function useTool($, name, e) {
	// The caller is whoever Claude Code says this session is now, never a value cached from an event that can be missed.
	const self = await $.session.id();
	const from = ["--from", self];
	// A launch carries forward the model and effort this session runs on, which swb reads from its records.
	if (name === "session_launch") await line.recording;
	switch (name) {
		case "session_list":
			return swb($, ["list", ...from]);
		case "session_search":
			return swb($, ["search", ...from, ...(e.limit ? ["--limit", String(e.limit)] : [])], e.query);
		case "session_send_message":
			return swb(
				$,
				["send", ...from, "--to", e.session, "--request-id", e.tool_use_id, ...(e.report_back ? ["--report-back"] : [])],
				e.message,
			);
		case "session_launch":
			return swb(
				$,
				[
					"launch",
					...from,
					...["harness", "model", "effort", "agent"].flatMap((k) => (e[k] ? [`--${k}`, e[k]] : [])),
					"--cwd",
					e.cwd ?? line.cwd,
					"--title",
					e.title,
					...groupFlags(e.group),
					...(e.report_back ? ["--report-back"] : []),
					...(e.at !== undefined ? ["--at", e.at] : []),
					...(e.cron !== undefined ? ["--cron", e.cron] : []),
					...(e.schedule_label !== undefined ? ["--schedule-label", e.schedule_label] : []),
					"--request-id",
					e.tool_use_id,
				],
				e.briefing,
			);
		case "session_schedule":
			return swb(
				$,
				[
					"schedule",
					...from,
					"--schedule-label",
					e.schedule_label,
					"--request-id",
					e.tool_use_id,
					...(e.at !== undefined ? ["--at", e.at] : []),
					...(e.cron !== undefined ? ["--cron", e.cron] : []),
					...(e.session !== undefined ? ["--to", e.session] : []),
					...(e.report_back ? ["--report-back"] : []),
					...(e.snooze ? ["--snooze"] : []),
				],
				e.message,
			);
		case "session_list_schedules":
			return swb($, ["list-schedules", ...from]);
		case "session_unschedule":
			return swb($, ["unschedule", e.schedule, ...from]);
		case "swb_show_session":
			return swb($, ["show", e.session, ...from, ...(e.view ? ["--view", e.view] : [])]);
		case "swb_update_session": {
			// The event carries the call's own fields beside its arguments; swb checks only the arguments.
			const { properties } = TOOLS.find((t) => t.name === name).inputSchema;
			const args = Object.fromEntries(Object.keys(properties).flatMap((key) => (e[key] === undefined ? [] : [[key, e[key]]])));
			return swb($, ["update", ...from], JSON.stringify(args));
		}
		default:
			throw new Error(`swb: no tool ${name}`);
	}
}

/**
 * Reads swb's launch environment and the session this process shows, and records that session's start once. Every
 * hook asks: session.start fires once per process, before /clear or /resume moves it to another session.
 */
async function init($) {
	if (!line.managed) {
		line.bin = await env($, "SWB_BIN");
		line.host = await env($, "SWB_TMUX_SESSION");
		line.managed = Boolean(line.bin && line.host);
		if (line.managed && !line.started) {
			line.started = true;
			void pump($);
		}
	}
	if (!line.managed) return;
	await follow($);
	await begin($);
}

/** Moves to the session Claude Code shows now; /clear and /resume change it. */
async function follow($) {
	const id = await $.session.id();
	if (id === line.session) return;
	// Messages held for a session this process left stay undelivered, for when that session runs again.
	line.pending = line.pending.filter((m) => m.target === id);
	line.session = id;
	line.cwd = await $.session.cwd();
	line.busy = false;
	line.blocked = false;
	line.request = "";
}

/** Records the start of the session this process shows, once. */
async function begin($) {
	if (line.recorded === line.session) return;
	line.recorded = line.session;
	await record($, ["start", "--session", line.session, "--cwd", line.cwd]);
	await restoreDraft($);
	void submitPending($);
}

/**
 * The tools come from the plugin's swb mcp server rather than $.tool.register, which can't mark a tool read-only, and
 * Claude runs only read-only MCP tools in parallel; the reader's are deferred there, since only it needs their schemas.
 * Claude doesn't wait for a plugin's server before the first turn, so this does. swb is the only thing that loads this
 * plugin; a call outside swb says so.
 */
async function connectTools($) {
	const connected = await $.mcp.connect("swb");
	if (!connected.isConnected) $.ui.toast(`swb: coordination tools unavailable: ${connected.message}`);
}

async function draftPath($, id) {
	const db = await env($, "SWB_DB");
	return `${db.slice(0, db.lastIndexOf("/"))}/drafts/${id}`;
}

async function restoreDraft($) {
	const path = await draftPath($, line.session);
	if (!(await $.fs.exists(path))) return;
	const draft = await $.fs.read(path);
	await $.fs.write(path, "");
	if (draft) await $.prompt.fill({ text: draft });
}

async function trackDraft(_$, e, next) {
	const result = await next(e);
	line.draft = result.text;
	return result;
}

async function saveDraft($) {
	if (line.draft.trim()) await $.fs.write(await draftPath($, line.session), line.draft);
}

export function register(on) {
	on("classic.SessionStart", async ($, e, next) => {
		const result = await next(e);
		if (line.recovered) return result;
		line.recovered = true;
		const notice = await $.env.get("SWB_RECOVERY_NOTICE");
		if (!notice) return result;
		$.ui.log(notice.replace(/^swb: /, ""));
		return { ...result, additionalContext: [...(result.additionalContext ?? []), notice] };
	});

	on("session.start", async ($, e, next) => {
		const result = await next(e);
		await connectTools($);
		await registerReader($);
		await init($);
		return result;
	});

	on("agent.offer", { agent: "swb:reader" }, () => ({ isOffered: false }));

	on("turn.start", async ($, e, next) => {
		await init($);
		if (line.managed && !e.agentId) {
			line.busy = true;
			line.turnId = e.turnId;
			void record($, ["turn", "--session", line.session, "--cwd", line.cwd]);
		}
		return next(e);
	});

	// Claude Code names a session from a prompt hook's sessionTitle, and writes it as its own custom title. No other
	// event can, so this stays a classic hook, which an organization's cc-plugin-sec-default sends on past the line.
	on("classic.UserPromptSubmit", async (_, e, next) => {
		const result = await next(e);
		const pending = line.title;
		if (!line.managed || pending?.target !== line.session) return result;
		line.title = null;
		return { ...result, sessionTitle: pending.title };
	});

	// A call's ask opens the permission dialog, unless a host answers it elsewhere. In auto mode the classifier answers it
	// instead, and only the transcript says which mode a prompt went in, so swb leaves those asks out; AskUserQuestion
	// asks the person in every mode, even right after an ask swb left out.
	on("tool.check", async ($, e, next) => {
		const verdict = await next(e);
		const person = e.tool === "AskUserQuestion";
		if (
			line.managed &&
			line.busy &&
			(person || !line.blocked) &&
			e.tool_use_id &&
			verdict.decision === "ask" &&
			verdict.decider !== "host"
		) {
			line.blocked = true;
			void record($, ["phase", "blocked", "--session", line.session, "--cwd", line.cwd, ...(person ? ["--asks-person"] : [])]);
		}
		return verdict;
	});

	// A model request means the permission prompt was answered.
	// Its transcript records the model of each turn but never the effort, so the line records both as each request goes out.
	// An effort given as a number of tokens isn't a level, and is recorded as none.
	on("turn.step", async function* ($, e, next) {
		if (line.managed && !e.agentId && e.model) {
			const effort = typeof e.effort === "string" ? e.effort : "";
			if (`${e.model}\t${effort}` !== line.request) {
				line.request = `${e.model}\t${effort}`;
				void record($, ["request", "--session", line.session, "--model", e.model, ...(effort ? ["--effort", effort] : [])]);
			}
		}
		if (line.managed && !e.agentId && line.blocked) {
			line.blocked = false;
			void record($, ["phase", "working", "--session", line.session]);
		}
		return yield* next(e);
	});

	on("turn.complete", async ($, e, next) => {
		const result = await next(e);
		const reader = e.agentId && readers.get(e.agentId);
		if (reader) {
			reader.answer = e.answer ?? "The reader stopped without an answer.";
			await reader.wait.return();
		}
		if (line.managed && !e.agentId) {
			line.busy = false;
			line.blocked = false;
			if (e.reason === "error") void record($, ["errored", "--session", line.session]);
			// swb stops this session after recording, when it was archived during the turn or is reloading.
			void record($, ["settled", "--session", line.session, "--cwd", line.cwd]);
			void submitPending($);
		}
		return result;
	});

	// Separate from the spawning hook: Claude skips that hook in the nested agent to prevent re-entry.
	for (const tool of READER_TOOLS) on("tool.call", { tool: `${PREFIX}${tool.name}` }, ($, e) => readerTool($, tool, e));

	on("tool.call", async ($, e, next) => {
		const tool = TOOLS.find((t) => e.tool === `${PREFIX}${t.name}`);
		if (tool) {
			await init($);
			if (!line.managed) return { deny: "this Claude Code session isn't on the switchboard: swb didn't start it" };
			try {
				if (tool.name === "session_recall") return { result: await ask($, e) };
				const { text, summary } = JSON.parse(await useTool($, tool.name, e));
				if (summary !== undefined) summaries.set(e.tool_use_id, summary);
				return { result: text };
			} catch (error) {
				return { deny: error.message };
			}
		}
		const result = await next(e);
		// Messages that arrived mid-turn ride on the next main-loop tool result, which Claude reads before going on.
		if (!line.managed || e.agentId || next.origin.plugin !== "engine" || !("result" in result)) return result;
		const batch = take();
		if (batch.length === 0) return result;
		for (const m of batch) receipt($, m);
		await ack(
			$,
			batch.map((m) => m.id),
		);
		return { ...result, context: [...(result.context ?? []), ...batch.map((m) => m.text)] };
	});

	// Only the folded line: unfolded, under ctrl+o or --verbose, each call draws Claude Code's own row, in full. A run
	// that mixes in other tools keeps Claude Code's line, which counts them all. Not gated on isCallsOnly: a failed
	// call clears it, and its error is what most needs showing.
	on("ui.render", { component: "ToolGroup" }, ($, e, next) => {
		const ours = (call) => call.tool.startsWith(PREFIX) && Object.hasOwn(LABELS, call.tool.slice(PREFIX.length));
		if (e.props.isExpanded || !e.props.calls.every(ours)) return next(e);
		return drawCalls($, e);
	});

	// A typed edit raises prompt.edit; a submit, a clear, a recall, or a fill raises prompt.change.
	on("prompt.edit", trackDraft);
	on("prompt.change", trackDraft);

	on("session.end", async ($, e, next) => {
		if (!line.managed) return next(e);
		// /clear and /resume carry this process on under another session, which it shows once the end is done.
		if (e.reason === "clear" || e.reason === "resume") {
			$.clock.after(0, () => init($));
			return next(e);
		}
		await saveDraft($);
		await record($, ["end"]);
		return next(e);
	});
}
