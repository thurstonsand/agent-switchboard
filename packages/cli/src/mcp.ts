import { parseArgs } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describeTool, inGitRepo, launchGuide, linkedWorktree, operatorDir } from "@swb/shared";
import {
	isDeferredTool,
	isWorktreeTool,
	offered,
	readerToolsAsJson,
	TOOLS,
	type ToolName,
	toolAnnotations,
	toolParameters,
	toolsAsJson,
	WORKTREE_NAMESPACE_DESCRIPTION,
} from "@swb/shared/tools";
import { callTool } from "./codex/tools.ts";
import { UsageError } from "./errors.ts";
import { VERSION } from "./version.ts";

// `swb mcp --harness claude|codex [--tools all|core|deferred]`: swb's tools as an MCP server, which Claude Code's and
// Codex's lines list them through. Codex calls them here (core upfront on `swb`, deferred move/worktree on `swb_workspace`).
// Claude Code's line answers every call in its mod, since session_recall's reader is a Claude subagent only the mod can
// start, so a Claude call that reaches this server is one the mod missed.

type McpHarness = "claude" | "codex";
type ToolGroup = "all" | "core" | "deferred";

function listing(harness: McpHarness, group: ToolGroup) {
	const cwd = process.cwd();
	const worktree = linkedWorktree(cwd) !== null;
	const inGit = inGitRepo(cwd);
	const operator = process.env.SWB_OPERATOR === "1" || cwd === operatorDir();
	const tools = toolsAsJson()
		.filter((tool) => {
			if (!offered(tool.name, process.env, { operator, inGit })) return false;
			if (group === "core") return !isDeferredTool(tool.name);
			if (group === "deferred") return isDeferredTool(tool.name);
			return true;
		})
		.map((tool) => ({
			...tool,
			inputSchema: JSON.parse(JSON.stringify(toolParameters(tool.name, worktree))),
			description: describeTool(tool.name, tool.description, launchGuide()),
			annotations: toolAnnotations(tool.name, worktree),
			// Core tools load upfront; session-move and worktree tools defer behind Claude Code's ToolSearch with a searchHint.
			...(harness === "claude"
				? {
						_meta: isWorktreeTool(tool.name)
							? { "anthropic/alwaysLoad": false, "anthropic/searchHint": "git worktree list fork checkout merge remove rebranch" }
							: isDeferredTool(tool.name)
								? { "anthropic/alwaysLoad": false, "anthropic/searchHint": "move session change working directory cwd" }
								: { "anthropic/alwaysLoad": true },
					}
				: {}),
		}));
	if (harness === "codex" || group === "deferred") return tools;
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
	const { values } = parseArgs({ args, options: { harness: { type: "string" }, tools: { type: "string" } } });
	if (values.harness !== "claude" && values.harness !== "codex") throw new UsageError("mcp: --harness claude|codex is required");
	const group = (values.tools ?? "all") as ToolGroup;
	if (group !== "all" && group !== "core" && group !== "deferred") throw new UsageError("mcp: --tools must be all, core, or deferred");
	const harness: McpHarness = values.harness;
	const cwd = process.cwd();
	const hasWorktreeTools =
		group !== "core" && process.env.SWB_OPERATOR !== "1" && cwd !== operatorDir() && process.env.SWB_WT === "1" && inGitRepo(cwd);
	const instructions =
		group === "deferred"
			? ["Move this session to another directory.", ...(hasWorktreeTools ? [WORKTREE_NAMESPACE_DESCRIPTION] : [])].join(" ")
			: [
					"Agent Switchboard: the other sessions the user runs, in pi, Claude Code, and Codex. Use these tools to reach them; messages from them arrive as user messages that start 'Message from session'.",
					...(hasWorktreeTools ? [WORKTREE_NAMESPACE_DESCRIPTION] : []),
				].join("\n\n");
	const server = new Server(
		{ name: group === "deferred" ? "swb_workspace" : "swb", version: VERSION },
		{ capabilities: { tools: {} }, instructions },
	);
	server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listing(harness, group) }));
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
