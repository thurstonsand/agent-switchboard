// The gallery's populated Deck, held open to look around in, for a design reviewer who chooses their own frames.
//
//   bun test/e2e/tapes/explore.ts              seeds the gallery's scenario, opens a driven Deck, prints `ready`, and
//                                              holds it until interrupted
//   bun test/e2e/tapes/explore.ts swb ARGS…    runs swb in the scenario, from the switchboard project: `swb drive keys`,
//                                              `drive move X Y`, `drive resize COLSxROWS`, `drive capture`, `deck state`
//   bun test/e2e/tapes/explore.ts shot FILE    photographs the Deck as it stands, through VHS, in the gallery's terminal
//   bun test/e2e/tapes/explore.ts theme NAME   switches the Deck's terminal theme as the gallery does, light or dark
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { scenario, which } from "../harness/index.ts";
import { directors } from "./directors.ts";

const tapes = import.meta.dir;
const dir = "/tmp/swb-explore";
const LIGHT = ["copied-city", "solarized-light", "light"];

type Held = { env: Record<string, string>; drive: string; cwd: string };

function held(): Held {
	return JSON.parse(readFileSync(join(dir, "held.json"), "utf8"));
}

function run(cmd: string[], env: Record<string, string>, cwd = tapes): string {
	const result = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${result.stderr.toString().trim()}`);
	return result.stdout.toString();
}

async function hold(): Promise<void> {
	const director = directors.gallery ?? {};
	const s = scenario("phase6", "explore", { packages: director.packages ?? [], recorder: true, harnesses: director.harnesses ?? [] });
	const stop = async () => {
		rmSync(dir, { recursive: true, force: true });
		await s.cleanup();
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	await director.setup?.(s);
	const env = { ...s.env, SWB_DEMO_PROJECT: s.project };
	const cwd = join(s.project, "../switchboard");
	run([`${s.bin}/swb`, "drive", "start", "--theme", "city-ruins"], env, cwd);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "held.json"), JSON.stringify({ env, drive: s.servers.drive, cwd }));
	console.log("ready");
	await new Promise(() => {});
}

function shot(file: string): void {
	const { env, drive } = held();
	const out = resolve(file);
	mkdirSync(dirname(out), { recursive: true });
	const theme = readFileSync(join(tapes, "gallery.tape"), "utf8")
		.split("\n")
		.find((line) => line.startsWith("Set Theme")) as string;
	const scratch = mkdtempSync(join(tmpdir(), "swb-shot-"));
	const tape = join(scratch, "shot.tape");
	writeFileSync(
		tape,
		[
			theme,
			"Source common.tape",
			"Hide",
			`Type 'tmux -T RGB -L ${drive} attach' Enter`,
			"Sleep 2s",
			"Show",
			"Sleep 1s",
			`Screenshot "${out}"`,
			"",
		].join("\n"),
	);
	const tools = [dirname(which("ttyd")), dirname(which("ffmpeg"))].join(":");
	try {
		run([which("vhs"), "-q", tape, "-o", join(scratch, "shot.mp4")], { ...env, PATH: `${env.PATH}:${tools}` });
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	console.log(out);
}

// The Deck and pi ask for colors again only when a light/dark report flips the scheme, so the report goes both ways,
// as from a fresh terminal.
async function theme(name: string): Promise<void> {
	const { env, drive } = held();
	run(["swb", "drive", "theme", name], env);
	await Bun.sleep(500);
	for (const report of LIGHT.includes(name) ? [1, 2] : [2, 1]) {
		run(["tmux", "-L", drive, "set-buffer", "-b", "report", `\x1b[?997;${report}n`], env);
		run(["tmux", "-L", drive, "paste-buffer", "-S", "-d", "-b", "report", "-t", "=drive:"], env);
		await Bun.sleep(300);
	}
}

const [command, arg, ...rest] = process.argv.slice(2);
if (command === undefined) await hold();
else if (command === "swb") {
	const { env, cwd } = held();
	process.stdout.write(run(["swb", ...[arg, ...rest].filter((a) => a !== undefined)], env, cwd));
} else if (command === "shot" && arg) shot(arg);
else if (command === "theme" && arg) await theme(arg);
else throw new Error("usage: explore.ts [swb ARGS… | shot FILE | theme NAME]");
