import { parseArgs } from "node:util";
import { update } from "../coordinate.ts";
import { UsageError } from "../errors.ts";
import { snoozeValue } from "../schedules.ts";
import { openStore } from "../store.ts";

/** From a line (--from), it prints the tool result; from a shell, what it did. */
export function snooze(args: string[]): void {
	const { values, positionals } = parseArgs({ args, options: { from: { type: "string" } }, allowPositionals: true });
	const [id, value] = positionals;
	if (!id || !value) throw new UsageError("snooze: a session id and one_hour, one_day, monday, next_message, off, or a time");
	const result = update(openStore(), values.from ?? null, id, { snooze: snoozeValue(value) });
	console.log(values.from ? JSON.stringify(result) : result.text);
}
