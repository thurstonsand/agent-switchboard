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

/**
 * Readers session_recall started, by agentId: the session each reads, and the caller and question its answer goes back
 * to. Only they may read transcripts, until their turn.complete.
 */
const readers = new Map();

/**
 * Starts a reader in the background and returns at once, as the Agent tool does; the answer arrives as a message once
 * the reader is done. In auto mode Claude Code delivers it, since it makes a subagent report through SubagentHandback;
 * otherwise a mod's agent answers only to the mod, so the line delivers it as it does a message from another session.
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
	readers.set(agentId, { session: e.session, question: e.question, caller: await $.session.id(), handedBack: false });
	// Worded after the Agent tool's own result for a background agent, which Claude models already know how to wait on.
	return `The reader started (agent ${agentId}) in the background. Its answer arrives in a later message once it's done. You know nothing about it until then: don't report, assume, or predict it, and don't ask again; continue other work or respond to the user in the meantime.`;
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

const line = {
	managed: false,
	started: false,
	bin: "",
	host: "",
	session: "",
	cwd: "",
	/** The session whose start swb has recorded, so a late environment records it once. */
	recorded: "",
	busy: false,
	/** A turn for held messages is being started: they're marked delivered, and Claude Code hasn't begun it yet. */
	submitting: false,
	turnId: "",
	blocked: false,
	draft: "",
	pending: [],
	/** Every message this process took from pending, whether marked delivered or still being marked, so a re-offer is dropped. */
	taken: new Set(),
	/** The model and effort of this session's last model request recorded, so only a change is recorded again. */
	request: "",
	/** The last record in flight; each waits for the one before, so swb sees them in order. */
	recording: Promise.resolve(""),
};

async function env($, name) {
	if (name === "SWB_BIN") return (await $.env.get("SWB_BIN")) ?? "";
	if (name === "SWB_TMUX_SESSION") return (await $.env.get("SWB_TMUX_SESSION")) ?? "";
	if (name === "SWB_OPERATOR") return (await $.env.get("SWB_OPERATOR")) ?? "";
	return (await $.env.get("SWB_DB")) ?? "";
}

// What swb exits with when its db stayed locked past busy_timeout (BUSY_EXIT): worth trying again.
const BUSY_EXIT = 75;
const RETRY_MS = 1000;

/** Runs swb; a failure carries its stderr, which is what the model or the person should read, and swb's exit code. */
async function swb($, args, stdin) {
	// The last turn still has to settle after archive-and-delete removes the session's directory.
	const result = await $.process.run([line.bin, ...args], {
		...(args[0] === "__record" ? { cwd: "/" } : {}),
		...(stdin === undefined ? {} : { stdin }),
		timeoutMs: 90000,
	});
	if (result.exitCode !== 0)
		throw Object.assign(new Error(result.stderr.trim().replace(/^swb: /, "") || `swb ${args[0]} exited ${result.exitCode}`), {
			exitCode: result.exitCode,
		});
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

/**
 * Recording never fails a hook: it says so where the person looks, and Claude carries on. A busy db holds this record,
 * and every one queued after it, until it gets through.
 */
async function recordNow($, args) {
	for (let said = false; ; said = true) {
		try {
			return await swb($, ["__record", ...args, "--host", line.host]);
		} catch (error) {
			if (error.exitCode === BUSY_EXIT) {
				if (!said) $.ui.toast(`swb: recording waits for a busy db: ${error.message}`);
				await $.clock.sleep(RETRY_MS);
				continue;
			}
			$.ui.toast(`swb: not recording: ${error.message}`);
			$.ui.log(`swb: not recording: ${error.message}`, { to: "debug" });
			return "";
		}
	}
}

/** The ids of a batch's messages that came through swb's inbox. */
function inboxIds(batch) {
	return batch.flatMap((m) => (m.id ? [m.id] : []));
}

/** Marks a batch delivered, just before it's handed to Claude Code. A reader's answer never went through swb's inbox. */
async function ack($, batch) {
	const ids = inboxIds(batch);
	if (ids.length > 0) await swb($, ["__ack", ...ids]);
}

/**
 * The only trace of a message delivered mid-turn: it rides as context on a tool result, which the transcript doesn't show.
 * One that starts a turn shows as that turn's prompt.
 */
function receipt($, m) {
	// Claude Code draws a log's trailing newline as �.
	$.ui.log(
		`↘ from \x1b[1m${m.title}\x1b[22m\n${m.body
			.trim()
			.split("\n")
			.map((line) => `  ${line}`)
			.join("\n")}`,
	);
}

/** The persisted mailbox frame, including launch briefings, drawn without its model-only reply address. */
function drawMessage($, e, next) {
	const messages = e.props.text
		.split(/\n\n---\n\n(?=Message from session ")/)
		.map((text) => /^Message from session "(.*?)" \(session: ([^,)]+)[^\n]*\):?[^\n]*\n\n([\s\S]*)$/.exec(text));
	if (messages.some((message) => message === null)) return next(e);
	const { Box, Text } = $.ui.resolve(e);
	return Box({
		flexDirection: "column",
		children: messages.map((message, i) =>
			Box({
				key: String(i),
				flexDirection: "column",
				children: [
					Text({ children: ["↘ from ", Text({ bold: true, children: [message[1]] })] }),
					Box({
						paddingLeft: 2,
						children: [
							Text({ children: [message[3].replace(`\n\nReport back: reply with session_send_message to session ${message[2]}.`, "")] }),
						],
					}),
				],
			}),
		),
	});
}

/** The held messages for the session this process shows now; any others wait for theirs. */
function take() {
	const batch = line.pending.filter((m) => m.target === line.session);
	line.pending = line.pending.filter((m) => m.target !== line.session);
	for (const m of batch) line.taken.add(m.id);
	return batch;
}

/** A batch that wasn't handed over after all: held again, ahead of anything newer. */
function putBack(batch) {
	for (const m of batch) line.taken.delete(m.id);
	line.pending.unshift(...batch);
}

/** Marks a taken batch delivered before it's handed over; on failure it's held again, and false says not to hand it over. */
async function delivering($, batch) {
	try {
		await ack($, batch);
		return true;
	} catch (error) {
		putBack(batch);
		$.ui.log(`swb: holding ${batch.length} message(s): ${error.message}`, { to: "debug" });
		// Mid-turn the next tool result tries again; idle, nothing would.
		if (error.exitCode === BUSY_EXIT) $.clock.after(RETRY_MS, () => void submitPending($));
		return false;
	}
}

/**
 * Starts a turn with what arrived while idle. submit resolves once that turn starts; awaited inside a hook that runs
 * while Claude works, it never would, so callers don't await this.
 */
async function submitPending($) {
	if (line.busy || line.submitting || !line.session) return;
	const batch = take();
	if (batch.length === 0) return;
	line.submitting = true;
	try {
		if (!(await delivering($, batch))) return;
		await $.prompt.submit({ text: batch.map((m) => m.text).join("\n\n---\n\n") });
	} catch (error) {
		$.ui.log(`swb: couldn't start a turn for ${batch.length} message(s): ${error.message}`);
		// Unmarked before it's held again: a tool result could otherwise take and deliver it, and the unmark land after.
		const ids = inboxIds(batch);
		if (ids.length > 0)
			await swb($, ["__unack", ...ids]).catch((unacked) =>
				$.ui.log(`swb: ${batch.length} held message(s) stay marked delivered: ${unacked.message}`, { to: "debug" }),
			);
		putBack(batch);
	} finally {
		line.submitting = false;
	}
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
			if (line.taken.has(m.id) || line.pending.some((held) => held.id === m.id)) continue;
			if (m.kind === "cancel") {
				line.taken.add(m.id);
				try {
					await ack($, [m]);
				} catch (error) {
					// The inbox restarts on this, and offers the cancel again.
					line.taken.delete(m.id);
					throw error;
				}
				try {
					if (line.busy && line.turnId) await $.turn.abort({ turnId: line.turnId });
				} catch (error) {
					await swb($, ["__unack", m.id]);
					line.taken.delete(m.id);
					throw error;
				}
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
	// Every call waits for this turn's records: a snooze or archive made before its turn recorded would be undone by it,
	// and a launch carries forward the model and effort swb reads from them.
	await line.recording;
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
	on("session.start", async ($, e, next) => {
		const result = await next(e);
		await connectTools($);
		await registerReader($);
		await init($);
		return result;
	});

	on("agent.offer", { agent: "swb:reader" }, () => ({ isOffered: false }));
	// An Operator's model starts no subagents, which the Deck can't see; the Agent tool stays, for session_recall's reader.
	on("agent.offer", async ($, e, next) => ((await env($, "SWB_OPERATOR")) ? { isOffered: false } : next(e)));
	on("tool.describe", { tool: "Agent" }, async ($, e, next) => {
		const described = await next(e);
		return (await env($, "SWB_OPERATOR")) ? { ...described, isDeferred: true } : described;
	});

	on("turn.start", async ($, e, next) => {
		await init($);
		if (line.managed && !e.agentId) {
			line.busy = true;
			line.turnId = e.turnId;
			void record($, ["turn", "--session", line.session, "--cwd", line.cwd]);
		}
		return next(e);
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
			readers.delete(e.agentId);
			if (!reader.handedBack) {
				// Worded after the Agent tool's own notification for a background agent.
				const about = `"${reader.question}" about session ${reader.session}`;
				const body = e.answer ?? "";
				const text = body
					? `session_recall's reader (agent ${e.agentId}) finished. Its answer to ${about}:\n\n${body}`
					: `session_recall's reader (agent ${e.agentId}) stopped without an answer to ${about}.`;
				line.pending.push({ target: reader.caller, title: "session_recall's answer", body: body || text, text });
				void submitPending($);
			}
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

	// A reader's SubagentHandback, in auto mode, delivers its answer itself.
	on("tool.call", { tool: "SubagentHandback" }, async (_$, e, next) => {
		const result = await next(e);
		const reader = readers.get(e.agentId);
		if (reader && result.result?.success) reader.handedBack = true;
		return result;
	});

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
		if (batch.length === 0 || !(await delivering($, batch))) return result;
		for (const m of batch) receipt($, m);
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
	on("ui.render", { component: "UserMessage" }, drawMessage);

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
