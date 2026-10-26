import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type Db, describeTool, launchGuide } from "@swb/shared";
import {
	parsed,
	READER_PROMPT,
	readerPrompt,
	readerToolsAsJson,
	TOOLS,
	type ToolName,
	type ToolResult,
	toolsAsJson,
} from "@swb/shared/tools";
import { launchSession, reachable, send, show, update } from "../coordinate.ts";
import { SwbError } from "../errors.ts";
import { recallRead } from "../recall/read.ts";
import { search } from "../recall/search.ts";
import { listSchedules, schedule, unschedule } from "../schedules.ts";
import { openStore } from "../store.ts";
import { VERSION } from "../version.ts";
import { CodexClient } from "./client.ts";
import { codexSocket, READER_SOURCE } from "./host.ts";

// `swb mcp`: the Codex line's tools, served over stdio to the app-server that swb's Codex host runs. Codex puts the
// calling thread in every tools/call's _meta, so the sender is the caller's own session, never a tool argument.

async function call(name: ToolName, args: unknown, from: string, callId: string | null, signal: AbortSignal): Promise<ToolResult> {
	const db = openStore();
	switch (name) {
		case "session_reachable":
			parsed(name, args);
			return reachable(db, from);
		case "session_send_message": {
			const a = parsed(name, args);
			return send(db, {
				from,
				to: a.session,
				body: a.message,
				requestResponse: a.requestResponse,
				requestId: callId,
				kind: "message",
			});
		}
		case "session_cancel": {
			const a = parsed(name, args);
			return send(db, { from, to: a.session, body: "", requestResponse: false, requestId: null, kind: "cancel" });
		}
		case "session_launch": {
			const a = parsed(name, args);
			return launchSession(db, {
				from,
				harness: a.harness ?? null,
				model: a.model ?? null,
				effort: a.effort ?? null,
				agent: a.agent ?? null,
				goal: a.goal,
				cwd: a.cwd ?? null,
				title: a.title,
				group: a.group,
				requestResponse: a.requestResponse,
				scheduled: null,
			});
		}
		case "session_schedule": {
			const a = parsed(name, args);
			// A retried call must not schedule twice, which only the call's id can tell.
			if (!callId) throw new SwbError("swb: Codex gave this call no id");
			return schedule(db, {
				from,
				to: a.session ?? null,
				launch: a.launch
					? {
							harness: a.launch.harness ?? null,
							model: a.launch.model ?? null,
							effort: a.launch.effort ?? null,
							agent: a.launch.agent ?? null,
							cwd: a.launch.cwd ?? null,
							title: a.launch.title,
							group: a.launch.group,
						}
					: null,
				body: a.message,
				at: a.at ?? null,
				cron: a.cron ?? null,
				label: a.label,
				requestResponse: a.requestResponse ?? false,
				snooze: a.snooze ?? false,
				requestId: callId,
			});
		}
		case "session_schedules":
			parsed(name, args);
			return listSchedules(db, from);
		case "session_unschedule":
			return unschedule(db, from, parsed(name, args).id);
		case "swb_show_session": {
			const a = parsed(name, args);
			return show(db, from, a.session, a.view ?? null);
		}
		case "session_search": {
			const a = parsed(name, args);
			return search(db, from, a.query, a.limit);
		}
		case "session_ask": {
			const a = parsed(name, args);
			return ask(db, from, a.session, a.question, signal);
		}
		case "swb_update_session": {
			const a = parsed(name, args);
			return update(db, from, a.session ?? from, a);
		}
	}
}

/**
 * A reader runs as Codex runs its own read-only agents, like its guardian reviewer: its usual base prompt and shell,
 * under a read-only sandbox that never asks for approval, without what reaches past this machine, asks the person,
 * or starts other agents.
 */
const READER_CONFIG = {
	"features.goals": false,
	"tools.experimental_request_user_input.enabled": false,
	"features.request_permissions_tool": false,
	"features.plugins": false,
	"features.apps": false,
	"features.tool_suggest": false,
	"features.image_generation": false,
	web_search: "disabled",
	"agents.enabled": false,
	"features.multi_agent": false,
	"features.multi_agent_v2": false,
};

/**
 * A private, non-persistent turn on the caller's own authenticated app-server. It runs until it answers, or until
 * the caller stops waiting: Codex cancels the call, the caller's turn ends, or either connection closes.
 */
async function ask(db: Db, from: string, session: string, question: string, cancelled: AbortSignal): Promise<ToolResult> {
	const row = db.get("SELECT tmux_session FROM runtimes WHERE session_id = ?", from);
	if (!row) throw new SwbError("session_ask: the caller has no running Codex host");
	const client = await CodexClient.connect(codexSocket(row.tmux_session as string), "swb-reader");
	let threadId: string | null = null;
	let turnId: string | null = null;
	let final = "";
	const completed = Promise.withResolvers<string>();
	// A startup failure or closed socket must not leave the eventual completion unhandled.
	void completed.promise.catch(() => {});
	const stop = (why: string) => completed.reject(new SwbError(`session_ask: ${why}`));
	client.onClose(() => stop("the caller's app-server closed"));
	cancelled.addEventListener("abort", () => stop("cancelled"), { once: true });
	client.onRequest(({ method, params }) => {
		if (method !== "item/tool/call" || params.threadId !== threadId) return undefined;
		try {
			if (params.tool !== "recall_read") throw new SwbError(`reader: unknown tool ${params.tool}`);
			const args = parsed("recall_read", params.arguments);
			if (args.session !== session) throw new SwbError("reader: only the question's target may be read");
			return { contentItems: [{ type: "inputText", text: recallRead(db, args.session).text }], success: true };
		} catch (error) {
			return { contentItems: [{ type: "inputText", text: (error as Error).message }], success: false };
		}
	});
	client.onNotification(({ method, params }) => {
		// Every connection hears each thread's status. The call is part of the caller's turn, so an idle caller isn't waiting.
		if (method === "thread/status/changed" && params.threadId === from && (params.status as { type: string }).type !== "active")
			stop("the caller's turn ended");
		if (params.threadId !== threadId) return;
		if (method === "turn/started") turnId = (params.turn as { id: string }).id;
		if (method === "item/completed") {
			const item = params.item as { type: string; text?: string };
			if (item.type === "agentMessage") final = item.text ?? "";
		}
		if (method === "turn/completed") {
			const turn = params.turn as { status: string; error?: { message: string } };
			if (turn.status === "completed") completed.resolve(final);
			else stop(`reader ${turn.status}: ${turn.error?.message ?? "no answer"}`);
		}
	});
	const request = <T>(method: string, params: unknown) =>
		Promise.race([client.request<T>(method, params), completed.promise as Promise<never>]);
	try {
		if (cancelled.aborted) stop("cancelled");
		const { thread: caller } = await request<{
			thread: { cwd: string; model: string | null; modelProvider: string; status: { type: string } };
		}>("thread/read", { threadId: from });
		if (!caller.model) throw new SwbError("session_ask: the caller's model is unknown");
		if (caller.status.type !== "active") stop("the caller's turn ended");
		const cwd = caller.cwd;
		// Tables merge across config layers, so each of the person's MCP servers is switched off by name.
		const { config } = await request<{ config: { mcp_servers?: Record<string, unknown> } }>("config/read", { cwd });
		const servers = Object.keys(config.mcp_servers ?? {}).map((name) => [`mcp_servers.${name}.enabled`, false]);
		const started = await request<{ thread: { id: string } }>("thread/start", {
			ephemeral: true,
			threadSource: READER_SOURCE,
			model: caller.model,
			modelProvider: caller.modelProvider,
			cwd,
			sandbox: "read-only",
			approvalPolicy: "never",
			developerInstructions: READER_PROMPT,
			config: { ...READER_CONFIG, ...Object.fromEntries(servers) },
			dynamicTools: readerToolsAsJson(),
		});
		threadId = started.thread.id;
		const { turn } = await request<{ turn: { id: string } }>("turn/start", {
			threadId,
			input: [{ type: "text", text: readerPrompt(session, question) }],
		});
		turnId = turn.id;
		const text = await completed.promise;
		if (!text) throw new SwbError("session_ask: reader returned no final message");
		return { text, details: { answer: text } };
	} finally {
		try {
			await Promise.race([
				(async () => {
					// An empty turn id interrupts whatever the reader is running, even a turn not yet reported.
					if (threadId) await client.request("turn/interrupt", { threadId, turnId: turnId ?? "" }).catch(() => {});
					if (threadId) await client.request("thread/backgroundTerminals/clean", { threadId }).catch(() => {});
					if (threadId) await client.request("thread/unsubscribe", { threadId }).catch(() => {});
				})(),
				Bun.sleep(1000),
			]);
		} finally {
			client.close();
		}
	}
}

export async function mcp(): Promise<void> {
	const server = new Server(
		{ name: "swb", version: VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				"Agent Switchboard: the other sessions the user runs, in pi, Claude Code, and Codex. Use these tools to reach them; messages from them arrive as user messages that start 'Message from session'.",
		},
	);
	// Codex asks before every tool call unless the tool is read-only, or neither destructive nor open-world.
	const annotations = (name: ToolName) =>
		TOOLS[name].readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: toolsAsJson().map((tool) => ({
			...tool,
			description: describeTool(tool.name, tool.description, launchGuide()),
			annotations: annotations(tool.name),
		})),
	}));
	server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
		const meta = params._meta as { threadId?: unknown; callId?: unknown } | undefined;
		if (typeof meta?.threadId !== "string")
			return { content: [{ type: "text", text: "swb: the caller's thread is unknown" }], isError: true };
		if (!Object.hasOwn(TOOLS, params.name)) return { content: [{ type: "text", text: `swb: no tool ${params.name}` }], isError: true };
		try {
			const callId = typeof meta.callId === "string" ? meta.callId : null;
			const result = await call(params.name as ToolName, params.arguments ?? {}, meta.threadId, callId, signal);
			return { content: [{ type: "text", text: result.text }], structuredContent: result.details };
		} catch (error) {
			return { content: [{ type: "text", text: (error as Error).message }], isError: true };
		}
	});
	await server.connect(new StdioServerTransport());
}
