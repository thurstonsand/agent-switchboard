import { parseArgs } from "node:util";
import { harness, view as viewNamed } from "@swb/shared";
import { parsed } from "@swb/shared/tools";
import {
	launchSession,
	reachable as listReachable,
	send as sendMessage,
	show as showSession,
	update as updateSession,
} from "../coordinate.ts";
import { UsageError } from "../errors.ts";
import { recallBegin, recallRead, recallSearch } from "../recall/read.ts";
import { search as searchSessions, syncAll } from "../recall/search.ts";
import { unschedule as cancelSchedule, listSchedules, schedule as scheduleMessage } from "../schedules.ts";
import { ensureSessionsServer } from "../sessions.ts";
import { openStore } from "../store.ts";

// The lines' commands: each prints { text, details } as JSON, the text being what the calling model reads.

function print(result: unknown): void {
	console.log(JSON.stringify(result));
}

export function reachable(args: string[]): void {
	const { values } = parseArgs({ args, options: { from: { type: "string" } } });
	if (!values.from) throw new UsageError("reachable: --from is required");
	print(listReachable(openStore(), values.from));
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
			"request-response": { type: "boolean", default: false },
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
			requestResponse: values["request-response"],
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
			"request-response": { type: "boolean", default: false },
		},
	});
	print(
		await launchSession(openStore(), {
			from: values.from ?? null,
			harness: values.harness ? harness(values.harness) : null,
			effort: values.effort ?? null,
			agent: values.agent ?? null,
			goal: await Bun.stdin.text(),
			cwd: values.cwd ?? null,
			title: values.title ?? null,
			group: groupOf("", values.group, values["no-group"]),
			requestResponse: values["request-response"],
			model: values.model ?? null,
			scheduled: null,
		}),
	);
}

export async function schedule(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			from: { type: "string" },
			to: { type: "string" },
			at: { type: "string" },
			cron: { type: "string" },
			label: { type: "string" },
			"launch-harness": { type: "string" },
			"launch-model": { type: "string" },
			"launch-effort": { type: "string" },
			"launch-agent": { type: "string" },
			"launch-cwd": { type: "string" },
			"launch-title": { type: "string" },
			"launch-group": { type: "string" },
			"launch-no-group": { type: "boolean", default: false },
			"request-response": { type: "boolean", default: false },
			snooze: { type: "boolean", default: false },
			"request-id": { type: "string" },
		},
	});
	if (!values.from || values.label === undefined) throw new UsageError("schedule: --from and --label are required");
	const launching = values["launch-title"] !== undefined;
	const given = ["harness", "model", "effort", "agent", "cwd", "group"].filter(
		(k) => values[`launch-${k}` as keyof typeof values] !== undefined,
	);
	if (!launching && values["launch-no-group"]) given.push("no-group");
	if (!launching && given.length > 0) throw new UsageError(`schedule: --launch-${given[0]} needs --launch-title`);
	const result = await scheduleMessage(openStore(), {
		from: values.from,
		to: values.to ?? null,
		launch: launching
			? {
					harness: values["launch-harness"] ? harness(values["launch-harness"]) : null,
					model: values["launch-model"] ?? null,
					effort: values["launch-effort"] ?? null,
					agent: values["launch-agent"] ?? null,
					cwd: values["launch-cwd"] ?? null,
					title: values["launch-title"] as string,
					group: groupOf("launch-", values["launch-group"], values["launch-no-group"]),
				}
			: null,
		body: await Bun.stdin.text(),
		at: values.at ?? null,
		cron: values.cron ?? null,
		label: values.label,
		requestResponse: values["request-response"],
		snooze: values.snooze,
		requestId: values["request-id"] ?? null,
	});
	// Its clock is what fires it, which a reboot or swb quit may have left stopped.
	ensureSessionsServer();
	print(result);
}

/** A launch's Group: named, none (--no-group), or omitted to keep the launcher's. */
function groupOf(prefix: string, name: string | undefined, none: boolean): string | null | undefined {
	if (name !== undefined && none) throw new UsageError(`--${prefix}group and --${prefix}no-group conflict`);
	return none ? null : name;
}

export function schedules(args: string[]): void {
	const { values } = parseArgs({ args, options: { from: { type: "string" } } });
	if (!values.from) throw new UsageError("schedules: --from is required");
	print(listSchedules(openStore(), values.from));
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
