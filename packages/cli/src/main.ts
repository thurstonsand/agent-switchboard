import { booted, span } from "@swb/shared/trace";
import { codexHost } from "./codex/host.ts";
import { adopt } from "./commands/adopt.ts";
import { archive } from "./commands/archive.ts";
import { launch, reachable, send } from "./commands/coordinate.ts";
import { deckCommand, deckNotify, help } from "./commands/deck.ts";
import { detached } from "./commands/detached.ts";
import { dirs } from "./commands/dirs.ts";
import { drive } from "./commands/drive.ts";
import { gc } from "./commands/gc.ts";
import { ack, inbox, record } from "./commands/line.ts";
import { LS_HELP, ls } from "./commands/ls.ts";
import { migrate } from "./commands/migrate.ts";
import { newSession } from "./commands/new.ts";
import { open } from "./commands/open.ts";
import { unarchive } from "./commands/unarchive.ts";
import { visit } from "./commands/visit.ts";
import { wake } from "./commands/wake.ts";
import { editorNav, openDeck } from "./deck/deck.ts";
import { SwbError, UsageError } from "./errors.ts";
import { VERSION } from "./version.ts";

const USAGE = `swb: Agent Switchboard

  swb                          open a Deck where the last one in this Project left off
  swb -c, --continue           open a Deck in pi on this Project's most recent session, or a new one
  swb new [--cwd DIR] [--harness H]  open a Deck on a new session
  swb open ID                  open a Deck on a session
  swb adopt ID|TRANSCRIPT      track a pi, Claude Code, or Codex session run outside swb, then open it; quit it first
  swb ls [--json]              list sessions with derived state
  swb dirs [--json]            list the directories the Deck's picker offers
  swb archive ID               archive a session
  swb unarchive ID             reopen an archived session
  swb wake ID                  start a dormant session in the background
  swb launch --harness pi|claude|codex [--cwd DIR] [--from ID] [--title T] [--model M] [--request-response]
                               start a new session in the background; its goal on stdin
  swb send --from ID --to ID [--request-response] [--request-id KEY] [--cancel]
                               message a session, waking it if dormant; the body on stdin
  swb reachable --from ID      every open session but the caller, as a line's tool reads it
  swb mcp                      the MCP server a Codex session's app-server runs for swb's tools
  swb drive start [--size COLSxROWS] [--theme light|dark] [-- swb-args]
  swb drive keys [--delay MS] [-l TEXT]… [KEY…] | capture [--ansi] | theme light|dark | focus in|out
            | click X Y | move X Y | drag X1 Y1 X2 Y2 [--hold] | release X Y (0-based cells) | resize COLSxROWS | clipboard | stop
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
		case "dirs":
			return dirs(rest);
		case "archive":
			return archive(rest);
		case "unarchive":
			return unarchive(rest);
		case "launch":
			return launch(rest);
		case "send":
			return send(rest);
		case "reachable":
			return reachable(rest);
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
		case "__peek":
			await import("./deck/peek.ts");
			return;
		case "mcp":
			// The MCP SDK costs every other command 40 ms of startup; only `swb mcp` loads it.
			return (await import("./codex/mcp.ts")).mcp();
		case "__codex":
			return codexHost(rest);
		case "__record":
			return span(`record.${rest[0]}`, () => record(rest));
		case "__inbox":
			return inbox(rest);
		case "__ack":
			return ack(rest);
		case "__help":
			return help();
		case "__nav":
			return editorNav(rest[0] ?? "", process.env.SWB_EDITOR ?? "");
		default:
			throw new UsageError(`unknown command ${command}\n\n${USAGE}`);
	}
}

booted(`boot ${process.argv[2] ?? "deck"}`);
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
