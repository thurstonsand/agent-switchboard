import { adopt } from "./commands/adopt.ts";
import { archive } from "./commands/archive.ts";
import { deckCommand, deckNotify, help } from "./commands/deck.ts";
import { detached } from "./commands/detached.ts";
import { drive } from "./commands/drive.ts";
import { gc } from "./commands/gc.ts";
import { launch } from "./commands/launch.ts";
import { LS_HELP, ls } from "./commands/ls.ts";
import { migrate } from "./commands/migrate.ts";
import { newSession } from "./commands/new.ts";
import { open } from "./commands/open.ts";
import { unarchive } from "./commands/unarchive.ts";
import { visit } from "./commands/visit.ts";
import { wake } from "./commands/wake.ts";
import { openDeck } from "./deck/deck.ts";
import { SwbError, UsageError } from "./errors.ts";
import { VERSION } from "./version.ts";

const USAGE = `swb: Agent Switchboard

  swb                          open a Deck where the last one in this Project left off
  swb -c, --continue           open a Deck in pi on this Project's most recent session, or a new one
  swb new [--cwd DIR]          open a Deck on a new pi session
  swb open ID                  open a Deck on a session
  swb adopt ID|TRANSCRIPT      track a session pi ran outside swb, then open it; quit that pi first
  swb ls [--json]              list sessions with derived state
  swb archive ID               archive a session
  swb unarchive ID             reopen an archived session
  swb launch --cwd DIR --session-id ID --model M
                               start pi on a session in the background, managed (pi-sessions handoffs)
  swb wake ID                  start a dormant session's pi in the background
  swb drive start [--size COLSxROWS] [--theme light|dark] [-- swb-args]
  swb drive keys [--delay MS] [-l TEXT]… [KEY…] | capture [--ansi] | theme light|dark | focus in|out
            | click X Y | drag X1 Y1 X2 Y2 [--hold] | release X Y (0-based cells) | resize COLSxROWS | clipboard | stop
  swb drive state | wait PATH=VALUE [--timeout MS]
  swb deck state [--deck NAME] [--json]
  swb migrate                  create or upgrade the db
  swb --version`;

async function main(args: string[]): Promise<void> {
	const [command, ...rest] = args;
	if (rest.includes("--help")) {
		console.log(command === "ls" ? LS_HELP : USAGE);
		return;
	}
	switch (command) {
		case undefined:
			return openDeck({ select: null, newCwd: null, continue: false });
		case "-c":
		case "--continue":
			return openDeck({ select: null, newCwd: null, continue: true });
		case "--version":
			console.log(VERSION);
			return;
		case "--help":
		case "help":
			console.log(USAGE);
			return;
		case "new":
			return newSession(rest);
		case "open":
			return open(rest);
		case "adopt":
			return adopt(rest);
		case "ls":
			return ls(rest);
		case "archive":
			return archive(rest);
		case "unarchive":
			return unarchive(rest);
		case "launch":
			return launch(rest);
		case "wake":
			return wake(rest);
		case "deck":
			return deckCommand(rest);
		case "migrate":
			return migrate();
		case "drive":
			return drive(rest);
		case "visit":
			return visit(rest);
		case "detached":
			return detached(rest);
		case "gc":
			return gc();
		case "__deck":
			return deckNotify(rest);
		case "__roster":
			await import("./deck/roster.ts");
			return;
		case "__placeholder":
			await import("./deck/placeholder.ts");
			return;
		case "__help":
			return help();
		default:
			throw new UsageError(`unknown command ${command}\n\n${USAGE}`);
	}
}

try {
	await main(process.argv.slice(2));
} catch (error) {
	if (error instanceof UsageError) {
		console.error(`swb: ${error.message}`);
		process.exit(2);
	}
	if (error instanceof SwbError) {
		console.error(`swb: ${error.message}`);
		process.exit(1);
	}
	throw error;
}
