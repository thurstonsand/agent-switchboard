import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { harness } from "@swb/shared";
import { openDeck } from "../deck/deck.ts";

export async function newSession(args: string[]): Promise<void> {
	const { values } = parseArgs({ args, options: { cwd: { type: "string" }, harness: { type: "string" } } });
	await openDeck({
		select: null,
		newCwd: realpathSync(resolve(values.cwd ?? process.cwd())),
		continue: false,
		...(values.harness ? { harness: harness(values.harness) } : {}),
	});
}
