import { parseArgs } from "node:util";
import { harness } from "@swb/shared";
import { launchSession, reachable as listReachable, send as sendMessage } from "../coordinate.ts";
import { UsageError } from "../errors.ts";
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
			"request-response": { type: "boolean", default: false },
			snooze: { type: "boolean", default: false },
			"request-id": { type: "string" },
		},
	});
	if (!values.from || values.label === undefined) throw new UsageError("schedule: --from and --label are required");
	const launching = values["launch-title"] !== undefined;
	const given = ["harness", "model", "effort", "agent", "cwd"].filter((k) => values[`launch-${k}` as keyof typeof values] !== undefined);
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

export function schedules(args: string[]): void {
	const { values } = parseArgs({ args, options: { from: { type: "string" } } });
	if (!values.from) throw new UsageError("schedules: --from is required");
	print(listSchedules(openStore(), values.from));
}

export function unschedule(args: string[]): void {
	const { values, positionals } = parseArgs({ args, options: { from: { type: "string" } }, allowPositionals: true });
	const id = positionals[0];
	if (!id || !values.from) throw new UsageError("unschedule: a schedule id and --from are required");
	print(cancelSchedule(openStore(), values.from, id));
}
