import { parseArgs } from "node:util";
import { UsageError } from "../errors.ts";
import { SESSIONS, tmux } from "../tmux.ts";
import { DECK } from "./conf.ts";
import { type DeckIntent, deckSocket } from "./deck.ts";

// What this roster process was started with: the intent of the swb that started it, its pane, and its socket.

const { values } = parseArgs({ args: process.argv.slice(3), options: { intent: { type: "string" } } });

/** What the swb that started this roster asked of the Deck; a later swb's arrives as a command. */
export const startIntent: DeckIntent | null = values.intent ? (JSON.parse(values.intent) as DeckIntent) : null;

if (!process.env.TMUX_PANE) throw new UsageError("__roster: runs only inside a Deck pane");

export const rosterPane = process.env.TMUX_PANE;

/** The pane in the Stage's first slot, and the session it belongs to, or none for the slot's stand-in. */
// biome-ignore lint/plugin: before the roster's first frame, when nothing waits on its keys yet.
const mains = tmux(SESSIONS, "list-panes", "-s", "-t", `=${DECK}`, "-f", "#{==:#{@swb_slot},main}", "-F", "#{pane_id}\t#{@swb_home}");
export const [stagePane, stageShows = ""] = (mains.split("\n")[0] as string).split("\t") as [string, string | undefined];

if (!stagePane) throw new UsageError("__roster: the Deck has no Stage");

export const sock = deckSocket();
