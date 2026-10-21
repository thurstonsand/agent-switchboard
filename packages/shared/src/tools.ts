import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { HARNESSES, SNOOZE_PRESETS, VIEWS } from "./index.ts";

// The coordination tools every line gives its agent, defined once. pi takes these schemas as they are; Claude Code
// and Codex take them as JSON Schema. Each tool runs an swb command and returns its text to the model unchanged.

/** `readOnly`: it only reads. The rest change only the user's own sessions, and never destroy one. */
export type ToolSpec = { description: string; guidelines: string[]; parameters: TSchema; readOnly: boolean };

const session = Type.String({ description: "The target session's id, from session_reachable." });
const requestResponse = Type.Boolean({ description: "Whether the recipient should reply to this session." });
const cwd = Type.Optional(Type.String({ description: "Its working directory; defaults to this session's." }));
const title = Type.String({ description: "A short title for the roster." });
/** A preset by its fields, as session_launch's description lists them. */
const preset = {
	harness: Type.Optional(
		Type.Union(
			HARNESSES.map((name) => Type.Literal(name)),
			{ description: "pi, claude (Claude Code), or codex." },
		),
	),
	model: Type.Optional(Type.String({ description: "As listed." })),
	effort: Type.Optional(Type.String({ description: "As listed; needed only between presets of one model." })),
	agent: Type.Optional(Type.String({ description: "A Claude Code agent, as listed, in place of model and effort." })),
};

export const TOOLS = {
	session_reachable: {
		description: "List every open session on the switchboard except this one.",
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
			requestResponse,
		}),
		readOnly: false,
	},
	session_cancel: {
		description: "Stop another session's running turn. The session stays open.",
		guidelines: ["Only cancel another session's turn when the user asks for it."],
		parameters: Type.Object({ session }),
		readOnly: false,
	},
	session_launch: {
		description: "Start a new session on the switchboard, on one of the presets below.",
		guidelines: [
			"Write the goal as a complete briefing: objective, relevant context, constraints, and what done means.",
			"Launch a new session when the work is independent of this one, belongs to another directory, or the user asks for one.",
			"Omit the preset fields to carry forward what this session runs now. To switch, pass the fields of the preset whose note fits the work; anything not listed is refused.",
		],
		parameters: Type.Object({
			...preset,
			goal: Type.String({ description: "The self-contained briefing, delivered as its first message." }),
			cwd,
			title,
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
			session: Type.Optional(session),
			launch: Type.Optional(
				Type.Object(
					{
						...preset,
						cwd,
						title,
					},
					{
						description:
							"Instead of an existing session, launch a new one each time it fires, on a preset as session_launch takes it, with the message as its goal.",
					},
				),
			),
			requestResponse: Type.Optional(requestResponse),
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
		description: "Update one session on the switchboard: this one, unless you name another.",
		guidelines: [
			"Archive only when the user asks, or when you started that session and have driven it to completion.",
			"Archiving this session quits it when the turn ends: call it last, then end with a brief final message.",
			"Archiving refuses any session other than this one that is mid-turn, blocked, cut off, or errored, and names them. If they should go anyway, call again with force, which cancels their turns.",
			"Unarchiving doesn't restart a session; session_send_message wakes it.",
			"Snooze or unsnooze only when the user asks.",
			"Group sessions when the user asks, or to keep sessions you started for one piece of work together. Reuse a Group session_reachable lists in that Project rather than inventing a near-duplicate.",
			"Retitle a session when the user asks, or when its title no longer says what it is working on.",
		],
		parameters: Type.Object({
			session: Type.Optional(session),
			archived: Type.Optional(Type.Boolean({ description: "True to archive, false to unarchive." })),
			family: Type.Optional(
				Type.Boolean({ description: "With archived true: archive every open session it started too, and the ones they started." }),
			),
			force: Type.Optional(
				Type.Boolean({
					description: "With archived true: archive sessions mid-turn, blocked, cut off, or errored anyway, cancelling their turns.",
				}),
			),
			group: Type.Optional(
				Type.Union([Type.String(), Type.Null()], {
					description: "The Group to move it into, within its Project; null takes it out of its Group.",
				}),
			),
			title: Type.Optional(Type.String({ description: "A new, short title." })),
			snooze: Type.Optional(
				Type.Union([...[...SNOOZE_PRESETS, "off"].map((preset) => Type.Literal(preset)), Type.Object({ until: Type.String() })], {
					description: 'How long to snooze it, off to unsnooze, or {"until":"2026-11-05T09:00:00-08:00"} for a set time.',
				}),
			),
		}),
		readOnly: false,
	},
	swb_show_session: {
		description: "Show the user a specific session by switching focus to it.",
		guidelines: ["Call it last in your turn, and end with one short line; the user won't be watching this session afterward."],
		parameters: Type.Object({
			session,
			view: Type.Optional(
				Type.Union(
					VIEWS.map((view) => Type.Literal(view)),
					{ description: "agent, its directory's editor, or a split of both; omit unless the user asks for one." },
				),
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
