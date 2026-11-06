import { parseArgs } from "node:util";
import { fetchState, postCommand } from "../deck/deck.ts";
import { UsageError } from "../errors.ts";

export async function deckCommand(args: string[]): Promise<void> {
	const [verb, ...rest] = args;
	if (verb !== "state") throw new UsageError(`deck: unknown verb ${verb ?? "(none)"}`);
	const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
	const state = await fetchState();
	if (values.json) {
		console.log(JSON.stringify(state));
		return;
	}
	console.log(`${state.ready ? "ready" : "starting"}  focus ${state.focus}  staged ${state.staged.kind} ${state.staged.id ?? "-"}`);
	for (const row of state.rows) {
		if (row.kind === "session")
			console.log(
				`${row.id === state.cursor ? ">" : " "} ${"  ".repeat(row.level)}${row.origin === "operator" ? "⌁" : row.origin === "session" ? "↳" : " "}${row.folded ? "▸" : " "}${row.glyph} ${row.title}  ${row.state}${row.folded ? `  +${row.hidden}` : ""}`,
			);
		else if (row.kind === "header") console.log(`  ${row.expanded ? "▾" : "▸"} ${row.project}`);
		else console.log(`  ${row.expanded ? "▾" : "▸"} ${row.label} (${row.count})`);
	}
}

/** A tmux hook or binding reporting to the Deck's roster. */
export async function deckNotify(args: string[]): Promise<void> {
	const [cmd, ...rest] = args;
	if (!cmd) throw new UsageError("__deck: <cmd> [args…]");
	await postCommand(cmd, rest);
}
