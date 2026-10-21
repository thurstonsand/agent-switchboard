import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { operatorDir } from "@swb/shared";
import agents from "./operator.md" with { type: "text" };

// A project extension, which pi runs ahead of every user extension: an Operator coordinates every Project, so it reads
// only its own AGENTS.md, not the ones above it or the user's.
const EXTENSION = `// Written by swb on every Deck start.
import { realpathSync } from "node:fs";
import { dirname } from "node:path";

export default function operator(pi) {
	pi.on("before_agent_start", (event, ctx) => {
		const here = realpathSync(ctx.cwd);
		const options = event.systemPromptOptions;
		// pi keeps the unfiltered list if this throws, so a vanished file is dropped rather than failing open.
		options.contextFiles = (options.contextFiles ?? []).filter((file) => {
			try {
				return realpathSync(dirname(file.path)) === here;
			} catch {
				return false;
			}
		});
	});
}
`;

// An Operator's new work goes to swb-managed sessions: a subagent is work the Deck can't see.
const SETTINGS = `${JSON.stringify({ sessions: { subagents: { enable: false } } }, null, "\t")}\n`;

/**
 * What keeps a Claude Code Operator to its folder, as `claude --settings`: every instruction file but the folder's
 * AGENTS.md excluded, the user's and any above it, and no subagents, which the Deck can't see.
 */
export function claudeOperatorSettings(): string {
	const ancestors: string[] = [];
	for (let dir = dirname(operatorDir()); ; dir = dirname(dir)) {
		ancestors.push(dir);
		if (dir === dirname(dir)) break;
	}
	const home = join(homedir(), ".claude");
	return JSON.stringify({
		claudeMdExcludes: [
			join(home, "CLAUDE.md"),
			join(home, "rules", "**"),
			...ancestors.flatMap((dir) =>
				["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude/CLAUDE.md", ".claude/rules/**"].map((f) => join(dir, f)),
			),
		],
		permissions: { deny: ["Agent"] },
	});
}

/**
 * A Codex Operator's `-c` overrides: the folder trusted, which Codex requires before it reads a folder's AGENTS.md,
 * and no subagents. Codex has no way to skip the user's ~/.codex/AGENTS.md, so that one still loads.
 */
export function codexOperatorConfig(): string[] {
	// agents.enabled is the switch a model's own multi-agent setting can't override; multi_agent_v2 overrides it.
	return [`projects={${JSON.stringify(operatorDir())}={trust_level="trusted"}}`, "agents.enabled=false", "features.multi_agent_v2=false"];
}

const CLAUDE = "@AGENTS.md\n";

/** The AGENTS.md swb ships, then mine, from Settings. */
function operatorAgents(instructions: string): string {
	return instructions === "" ? agents : `${agents}\n## My preferences\n\n${instructions}\n`;
}

/** The Operator folder: swb owns its AGENTS.md, CLAUDE.md, extension, and pi settings, and keeps them current. */
export function ensureOperatorDir(instructions: string): void {
	const dir = operatorDir();
	const extensions = join(dir, ".pi", "extensions");
	mkdirSync(extensions, { recursive: true });
	const extensionPath = join(extensions, "operator.js");
	if (!existsSync(extensionPath) || readFileSync(extensionPath, "utf8") !== EXTENSION) writeFileSync(extensionPath, EXTENSION);
	const settingsPath = join(dir, ".pi", "settings.json");
	if (!existsSync(settingsPath) || readFileSync(settingsPath, "utf8") !== SETTINGS) writeFileSync(settingsPath, SETTINGS);
	const agentsPath = join(dir, "AGENTS.md");
	const text = operatorAgents(instructions);
	if (!existsSync(agentsPath) || readFileSync(agentsPath, "utf8") !== text) writeFileSync(agentsPath, text);
	// Claude Code reads a CLAUDE.md here or above in place of AGENTS.md; this one makes sure it's the Operator's.
	const claudePath = join(dir, "CLAUDE.md");
	if (!existsSync(claudePath) || readFileSync(claudePath, "utf8") !== CLAUDE) writeFileSync(claudePath, CLAUDE);
}
