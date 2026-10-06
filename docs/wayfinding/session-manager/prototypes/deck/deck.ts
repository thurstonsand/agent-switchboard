// PROTOTYPE, never ships. `bun run deck`: brings up the mock sessions server and the mock UI server, builds one
// Deck (roster pane + Stage pane), and attaches this terminal to it. See README.md.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	DIR,
	ensureScratchDirs,
	HELP,
	hex4,
	makeSeed,
	paths,
	placeholderSession,
	readJson,
	type SeedSession,
	SESSIONS_SERVER,
	STATE,
	sessionsOverlay,
	UI_SERVER,
	uiConf,
	writeJsonAtomic,
} from "./shared.ts";

const deck = process.env.SWB_DECK_ID ?? hex4();
const hover = process.env.SWB_HOVER === "eager" ? "eager" : "lazy";
const prefix = process.env.SWB_PREFIX ?? "M-a";
const fakepiTui = process.env.FAKEPI_TUI === "regular" ? "regular" : "fullscreen";

const env = { ...process.env };
delete env.TMUX;
delete env.TMUX_PANE;

function tmux(server: string, ...args: string[]): string {
	const r = Bun.spawnSync(["tmux", "-L", server, ...args], { env });
	if (r.exitCode !== 0) throw new Error(`tmux -L ${server} ${args.join(" ")}: ${r.stderr.toString().trim()}`);
	return r.stdout.toString().trim();
}

function serverUp(server: string): boolean {
	return Bun.spawnSync(["tmux", "-L", server, "list-sessions"], { env, stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

function hasSession(server: string, name: string): boolean {
	return Bun.spawnSync(["tmux", "-L", server, "has-session", "-t", `=${name}`], { env, stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

// ── state dir ───────────────────────────────────────────────────────────

for (const dir of [STATE, paths.rt, paths.transcripts]) mkdirSync(dir, { recursive: true });
if (!existsSync(paths.seed)) writeJsonAtomic(paths.seed, makeSeed(Date.now()));
const seed = readJson<SeedSession[]>(paths.seed);
ensureScratchDirs(seed);
writeFileSync(paths.help, HELP);
writeFileSync(paths.overlay, sessionsOverlay());
writeFileSync(paths.uiConf, uiConf(prefix));

// ── sessions server ─────────────────────────────────────────────────────

const placeholder = placeholderSession(deck);
const placeholderCmd = `env -u TMUX -u TMUX_PANE SWB_MOCK_STATE=${STATE} bun ${DIR}/placeholder.ts ${deck}`;
writeJsonAtomic(paths.deckStage(deck), { tone: "empty", headline: "", title: "", path: "", lines: ["Deck starting…"], excerpts: null, keys: "", since: Date.now() });
writeFileSync(paths.deckTarget(deck), placeholder);

if (!serverUp(SESSIONS_SERVER)) {
	tmux(SESSIONS_SERVER, "-f", join(homedir(), ".config/tmux/tmux.conf"), "new-session", "-d", "-s", placeholder, "-x", "120", "-y", "40", placeholderCmd);
	tmux(SESSIONS_SERVER, "source-file", paths.overlay);
	// Seeded sessions that were "already running" before this Deck existed.
	for (const s of seed.filter((x) => x.prestart !== null && x.archivedAt === null)) {
		const name = `${s.project}-${hex4()}`;
		tmux(
			SESSIONS_SERVER,
			"new-session", "-d", "-s", name, "-c", s.cwd, "-x", "100", "-y", "40",
			"-e", `SWB_TMUX_NAME=${name}`, "-e", `FAKEPI_PRESTART=${s.prestart}`,
			`env -u TMUX -u TMUX_PANE SWB_MOCK_STATE=${STATE} FAKEPI_TUI=${fakepiTui} bun ${DIR}/fakepi.ts ${s.id}`,
		);
		tmux(SESSIONS_SERVER, "set-option", "-t", `=${name}:`, "@swb_id", s.id);
	}
} else if (!hasSession(SESSIONS_SERVER, placeholder)) {
	tmux(SESSIONS_SERVER, "new-session", "-d", "-s", placeholder, "-x", "120", "-y", "40", placeholderCmd);
}

// ── UI server and the Deck ──────────────────────────────────────────────

const deckSession = `deck-${deck}`;
if (serverUp(UI_SERVER)) {
	tmux(UI_SERVER, "source-file", paths.uiConf);
	if (hasSession(UI_SERVER, deckSession)) tmux(UI_SERVER, "kill-session", "-t", `=${deckSession}`);
}
const cols = process.stdout.columns ?? 140;
const rows = process.stdout.rows ?? 40;
const stagePane = tmux(
	UI_SERVER,
	"-f", paths.uiConf,
	"new-session", "-d", "-s", deckSession, "-x", String(cols), "-y", String(rows), "-P", "-F", "#{pane_id}",
	`sh ${DIR}/stage.sh ${deck} ${STATE}`,
);
const rosterWidth = Math.max(32, Math.min(44, Math.round(cols * 0.3)));
const rosterPane = tmux(
	UI_SERVER,
	"split-window", "-h", "-b", "-l", String(rosterWidth), "-t", stagePane, "-P", "-F", "#{pane_id}",
	"-e", `SWB_DECK_ID=${deck}`, "-e", `SWB_STAGE_PANE=${stagePane}`, "-e", `SWB_HOVER=${hover}`, "-e", `SWB_MOCK_STATE=${STATE}`, "-e", `FAKEPI_TUI=${fakepiTui}`,
	`bun ${DIR}/roster.ts`,
);
tmux(UI_SERVER, "select-pane", "-t", rosterPane);

const attach = Bun.spawn(["tmux", "-L", UI_SERVER, "attach", "-t", `=${deckSession}`], { env, stdio: ["inherit", "inherit", "inherit"] });
process.exit(await attach.exited);
