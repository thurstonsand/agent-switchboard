import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { now } from "../../../packages/shared/src/trace.ts";
import type { Scenario } from "../../e2e/harness/index.ts";
import { dormant, entry, stop } from "../fleet.ts";
import { cursorTo, exits, focusRoster, onScreen, type Probe, suite, when } from "../probe.ts";
import { Terminal } from "../terminal.ts";

// Starting and resuming sessions in each harness: through the Deck as a person does, and through `swb launch` as an
// agent does. Each `start.*.bare` runs the same harness with the same first prompt, outside swb and without its line,
// so the difference from its `start.*.swb` is what swb adds.

type Harness = "pi" | "claude" | "codex";
type Ctx = { t: Terminal; resumable: string; bareAgentDir: string; shell: string };

/** The user's login shell, which swb starts every harness through. */
function loginShell(): string {
	const out = Bun.spawnSync(["getent", "passwd", String(process.getuid?.())])
		.stdout.toString()
		.trim();
	return out.split(":").at(-1) || "/bin/sh";
}

/** pi's agent dir without the pi line, for a pi that swb has nothing to do with. */
function bareAgentDir(s: Scenario): string {
	const agent = s.env.PI_CODING_AGENT_DIR as string;
	const bare = join(s.root, "pi-agent-bare");
	cpSync(agent, bare, { recursive: true });
	const settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")) as { packages: string[] };
	settings.packages = settings.packages.filter((p) => !p.endsWith("/pi"));
	writeFileSync(join(bare, "settings.json"), JSON.stringify(settings));
	return bare;
}

function bareCommand(harness: Harness, prompt: string, ctx: Ctx): string {
	const quoted = `'${prompt}'`;
	if (harness === "pi") return `PI_CODING_AGENT_DIR=${ctx.bareAgentDir} exec pi ${quoted}`;
	return `exec ${harness} ${quoted}`;
}

const NAMES: Record<Harness, string> = { pi: "pi", claude: "Claude Code", codex: "Codex" };
// Their TUIs keep repainting for a while after they're up: a spinner settling, a status line filling in.
const QUIET: Record<Harness, number> = { pi: 300, claude: 500, codex: 500 };

function probes(harness: Harness): Probe<Ctx>[] {
	const name = NAMES[harness];
	return [
		{
			name: `session.new.${harness}`,
			feels: `n, ${harness === "pi" ? "" : "its preset from the menu, "}Enter: until a new ${name} has the keyboard and the screen is still.`,
			primary: "settled",
			runs: 4,
			sample: async ({ s }, { t }) => {
				await focusRoster(t);
				await t.press("n");
				await t.waitState("the picker", (x) => x.picker !== null && x.picker.rows.length > 0);
				if ((await t.state())?.picker?.harness !== harness) {
					await t.press("Tab");
					await t.waitState("the preset menu", (x) => x.picker?.menu != null);
					await t.type(harness);
					await t.waitState(`the menu narrowed to ${name}`, (x) => x.picker?.menu?.query === harness);
					await t.press("Enter");
					await t.waitState(`${name} chosen`, (x) => x.picker?.harness === harness && x.picker.menu === null);
				}
				await t.waitState("the picker on a directory", (x) => x.picker?.rows[x.picker.choice]?.path != null);
				await Bun.sleep(300);
				const t0 = await t.press("Enter");
				const { last, doneAt } = await t.settle(
					t0,
					async () => {
						const st = await t.state();
						return st?.staged.kind === "live" && st.focus === "stage";
					},
					{ what: `the new ${name} live`, quietMs: QUIET[harness], timeoutMs: 60_000 },
				);
				const started = (await t.state())?.staged.host;
				if (started) s.tmux(s.servers.sessions, "kill-session", "-t", `=${started}`);
				await focusRoster(t);
				return { t0, metrics: { settled: last - t0, live: doneAt - t0 } };
			},
		},
		{
			name: `session.wake.${harness}`,
			feels: `Enter on a dormant ${name} session: until it is resumed with the keyboard and the screen is still.`,
			primary: "settled",
			runs: 4,
			sample: async ({ s }, { t, resumable }) => {
				stop(s, resumable);
				await cursorTo(t, resumable);
				// Exited, when its pi was stopped while on view.
				await t.waitState(
					"its card on the Stage",
					(x) => x.staged.id === resumable && (x.staged.kind === "dormant" || x.staged.kind === "exited"),
				);
				await Bun.sleep(300);
				const t0 = await t.press("Enter");
				const { last, doneAt } = await t.settle(
					t0,
					async () => {
						const st = await t.state();
						return st?.staged.id === resumable && st.staged.kind === "live" && st.focus === "stage";
					},
					{ what: `${name} resumed`, quietMs: QUIET[harness], timeoutMs: 60_000 },
				);
				stop(s, resumable);
				await focusRoster(t);
				return { t0, metrics: { settled: last - t0, live: doneAt - t0 } };
			},
		},
		{
			name: `start.${harness}.bare`,
			feels: `${name} started outside swb with a first prompt, through the login shell: until its reply is on screen.`,
			primary: "reply",
			runs: 4,
			sample: async ({ s }, ctx, i) => {
				const marker = `bare-${i}-${crypto.randomUUID().slice(0, 4)}`;
				const server = `perf-bare-${s.instance}`;
				const name = `b${i}`;
				const t0 = now();
				s.tmux(
					server,
					"new-session",
					"-d",
					"-s",
					name,
					"-x",
					"140",
					"-y",
					"40",
					"-c",
					s.project,
					ctx.shell,
					"-lic",
					bareCommand(harness, `reply ${marker}`, ctx),
				);
				const replied = await when(() => onScreen(s, server, `=${name}:`, marker) >= 2, `bare ${name}'s reply`);
				s.tmux(server, "kill-session", "-t", `=${name}`);
				return { t0, metrics: { reply: replied - t0 } };
			},
		},
		{
			name: `start.${harness}.swb`,
			feels: `${name} started by \`swb launch\` with the same prompt, as session_launch does: until the tool returns, and until the reply is on screen.`,
			primary: "reply",
			runs: 4,
			sample: async ({ s }, _ctx, i) => {
				const marker = `swb-${i}-${crypto.randomUUID().slice(0, 4)}`;
				const { t0, ms, out } = await exits(s, ["launch", "--harness", harness, "--cwd", s.project], `reply ${marker}`);
				const { id, host: name } = (JSON.parse(out) as { details: { id: string; host: string } }).details;
				const replied = await when(() => onScreen(s, s.servers.sessions, `=${name}:`, marker) >= 2, "the launched session's reply");
				await when(() => entry(s, id)?.activity === "idle", "its turn settled");
				stop(s, id);
				s.swb("archive", id);
				return { t0, metrics: { reply: replied - t0, returned: ms } };
			},
		},
	];
}

function sessions(harness: Harness) {
	return suite<Ctx>({
		name: `sessions-${harness}`,
		...(harness === "pi" ? {} : { harnesses: [harness] }),
		setup: async ({ s }) => {
			const resumable = await dormant(s, harness, "reply hello");
			const t = new Terminal(s);
			await t.open();
			return { t, resumable, bareAgentDir: bareAgentDir(s), shell: loginShell() };
		},
		probes: probes(harness),
	});
}

export const sessionsPi = sessions("pi");
export const sessionsClaude = sessions("claude");
export const sessionsCodex = sessions("codex");
