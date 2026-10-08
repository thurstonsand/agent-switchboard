// Renders every tape in this directory (or the ones named on the command line) against a disposable scenario.
// The tape is the human at the keyboard; its director, run alongside, plays the rest of the world (held turns
// released, processes killed, the clock moved) and asserts on `swb deck state`. Either failing fails the render.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { repo, type Scenario, scenario, which } from "../harness/index.ts";
import { directors } from "./directors.ts";

const tapes = import.meta.dir;
const videos = join(repo, "test/e2e/artifacts/phase6/videos");

const vhs = which("vhs");
const toolPath = [which("ttyd"), which("ffmpeg")].map((bin) => dirname(bin)).join(":");

/** The Deck as text and ANSI, taken when the director finishes, while the tape still holds the Deck open. */
function snapshot(s: Scenario): void {
	const decks = readdirSync(join(s.env.XDG_STATE_HOME as string, "agent-switchboard/decks"))
		.filter((file) => file.endsWith(".sock"))
		.map((file) => file.slice(0, -".sock".length));
	for (const deck of decks) {
		s.save(decks.length === 1 ? "deck-state.json" : `deck-state-${deck}.json`, s.swb("deck", "state", "--json", "--deck", deck));
	}
	const panes = s.tmux(s.servers.ui, "list-panes", "-a", "-F", "#{pane_id}").split("\n").filter(Boolean);
	const capture = (...flags: string[]) =>
		panes.map((pane) => s.tmux(s.servers.ui, "capture-pane", "-p", ...flags, "-t", pane)).join("\n----\n");
	s.save("screen.txt", capture());
	s.save("screen.ansi", capture("-e"));
}

async function render(name: string): Promise<void> {
	for (const ext of ["mp4", "gif"]) rmSync(join(videos, `${name}.${ext}`), { force: true });
	const director = directors[name] ?? {};
	const s = scenario("phase6", `video-${name}`, { packages: director.packages ?? [], recorder: true });
	try {
		await director.setup?.(s);
		const proc = Bun.spawn([vhs, "-q", join(tapes, `${name}.tape`), "-o", join(videos, `${name}.mp4`), "-o", join(videos, `${name}.gif`)], {
			cwd: tapes,
			env: { ...s.env, PATH: `${s.env.PATH}:${toolPath}`, SWB_DEMO_PROJECT: s.project },
			stdout: "pipe",
			stderr: "pipe",
		});
		const exited = proc.exited.then(async (code) => {
			if (code !== 0) throw new Error(`vhs exited ${code}: ${await new Response(proc.stderr).text()}`);
		});
		const directed = director.run?.(s).then(() => snapshot(s));
		try {
			await Promise.all([exited, directed]);
		} catch (error) {
			try {
				snapshot(s);
			} catch (failed) {
				console.log(`  (no snapshot: ${(failed as Error).message})`);
			}
			proc.kill();
			// The director may still be polling; let it fail before the scenario it polls is torn down.
			await directed?.catch(() => {});
			throw error;
		}
	} finally {
		try {
			s.save("final-ls.json", JSON.stringify(s.ls(), null, 2));
		} catch {}
		await s.cleanup();
	}
}

mkdirSync(videos, { recursive: true });
const all = readdirSync(tapes)
	.filter((file) => file.endsWith(".tape") && file !== "common.tape")
	.map((file) => file.slice(0, -".tape".length))
	.sort();
const wanted = process.argv.slice(2);
const unknown = wanted.filter((name) => !all.includes(name));
if (unknown.length > 0) throw new Error(`no such tape: ${unknown.join(", ")}`);

let failed = 0;
for (const name of wanted.length > 0 ? wanted : all) {
	const started = Date.now();
	try {
		await render(name);
		console.log(`✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
	} catch (error) {
		failed++;
		console.log(`✗ ${name}: ${(error as Error).message}`);
	}
}
if (failed > 0) process.exit(1);
