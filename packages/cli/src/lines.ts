import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stateDir } from "@swb/shared";
// Macros inline the tool schemas as JSON at build time, rather than bundling their TypeBox objects here.
import { readerToolsAsJson, toolLabels, toolsAsJson } from "@swb/shared/tools" with { type: "macro" };
import { READER_PROMPT } from "@swb/shared/tools";
import manifest from "../../lines/claude/plugin/.claude-plugin/plugin.json";
import hooks from "../../lines/claude/plugin/hooks/hooks.json";
// @ts-expect-error: the mod is embedded as text, never imported as a module.
import register from "../../lines/claude/plugin/hooks/register.js" with { type: "text" };
import { SwbError } from "./errors.ts";

/** Replaced whole, so a harness reading it mid-write never sees half a file. */
function write(path: string, text: string): void {
	if (existsSync(path) && readFileSync(path, "utf8") === text) return;
	writeFileSync(`${path}.${process.pid}.tmp`, text);
	renameSync(`${path}.${process.pid}.tmp`, path);
}

/**
 * The Claude line's plugin, written from the copy this swb carries, so a session always loads its own swb's line. Its
 * coordination tools come from the plugin's swb mcp server, which marks the read-only ones so Claude runs them in
 * parallel; the mod still answers every call, since session_ask's reader is a Claude subagent only the mod can start.
 */
export function writeClaudeLine(swb: string): string {
	const dir = join(stateDir(), "lines", "claude");
	mkdirSync(join(dir, ".claude-plugin"), { recursive: true, mode: 0o700 });
	mkdirSync(join(dir, "hooks"), { recursive: true });
	const mcpServers = { swb: { command: swb, args: ["mcp", "--harness", "claude"] } };
	write(join(dir, ".claude-plugin", "plugin.json"), `${JSON.stringify({ ...manifest, mcpServers }, null, "\t")}\n`);
	write(join(dir, "hooks", "hooks.json"), `${JSON.stringify(hooks, null, "\t")}\n`);
	write(join(dir, "hooks", "register.js"), register as string);
	write(
		join(dir, "hooks", "tools.js"),
		`// Written by swb: the contracts, labels, and reader instructions every line shares.
export const TOOLS = ${JSON.stringify(toolsAsJson(), null, "\t")};
export const LABELS = ${JSON.stringify(toolLabels(), null, "\t")};
export const READER_TOOLS = ${JSON.stringify(readerToolsAsJson(), null, "\t")};
export const READER_PROMPT = ${JSON.stringify(READER_PROMPT)};
`,
	);
	return dir;
}

const codexConfig = (): string => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");

/** What `declareCodexServer` adds: enough of swb's MCP server to keep it whole through Codex's title requests. */
const CODEX_STUB = `
# Agent Switchboard's tools, switched on only in the Codex sessions swb hosts, which pass the rest of it.
[mcp_servers.swb]
command = "swb"
args = ["mcp", "--harness", "codex"]
enabled = false
`;

/**
 * Declares swb's MCP server in Codex's config.toml, switched off, unless it's declared there already. swb's own
 * app-servers switch it on with -c, so only they offer its tools. The declaration has to be in a file: Codex's title
 * generator replaces the whole mcp_servers table from -c to switch servers off, which leaves a server declared only
 * with -c no command, and its title request fails unseen.
 */
export function declareCodexServer(): void {
	const path = codexConfig();
	const text = existsSync(path) ? readFileSync(path, "utf8") : "";
	let config: { mcp_servers?: Record<string, unknown> };
	try {
		config = Bun.TOML.parse(text) as typeof config;
	} catch (error) {
		throw new SwbError(`${path}: ${(error as Error).message}`);
	}
	if (config.mcp_servers?.swb) return;
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, text === "" || text.endsWith("\n") ? CODEX_STUB : `\n${CODEX_STUB}`);
}

/** The -c overrides that switch the declared server on, as swb runs it, for one of swb's own app-servers. */
export function codexServerOverrides(swb: string): string[] {
	const server = {
		enabled: true,
		command: swb,
		args: ["mcp", "--harness", "codex"],
		// Codex starts MCP servers with only a few of its variables; these say which db and tmux servers are swb's.
		env_vars: ["SWB_INSTANCE", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "TMUX_TMPDIR", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"],
		// Straight into the model's tool list, so the agent sees them like its own: not behind tool search, and not
		// only inside code mode's exec, where a code-mode-only model such as gpt-6-sol reaches for spawn_agent instead.
		omit_tools_from: ["deferred", "code_mode"],
		// session_ask waits as long as its reader works, which Codex's 300 s default would cut short.
		tool_timeout_sec: 3600,
		// swb mcp answers each call independently, so several session_ask readers can work at once.
		supports_parallel_tool_calls: true,
	};
	// Each value as JSON, which is TOML too.
	return Object.entries(server).flatMap(([key, value]) => ["-c", `mcp_servers.swb.${key}=${JSON.stringify(value)}`]);
}
