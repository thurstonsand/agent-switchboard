import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { launch } from "../sessions.ts";
import { openStore } from "../store.ts";
import { cleanEnv, SESSIONS, tmuxBin } from "../tmux.ts";

export async function newSession(args: string[]): Promise<void> {
	const { values } = parseArgs({ args, options: { cwd: { type: "string" } } });
	const cwd = realpathSync(resolve(values.cwd ?? process.cwd()));
	openStore();
	const name = launch(cwd, null);
	const attach = Bun.spawn([tmuxBin(), "-L", SESSIONS, "attach", "-t", `=${name}`], {
		env: cleanEnv(),
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	process.exitCode = await attach.exited;
}
