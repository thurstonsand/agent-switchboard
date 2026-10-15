import { parseArgs } from "node:util";
import { harness } from "@swb/shared";
import { launchSession, reachable as listReachable, send as sendMessage } from "../coordinate.ts";
import { UsageError } from "../errors.ts";
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
			cwd: { type: "string" },
			from: { type: "string" },
			title: { type: "string" },
			model: { type: "string" },
			"request-response": { type: "boolean", default: false },
		},
	});
	if (!values.harness) throw new UsageError("launch: --harness is required");
	print(
		await launchSession(openStore(), {
			from: values.from ?? null,
			harness: harness(values.harness),
			goal: await Bun.stdin.text(),
			cwd: values.cwd ?? null,
			title: values.title ?? null,
			requestResponse: values["request-response"],
			model: values.model ?? null,
		}),
	);
}
