import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { HARNESSES } from "./index.ts";

// The coordination tools every line gives its agent, defined once. pi takes these schemas as they are; Claude Code
// and Codex take them as JSON Schema. Each tool runs an swb command and returns its text to the model unchanged.

export type ToolSpec = { description: string; guidelines: string[]; parameters: TSchema };

const session = Type.String({ description: "The target session's id, from session_reachable." });

export const TOOLS = {
	session_reachable: {
		description: "List every open session on the switchboard, in any harness (pi, Claude Code, Codex), except this one.",
		guidelines: [
			"Use session_reachable to find another session before messaging, cancelling, or archiving it.",
			"Sessions in other projects and other harnesses are all reachable; a dormant one wakes when messaged.",
		],
		parameters: Type.Object({}),
	},
	session_send_message: {
		description:
			"Send a message to another session on the switchboard. It arrives in that session's conversation, mid-turn when it is working; a dormant session is woken first.",
		guidelines: [
			"Messages are for coordinating with the session that owns the work; don't send what you can do yourself.",
			"Set requestResponse when you need an answer; the reply arrives later as a message to you, so end your turn instead of polling.",
		],
		parameters: Type.Object({
			session,
			message: Type.String({ description: "The message, self-contained: the recipient doesn't see this conversation." }),
			requestResponse: Type.Boolean({ description: "Whether the recipient should reply to this session." }),
		}),
	},
	session_cancel: {
		description: "Interrupt another session's running turn. The session stays open.",
		guidelines: ["Only cancel another session's turn when the user asks for it."],
		parameters: Type.Object({ session }),
	},
	session_launch: {
		description:
			"Start a new session on the switchboard, in pi, Claude Code, or Codex, whose first turn is the goal you give it. It shows up on the user's roster.",
		guidelines: [
			"Write the goal as a complete briefing: objective, relevant context, constraints, and what done means. The new session sees nothing else.",
			"Launch a new session when the work is independent of this one, belongs to another directory, or the user asks for one.",
		],
		parameters: Type.Object({
			harness: Type.Union(
				HARNESSES.map((name) => Type.Literal(name)),
				{ description: "Which harness runs it: pi, claude (Claude Code), or codex." },
			),
			goal: Type.String({ description: "The self-contained briefing, delivered as its first message." }),
			cwd: Type.Optional(Type.String({ description: "Its working directory; defaults to this session's." })),
			title: Type.String({ description: "A short title for the roster." }),
			requestResponse: Type.Boolean({ description: "Whether it should report back to this session when done." }),
		}),
	},
	swb_update_session: {
		description: "Archive or unarchive a session. Omit session to update the current session.",
		guidelines: [
			"Archive only when the user asks, or when you started that session and have driven it to completion.",
			"Archiving the current session quits it when the turn ends: call it last, then end with a brief final message.",
			"Archiving another session fails while it is mid-turn. Unarchiving doesn't restart it; session_send_message wakes it.",
		],
		parameters: Type.Object({
			session: Type.Optional(Type.String({ description: "Session id; omit for the current session." })),
			archived: Type.Boolean(),
		}),
	},
} satisfies Record<string, ToolSpec>;

export type ToolName = keyof typeof TOOLS;
export type ToolArgs<N extends ToolName> = Static<(typeof TOOLS)[N]["parameters"]>;

/** A tool's arguments from a model, checked against its schema before anything runs. */
export function parsed<N extends ToolName>(name: N, args: unknown): ToolArgs<N> {
	const schema = TOOLS[name].parameters;
	if (Value.Check(schema, args)) return args as ToolArgs<N>;
	const problems = [...Value.Errors(schema, args)].map((e) => `${e.instancePath || "arguments"} ${e.message}`);
	throw new Error(`${name}: ${problems.join("; ")}`);
}

/** What every coordination command prints: the text the model reads, and facts for the line to render. */
export type ToolResult = { text: string; details: Record<string, unknown> };

/** The contract as plain JSON Schema, for the harnesses that don't take TypeBox. */
export function toolsAsJson(): { name: ToolName; description: string; inputSchema: unknown }[] {
	return (Object.keys(TOOLS) as ToolName[]).map((name) => ({
		name,
		description: [TOOLS[name].description, ...TOOLS[name].guidelines].join("\n"),
		inputSchema: JSON.parse(JSON.stringify(TOOLS[name].parameters)),
	}));
}
