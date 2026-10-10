import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

// An Operator's new work goes to swb-managed sessions: a subagent or a deferred handoff is work the Deck can't see.
const SETTINGS = `${JSON.stringify({ sessions: { subagents: { enable: false }, handoff: { deferred: { enable: false } } } }, null, "\t")}\n`;

/** The Operator folder: swb owns its AGENTS.md, extension, and pi settings, and keeps them current. */
export function ensureOperatorDir(): void {
	const dir = operatorDir();
	const extensions = join(dir, ".pi", "extensions");
	mkdirSync(extensions, { recursive: true });
	const extensionPath = join(extensions, "operator.js");
	if (!existsSync(extensionPath) || readFileSync(extensionPath, "utf8") !== EXTENSION) writeFileSync(extensionPath, EXTENSION);
	const settingsPath = join(dir, ".pi", "settings.json");
	if (!existsSync(settingsPath) || readFileSync(settingsPath, "utf8") !== SETTINGS) writeFileSync(settingsPath, SETTINGS);
	const agentsPath = join(dir, "AGENTS.md");
	if (!existsSync(agentsPath) || readFileSync(agentsPath, "utf8") !== agents) writeFileSync(agentsPath, agents);
}
