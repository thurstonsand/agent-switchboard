import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDeck } from "../deck/deck.ts";

export async function newSession(args: string[]): Promise<void> {
	const { values } = parseArgs({ args, options: { cwd: { type: "string" } } });
	await openDeck({ select: null, newCwd: realpathSync(resolve(values.cwd ?? process.cwd())), continue: false });
}
