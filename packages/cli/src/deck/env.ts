import { parseArgs } from "node:util";
import { UsageError } from "../errors.ts";
import { tmux, UI } from "../tmux.ts";
import { deckSocket, placeholderName } from "./deck.ts";

// What this Deck's roster process was started with: its flags, its panes, and its socket.

export const { values: args } = parseArgs({
	args: process.argv.slice(3),
	options: {
		deck: { type: "string" },
		select: { type: "string" },
		new: { type: "string" },
		harness: { type: "string" },
		here: { type: "string" },
		continue: { type: "boolean" },
	},
});

if (!args.deck || !args.here) throw new UsageError("__roster: --deck and --here are required");

export const deck = args.deck;

/** Where swb was run: `-c` and `swb new` start there. */
export const here = args.here;

if (!process.env.TMUX_PANE) throw new UsageError("__roster: runs only inside a Deck pane");

export const rosterPane = process.env.TMUX_PANE;

/** The Stage's pane and its tty, from the window option the Deck set as it made the Stage. */
// biome-ignore lint/plugin: before the roster's first frame, when nothing waits on its keys yet.
export const [stagePane, stageTty] = tmux(
	UI,
	"display",
	"-p",
	"-t",
	rosterPane,
	"#{P:#{?#{==:#{pane_id},#{@swb_stage}},#{pane_id} #{pane_tty},}}",
)
	.trim()
	.split(" ") as [string, string];

if (!stagePane || !stageTty) throw new UsageError("__roster: its window names no Stage");

export const sock = deckSocket(deck);

export const placeholder = placeholderName(deck);
