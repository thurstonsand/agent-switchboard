import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeTool, launchGuide, stateDir } from "@swb/shared";
// Macros inline the tool schemas as JSON at build time, rather than bundling their TypeBox objects here.
import { readerToolsAsJson, toolsAsJson } from "@swb/shared/tools" with { type: "macro" };
import { READER_PROMPT } from "@swb/shared/tools";
import manifest from "../../lines/claude/plugin/.claude-plugin/plugin.json";
import hooks from "../../lines/claude/plugin/hooks/hooks.json";
// @ts-expect-error: the mod is embedded as text, never imported as a module.
import register from "../../lines/claude/plugin/hooks/register.js" with { type: "text" };

/** Replaced whole, so a harness reading it mid-write never sees half a file. */
function write(path: string, text: string): void {
	if (existsSync(path) && readFileSync(path, "utf8") === text) return;
	writeFileSync(`${path}.${process.pid}.tmp`, text);
	renameSync(`${path}.${process.pid}.tmp`, path);
}

/** The Claude line's plugin, written from the copy this swb carries, so a session always loads its own swb's line. */
export function writeClaudeLine(): string {
	const dir = join(stateDir(), "lines", "claude");
	mkdirSync(join(dir, ".claude-plugin"), { recursive: true, mode: 0o700 });
	mkdirSync(join(dir, "hooks"), { recursive: true });
	write(join(dir, ".claude-plugin", "plugin.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	write(join(dir, "hooks", "hooks.json"), `${JSON.stringify(hooks, null, "\t")}\n`);
	write(join(dir, "hooks", "register.js"), register as string);
	write(
		join(dir, "hooks", "tools.js"),
		`// Written by swb: the contracts and reader instructions every line shares.
export const TOOLS = ${JSON.stringify(tools(), null, "\t")};
export const READER_TOOLS = ${JSON.stringify(readerToolsAsJson(), null, "\t")};
export const READER_PROMPT = ${JSON.stringify(READER_PROMPT)};
`,
	);
	return dir;
}

/** The tool contracts, session_launch's carrying the shortlist as it stands at this launch. */
function tools(): { name: string; description: string; inputSchema: unknown }[] {
	const guide = launchGuide();
	return toolsAsJson().map((tool) => ({ ...tool, description: describeTool(tool.name, tool.description, guide) }));
}

/** The id the Codex line's plugin has: the private app-server enables it with -c, so nothing enables it elsewhere. */
export const CODEX_PLUGIN = "swb@swb";

/**
 * The Codex line's MCP server, as a plugin installed into Codex's plugin cache. A plugin rather than `-c
 * mcp_servers.swb`, because Codex's title generator replaces the whole mcp_servers table to switch servers off,
 * which leaves a `-c` server without its command; it switches plugins off instead.
 */
export function writeCodexLine(swb: string): void {
	const dir = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "plugins", "cache", "swb", "swb", "local", ".codex-plugin");
	mkdirSync(dir, { recursive: true });
	const plugin = {
		name: "swb",
		version: "1.0.0",
		description: "Agent Switchboard: reach the other sessions on the switchboard. Enabled only in sessions swb hosts.",
		mcpServers: {
			swb: {
				command: swb,
				args: ["mcp"],
				// Codex starts MCP servers with only a few of its variables; these say which db and tmux servers are swb's.
				env_vars: [
					"SWB_INSTANCE",
					"XDG_STATE_HOME",
					"XDG_CONFIG_HOME",
					"TMUX_TMPDIR",
					"PI_CODING_AGENT_DIR",
					"PI_CODING_AGENT_SESSION_DIR",
				],
				// Straight into the model's tool list, not behind tool search, so the agent sees them like its own.
				omit_tools_from: ["deferred"],
				// session_ask waits as long as its reader works, which Codex's 300 s default would cut short.
				tool_timeout_sec: 3600,
				// swb mcp answers each call independently, so several session_ask readers can work at once.
				supports_parallel_tool_calls: true,
			},
		},
	};
	write(join(dir, "plugin.json"), `${JSON.stringify(plugin, null, "\t")}\n`);
}
