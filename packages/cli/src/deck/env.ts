import { parseArgs } from "node:util";
import { UsageError } from "../errors.ts";
import { tmux, UI } from "../tmux.ts";
import { type DeckIntent, deckSocket } from "./deck.ts";

// What this roster process was started with: the intent of the swb that started it, its panes, and its socket.

const { values } = parseArgs({ args: process.argv.slice(3), options: { intent: { type: "string" } } });

/** What the swb that started this roster asked of the Deck; a later swb's arrives as a command. */
export const startIntent: DeckIntent | null = values.intent ? (JSON.parse(values.intent) as DeckIntent) : null;

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

export const sock = deckSocket();
