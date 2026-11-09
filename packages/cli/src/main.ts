import { BUSY_EXIT, isBusy, projectRoot } from "@swb/shared";
import { booted, span } from "@swb/shared/trace";
import { codexHost } from "./codex/host.ts";
import { adopt } from "./commands/adopt.ts";
import { archive } from "./commands/archive.ts";
import { clock } from "./commands/clock.ts";
import { launch, list, listSchedules, recall, schedule, search, send, show, unschedule, update } from "./commands/coordinate.ts";
import { deckCommand, deckNotify } from "./commands/deck.ts";
import { dirs } from "./commands/dirs.ts";
import { drive } from "./commands/drive.ts";
import { gc } from "./commands/gc.ts";
import { ack, claudeHook, inbox, record, unack } from "./commands/line.ts";
import { LS_HELP, ls } from "./commands/ls.ts";
import { migrate } from "./commands/migrate.ts";
import { models } from "./commands/models.ts";
import { newSession } from "./commands/new.ts";
import { open } from "./commands/open.ts";
import { quit } from "./commands/quit.ts";
import { reload } from "./commands/reload.ts";
import { snooze } from "./commands/snooze.ts";
import { unarchive } from "./commands/unarchive.ts";
import { wake } from "./commands/wake.ts";
import { readConfig } from "./config.ts";
import { editorNav, openDeck } from "./deck/deck.ts";
import { help } from "./deck/help.ts";
import { SwbError, UsageError } from "./errors.ts";
import { VERSION } from "./version.ts";

const USAGE = `swb: Agent Switchboard

  swb                          open the Deck as it was left
  swb -c, --continue           move the Deck to this Project's most recent session, or a new one
  swb new [--cwd DIR] [--harness H]  move the Deck to a new session
  swb open ID                  move the Deck to a session
  swb adopt ID|TRANSCRIPT      track a pi, Claude Code, or Codex session run outside swb, then open it; quit it first
  swb adopt --all              track every session pi, Claude Code, and Codex ran outside swb, archived, and index them
  swb ls [--json]              list sessions with derived state
  swb dirs [--json]            list the directories the Deck's picker offers
  swb models [--harness H] [--json] [QUERY]
                               list every model the harnesses offer, with its default effort and note
  swb archive ID [--yes]       archive a session; one with schedules, which archiving cancels, asks first, or needs --yes
                               without a terminal
  swb unarchive ID             reopen an archived session
  swb snooze ID one_hour|one_day|monday|next_message|off|TIME
                               hide a session in Snoozed until then, or its next message; TIME is ISO 8601, local unless it has an offset
  swb quit [--force]           stop every session, the Deck, and the clock; sessions stay open, dormant
  swb wake ID                  start a dormant session in the background
  swb reload ID [--idle]       restart a session's agent on fresh config and have it carry on; --idle waits for its turn to end
                               and leaves it waiting for a prompt
  swb launch [--harness H] [--model M] [--effort E] [--agent A] [--cwd DIR] [--from ID] [--title T]
             [--group NAME | --no-group] [--report-back] [(--at WHEN | --cron EXPR) --schedule-label TEXT [--request-id KEY]]
                               start a new session in the background on the shortlist's preset matching those; naming none, the
                               preset nearest what --from runs now, else the default; its briefing on stdin. It starts in --from's
                               Group when both are in one Project, unless --group or --no-group says otherwise. With --at or
                               --cron, as swb schedule takes them, it launches then instead, or anew each time the cron fires
  swb send --from ID --to ID [--report-back] [--request-id KEY] [--cancel]
                               message a session; the body on stdin
  swb list --from ID           every open session but the caller, as a line's tool reads it
  swb search --from ID [--limit N]
                               every session's conversation but the caller's, searched, as session_search reads it; the query on stdin
  swb recall begin|search|read ID
                               session_recall's reader, bound to a session: its first message from {"question"}, then its tools,
                               each taking its arguments as JSON on stdin
  swb recall sync              bring the search index up to date with every session's transcripts
  swb schedule --from ID [--to ID] (--at WHEN | --cron EXPR) --schedule-label TEXT [--report-back] [--snooze] [--request-id KEY]
                               message a session later; the body on stdin. WHEN is ISO 8601: a time, local unless it has an
                               offset, or a duration (PT2H); EXPR is 5-field cron in local time
  swb list-schedules --from ID
                               the schedules a session set or receives
  swb unschedule ID --from ID  cancel a pending schedule
  swb show ID --from ID [--view agent|editor|split]
                               switch the Deck, while it shows the caller, to a session, and start it
  swb update --from ID         swb_update_session as a line calls it; its arguments as JSON on stdin
  swb mcp --harness claude|codex
                               the MCP server a Claude Code or Codex session lists swb's tools from
  swb drive start [--size COLSxROWS] [--theme THEME] [-- swb-args]
  swb drive keys [--delay MS] [-l TEXT]… [KEY…] | capture [--ansi] | theme THEME | focus in|out
            | click X Y | click --on TEXT | wheel up|down X Y | move X Y | drag X1 Y1 X2 Y2 [--hold] | release X Y (0-based cells) | resize COLSxROWS | clipboard | stop
  swb drive state | wait PATH=VALUE [--timeout MS]   (these, capture, keys, click, and wheel wait for the Deck to catch up and come to rest; SWB_DRIVE_NOW=1 skips that)
  swb deck state [--json]
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
	"list",
	"wake",
	"reload",
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
			return openDeck(null);
		case "-c":
		case "--continue":
			return openDeck({ kind: "continue", root: projectRoot(process.cwd()), cwd: process.cwd() });
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
		case "list-schedules":
			return listSchedules(rest);
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
		case "list":
			return list(rest);
		case "search":
			return search(rest);
		case "recall":
			return recall(rest);
		case "wake":
			return wake(rest);
		case "reload":
			return reload(rest);
		case "deck":
			return deckCommand(rest);
		case "migrate":
			return migrate();
		case "drive":
			return drive(rest);
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
		case "__unack":
			return unack(rest);
		case "__claude_hook":
			return claudeHook(rest);
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
	if (isBusy(error)) {
		console.error(`swb: ${(error as Error).message}`);
		process.exit(BUSY_EXIT);
	}
	throw error;
}
