// Agent Switchboard's Claude Code line, written by swb into its state directory and loaded with --plugin-dir.
// It records this session's lifecycle, gives Claude the switchboard's coordination tools, and delivers messages from
// other sessions: mid-turn as context on the next tool result, or as a new turn when idle.
//
// claude plugin validate only accepts `$` passed to top-level functions, so every call goes through one.
import { READER_PROMPT, READER_TOOLS, TOOLS } from "./tools.js";

async function registerReader($) {
	await $.agent.register({
		name: "reader",
		description: "Answer a question about a switchboard session's conversation.",
		prompt: READER_PROMPT,
		tools: [...READER_TOOLS.map((tool) => `mcp__swb__${tool.name}`), "Read", "Grep", "Glob"],
		model: "inherit",
	});
}

// Readers session_ask started, by agentId, each with the session it reads: only they may read transcripts, and each
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
	if (reader.answer === undefined) throw new Error("session_ask's reader stopped waiting");
	return reader.answer;
}

/** A reader's tool, on the session it reads, with the arguments its schema names. */
async function readerTool($, tool, e) {
	const reader = readers.get(e.agentId);
	if (!reader) return { deny: `${tool.name} is only available to session_ask's reader` };
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
		$.ui.log(`swb: session_ask's reader didn't stop: ${error.message}`);
	}
}

const line = {
	managed: false,
	started: false,
	bin: "",
	host: "",
	session: "",
	cwd: "",
	transcript: "",
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
	const result = await $.process.run([line.bin, ...args], { ...(stdin === undefined ? {} : { stdin }), timeoutMs: 90000 });
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

function receipt($, m, how) {
	// Claude Code draws a log's trailing newline as �.
	const body = m.body.trim();
	$.ui.log(`↘ ${m.title} (${how}): ${body.length > 200 ? `${body.slice(0, 200)}…` : body}`);
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
	for (const m of batch) receipt($, m, "new turn");
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
function groupFlags(prefix, group) {
	if (group === undefined) return [];
	return group === null ? [`${prefix}no-group`] : [`${prefix}group`, group];
}

async function useTool($, name, e) {
	// The caller is whoever Claude Code says this session is now, never a value cached from an event that can be missed.
	const self = await $.session.id();
	const from = ["--from", self];
	// A launch carries forward the model and effort this session runs on, which swb reads from its records.
	if (name === "session_launch" || name === "session_schedule") await line.recording;
	switch (name) {
		case "session_reachable":
			return swb($, ["reachable", ...from]);
		case "session_search":
			return swb($, ["search", ...from, ...(e.limit ? ["--limit", String(e.limit)] : [])], e.query);
		case "session_send_message":
			return swb(
				$,
				["send", ...from, "--to", e.session, "--request-id", e.tool_use_id, ...(e.requestResponse ? ["--request-response"] : [])],
				e.message,
			);
		case "session_cancel":
			return swb($, ["send", ...from, "--to", e.session, "--cancel"]);
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
					...groupFlags("--", e.group),
					...(e.requestResponse ? ["--request-response"] : []),
				],
				e.goal,
			);
		case "session_schedule":
			return swb(
				$,
				[
					"schedule",
					...from,
					"--label",
					e.label,
					"--request-id",
					e.tool_use_id,
					...(e.at !== undefined ? ["--at", e.at] : []),
					...(e.cron !== undefined ? ["--cron", e.cron] : []),
					...(e.session !== undefined ? ["--to", e.session] : []),
					...(e.launch
						? [
								...["harness", "model", "effort", "agent"].flatMap((k) => (e.launch[k] ? [`--launch-${k}`, e.launch[k]] : [])),
								"--launch-title",
								e.launch.title,
								"--launch-cwd",
								e.launch.cwd ?? line.cwd,
								...groupFlags("--launch-", e.launch.group),
							]
						: []),
					...(e.requestResponse ? ["--request-response"] : []),
					...(e.snooze ? ["--snooze"] : []),
				],
				e.message,
			);
		case "session_schedules":
			return swb($, ["schedules", ...from]);
		case "session_unschedule":
			return swb($, ["unschedule", e.id, ...from]);
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
 * hook asks, since none is sure to arrive: another mod can answer classic.SessionStart without passing it on.
 */
async function init($, start) {
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
	await follow($, start);
	await begin($);
}

/** Moves to the session Claude Code shows now; /clear and /resume change it. classic.SessionStart also names its transcript. */
async function follow($, start) {
	const id = start?.session_id ?? (await $.session.id());
	if (id !== line.session) {
		// Messages held for a session this process left stay undelivered, for when that session runs again.
		line.pending = line.pending.filter((m) => m.target === id);
		line.session = id;
		line.cwd = start?.cwd ?? (await $.session.cwd());
		line.transcript = "";
		line.busy = false;
		line.blocked = false;
		line.request = "";
	}
	if (start?.transcript_path) line.transcript = start.transcript_path;
}

/** Records the start of the session this process shows, once. */
async function begin($) {
	if (line.recorded === line.session) return;
	line.recorded = line.session;
	await record($, ["start", "--session", line.session, "--cwd", line.cwd, "--transcript", line.transcript]);
	await restoreDraft($);
	void submitPending($);
}

/**
 * The reader's tools, registered here and deferred, since only the reader needs their schemas. All at once: each
 * registration reconnects the plugin's tool server and waits until its tool lists, which the first turn waits for.
 */
async function registerReaderTools($) {
	await Promise.all(READER_TOOLS.map((tool) => registerTool($, tool)));
}

async function registerTool($, tool) {
	try {
		await $.tool.register({ ...tool, isDeferred: true });
	} catch (error) {
		$.ui.log(`swb: tool ${tool.name} not registered: ${error.message}`);
	}
}

/**
 * The coordination tools come from the plugin's swb mcp server rather than $.tool.register, which can't mark a tool
 * read-only, and Claude runs only read-only MCP tools in parallel. Claude doesn't wait for a plugin's server before the
 * first turn, so this does. swb is the only thing that loads this plugin; a call outside swb says so.
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
		await Promise.all([registerReaderTools($), connectTools($)]);
		await registerReader($);
		await init($);
		return result;
	});

	on("agent.offer", { agent: "swb:reader" }, () => ({ isOffered: false }));

	// Fires at startup and again after /clear and /resume, which move this process to another session.
	on("classic.SessionStart", async ($, e, next) => {
		await init($, e);
		return next(e);
	});

	on("turn.start", async ($, e, next) => {
		await init($);
		if (line.managed && !e.agentId) {
			line.busy = true;
			line.turnId = e.turnId;
			void record($, ["turn", "--session", line.session, "--cwd", line.cwd, "--transcript", line.transcript]);
		}
		return next(e);
	});

	// Claude Code names a session from a prompt hook's sessionTitle, and writes it as its own custom title.
	on("classic.UserPromptSubmit", async (_, e, next) => {
		const result = await next(e);
		const pending = line.title;
		if (!line.managed || pending?.target !== line.session) return result;
		line.title = null;
		return { ...result, sessionTitle: pending.title };
	});

	on("classic.PermissionRequest", async ($, e, next) => {
		if (line.managed && line.busy && !line.blocked) {
			line.blocked = true;
			void record($, ["phase", "blocked", "--session", line.session]);
		}
		return next(e);
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
			// swb stops this session after recording, when it was archived during the turn.
			void record($, ["settled", "--session", line.session, "--cwd", line.cwd, "--transcript", line.transcript]);
			void submitPending($);
		}
		return result;
	});

	// The turn ended on an API error; turn.complete still settles it.
	on("classic.StopFailure", async ($, e, next) => {
		if (line.managed && !e.agent_id) void record($, ["errored", "--session", line.session]);
		return next(e);
	});

	// Separate from the spawning hook: Claude skips that hook in the nested agent to prevent re-entry.
	for (const tool of READER_TOOLS) on("tool.call", { tool: `mcp__swb__${tool.name}` }, ($, e) => readerTool($, tool, e));

	on("tool.call", async ($, e, next) => {
		const tool = TOOLS.find((t) => e.tool === `mcp__plugin_swb_swb__${t.name}`);
		if (tool) {
			await init($);
			if (!line.managed) return { deny: "this Claude Code session isn't on the switchboard: swb didn't start it" };
			try {
				if (tool.name === "session_ask") return { result: await ask($, e) };
				return { result: JSON.parse(await useTool($, tool.name, e)).text };
			} catch (error) {
				return { deny: error.message };
			}
		}
		const result = await next(e);
		// Messages that arrived mid-turn ride on the next main-loop tool result, which Claude reads before going on.
		if (!line.managed || e.agentId || next.origin.plugin !== "engine" || !("result" in result)) return result;
		const batch = take();
		if (batch.length === 0) return result;
		for (const m of batch) receipt($, m, "mid-turn");
		await ack(
			$,
			batch.map((m) => m.id),
		);
		return { ...result, context: [...(result.context ?? []), ...batch.map((m) => m.text)] };
	});

	// A typed edit raises prompt.edit; a submit, a clear, a recall, or a fill raises prompt.change.
	on("prompt.edit", trackDraft);
	on("prompt.change", trackDraft);

	on("session.end", async ($, e, next) => {
		if (line.managed && e.reason !== "clear" && e.reason !== "resume") {
			await saveDraft($);
			await record($, ["end"]);
		}
		return next(e);
	});
}
