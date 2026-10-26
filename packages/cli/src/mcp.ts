import { parseArgs } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describeTool, launchGuide } from "@swb/shared";
import { readerToolsAsJson, TOOLS, type ToolName, toolsAsJson } from "@swb/shared/tools";
import { callTool } from "./codex/tools.ts";
import { UsageError } from "./errors.ts";
import { VERSION } from "./version.ts";

// `swb mcp --harness claude|codex`: swb's tools as an MCP server, which Claude Code's and Codex's lines list them
// through. Codex calls them here. Claude Code's line answers every call in its mod, since session_ask's reader is a
// Claude subagent only the mod can start, so a Claude call that reaches this server is one the mod missed.

type McpHarness = "claude" | "codex";

/**
 * Read-only tools say so: Codex asks before a tool unless it's read-only, or neither destructive nor open-world, and
 * Claude Code runs a tool beside others only when it's read-only. The rest change only the user's own sessions.
 */
function annotations(name: ToolName) {
	return TOOLS[name].readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
}

function listing(harness: McpHarness) {
	const tools = toolsAsJson().map((tool) => ({
		...tool,
		description: describeTool(tool.name, tool.description, launchGuide()),
		annotations: annotations(tool.name),
		// Upfront rather than behind Claude Code's tool search; Codex's line asks the same through omit_tools_from.
		...(harness === "claude" ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
	}));
	if (harness === "codex") return tools;
	// Claude's reader takes its tools from here too, deferred, since only it needs their schemas. Codex's reader gets
	// them as dynamic tools on its own thread.
	const reader = readerToolsAsJson().map((tool) => ({
		...tool,
		annotations: { readOnlyHint: true },
		_meta: { "anthropic/alwaysLoad": false },
	}));
	return [...tools, ...reader];
}

export async function mcp(args: string[]): Promise<void> {
	const { values } = parseArgs({ args, options: { harness: { type: "string" } } });
	if (values.harness !== "claude" && values.harness !== "codex") throw new UsageError("mcp: --harness claude|codex is required");
	const harness: McpHarness = values.harness;
	const server = new Server(
		{ name: "swb", version: VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				"Agent Switchboard: the other sessions the user runs, in pi, Claude Code, and Codex. Use these tools to reach them; messages from them arrive as user messages that start 'Message from session'.",
		},
	);
	server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listing(harness) }));
	server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
		const fail = (text: string) => ({ content: [{ type: "text", text }], isError: true });
		if (harness === "claude") return fail(`swb: ${params.name} reached swb mcp, but swb's Claude Code line answers its tools`);
		const meta = params._meta as { threadId?: unknown; callId?: unknown } | undefined;
		if (typeof meta?.threadId !== "string") return fail("swb: the caller's thread is unknown");
		if (!Object.hasOwn(TOOLS, params.name)) return fail(`swb: no tool ${params.name}`);
		try {
			const callId = typeof meta.callId === "string" ? meta.callId : null;
			const result = await callTool(params.name as ToolName, params.arguments ?? {}, meta.threadId, callId, signal);
			return { content: [{ type: "text", text: result.text }], structuredContent: result.details };
		} catch (error) {
			return fail((error as Error).message);
		}
	});
	await server.connect(new StdioServerTransport());
}
