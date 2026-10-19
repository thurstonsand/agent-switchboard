import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { HARNESSES } from "./index.ts";

// The coordination tools every line gives its agent, defined once. pi takes these schemas as they are; Claude Code
// and Codex take them as JSON Schema. Each tool runs an swb command and returns its text to the model unchanged.

/** `readOnly`: it only reads. The rest change only the user's own sessions, and never destroy one. */
export type ToolSpec = { description: string; guidelines: string[]; parameters: TSchema; readOnly: boolean };

const session = Type.String({ description: "The target session's id, from session_reachable." });
const harnessName = Type.Union(
	HARNESSES.map((name) => Type.Literal(name)),
	{ description: "Which harness runs it: pi, claude (Claude Code), or codex." },
);

export const SNOOZE_PRESETS = ["one_hour", "one_day", "monday", "next_message"] as const;
export type SnoozePreset = (typeof SNOOZE_PRESETS)[number];
/** What swb_update_session's snooze takes, and `swb snooze` too: a preset, off, or a time. */
export type Snooze = SnoozePreset | "off" | { until: string };

export const TOOLS = {
	session_reachable: {
		description: "List every open session on the switchboard, in any harness (pi, Claude Code, Codex), except this one.",
		guidelines: [
			"Use session_reachable to find another session before messaging, cancelling, or archiving it.",
			"Sessions in other projects and other harnesses are all reachable; a dormant one wakes when messaged.",
		],
		parameters: Type.Object({}),
		readOnly: true,
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
		readOnly: false,
	},
	session_cancel: {
		description: "Interrupt another session's running turn. The session stays open.",
		guidelines: ["Only cancel another session's turn when the user asks for it."],
		parameters: Type.Object({ session }),
		readOnly: false,
	},
	session_launch: {
		description:
			"Start a new session on the switchboard, in pi, Claude Code, or Codex, whose first turn is the goal you give it. It shows up on the user's roster.",
		guidelines: [
			"Write the goal as a complete briefing: objective, relevant context, constraints, and what done means. The new session sees nothing else.",
			"Launch a new session when the work is independent of this one, belongs to another directory, or the user asks for one.",
		],
		parameters: Type.Object({
			harness: harnessName,
			goal: Type.String({ description: "The self-contained briefing, delivered as its first message." }),
			cwd: Type.Optional(Type.String({ description: "Its working directory; defaults to this session's." })),
			title: Type.String({ description: "A short title for the roster." }),
			requestResponse: Type.Boolean({ description: "Whether it should report back to this session when done." }),
		}),
		readOnly: false,
	},
	session_schedule: {
		description:
			"Schedule a message for later, once or on a recurring cron schedule: to this session, another session, or a new session launched when it fires.",
		guidelines: [
			"Schedule only when the user asks to remind, follow up, check back, or repeat something. To wait on another session, set requestResponse on your message instead of scheduling checks.",
			"For something expected within a few minutes, keep working in this turn instead.",
			"Write the message as instructions for when it fires: what to check, and what to do with each outcome. A recurring message should say when to unschedule itself.",
			"To message this session, omit both session and launch.",
			"Set snooze only when the user asks for it.",
		],
		parameters: Type.Object({
			message: Type.String({ description: "What to deliver, self-contained when it goes to another session." }),
			at: Type.Optional(
				Type.String({
					description:
						'When, once: an ISO 8601 time, local unless it has an offset ("2026-10-23T15:00"), or a duration from now ("PT2H", "P1D").',
				}),
			),
			cron: Type.Optional(
				Type.String({
					description:
						'Recurring instead: standard 5-field cron in local time, "M H DoM Mon DoW" (e.g. "57 8 * * 1-5" = weekdays at 8:57am).',
				}),
			),
			label: Type.String({ description: 'When it runs, in plain words, such as "Weekdays, 8:57 AM".' }),
			session: Type.Optional(Type.String({ description: "The recipient's id, from session_reachable." })),
			launch: Type.Optional(
				Type.Object(
					{
						harness: harnessName,
						cwd: Type.Optional(Type.String({ description: "Its working directory; defaults to this session's." })),
						title: Type.String({ description: "A short title for the roster." }),
					},
					{ description: "Instead of an existing session, launch a new one each time it fires, with the message as its goal." },
				),
			),
			requestResponse: Type.Optional(Type.Boolean({ description: "Whether the recipient should reply to this session." })),
			snooze: Type.Optional(Type.Boolean({ description: "Snooze the recipient until this fires." })),
		}),
		readOnly: false,
	},
	session_schedules: {
		description:
			"List this session's schedules, the ones it set and the ones that deliver to it: pending ones with their next run, finished ones with their last.",
		guidelines: [],
		parameters: Type.Object({}),
		readOnly: true,
	},
	session_unschedule: {
		description: "Cancel a pending schedule.",
		guidelines: ["Unschedule only when the user asks, or when the schedule's stated completion condition is met."],
		parameters: Type.Object({ id: Type.String({ description: "The schedule's id, from session_schedules." }) }),
		readOnly: false,
	},
	swb_update_session: {
		description: "Archive, unarchive, snooze, or unsnooze a session. Omit session to update the current session.",
		guidelines: [
			"Archive only when the user asks, or when you started that session and have driven it to completion.",
			"Archiving the current session quits it when the turn ends: call it last, then end with a brief final message.",
			"Archiving another session fails while it is mid-turn. Unarchiving doesn't restart it; session_send_message wakes it.",
			"Snooze or unsnooze only when the user asks. A message ends a next_message snooze; a timed snooze lasts until its time.",
		],
		parameters: Type.Object({
			session: Type.Optional(Type.String({ description: "Session id; omit for the current session." })),
			archived: Type.Optional(Type.Boolean()),
			snooze: Type.Optional(
				Type.Union([...[...SNOOZE_PRESETS, "off"].map((preset) => Type.Literal(preset)), Type.Object({ until: Type.String() })], {
					description: 'Snooze preset, off to unsnooze, or {"until": "2026-11-05T09:00"} for a custom local time.',
				}),
			),
		}),
		readOnly: false,
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
