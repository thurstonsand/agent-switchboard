import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { fetchState, liveDecks, postCommand } from "../deck/deck.ts";
import { bold, dim } from "../deck/style.ts";
import { SwbError, UsageError } from "../errors.ts";

/** The one Deck a command means: `--deck`, else the only live one. */
export function resolveDeck(named: string | undefined): string {
	const decks = liveDecks();
	if (named) {
		if (!decks.includes(named)) throw new SwbError(`no live deck ${named}`);
		return named;
	}
	if (decks.length === 0) throw new SwbError("no live deck");
	if (decks.length > 1) throw new SwbError(`several live decks (${decks.join(", ")}); pick one with --deck`);
	return decks[0] as string;
}

export async function deckCommand(args: string[]): Promise<void> {
	const [verb, ...rest] = args;
	if (verb !== "state") throw new UsageError(`deck: unknown verb ${verb ?? "(none)"}`);
	const { values } = parseArgs({ args: rest, options: { deck: { type: "string" }, json: { type: "boolean" } } });
	const state = await fetchState(resolveDeck(values.deck));
	if (values.json) {
		console.log(JSON.stringify(state));
		return;
	}
	console.log(
		`${state.deck}  ${state.ready ? "ready" : "starting"}  focus ${state.focus}  staged ${state.staged.kind} ${state.staged.id ?? "-"}`,
	);
	for (const row of state.rows) {
		if (row.kind === "session") console.log(`${row.id === state.cursor ? ">" : " "} ${row.glyph} ${row.title}  ${row.state}`);
		else if (row.kind === "header") console.log(`  ${row.expanded ? "▾" : "▸"} ${row.project}`);
		else console.log(`  ${row.expanded ? "▾" : "▸"} ${row.label} (${row.count})`);
	}
}

/** A tmux hook or binding reporting to a Deck's roster. */
export async function deckNotify(args: string[]): Promise<void> {
	const [deck, cmd, ...rest] = args;
	if (!deck || !cmd) throw new UsageError("__deck: <deck> <cmd> [args…]");
	await postCommand(deck, cmd, rest);
}

function keys(prefix: string): [string, string][] {
	return [
		["j k ↑ ↓", "move"],
		["g G", "first, last"],
		["⏎", "focus the session (wakes it)"],
		["l →", "focus the session; expand a header"],
		["h ←", "collapse a header"],
		["space", "toggle a header"],
		["w", "wake without focusing"],
		["n", "new session in the highlighted directory"],
		["N", "new session where swb was started"],
		["a", "archive; unarchive an archived one"],
		["y Y", "copy swb open <id>; @session:<id>"],
		["m", "put the session in a Group; rename a Group"],
		["drag", "into a Group, or out onto its Project"],
		["/", "filter; esc clears"],
		["q", "close the Deck (sessions keep running)"],
		["", ""],
		[`${prefix} h`, "the pane to the left"],
		[`${prefix} l`, "the pane to the right"],
		[`${prefix} Tab`, "the sidebar, or the session"],
		[`${prefix} e`, "swap pi and the editor"],
		[`${prefix} v`, "split the editor beside pi"],
		[`${prefix} z`, "hide or show the sidebar"],
		[`${prefix} <key>`, "j k n N w a y Y / m, as in the sidebar"],
		[`${prefix} q`, "close the Deck from anywhere"],
		[`${prefix} ?`, "these keys"],
		[`${prefix} ${prefix}`, `a literal ${prefix}`],
	];
}

export async function help(): Promise<void> {
	const lines = keys(loadConfig().prefix).map(([k, label]) => (k === "" ? "" : `  ${bold(k.padEnd(12))} ${label}`));
	process.stdout.write(`\n${lines.join("\n")}\n\n  ${dim("any key closes")}`);
	process.stdin.setRawMode(true);
	await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
	process.exit(0);
}
