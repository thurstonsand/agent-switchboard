import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describeTool, launchGuide } from "@swb/shared";
import { parsed, TOOLS, type ToolName, type ToolResult, toolsAsJson } from "@swb/shared/tools";
import { launchSession, reachable, send, update, updateOf } from "../coordinate.ts";
import { SwbError } from "../errors.ts";
import { listSchedules, schedule, unschedule } from "../schedules.ts";
import { openStore } from "../store.ts";
import { VERSION } from "../version.ts";

// `swb mcp`: the Codex line's tools, served over stdio to the app-server that swb's Codex host runs. Codex puts the
// calling thread in every tools/call's _meta, so the sender is the caller's own session, never a tool argument.

async function call(name: ToolName, args: unknown, from: string, callId: string | null): Promise<ToolResult> {
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
		case "swb_update_session": {
			const a = parsed(name, args);
			return update(db, from, a.session ?? from, updateOf(a));
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
	server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
		const meta = params._meta as { threadId?: unknown; callId?: unknown } | undefined;
		if (typeof meta?.threadId !== "string")
			return { content: [{ type: "text", text: "swb: the caller's thread is unknown" }], isError: true };
		if (!Object.hasOwn(TOOLS, params.name)) return { content: [{ type: "text", text: `swb: no tool ${params.name}` }], isError: true };
		try {
			const callId = typeof meta.callId === "string" ? meta.callId : null;
			const result = await call(params.name as ToolName, params.arguments ?? {}, meta.threadId, callId);
			return { content: [{ type: "text", text: result.text }], structuredContent: result.details };
		} catch (error) {
			return { content: [{ type: "text", text: (error as Error).message }], isError: true };
		}
	});
	await server.connect(new StdioServerTransport());
}
