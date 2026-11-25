import { parseArgs } from "node:util";
import { harness, view as viewNamed } from "@swb/shared";
import { parsed } from "@swb/shared/tools";
import {
	askUser as askUserFrom,
	launchSession,
	list as listSessions,
	send as sendMessage,
	showFile as showFileIn,
	show as showSession,
	update as updateSession,
} from "../coordinate.ts";
import { UsageError } from "../errors.ts";
import { recallBegin, recallRead, recallSearch } from "../recall/read.ts";
import { search as searchSessions, syncAll } from "../recall/search.ts";
import { unschedule as cancelSchedule, schedule as scheduleMessage, listSchedules as schedulesOf } from "../schedules.ts";
import { ensureSessionsServer } from "../sessions.ts";
import { openStore } from "../store.ts";
import {
	humanMove,
	humanWt,
	moveSession,
	worktreeCheckout,
	worktreeFork,
	worktreeList,
	worktreeMerge,
	worktreeRebranch,
	worktreeRemove,
} from "../worktree.ts";

// The lines' commands: each prints { text, details } as JSON, the text being what the calling model reads.

function print(result: unknown): void {
	console.log(JSON.stringify(result));
}

export function list(args: string[]): void {
	const { values } = parseArgs({ args, options: { from: { type: "string" } } });
	if (!values.from) throw new UsageError("list: --from is required");
	print(listSessions(openStore(), values.from));
}

/** session_search, the query on stdin. */
export async function search(args: string[]): Promise<void> {
	const { values } = parseArgs({ args, options: { from: { type: "string" }, limit: { type: "string" } } });
	if (!values.from) throw new UsageError("search: --from is required");
	print(searchSessions(openStore(), values.from, await Bun.stdin.text(), values.limit === undefined ? undefined : Number(values.limit)));
}

/**
 * What every line's reader runs, bound to the session it was asked about: `swb recall begin ID` writes its first
 * message from the question, and `search` and `read` are its tools, each taking its arguments as JSON on stdin. The
 * clock's `swb recall sync` keeps the index warm.
 */
export async function recall(args: string[]): Promise<void> {
	const [op, id, ...rest] = args;
	if (op === "sync" && !id) {
		syncAll(openStore());
		return;
	}
	if (!id || rest.length > 0 || (op !== "begin" && op !== "search" && op !== "read"))
		throw new UsageError("recall: begin|search|read ID | sync");
	const input = JSON.parse((await Bun.stdin.text()) || "{}") as unknown;
	const db = openStore();
	if (op === "begin") {
		const { question } = input as { question?: unknown };
		if (typeof question !== "string") throw new UsageError('recall begin: {"question": "…"} on stdin');
		print(recallBegin(db, id, question));
	} else if (op === "search") print(recallSearch(db, id, parsed("recall_search", input)));
	else print(recallRead(db, id, parsed("recall_read", input)));
}

export async function send(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			from: { type: "string" },
			to: { type: "string" },
			"report-back": { type: "boolean", default: false },
			"request-id": { type: "string" },
			cancel: { type: "boolean", default: false },
		},
	});
	if (!values.from || !values.to) throw new UsageError("send: --from and --to are required");
	const body = values.cancel ? "" : await Bun.stdin.text();
	print(
		await sendMessage(openStore(), {
			from: values.from,
			to: values.to,
			body,
			reportBack: values["report-back"],
			requestId: values["request-id"] ?? null,
			kind: values.cancel ? "cancel" : "message",
		}),
	);
}

export async function launch(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			harness: { type: "string" },
			effort: { type: "string" },
			agent: { type: "string" },
			cwd: { type: "string" },
			from: { type: "string" },
			title: { type: "string" },
			group: { type: "string" },
			"no-group": { type: "boolean", default: false },
			model: { type: "string" },
			"report-back": { type: "boolean", default: false },
			at: { type: "string" },
			cron: { type: "string" },
			"schedule-label": { type: "string" },
			"request-id": { type: "string" },
		},
	});
	const db = openStore();
	const preset = {
		harness: values.harness ? harness(values.harness) : null,
		model: values.model ?? null,
		effort: values.effort ?? null,
		agent: values.agent ?? null,
	};
	const briefing = await Bun.stdin.text();
	const group = groupOf(values.group, values["no-group"]);
	if (values.at === undefined && values.cron === undefined && values["schedule-label"] === undefined) {
		print(
			await launchSession(db, {
				from: values.from ?? null,
				...preset,
				briefing,
				cwd: values.cwd ?? null,
				title: values.title ?? null,
				group,
				reportBack: values["report-back"],
				scheduled: null,
			}),
		);
		return;
	}
	if (!values.from || values.title === undefined)
		throw new UsageError("launch: --at, --cron, and --schedule-label need --from and --title");
	const result = await scheduleMessage(db, {
		from: values.from,
		to: null,
		launch: { ...preset, cwd: values.cwd ?? null, title: values.title, group },
		body: briefing,
		at: values.at ?? null,
		cron: values.cron ?? null,
		scheduleLabel: values["schedule-label"] ?? "",
		reportBack: values["report-back"],
		snooze: false,
		requestId: values["request-id"] ?? null,
	});
	// Its clock is what fires it, which a reboot or swb quit may have left stopped.
	ensureSessionsServer();
	print(result);
}

export async function schedule(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			from: { type: "string" },
			to: { type: "string" },
			at: { type: "string" },
			cron: { type: "string" },
			"schedule-label": { type: "string" },
			"report-back": { type: "boolean", default: false },
			snooze: { type: "boolean", default: false },
			"request-id": { type: "string" },
		},
	});
	if (!values.from || values["schedule-label"] === undefined) throw new UsageError("schedule: --from and --schedule-label are required");
	const result = await scheduleMessage(openStore(), {
		from: values.from,
		to: values.to ?? null,
		launch: null,
		body: await Bun.stdin.text(),
		at: values.at ?? null,
		cron: values.cron ?? null,
		scheduleLabel: values["schedule-label"],
		reportBack: values["report-back"],
		snooze: values.snooze,
		requestId: values["request-id"] ?? null,
	});
	// Its clock is what fires it, which a reboot or swb quit may have left stopped.
	ensureSessionsServer();
	print(result);
}

/** A launch's Group: named, none (--no-group), or omitted to keep the launcher's. */
function groupOf(name: string | undefined, none: boolean): string | null | undefined {
	if (name !== undefined && none) throw new UsageError("--group and --no-group conflict");
	return none ? null : name;
}

export function listSchedules(args: string[]): void {
	const { values } = parseArgs({ args, options: { from: { type: "string" } } });
	if (!values.from) throw new UsageError("list-schedules: --from is required");
	print(schedulesOf(openStore(), values.from));
}

export async function show(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: { from: { type: "string" }, view: { type: "string" } },
		allowPositionals: true,
	});
	const id = positionals[0];
	if (!id || !values.from) throw new UsageError("show: a session id and --from are required");
	print(await showSession(openStore(), values.from, id, values.view === undefined ? null : viewNamed(values.view)));
}

export async function showFile(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: { from: { type: "string" }, line: { type: "string" } },
		allowPositionals: true,
	});
	const path = positionals[0];
	if (!path || !values.from) throw new UsageError("show-file: a path and --from are required");
	const line = values.line === undefined ? 1 : Number(values.line);
	if (!Number.isInteger(line) || line < 1) throw new UsageError(`show-file: --line takes a line number, got ${values.line}`);
	print(await showFileIn(openStore(), values.from, path, line));
}

export function askUser(args: string[]): void {
	const { values } = parseArgs({ args, options: { from: { type: "string" } } });
	if (!values.from) throw new UsageError("ask-user: --from is required");
	print(askUserFrom(openStore(), values.from));
}

/** swb_update_session as every line calls it: its arguments as JSON on stdin, checked against the tool's schema. */
export async function update(args: string[]): Promise<void> {
	const { values } = parseArgs({ args, options: { from: { type: "string" } } });
	if (!values.from) throw new UsageError("update: --from is required");
	const { parsed } = await import("@swb/shared/tools");
	const a = parsed("swb_update_session", JSON.parse(await Bun.stdin.text()));
	print(await updateSession(openStore(), values.from, a.session ?? values.from, a));
}

export function unschedule(args: string[]): void {
	const { values, positionals } = parseArgs({ args, options: { from: { type: "string" } }, allowPositionals: true });
	const id = positionals[0];
	if (!id || !values.from) throw new UsageError("unschedule: a schedule id and --from are required");
	print(cancelSchedule(openStore(), values.from, id));
}

/**
 * Moves a session to another directory:
 * - Agent tool (`--from ID --agent DIR`): schedules a mid-turn move and prints ToolResult JSON.
 * - Slash command (`--from ID --defer [--stop-host] DIR`): schedules an idle move and prints JSON.
 * - CLI (`swb move ID DIR`): moves immediately and prints a plain message.
 */
export async function move(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			from: { type: "string" },
			agent: { type: "boolean", default: false },
			defer: { type: "boolean", default: false },
			"stop-host": { type: "boolean", default: false },
		},
		allowPositionals: true,
	});
	const db = openStore();
	if (values.agent) {
		const dir = positionals[0];
		if (!values.from || !dir) throw new UsageError("move --agent: --from ID and DIR are required");
		print(await moveSession(db, values.from, dir));
		return;
	}
	if (values.from) {
		const dir = positionals[0];
		if (!dir) throw new UsageError("move: DIR is required");
		print(await humanMove(db, values.from, dir, { defer: values.defer, stopHost: values["stop-host"] }));
		return;
	}
	const [id, dir] = positionals;
	if (!id || !dir) throw new UsageError("move: ID and DIR are required");
	const result = await humanMove(db, id, dir);
	console.log(result.text);
}

/** Agent worktree tools as every line calls them: `swb worktree <op> --from ID`, JSON args on stdin. */
export async function worktree(args: string[]): Promise<void> {
	const [op, ...rest] = args;
	const { values } = parseArgs({ args: rest, options: { from: { type: "string" } } });
	if (!op || !values.from) throw new UsageError("worktree: list|fork|checkout|merge|remove|rebranch and --from ID are required");
	const input = JSON.parse((await Bun.stdin.text()) || "{}") as unknown;
	const db = openStore();
	switch (op) {
		case "list":
			print(await worktreeList(db, values.from, parsed("swb_worktree_list", input)));
			return;
		case "fork":
			print(await worktreeFork(db, values.from, parsed("swb_worktree_fork", input)));
			return;
		case "checkout":
			print(await worktreeCheckout(db, values.from, parsed("swb_worktree_checkout", input)));
			return;
		case "merge":
			print(await worktreeMerge(db, values.from, parsed("swb_worktree_merge", input)));
			return;
		case "remove":
			print(await worktreeRemove(db, values.from, parsed("swb_worktree_remove", input)));
			return;
		case "rebranch":
			print(await worktreeRebranch(db, values.from, parsed("swb_worktree_rebranch", input)));
			return;
		default:
			throw new UsageError(`worktree: unknown op ${op}`);
	}
}

/** Human /wt slash command: `swb wt --from ID [--defer] [--stop-host]`, raw argument string on stdin. */
export async function wtSlash(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			from: { type: "string" },
			defer: { type: "boolean", default: false },
			"stop-host": { type: "boolean", default: false },
		},
	});
	if (!values.from) throw new UsageError("wt: --from ID is required");
	const rawInput = await Bun.stdin.text();
	print(await humanWt(openStore(), values.from, rawInput, { defer: values.defer, stopHost: values["stop-host"] }));
}
