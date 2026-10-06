import { detached } from "./commands/detached.ts";
import { drive } from "./commands/drive.ts";
import { gc } from "./commands/gc.ts";
import { LS_HELP, ls } from "./commands/ls.ts";
import { migrate } from "./commands/migrate.ts";
import { newSession } from "./commands/new.ts";
import { visit } from "./commands/visit.ts";
import { SwbError, UsageError } from "./errors.ts";
import { VERSION } from "./version.ts";

const USAGE = `swb: Agent Switchboard

  swb new [--cwd DIR]          start a new managed pi session
  swb ls [--json]              list sessions with derived state
  swb drive start [--size COLSxROWS] [--theme light|dark] [-- swb-args]
  swb drive keys [--delay MS] [-l TEXT]… [KEY…] | capture [--ansi] | theme light|dark | focus in|out
            | click X Y | drag X1 Y1 X2 Y2 | resize COLSxROWS | clipboard | stop
  swb migrate                  create or upgrade the db
  swb --version`;

async function main(args: string[]): Promise<void> {
	const [command, ...rest] = args;
	if (rest.includes("--help")) {
		console.log(command === "ls" ? LS_HELP : USAGE);
		return;
	}
	switch (command) {
		case "--version":
			console.log(VERSION);
			return;
		case "--help":
		case "help":
			console.log(USAGE);
			return;
		case "new":
			return newSession(rest);
		case "ls":
			return ls(rest);
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
		default:
			throw new UsageError(`unknown command ${command ?? "(none)"}\n\n${USAGE}`);
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
