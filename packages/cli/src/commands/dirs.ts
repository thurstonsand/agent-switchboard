import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { targets } from "../dirs.ts";
import { openStore } from "../store.ts";

/** The directory picker's list: each tree's main checkout or plain directory, then its worktrees, indented. */
export function dirs(args: string[]): void {
	const { values } = parseArgs({ args, options: { json: { type: "boolean", default: false } } });
	const trees = targets(openStore(), loadConfig().dirs);
	if (values.json) {
		console.log(
			JSON.stringify(
				trees.flatMap((t) => [t.root, ...t.worktrees]),
				null,
				2,
			),
		);
		return;
	}
	for (const tree of trees) {
		console.log(tree.root.path);
		for (const w of tree.worktrees) console.log(`  ${w.path}`);
	}
}
