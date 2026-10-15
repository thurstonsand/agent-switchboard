import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parsed, TOOLS, type ToolName, type ToolResult, toolsAsJson } from "@swb/shared/tools";
import { launchSession, reachable, send, update } from "../coordinate.ts";
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
				harness: a.harness,
				goal: a.goal,
				cwd: a.cwd ?? null,
				title: a.title,
				requestResponse: a.requestResponse,
				model: null,
			});
		}
		case "swb_update_session": {
			const a = parsed(name, args);
			return update(db, from, a.session ?? from, a.archived);
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
	server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolsAsJson() }));
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
