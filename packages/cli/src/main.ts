import { booted, span } from "@swb/shared/trace";
import { codexHost } from "./codex/host.ts";
import { adopt } from "./commands/adopt.ts";
import { archive } from "./commands/archive.ts";
import { clock } from "./commands/clock.ts";
import { launch, reachable, recall, schedule, schedules, search, send, show, unschedule, update } from "./commands/coordinate.ts";
import { deckCommand, deckNotify, help } from "./commands/deck.ts";
import { detached } from "./commands/detached.ts";
import { dirs } from "./commands/dirs.ts";
import { drive } from "./commands/drive.ts";
import { gc } from "./commands/gc.ts";
import { ack, inbox, record } from "./commands/line.ts";
import { LS_HELP, ls } from "./commands/ls.ts";
import { migrate } from "./commands/migrate.ts";
import { models } from "./commands/models.ts";
import { newSession } from "./commands/new.ts";
import { open } from "./commands/open.ts";
import { quit } from "./commands/quit.ts";
import { snooze } from "./commands/snooze.ts";
import { unarchive } from "./commands/unarchive.ts";
import { visit } from "./commands/visit.ts";
import { wake } from "./commands/wake.ts";
import { readConfig } from "./config.ts";
import { editorNav, openDeck } from "./deck/deck.ts";
import { SwbError, UsageError } from "./errors.ts";
import { VERSION } from "./version.ts";

const USAGE = `swb: Agent Switchboard

  swb                          open a Deck where the last one in this Project left off
  swb -c, --continue           open a Deck on this Project's most recent session, or a new one
  swb new [--cwd DIR] [--harness H]  open a Deck on a new session
  swb open ID                  open a Deck on a session
  swb adopt ID|TRANSCRIPT      track a pi, Claude Code, or Codex session run outside swb, then open it; quit it first
  swb adopt --all              track every session pi, Claude Code, and Codex ran outside swb, archived, and index them
  swb ls [--json]              list sessions with derived state
  swb dirs [--json]            list the directories the Deck's picker offers
  swb models [--harness H] [--json] [QUERY]
                               list every model the harnesses offer, with its default effort and note
  swb archive ID               archive a session
  swb unarchive ID             reopen an archived session
  swb snooze ID one_hour|one_day|monday|next_message|off|TIME
                               hide a session in Snoozed until then, or its next message; TIME is ISO 8601, local unless it has an offset
  swb quit [--force]           stop every session, Deck, and the clock; sessions stay open, dormant
  swb wake ID                  start a dormant session in the background
  swb launch [--harness H] [--model M] [--effort E] [--agent A] [--cwd DIR] [--from ID] [--title T]
             [--group NAME | --no-group] [--request-response]
                               start a new session in the background on the shortlist's preset matching those; naming none, the
                               preset nearest what --from runs now, else the default; its goal on stdin. It starts in --from's
                               Group when both are in one Project, unless --group or --no-group says otherwise
  swb send --from ID --to ID [--request-response] [--request-id KEY] [--cancel]
                               message a session, waking it if dormant; the body on stdin
  swb reachable --from ID      every open session but the caller, as a line's tool reads it
  swb search --from ID [--limit N]
                               every session's conversation but the caller's, searched, as session_search reads it; the query on stdin
  swb recall begin|search|read ID
                               session_ask's reader, bound to a session: its first message from {"question"}, then its tools,
                               each taking its arguments as JSON on stdin
  swb recall sync              bring the search index up to date with every session's transcripts
  swb schedule --from ID [--to ID | --launch-title T [--launch-harness H] [--launch-model M] [--launch-effort E]
               [--launch-agent A] [--launch-cwd DIR] [--launch-group NAME | --launch-no-group]] (--at WHEN | --cron EXPR)
               --label TEXT [--request-response] [--snooze] [--request-id KEY]
                               message a session later, or launch one on a preset and in a Group, as swb launch does; the body
                               on stdin. WHEN is ISO 8601: a time, local unless it has an offset, or a duration (PT2H); EXPR is
                               5-field cron in local time
  swb schedules --from ID      the schedules a session set or receives
  swb unschedule ID --from ID  cancel a pending schedule
  swb show ID --from ID [--view agent|editor|split]
                               switch the Deck showing the caller to a session, and start it
  swb update --from ID         swb_update_session as a line calls it; its arguments as JSON on stdin
  swb mcp --harness claude|codex
                               the MCP server a Claude Code or Codex session lists swb's tools from
  swb drive start [--size COLSxROWS] [--theme light|dark] [-- swb-args]
  swb drive keys [--delay MS] [-l TEXT]… [KEY…] | capture [--ansi] | theme light|dark | focus in|out
            | click X Y | move X Y | drag X1 Y1 X2 Y2 [--hold] | release X Y (0-based cells) | resize COLSxROWS | clipboard | stop
  swb drive state | wait PATH=VALUE [--timeout MS]
  swb deck state [--deck NAME] [--json]
  swb migrate                  create or upgrade the db
  swb --version`;

const CHECKS_CONFIG = new Set([
	undefined,
	"-c",
	"--continue",
	"new",
	"open",
	"adopt",
	"ls",
	"dirs",
	"models",
	"archive",
	"unarchive",
	"launch",
	"send",
	"reachable",
	"wake",
]);

async function main(args: string[]): Promise<void> {
	const [command, ...rest] = args;
	if (rest.includes("--help")) {
		console.log(command === "ls" ? LS_HELP : USAGE);
		return;
	}
	// A config.toml swb can't read stops every command a person or agent runs, before it does anything.
	if (CHECKS_CONFIG.has(command)) readConfig();
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
		case "models":
			return models(rest);
		case "archive":
			return archive(rest);
		case "unarchive":
			return unarchive(rest);
		case "snooze":
			return snooze(rest);
		case "quit":
			return quit(rest);
		case "schedule":
			return schedule(rest);
		case "schedules":
			return schedules(rest);
		case "unschedule":
			return unschedule(rest);
		case "show":
			return show(rest);
		case "update":
			return update(rest);
		case "launch":
			return launch(rest);
		case "send":
			return send(rest);
		case "reachable":
			return reachable(rest);
		case "search":
			return search(rest);
		case "recall":
			return recall(rest);
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
		case "mcp":
			// The MCP SDK costs every other command 40 ms of startup; only `swb mcp` loads it.
			return (await import("./mcp.ts")).mcp(rest);
		case "__clock":
			return clock();
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
