// Agent Switchboard's Claude Code line, written by swb into its state directory and loaded with --plugin-dir.
// It records this session's lifecycle, gives Claude the switchboard's coordination tools, and delivers messages from
// other sessions: mid-turn as context on the next tool result, or as a new turn when idle.
//
// claude plugin validate only accepts `$` passed to top-level functions, so every call goes through one.
import { TOOLS } from "./tools.js";

const line = {
	managed: false,
	started: false,
	bin: "",
	host: "",
	parent: "",
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
};

async function env($, name) {
	if (name === "SWB_BIN") return (await $.env.get("SWB_BIN")) ?? "";
	if (name === "SWB_TMUX_SESSION") return (await $.env.get("SWB_TMUX_SESSION")) ?? "";
	if (name === "SWB_PARENT") return (await $.env.get("SWB_PARENT")) ?? "";
	return (await $.env.get("SWB_DB")) ?? "";
}

/** Runs swb; a failure carries its stderr, which is what the model or the person should read. */
async function swb($, args, stdin) {
	const result = await $.process.run([line.bin, ...args], { ...(stdin === undefined ? {} : { stdin }), timeoutMs: 90000 });
	if (result.exitCode !== 0) throw new Error(result.stderr.trim().replace(/^swb: /, "") || `swb ${args[0]} exited ${result.exitCode}`);
	return result.stdout;
}

/** Recording never fails a hook: it says so where the person looks, and Claude carries on. */
async function record($, args) {
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
	$.ui.log(`↘ ${m.title} (${how}): ${m.body.length > 200 ? `${m.body.slice(0, 200)}…` : m.body}`);
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
			if (m.kind === "cancel") {
				if (line.busy && line.turnId) await $.turn.abort({ turnId: line.turnId });
				await ack($, [m.id]);
			} else {
				line.pending.push(m);
				void submitPending($);
			}
		}
	}
}

async function useTool($, name, e) {
	// The caller is whoever Claude Code says this session is now, never a value cached from an event that can be missed.
	const self = await $.session.id();
	const from = ["--from", self];
	switch (name) {
		case "session_reachable":
			return swb($, ["reachable", ...from]);
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
					"--harness",
					e.harness,
					"--cwd",
					e.cwd ?? line.cwd,
					"--title",
					e.title,
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
						? ["--launch-harness", e.launch.harness, "--launch-title", e.launch.title, "--launch-cwd", e.launch.cwd ?? line.cwd]
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
		case "swb_update_session":
			if ((e.archived === undefined) === (e.snooze === undefined)) throw new Error("give archived or snooze: one of them");
			if (e.snooze !== undefined)
				return swb($, ["snooze", e.session ?? self, typeof e.snooze === "string" ? e.snooze : e.snooze.until, ...from]);
			return swb($, [e.archived ? "archive" : "unarchive", e.session ?? self, ...from]);
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
		line.parent = await env($, "SWB_PARENT");
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
 * swb is the only thing that loads this plugin, so its tools are always offered; a call outside swb says so. All at
 * once: each registration reconnects the plugin's tool server and waits until its tool lists, which the first turn
 * waits for, and five in a row took 750 ms.
 */
async function registerTools($) {
	await Promise.all(TOOLS.map((tool) => registerTool($, tool)));
}

async function registerTool($, tool) {
	try {
		await $.tool.register(tool);
	} catch (error) {
		$.ui.log(`swb: tool ${tool.name} not registered: ${error.message}`);
	}
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
		await registerTools($);
		await init($);
		return result;
	});

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
			// The launcher is recorded with the first turn, which makes the session's row.
			const parent = line.parent ? ["--parent", line.parent] : [];
			line.parent = "";
			await record($, ["turn", "--session", line.session, "--cwd", line.cwd, "--transcript", line.transcript, ...parent]);
		}
		return next(e);
	});

	on("classic.PermissionRequest", async ($, e, next) => {
		if (line.managed && line.busy && !line.blocked) {
			line.blocked = true;
			await record($, ["phase", "blocked", "--session", line.session]);
		}
		return next(e);
	});

	// A model request means the permission prompt was answered.
	on("turn.step", async function* ($, e, next) {
		if (line.managed && !e.agentId && line.blocked) {
			line.blocked = false;
			await record($, ["phase", "working", "--session", line.session]);
		}
		return yield* next(e);
	});

	on("turn.complete", async ($, e, next) => {
		const result = await next(e);
		if (line.managed && !e.agentId) {
			line.busy = false;
			line.blocked = false;
			// swb stops this session after recording, when it was archived during the turn.
			await record($, ["settled", "--session", line.session, "--cwd", line.cwd, "--transcript", line.transcript]);
			void submitPending($);
		}
		return result;
	});

	on("tool.call", async ($, e, next) => {
		const tool = TOOLS.find((t) => e.tool === `mcp__swb__${t.name}`);
		if (tool) {
			await init($);
			if (!line.managed) return { deny: "this Claude Code session isn't on the switchboard: swb didn't start it" };
			try {
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
