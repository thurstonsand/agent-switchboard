import { parseArgs } from "node:util";
import { clockTime } from "@swb/shared/mailbox";
import { titleOf } from "@swb/shared/record";
import { update } from "../coordinate.ts";
import { SwbError, UsageError } from "../errors.ts";
import { pendingBySession } from "../schedules.ts";
import { archive as archiveSession } from "../sessions.ts";
import { openStore } from "../store.ts";

/**
 * From a line (--from), it prints the tool result, and a session may archive itself mid-turn. From a shell, a session
 * with schedules, which archiving cancels, asks first at a terminal and needs --yes without one. Either way it waits
 * for the harness to quit, so a script hears when it had to be closed.
 */
export async function archive(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: { from: { type: "string" }, yes: { type: "boolean", default: false } },
		allowPositionals: true,
	});
	const id = positionals[0];
	if (!id) throw new UsageError("archive: a session id is required");
	const db = openStore();
	if (values.from) {
		console.log(JSON.stringify(await update(db, values.from, id, { archived: true })));
		return;
	}
	const pending = pendingBySession(db).get(id) ?? [];
	if (pending.length > 0 && !values.yes) {
		const title = titleOf(db, id) ?? id;
		if (!process.stdin.isTTY) {
			const labels = pending.map((p) => `"${p.scheduleLabel}"`).join(", ");
			throw new SwbError(
				`archiving "${title}" cancels ${pending.length} schedule${pending.length === 1 ? "" : "s"}: ${labels}; swb archive --yes ${id} to archive anyway`,
			);
		}
		console.log(`Archiving "${title}" cancels its schedules:`);
		for (const p of pending) console.log(`  ◷ ${p.scheduleLabel} · ${clockTime(p.nextAt)}`);
		if (!/^y(es)?$/i.test(prompt("Archive it? [y/N]")?.trim() ?? "")) throw new SwbError("not archived");
	}
	const { refused, stopped } = archiveSession(db, [id]);
	if (refused) throw refused;
	await stopped;
}
