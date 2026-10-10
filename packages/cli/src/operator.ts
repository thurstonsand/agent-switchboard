import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { operatorDir } from "@swb/shared";
import agents from "./operator.md" with { type: "text" };

// A project extension, which pi runs ahead of every user extension: an Operator coordinates every Project, so it reads
// only its own AGENTS.md, not the ones above it or the user's. Its new work goes to swb-managed sessions: a subagent or
// a deferred handoff is work the Deck can't see.
const EXTENSION = `// Written by swb on every Deck start.
import { realpathSync } from "node:fs";
import { dirname } from "node:path";

export default function operator(pi) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "session_handoff" || event.input.launch === "swb") return;
		return {
			block: true,
			reason: \`An Operator can't launch "\${event.input.launch}" sessions: swb can't see them. Use launch "swb", or session_send_message to a session that already owns the work.\`,
		};
	});

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
		const handoff = options.toolGuidelines?.session_handoff;
		if (handoff) options.toolGuidelines.session_handoff = handoff.filter((line) => !/subagent/i.test(line));
	});
}
`;

/** The Operator folder: swb owns its AGENTS.md and extension, and keeps both current. */
export function ensureOperatorDir(): void {
	const dir = operatorDir();
	const extensions = join(dir, ".pi", "extensions");
	mkdirSync(extensions, { recursive: true });
	const extensionPath = join(extensions, "operator.js");
	if (!existsSync(extensionPath) || readFileSync(extensionPath, "utf8") !== EXTENSION) writeFileSync(extensionPath, EXTENSION);
	const agentsPath = join(dir, "AGENTS.md");
	if (!existsSync(agentsPath) || readFileSync(agentsPath, "utf8") !== agents) writeFileSync(agentsPath, agents);
}
