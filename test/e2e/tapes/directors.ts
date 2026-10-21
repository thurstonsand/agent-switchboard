import { expect } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeckState } from "../../../packages/cli/src/deck/protocol.ts";
import { config, launched, launchTry, seed } from "../harness/deck.ts";
import { git, gitRepo, gitWorktree, type LsEntry, type PiPackage, release, type Scenario, until, which } from "../harness/index.ts";

export type Director = {
	packages?: PiPackage[];
	/** Claude Code and Codex, each with its fake model server. */
	harnesses?: ("claude" | "codex")[];
	/** Runs before the tape starts. */
	setup?: (s: Scenario) => Promise<void>;
	/** Runs alongside the tape, playing everything that isn't the human at the keyboard. */
	run?: (s: Scenario) => Promise<void>;
};

const NVIM = which("nvim");
const TAPE = 40_000;

/** The one Deck the tape's terminal opened. */
function deck(s: Scenario, name?: string): DeckState {
	return JSON.parse(s.swb("deck", "state", ...(name ? ["--deck", name] : []), "--json"));
}

async function waitDeck(s: Scenario, what: string, probe: (st: DeckState) => boolean, name?: string): Promise<DeckState> {
	return until(
		() => {
			try {
				const st = deck(s, name);
				return probe(st) && st;
			} catch {
				return false;
			}
		},
		TAPE,
		what,
	);
}

async function waitLs(s: Scenario, what: string, probe: (ls: LsEntry[]) => boolean): Promise<LsEntry[]> {
	return until(
		() => {
			const ls = s.ls();
			return probe(ls) && ls;
		},
		TAPE,
		what,
	);
}

/** The Deck the drive harness's terminal is attached to, which the tape watches. */
function drive(s: Scenario): DeckState {
	return JSON.parse(s.swb("drive", "state"));
}

async function waitDrive(s: Scenario, what: string, probe: (st: DeckState) => boolean): Promise<DeckState> {
	return until(
		() => {
			try {
				const st = drive(s);
				return probe(st) && st;
			} catch {
				return false;
			}
		},
		TAPE,
		what,
	);
}

/** A cell inside the first `text` between columns `from` and `cols`, for `swb drive`. */
async function onScreen(s: Scenario, text: string, cols: number, from = 0): Promise<[number, number]> {
	return until(
		() => {
			const lines = s.swb("drive", "capture").split("\n");
			const at = lines.findIndex((line) => line.slice(from, cols).includes(text));
			return at !== -1 && ([(lines[at] as string).indexOf(text, from) + 1, at] as [number, number]);
		},
		TAPE,
		`${text} on screen`,
	);
}

const entered = (s: Scenario, name: string) => until(() => s.signal(`${name}.entered`) !== "", TAPE, `${name} held`);

function files(s: Scenario): void {
	mkdirSync(join(s.project, "src"));
	writeFileSync(join(s.project, "README.md"), "# project\n\nA small project for the switchboard to look after.\n");
	writeFileSync(join(s.project, "src/main.ts"), 'console.log("hello");\n');
}

/** Starts a session the way session_launch does, titled, and waits for its first turn to settle; returns its id. */
async function launch(s: Scenario, harness: "pi" | "claude" | "codex", title: string): Promise<string> {
	const proc = Bun.spawn([`${s.bin}/swb`, "launch", "--harness", harness, "--cwd", s.project, "--title", title], {
		env: s.env,
		cwd: s.project,
		stdin: new Blob([`reply ${title}`]),
		stdout: "pipe",
		stderr: "inherit",
	});
	const id = (JSON.parse(await proc.stdout.text()) as { details: { id: string } }).details.id;
	await waitLs(s, `${title} idle`, (ls) => ls.find((e) => e.id === id)?.activity === "idle");
	return id;
}

function hostOf(s: Scenario, id: string): string {
	return s.query<{ tmux_session: string }>("select tmux_session from runtimes where session_id = ?", id)[0]?.tmux_session as string;
}

/** Types into a session's own TUI, as the agent's user would, while the tape's human is elsewhere. */
function typeInto(s: Scenario, id: string, text: string): void {
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${hostOf(s, id)}:`, "-l", text);
	Bun.sleepSync(300);
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${hostOf(s, id)}:`, "Enter");
}

export const directors: Record<string, Director> = {
	settings: {
		harnesses: ["claude", "codex"],
		setup: async (s) => {
			files(s);
			config(s, '# mine: Settings keeps this comment\ninactive_after = "96h" # long weekends\n');
			await seed(s, { turns: ["plan the v3 migration"], title: "Plan the v3 migration" });
		},
		run: async (s) => {
			const file = join(s.env.XDG_CONFIG_HOME as string, "agent-switchboard", "config.toml");
			await waitDeck(s, "Settings", (x) => x.mode === "settings");
			await waitDeck(s, "the shortlist written", (x) => x.settings?.items.some((i) => i.kind === "preset" && i.set) ?? false);
			await waitDeck(s, "the add search", (x) => x.settings != null && x.settings.adding !== null);
			await waitDeck(s, "the picker", (x) => x.picker !== null);
			await waitDeck(s, "the picker closed", (x) => x.picker === null && x.mode === "roster");
			const good = readFileSync(file, "utf8");
			expect(good).toContain('inactive_after = "3d" # long weekends');
			expect(good).toContain("[[presets]]");
			// A hand edit gone wrong while the Deck is open.
			writeFileSync(file, good.replace("[[presets]]", '[[presets]]\nmodle = "opus"'));
			await waitDeck(s, "the error shown", (x) => x.configError !== null);
			await waitDeck(s, "Settings on the error", (x) => x.mode === "settings");
			await waitDeck(s, "back to the roster", (x) => x.mode === "roster");
			writeFileSync(file, good);
			await waitDeck(s, "the error cleared", (x) => x.configError === null);
		},
	},

	"operator-instructions": {
		setup: async (s) => {
			files(s);
			await seed(s, { turns: ["plan the v3 migration"], title: "Plan the v3 migration" });
		},
		run: async (s) => {
			const agents = join(s.env.XDG_CONFIG_HOME as string, "agent-switchboard", "operator", "AGENTS.md");
			const st = await waitDeck(s, "the editor", (x) => x.settings?.prose?.focused === true);
			const shipped = readFileSync(agents, "utf8");
			// Saved with no key pressed for it.
			await until(() => readFileSync(agents, "utf8").endsWith("lead with the one that's waited longest.\n"), TAPE, "AGENTS.md rewritten");
			expect(readFileSync(agents, "utf8").startsWith(`${shipped}\n## My preferences\n\nPrefer Codex`)).toBe(true);
			// After the tape's look at what it typed.
			await Bun.sleep(3000);
			// A long style guide pasted in, as the tape can't: the shipped instructions, over and over, past the cap.
			const paste = join(s.root, "paste.md");
			writeFileSync(paste, `\n\n${shipped.repeat(Math.ceil(16_000 / shipped.length))}`);
			const roster = s.tmux(s.servers.ui, "display", "-p", "-t", `=${st.deck}:.0`, "#{pane_id}");
			s.tmux(s.servers.ui, "load-buffer", "-b", "guide", paste);
			s.tmux(s.servers.ui, "paste-buffer", "-p", "-b", "guide", "-t", roster);
			await waitDeck(s, "the paste cut at the cap", (x) => x.settings?.prose?.text.length === 16_000);
			await waitDeck(s, "back to the roster", (x) => x.mode === "roster");
			// What the tape typed at the cap never went in.
			expect(readFileSync(agents, "utf8")).not.toContain("and one more thing");
			expect(readFileSync(agents, "utf8").length).toBeGreaterThan(shipped.length + 15_000);
		},
	},

	"harness-picker": {
		harnesses: ["claude", "codex"],
		setup: async (s) => {
			files(s);
			await seed(s, { turns: ["plan the v3 migration"], title: "Plan the v3 migration" });
		},
		run: async (s) => {
			const ls = await waitLs(s, "a Claude Code and a Codex session", (ls) =>
				["claude", "codex"].every((h) => ls.some((e) => e.harness === h && e.activity === "idle")),
			);
			expect(ls.map((e) => e.harness).sort()).toEqual(["claude", "codex", "pi"]);
			await Bun.sleep(4000);
		},
	},

	"cross-harness": {
		harnesses: ["claude", "codex"],
		setup: async (s) => {
			files(s);
			// One after another, so the roster lists them newest first: Docs writer, API worker, Planner.
			await launch(s, "pi", "Planner");
			await launch(s, "claude", "API worker");
			await launch(s, "codex", "Docs writer");
		},
		run: async (s) => {
			const ids = Object.fromEntries(s.ls().map((e) => [e.harness, e.id])) as Record<string, string>;
			await until(
				() => s.query("select 1 from messages where target_id = ? and delivered_at is not null", ids.codex as string).length > 0,
				TAPE,
				"Claude's message delivered to Codex",
			);
			await until(
				() => s.query("select 1 from messages where target_id = ? and delivered_at is not null", ids.pi as string).length > 0,
				TAPE,
				"Codex's message delivered to pi",
			);
			// pi is held mid-turn when Claude's agent messages it.
			await entered(s, "review");
			await Bun.sleep(1500);
			typeInto(s, ids.claude as string, "tell pi Stop: review against v3");
			await until(
				() =>
					s.query("select 1 from messages where target_id = ? and body like 'Stop:%' and delivered_at is not null", ids.pi as string)
						.length > 0,
				TAPE,
				"the steer delivered into pi's running turn",
			);
			await Bun.sleep(2500);
			release(s, "review");
			const sent = s.query<{ source_id: string; target_id: string }>("select source_id, target_id from messages order by created_at");
			expect(sent).toEqual([
				{ source_id: ids.claude as string, target_id: ids.codex as string },
				{ source_id: ids.codex as string, target_id: ids.pi as string },
				{ source_id: ids.claude as string, target_id: ids.pi as string },
			]);
		},
	},

	"operator-harness": {
		harnesses: ["claude", "codex"],
		setup: async (s) => {
			files(s);
			await launch(s, "codex", "Docs writer");
			// Claude Code asks once to trust a folder, the Operator's included.
			s.trust(join(s.env.XDG_CONFIG_HOME as string, "agent-switchboard", "operator"));
		},
		run: async (s) => {
			const operator = await waitLs(s, "a Claude Code Operator", (ls) => ls.some((e) => e.operator && e.harness === "claude")).then(
				(ls) => ls.find((e) => e.operator) as LsEntry,
			);
			const codex = s.ls().find((e) => e.harness === "codex")?.id as string;
			await until(
				() =>
					s.query("select 1 from messages where source_id = ? and target_id = ? and delivered_at is not null", operator.id, codex).length >
					0,
				TAPE,
				"the Operator's message delivered to Codex",
			);
		},
	},

	"show-session": {
		setup: async (s) => {
			const infra = join(s.root, "infra");
			const operator = join(s.env.XDG_CONFIG_HOME as string, "agent-switchboard/operator");
			mkdirSync(infra);
			mkdirSync(operator, { recursive: true });
			await launched(s, "reply drafted", { cwd: s.project, title: "Draft the v3 changelog" });
			await launched(s, "reply bisected", { cwd: s.project, title: "Bisect the flaky login test" });
			await launched(s, "reply measured", { cwd: s.project, title: "Profile roster render" });
			const certs = await launched(s, "reply certs rotated", { cwd: infra, title: "Rotate the staging certs" });
			await launched(s, "reply pinned", { cwd: infra, title: "Pin the base image" });
			await launched(s, "reply on it", { cwd: operator, title: "Morning triage" });
			const host = s.query<{ tmux_session: string }>("select tmux_session from runtimes where session_id = ?", certs)[0]?.tmux_session;
			s.tmux(s.servers.sessions, "kill-session", "-t", `=${host}`);
			await waitLs(s, "the certs session dormant", (ls) => ls.find((e) => e.id === certs)?.live === false);
		},
		run: async (s) => {
			const target = s.ls().find((e) => e.title === "Rotate the staging certs")?.id as string;
			const shown = await waitDeck(s, "the certs session live", (x) => x.cursor === target && x.staged.kind === "live");
			expect(shown).toMatchObject({ focus: "stage", staged: { id: target } });
			await Bun.sleep(3000);
		},
	},

	"operator-tidy": {
		setup: async (s) => {
			const infra = join(s.root, "infra");
			const operator = join(s.env.XDG_CONFIG_HOME as string, "agent-switchboard/operator");
			mkdirSync(infra);
			mkdirSync(operator, { recursive: true });
			await launched(s, "reply measured", { cwd: s.project, title: "Profile roster render" });
			await launched(s, "reply pinned", { cwd: s.project, title: "Pin the base image" });
			const certs = await launched(s, "reply certs rotated", { cwd: infra, title: "Rotate the staging certs" });
			await launchTry(s, "reply child renew", { from: certs, title: "Renew the wildcard cert" });
			await entered(s, "child.renew");
			await launched(s, "reply on it", { cwd: operator, title: "Morning triage" });
		},
		run: async (s) => {
			await waitLs(s, "Pin the base image in hygiene", (ls) => ls.some((e) => e.title === "Pin the base image" && e.group === "hygiene"));
			await waitLs(s, "the render session retitled", (ls) => ls.some((e) => e.title === "Roster render at 60 fps"));
			const family = (ls: LsEntry[]) => ls.filter((e) => e.title === "Rotate the staging certs" || e.title === "Renew the wildcard cert");
			const operator = s.ls().find((e) => e.title === "Morning triage")?.id as string;
			const host = s.query<{ tmux_session: string }>("select tmux_session from runtimes where session_id = ?", operator)[0]?.tmux_session;
			await until(
				() => s.tmux(s.servers.sessions, "capture-pane", "-p", "-J", "-t", `=${host}:`).includes("Nothing changed"),
				TAPE,
				"the refusal in the Operator",
			);
			expect(family(s.ls()).every((e) => e.open)).toBe(true);
			await waitLs(s, "the certs family archived", (ls) => family(ls).every((e) => !e.open && !e.live));
		},
	},

	"launch-wake-archive": {
		harnesses: ["claude", "codex"],
		setup: async (s) => {
			files(s);
			await launch(s, "claude", "API worker");
		},
		run: async (s) => {
			const claude = s.ls()[0]?.id as string;
			const child = await waitLs(s, "the launched Codex session idle", (ls) =>
				ls.some((e) => e.parentId === claude && e.harness === "codex" && e.activity === "idle"),
			).then((ls) => ls.find((e) => e.parentId === claude) as LsEntry);
			await Bun.sleep(1500);
			s.tmux(s.servers.sessions, "kill-session", "-t", `=${hostOf(s, child.id)}`);
			await waitLs(s, "the Codex session dormant", (ls) => ls.find((e) => e.id === child.id)?.live === false);
			await waitLs(s, "the Codex session woken", (ls) => ls.find((e) => e.id === child.id)?.live === true);
			await waitLs(s, "the Codex session archived", (ls) => ls.find((e) => e.id === child.id)?.open === false);
		},
	},

	"first-turn": {
		run: async (s) => {
			await entered(s, "first");
			const [working] = await waitLs(s, "the first turn working", (ls) => ls[0]?.activity === "working");
			await Bun.sleep(3000);
			release(s, "first");
			await waitLs(s, "idle and titled", (ls) => ls[0]?.activity === "idle" && ls[0].title === "Wire up the switchboard");
			expect(s.ls()).toMatchObject([{ id: working?.id, open: true, live: true, unseen: false }]);
		},
	},

	links: {
		run: async (s) => {
			await until(() => s.signal("replied.see [the docs](mailto:ops@example.com) for the deploy steps") !== "", TAPE, "the reply");
			const pi = s
				.tmux(s.servers.sessions, "list-panes", "-a", "-F", "#{@swb_kind} #{pane_id}")
				.split("\n")
				.find((line) => line.startsWith("pi "))
				?.split(" ")[1] as string;
			await until(
				() => s.tmux(s.servers.sessions, "capture-pane", "-p", "-e", "-t", pi).includes("\x1b]8;;mailto:ops@example.com\x1b\\the docs"),
				TAPE,
				"the link as an OSC 8 hyperlink",
			);
		},
	},

	"tool-turn": {
		run: async (s) => {
			await waitLs(s, "the tool turn done", (ls) => ls[0]?.activity === "idle");
		},
	},

	"blocked-release": {
		run: async (s) => {
			await entered(s, "deploy-approval");
			await waitLs(s, "blocked", (ls) => ls[0]?.activity === "blocked");
			await waitDeck(s, "the row blocked", (x) => x.rows.some((r) => r.kind === "session" && r.state === "blocked"));
			await Bun.sleep(4000);
			release(s, "deploy-approval");
			await waitLs(s, "idle after the approval", (ls) => ls[0]?.activity === "idle");
		},
	},

	"pi-dialog": {
		run: async (s) => {
			await entered(s, "deploy");
			await waitLs(s, "blocked", (ls) => ls[0]?.activity === "blocked");
			await waitDeck(s, "the row blocked", (x) => x.rows.some((r) => r.kind === "session" && r.state === "blocked"));
			await waitLs(s, "idle once answered", (ls) => ls[0]?.activity === "idle");
		},
	},

	"wake-enter-esc": {
		setup: async (s) => {
			await seed(
				s,
				{ title: "Refactor the parser", turns: ["parser refactored"] },
				{ title: "Draft release notes", turns: ["notes drafted"] },
				{ title: "Triage the bug queue", turns: ["queue triaged"] },
			);
		},
		run: async (s) => {
			await waitDeck(s, "w woke one in place", (x) => x.staged.kind === "live" && x.focus === "roster");
			await waitDeck(s, "Enter woke one with the keyboard", (x) => x.staged.kind === "loading" && x.focus === "stage");
			const ls = await waitLs(s, "all three live", (x) => x.every((e) => e.live));
			const last = ls.find((e) => e.title === "Refactor the parser")?.id;
			await waitDeck(
				s,
				"esc left the keyboard in the roster",
				(x) => x.staged.id === last && x.staged.kind === "live" && x.focus === "roster",
			);
		},
	},

	"stage-key-wake": {
		setup: async (s) => {
			await seed(
				s,
				{ title: "Draft release notes", turns: ["notes drafted"] },
				{ title: "Refactor the parser", turns: ["parser refactored"] },
			);
		},
		run: async (s) => {
			const ls = await waitLs(s, "both seeded", (x) => x.length === 2);
			const notes = ls.find((e) => e.title === "Draft release notes")?.id;
			await waitDeck(s, "the first one live with the keyboard", (x) => x.staged.kind === "live" && x.focus === "stage");
			const asleep = await waitDeck(s, "M-a J onto the sleeping one", (x) => x.staged.id === notes);
			expect(asleep.staged.kind).toBe("dormant");
			expect(asleep.focus).toBe("stage");
			await waitDeck(s, "a key woke it", (x) => x.staged.id === notes && x.staged.kind === "live" && x.focus === "stage");
		},
	},

	"dormant-card": {
		setup: async (s) => {
			await seed(
				s,
				{ title: "Investigate the slow query", turns: ["the index on created_at is missing", "added it; p95 is down to 40 ms"] },
				{ title: "Rename the config keys", turns: ["renamed, with a migration"] },
			);
		},
		run: async (s) => {
			await waitDeck(s, "a dormant card on view", (x) => x.staged.kind === "dormant");
			expect(s.ls().every((e) => !e.live)).toBe(true);
		},
	},

	"stage-switching": {
		setup: async (s) => {
			await seed(
				s,
				{ title: "Port the CLI to Bun", turns: ["ported"] },
				{ title: "Fix the flaky test", turns: ["fixed the race"] },
				{ title: "Write the README", turns: ["written"] },
			);
		},
		run: async (s) => {
			await waitLs(s, "all three live", (ls) => ls.every((e) => e.live));
			const st = await waitDeck(s, "a dozen switches", (x) => x.perf.keyToSwitch.n >= 8);
			expect(st.perf.keyToSwitch.maxMs).toBeLessThanOrEqual(150);
		},
	},

	"editor-split": {
		setup: async (s) => {
			files(s);
			config(s, `editor = "${NVIM} --clean ."\n`);
		},
		run: async (s) => {
			await waitDeck(s, "the editor view", (x) => x.staged.view === "editor" && x.focus === "editor");
			await waitDeck(s, "back to pi", (x) => x.staged.view === "agent");
			await waitDeck(s, "split", (x) => x.layout.split && x.staged.view === "split");
			await waitDeck(s, "the shell", (x) => x.layout.shell && x.focus === "shell");
			await waitDeck(s, "ctrl-d closed it", (x) => !x.layout.shell && x.layout.split);
		},
	},

	"pane-labels": {
		setup: async (s) => {
			files(s);
			config(s, `editor = "${NVIM} --clean ."\n`);
			await seed(
				s,
				{ title: "Draft release notes", turns: ["notes drafted"] },
				{ title: "Refactor the parser", turns: ["parser refactored"] },
			);
		},
		run: async (s) => {
			const live = await waitDeck(s, "pi live with the keyboard", (x) => x.staged.kind === "live" && x.focus === "stage");
			const [first, next] = live.rows.flatMap((r) => (r.kind === "session" ? [r.id] : [])) as [string, string];
			expect(live.staged.id).toBe(first);
			await waitDeck(s, "split, the shell under pi", (x) => x.layout.split && x.layout.shell && x.focus === "shell");
			await waitDeck(s, "M-a k up to pi", (x) => x.focus === "stage");
			await waitDeck(s, "M-a h to the editor", (x) => x.focus === "editor");
			await waitDeck(s, "M-a h to the sidebar", (x) => x.focus === "roster");
			await waitDeck(s, "M-a j in the sidebar stages the next session", (x) => x.staged.id === next && x.focus === "roster");
		},
	},

	archive: {
		run: async (s) => {
			await entered(s, "busy");
			await waitDeck(s, "the refusal", (x) => x.toasts.some((t) => t.text.includes("turn running")));
			expect(s.ls()[0]?.open).toBe(true);
			await Bun.sleep(1500);
			release(s, "busy");
			await waitLs(s, "archived", (ls) => ls[0]?.open === false && !ls[0].live);
			await waitLs(s, "unarchived", (ls) => ls[0]?.open === true);
		},
	},

	"theme-flip": {
		run: async (s) => {
			await waitDeck(s, "the pi live", (x) => x.staged.kind === "live" && x.colors.background === "#f9f5d7");
			await until(() => s.signal("replied.light or dark, the switchboard follows") !== "", TAPE, "the reply");
			await Bun.sleep(2500);
			s.swb("drive", "theme", "dark");
			await waitDeck(s, "dark", (x) => x.colors.background === "#1d2021");
			await Bun.sleep(3500);
			s.swb("drive", "theme", "light");
			await waitDeck(s, "light again", (x) => x.colors.background === "#f9f5d7");
		},
	},

	"working-breathe": {
		setup: async (s) => {
			files(s);
			await launch(s, "pi", "Planner");
			await launch(s, "pi", "Rewrite the parser");
		},
		run: async (s) => {
			await waitDrive(s, "the Deck ready", (x) => x.ready);
			const parser = s.ls().find((e) => e.title === "Rewrite the parser")?.id as string;
			typeInto(s, parser, "hold breath");
			await entered(s, "breath");
			const working = (x: DeckState) => x.rows.some((r) => r.kind === "session" && r.state === "working");
			await waitDeck(s, "working on dark", (x) => working(x) && x.colors.background === "#1d2021");
			await Bun.sleep(4500);
			s.swb("drive", "theme", "light");
			await waitDeck(s, "working on light", (x) => working(x) && x.colors.background === "#f9f5d7");
			await Bun.sleep(4500);
			s.swb("drive", "theme", "dark");
			await waitDeck(s, "working on dark again", (x) => working(x) && x.colors.background === "#1d2021");
			await Bun.sleep(3000);
			release(s, "breath");
			await waitLs(s, "both idle", (ls) => ls.length === 2 && ls.every((e) => e.activity === "idle"));
		},
	},

	"unarchive-new-turn": {
		setup: async (s) => {
			const [id] = (await seed(s, { title: "Ship the hotfix", turns: ["hotfix shipped"] })) as [string];
			s.swb("archive", id);
		},
		run: async (s) => {
			await waitLs(s, "live but still archived", (ls) => ls[0]?.live === true && ls[0].open === false);
			await waitLs(s, "open again after the new turn", (ls) => ls[0]?.open === true);
		},
	},

	"unseen-visit": {
		run: async (s) => {
			await entered(s, "background-job");
			const [busy] = await waitLs(s, "the job working", (ls) => ls.length === 1 && ls[0]?.activity === "working");
			await waitLs(s, "a second session in front", (ls) => ls.length === 2);
			await until(() => s.signal("replied.meanwhile, in front") !== "", TAPE, "the front session's reply");
			await Bun.sleep(1500);
			release(s, "background-job");
			await waitLs(s, "the job unseen", (ls) => ls.find((e) => e.id === busy?.id)?.unseen === true);
			await waitDeck(s, "the cursor on the job", (x) => x.staged.id === busy?.id && x.staged.kind === "live" && x.focus === "roster");
			await Bun.sleep(2000);
			if (!s.ls().find((e) => e.id === busy?.id)?.unseen) throw new Error("passing over the job cleared Unseen");
			await waitLs(s, "visited", (ls) => ls.find((e) => e.id === busy?.id)?.unseen === false);
		},
	},

	inactive: {
		setup: async (s) => {
			await seed(s, { title: "Spike: try SQLite FTS", turns: ["works, but not worth it yet"] });
			config(s, 'inactive_after = "8s"\n');
		},
		run: async (s) => {
			const spike = (ls: LsEntry[]) => ls.find((e) => e.title?.startsWith("Spike"));
			await waitLs(
				s,
				"the new session folded, the unseen spike not",
				(ls) => ls.some((e) => e.inactive && !e.title) && spike(ls)?.unseen === true && !spike(ls)?.inactive,
			);
			await waitDeck(s, "the Inactive section", (x) => x.rows.some((r) => r.kind === "section" && r.label === "Inactive"));
			await waitLs(s, "the spike visited", (ls) => spike(ls)?.unseen === false);
			await waitLs(s, "the spike folded too", (ls) => spike(ls)?.inactive === true);
		},
	},

	snooze: {
		setup: async (s) => {
			const [ci, spike] = await seed(
				s,
				{ title: "Wait on CI for #142", turns: ["CI is still running the e2e matrix"] },
				{ title: "Spike: FTS5 ranking", turns: ["asked the codex session for its API shape"] },
				{ title: "Bump pi to 0.71", turns: ["bumped; tests are green"] },
			);
			const schedule = (from: string, body: string, ...args: string[]) => {
				const result = Bun.spawnSync([`${s.bin}/swb`, "schedule", "--from", from, ...args], {
					env: s.env,
					cwd: s.project,
					stdin: new Blob([body]),
					stderr: "pipe",
				});
				if (result.exitCode !== 0) throw new Error(`swb schedule: ${result.stderr.toString()}`);
			};
			schedule(ci as string, "Check CI on #142; if green, merge it.", "--at", "PT2H", "--label", "Check CI on #142", "--snooze");
			schedule(ci as string, "Post a one-line status to triage.", "--cron", "57 8 * * 1-5", "--label", "Weekdays, 8:57 AM");
			s.swb("snooze", spike as string, "next_message");
		},
		run: async (s) => {
			const bump = (ls: LsEntry[]) => ls.find((e) => e.title === "Bump pi to 0.71") as LsEntry & { snoozed: boolean };
			await waitDrive(s, "the Snoozed section, folded", (x) =>
				x.rows.some((r) => r.kind === "section" && r.label === "Snoozed" && r.count === 2 && !r.expanded),
			);
			await waitLs(s, "Bump snoozed from the roster", (ls) => bump(ls)?.snoozed === true);
			await waitDrive(
				s,
				"Snoozed open, with the CI session's Peek",
				(x) => x.peek?.lines.some((l) => l.includes("Weekdays, 8:57 AM")) ?? false,
			);
		},
	},

	"simulated-process-loss": {
		run: async (s) => {
			await entered(s, "long-build");
			await waitLs(s, "one idle, one working", (ls) => ls.length === 2 && ls.some((e) => e.activity === "working"));
			await Bun.sleep(2500);
			s.tmux(s.servers.sessions, "kill-server");
			const ls = await waitLs(s, "both dormant", (x) => x.every((e) => !e.live));
			expect(ls.map((e) => [e.title, e.cutOff !== null]).sort()).toEqual([
				["Simulated: idle when killed", false],
				["Simulated: mid-turn when killed", true],
			]);
		},
	},

	"turn-endings": {
		harnesses: ["claude", "codex"],
		setup: async (s) => {
			files(s);
			const held = (name: string) =>
				`${name}:\n\t@echo entered > $$HOME/e2e-signals/${name}.entered; until [ -e $$HOME/e2e-signals/${name}.release ]; do sleep 0.1; done\n`;
			writeFileSync(join(s.project, "Makefile"), `${held("test")}${held("lint")}`);
			const pi = await launch(s, "pi", "Fix the flaky login test");
			const claude = await launch(s, "claude", "Tidy the parser");
			const codex = await launch(s, "codex", "Bump the API client");
			typeInto(s, pi, "run make test");
			typeInto(s, claude, "run make lint");
			typeInto(s, codex, "fail the model is overloaded");
			await entered(s, "test");
			await entered(s, "lint");
			// Claude Code writes its transcript a few seconds behind.
			await Bun.sleep(5000);
			const [{ pid }] = s.query<{ pid: number }>("select pid from runtimes where session_id = ?", pi) as [{ pid: number }];
			process.kill(pid, "SIGKILL");
			s.tmux(s.servers.sessions, "send-keys", "-t", `=${hostOf(s, claude)}:`, "Escape");
			await waitLs(s, "pi killed, Claude Code stopped, Codex errored", (ls) =>
				ls.every((e) => (e.id === pi ? !e.live : e.activity === "idle")),
			);
			for (const id of [claude, codex]) s.tmux(s.servers.sessions, "kill-session", "-t", `=${hostOf(s, id)}`);
			await waitLs(s, "all three dormant", (ls) => ls.every((e) => !e.live));
			release(s, "test");
			release(s, "lint");
		},
		run: async (s) => {
			const ls = s.ls();
			expect(Object.fromEntries(ls.map((e) => [e.harness, e.cutOff]))).toEqual({ pi: "killed", claude: null, codex: null });
			expect(Object.fromEntries(ls.map((e) => [e.harness, e.errored]))).toEqual({ pi: false, claude: false, codex: true });
			const pi = ls.find((e) => e.harness === "pi")?.id;
			// Woken, the cut-off pi picks its turn back up and settles; nothing else wakes.
			await waitLs(s, "pi continued", (now) => now.some((e) => e.id === pi && e.live && e.activity === "idle" && e.cutOff === null));
			await Bun.sleep(2000);
			expect(
				s
					.ls()
					.filter((e) => e.live)
					.map((e) => e.harness),
			).toEqual(["pi"]);
		},
	},

	"subagent-exclusion": {
		packages: ["pi-sessions"],
		run: async (s) => {
			await entered(s, "child.scout");
			const parent = s.ls();
			expect(parent).toHaveLength(1);
			await waitDeck(s, "one row", (x) => x.rows.filter((r) => r.kind === "session").length === 1);
			await Bun.sleep(4000);
			release(s, "child.scout");
			await waitLs(s, "the parent idle", (ls) => ls[0]?.activity === "idle");
			expect(s.ls().map((e) => e.id)).toEqual(parent.map((e) => e.id));
		},
	},

	adopt: {
		run: async (s) => {
			const [adopted] = await waitLs(s, "adopted, dormant", (ls) => ls.length === 1 && !ls[0]?.live);
			expect(adopted).toMatchObject({ open: true, unseen: false });
			await until(() => s.signal("replied.back inside swb") !== "", TAPE, "the reply inside swb");
			expect(s.ls()).toMatchObject([{ id: adopted?.id, open: true, live: true }]);
		},
	},

	"swb-handoff": {
		packages: ["pi-sessions"],
		run: async (s) => {
			await entered(s, "child.scout");
			const child = await until(() => s.ls().find((e) => e.title === "child scout"), TAPE, "the child tracked");
			await Bun.sleep(3000);
			expect(s.ls().find((e) => e.id === child.id)).toMatchObject({ live: true, activity: "working" });
			release(s, "child.scout");
			await waitLs(s, "the child idle", (ls) => ls.find((e) => e.id === child.id)?.activity === "idle");
			await Bun.sleep(2000);
			const host = s.query<{ tmux_session: string }>("select tmux_session from runtimes where session_id = ?", child.id)[0]?.tmux_session;
			s.tmux(s.servers.sessions, "kill-session", "-t", `=${host}`);
			await waitLs(s, "the child dormant", (ls) => ls.find((e) => e.id === child.id)?.live === false);
			await until(() => s.signal("replied.w1") !== "", TAPE, "the woken child's reply");
			expect(s.ls().find((e) => e.id === child.id)).toMatchObject({ open: true, live: true });
		},
	},

	"agent-archive": {
		run: async (s) => {
			await waitLs(s, "a session", (ls) => ls[0]?.open === true);
			await waitLs(s, "archived by its own pi", (ls) => ls[0]?.open === false && !ls[0].live);
		},
	},

	"three-decks": {
		run: async (s) => {
			const pane = (i: number) => `=demo:0.${i}`;
			const keys = (i: number, ...k: string[]) => {
				for (let j = 0; j < k.length; j++) {
					if (k[j] === "-l") s.tmux("demo", "send-keys", "-t", pane(i), "-l", k[++j] as string);
					else s.tmux("demo", "send-keys", "-t", pane(i), k[j] as string);
				}
			};
			const screens = () => {
				try {
					return [0, 1, 2].map((i) => s.tmux("demo", "capture-pane", "-p", "-t", pane(i)));
				} catch {
					return [];
				}
			};
			const all = (what: string, text: string) =>
				until(
					() => {
						const shown = screens();
						return shown.length === 3 && shown.every((x) => x.includes(text));
					},
					TAPE,
					what,
				);
			await all("three Decks", "Archived (0)");
			await until(() => screens()[0]?.includes("faux-1"), TAPE, "pi in the first Deck");
			await Bun.sleep(800);
			keys(0, "-l", "reply one session, three Decks", "Enter");
			await all("the session in every roster", "(1)");
			await Bun.sleep(1200);
			keys(0, "-l", "/name Shared by three Decks", "Enter");
			await all("the title in every roster", "Shared by three Decks");
			await Bun.sleep(1500);
			keys(1, "Enter");
			await Bun.sleep(800);
			keys(1, "-l", "reply typed from the second Deck", "Enter");
			await until(() => s.signal("replied.typed from the second Deck") !== "", TAPE, "the second Deck's turn");
			await Bun.sleep(2000);
			keys(2, "a");
			await all("archived everywhere", "Archived (1)");
			expect(s.ls()[0]?.open).toBe(false);
		},
	},

	"dir-picker": {
		setup: async (s) => {
			const code = join(s.home, "code");
			const repo = (name: string) => gitRepo(s, join(code, name));
			const worktree = (main: string, branch: string) => gitWorktree(s, main, branch);
			const swbRepo = repo("agent-switchboard");
			const picker = worktree(swbRepo, "dir-picker");
			worktree(swbRepo, "reaper-fix");
			// Removed by hand, never pruned: git still lists it, the picker mustn't.
			rmSync(worktree(swbRepo, "old-spike"), { recursive: true });
			const ansible = repo("ansiblonomicon");
			worktree(ansible, "amp-model-config");
			const piSessions = repo("pi-sessions");
			for (const name of ["pi-doppelclaude", "ghosttykit", "go-unifi", "sagecoffee", "matic-home-assistant", "dotfiles"]) repo(name);
			repo("node_modules/left-pad");
			for (const dir of ["games", "matic-re/jadx", ".scratch/dc-0123", "../notes"]) mkdirSync(join(code, dir), { recursive: true });
			config(s, '[dirs]\nscan = ["~/code"]\ninclude = ["~/code/games"]\nexclude = ["dotfiles"]\n');
			for (const [cwd, title] of [
				[swbRepo, "Directory picker design"],
				[swbRepo, "Reaper flake"],
				[picker, "Prototype the picker"],
				[ansible, "pod042 runner unit"],
				[piSessions, "Handoff wake race"],
			] as const) {
				s.swb("drive", "start", "--", "new", "--cwd", cwd);
				const st = await until(
					() => {
						const x = JSON.parse(s.swb("drive", "state"));
						return x.staged.kind === "live" && x;
					},
					TAPE,
					"pi on the Stage",
				);
				s.swb("drive", "focus", "out");
				s.keys("-l", `reply ${title}`, "Enter");
				await until(() => s.signal(`replied.${title}`) !== "", TAPE, title);
				s.keys("-l", `/name ${title}`, "Enter");
				await waitLs(s, `${title} titled`, (ls) => ls.some((e) => e.title === title && e.activity === "idle"));
				s.tmux(s.servers.sessions, "kill-session", "-t", `=${st.staged.host}`);
				await waitLs(s, `${title} dormant`, (ls) => ls.some((e) => e.title === title && !e.live));
				s.swb("drive", "stop");
			}
		},
		run: async (s) => {
			const { deck } = await waitDeck(s, "the Deck up", () => true);
			const pane = `=${deck}:.0`;
			const lines = () => s.tmux(s.servers.ui, "capture-pane", "-p", "-t", pane).split("\n");
			// The last picker: opened after matic-re was added, so it's listed.
			const shown = await until(
				() => {
					const now = lines();
					return now[0]?.includes("new session in") && now.some((l) => /^\s*matic-re\s/.test(l)) && now;
				},
				TAPE,
				"the picker with matic-re listed",
			);
			// Long enough for the tape to capture it as opened, on matic-re.
			await Bun.sleep(3000);
			// The pointer moves, no button held, onto pi-sessions: SGR motion is button 35.
			const y = shown.findIndex((l) => /^\s*pi-sessions\b/.test(l)) + 1;
			for (const x of [30, 20, 10]) {
				const bytes = [...Buffer.from(`\x1b[<35;${x};${y}M`)].map((b) => b.toString(16).padStart(2, "0"));
				s.tmux(s.servers.ui, "send-keys", "-t", pane, "-H", ...bytes);
				await Bun.sleep(150);
			}
			await until(() => lines().some((l) => /pi-sessions\s+✕/.test(l)), TAPE, "the highlight under the pointer");
			await until(() => !lines()[0]?.includes("new session in"), TAPE, "the picker closed");
		},
	},

	groups: {
		setup: async (s) => {
			const worktree = join(s.root, "project-wt");
			git(s, s.project, "init", "-q", "-b", "main");
			git(s, s.project, "commit", "-q", "--allow-empty", "-m", "init");
			git(s, s.project, "worktree", "add", "-q", "-b", "wt", worktree);
			await seed(s, { turns: ["one"], title: "alpha" }, { turns: ["two"], title: "bravo" });
			s.swb("drive", "start", "--", "new", "--cwd", worktree);
			await until(() => JSON.parse(s.swb("drive", "state")).staged.kind === "live", TAPE, "the worktree's pi on the Stage");
			s.keys("-l", "reply in the worktree", "Enter");
			await until(() => s.signal("replied.in the worktree") !== "", TAPE, "the worktree's reply");
			await waitLs(s, "titled after a turn", (ls) => ls.some((e) => e.cwd === worktree && e.activity === "idle"));
			s.swb("drive", "stop");
		},
		run: async (s) => {
			const id = (title: string) => s.ls().find((e) => e.title === title)?.id;
			await waitLs(s, "alpha in review", (ls) => ls.find((e) => e.title === "alpha")?.group === "review");
			let st = await waitDeck(
				s,
				"review on the roster",
				(x) => x.filter === "" && x.rows.some((r) => r.kind === "header" && r.group === "review"),
			);
			// The roster's own pane, as a terminal would report the mouse to it: SGR, 1-based.
			const mouse = async (...events: [number, number, number, boolean?][]) => {
				for (const [button, col, row, up] of events) {
					const bytes = [...Buffer.from(`\x1b[<${button};${col + 1};${row + 1}${up ? "m" : "M"}`)].map((b) =>
						b.toString(16).padStart(2, "0"),
					);
					s.tmux(s.servers.ui, "send-keys", "-t", `=${st.deck}:.0`, "-H", ...bytes);
					await Bun.sleep(120);
				}
			};
			// The roster pane's own rows: its list is the first of them.
			const line = (probe: (row: DeckState["rows"][number]) => boolean) => st.rows.findIndex(probe);
			const drag = (from: number, to: number) =>
				mouse([0, 8, from], ...[1, 2, 3, 4].map((i): [number, number, number] => [32, 8, Math.round(from + ((to - from) * i) / 4)]));

			await Bun.sleep(2500);
			const bravo = line((r) => r.kind === "session" && r.id === id("bravo"));
			const alpha = line((r) => r.kind === "session" && r.id === id("alpha"));
			await drag(bravo, alpha);
			await waitDeck(s, "review lit as the drop", (x) => x.drop?.group === "review");
			await Bun.sleep(2500);
			await mouse([0, 8, alpha, true]);
			await waitLs(s, "bravo in review", (ls) => ls.find((e) => e.title === "bravo")?.group === "review");

			st = await waitDeck(s, "two in review", (x) => x.rows.filter((r) => r.kind === "session" && r.group === "review").length === 2);
			await Bun.sleep(2500);
			const from = line((r) => r.kind === "session" && r.id === id("bravo"));
			const operators = line((r) => r.kind === "section" && r.label === "Operators");
			await drag(from, operators);
			await Bun.sleep(2500);
			if (deck(s).drop !== null) throw new Error("the Operators section offered itself as a drop");
			await mouse([0, 8, operators, true]);
			await waitDeck(s, "the refusal", (x) => x.toasts.some((t) => t.text.includes("nothing moved")));
			expect(s.ls().find((e) => e.title === "bravo")?.group).toBe("review");
			await waitLs(s, "n joined review", (ls) => ls.filter((e) => e.group === "review").length === 3);
		},
	},

	lineage: {
		setup: async (s) => {
			const other = join(s.root, "pi-sessions");
			const operator = join(s.env.XDG_CONFIG_HOME as string, "agent-switchboard/operator");
			mkdirSync(other);
			mkdirSync(operator, { recursive: true });
			const root = await launched(s, "reply on it", { cwd: s.project, title: "Roster lineage design" });
			const survey = await launched(s, "reply surveyed", { from: root, title: "Survey parent_id usage" });
			await launched(s, "reply measured", { from: survey, title: "Measure lineage depth" });
			await launched(s, "reply ported", { from: survey, cwd: other, title: "Port lineage entry" });
			await launched(s, "reply tested", { from: root, title: "E2E for nested rows" });
			const op = await launched(s, "reply triaged", { cwd: operator, title: "Triage open issues" });
			await launched(s, "reply bumped", { from: op, cwd: s.project, title: "Bump pi-tui to 0.9" });
		},
		run: async (s) => {
			const family = [
				"Roster lineage design",
				"Survey parent_id usage",
				"Measure lineage depth",
				"Port lineage entry",
				"E2E for nested rows",
				"Draft lineage docs",
			];
			// Once the tape has shown the root alone in lab, the root starts a child, which begins there too.
			const st = await waitDeck(s, "the root in lab", (x) =>
				x.rows.some((r) => r.kind === "session" && r.title === "Roster lineage design" && r.group === "lab"),
			);
			const root = st.rows.find((r) => r.kind === "session" && r.title === "Roster lineage design");
			if (root?.kind !== "session") throw new Error("no root row");
			await Bun.sleep(4000);
			await launched(s, "reply drafted", { from: root.id, title: "Draft lineage docs" });
			await waitDeck(s, "the archive prompt", (x) => x.mode === "archive" && x.archive?.all === family.length);
			await waitLs(s, "the family archived", (ls) => {
				const members = ls.filter((e) => family.includes(e.title ?? ""));
				return members.length === family.length && members.every((e) => !e.open);
			});
			expect(
				s
					.ls()
					.filter((e) => e.open)
					.map((e) => e.title),
			).toEqual(expect.arrayContaining(["Triage open issues", "Bump pi-tui to 0.9"]));
		},
	},

	"move-mv": {
		packages: ["@thurstonsand/pi-wt"],
		setup: async (s) => {
			mkdirSync(join(s.root, "elsewhere"));
		},
		run: async (s) => {
			await waitLs(s, "a session", (ls) => ls.length === 1);
			const [moved] = await waitLs(s, "swb following the move", (ls) => ls[0]?.cwd === join(s.root, "elsewhere"));
			expect(moved).toMatchObject({ project: join(s.root, "elsewhere"), open: true, live: true });
		},
	},

	"move-wt": {
		packages: ["@thurstonsand/pi-wt"],
		setup: async (s) => {
			files(s);
			git(s, s.project, "init", "-q", "-b", "main");
			git(s, s.project, "add", ".");
			git(s, s.project, "commit", "-q", "-m", "init");
		},
		run: async (s) => {
			await waitLs(s, "a session", (ls) => ls.length === 1);
			const [moved] = await waitLs(s, "swb following into the worktree", (ls) => ls[0]?.branch === "feature");
			expect(moved?.cwd).toContain(".wt/worktrees/project/feature");
			expect(moved).toMatchObject({ open: true, live: true });
		},
	},

	mouse: {
		setup: async (s) => {
			await seed(
				s,
				{ turns: ["the parser is refactored"], title: "Refactor the parser" },
				{ turns: ["notes drafted"], title: "Draft release notes" },
			);
		},
		run: async (s) => {
			// The tape only watches; the clicks are the director's, through the drive harness the tape attached to.
			const click = async (text: string, cols = 42) => {
				await Bun.sleep(1500);
				const [x, y] = await onScreen(s, text, cols);
				s.swb("drive", "click", String(x), String(y));
			};
			await waitDrive(s, "the Deck up", (x) => x.ready);
			await click("Refactor");
			await waitDrive(s, "its pi focused by a click", (x) => x.focus === "stage" && x.staged.kind === "live");
			await click("hide list");
			await waitDrive(s, "the roster hidden", (x) => x.layout.rosterHidden);
			await Bun.sleep(1000);
			await click("show list");
			await waitDrive(s, "the roster back", (x) => !x.layout.rosterHidden);
			await click(" shell ");
			await waitDrive(s, "the shell", (x) => x.layout.shell && x.focus === "shell");
			s.keys("-l", "echo the shell came from a click", "Enter");
			await Bun.sleep(1000);
			await click(" shell ");
			await waitDrive(s, "the shell closed", (x) => !x.layout.shell);
			await click("? keys");
			await click("any key or click closes", 1000);
			await until(() => !s.swb("drive", "capture").includes("any key or click closes"), TAPE, "help closed by a click");
			s.swb("drive", "resize", "90x30");
			await waitDrive(s, "a narrow Deck, the roster alone", (x) => x.layout.rosterOnly && x.focus === "roster");
			// No Stage beside the roster: the roster draws the Peek itself, at its right edge.
			const [dx, dy] = await onScreen(s, "Draft", 90);
			s.swb("drive", "move", String(dx), String(dy));
			await waitDrive(s, "Draft's Peek in the narrow roster", (x) => x.peek?.lines[0]?.startsWith("╭") === true);
			await Bun.sleep(3000);
			await click("Refactor", 20);
			await waitDrive(s, "pi alone", (x) => x.focus === "stage");
			await Bun.sleep(1000);
			await click("show list", 90);
			await waitDrive(s, "the roster alone again", (x) => x.focus === "roster");
		},
	},

	peek: {
		setup: async (s) => {
			gitRepo(s, s.project);
			files(s);
			git(s, s.project, "add", ".");
			git(s, s.project, "commit", "-q", "-m", "files");
			writeFileSync(
				join(s.project, "README.md"),
				"# project\n\nA small project for the switchboard to look after.\nIt now has a parser.\nAnd release notes.\n",
			);
			config(s, `editor = "${NVIM} --clean ."\n`);
			await seed(
				s,
				{ turns: ["the parser is refactored"], title: "Refactor the parser so error recovery survives nested blocks" },
				{ turns: ["notes drafted"], title: "Draft release notes" },
				{ turns: ["the retry test is stable now"], title: "Fix the flaky retry test" },
			);
		},
		run: async (s) => {
			const idOf = (title: string) => {
				const row = drive(s).rows.find((r) => r.kind === "session" && r.title.startsWith(title));
				if (row?.kind !== "session") throw new Error(`no row ${title}`);
				return row.id;
			};
			/** The pointer onto `text`: on the roster, or right of it, on a Peek. */
			const point = async (text: string, right = false) => {
				const [x, y] = await onScreen(s, text, right ? 1000 : 42, right ? 43 : 0);
				s.swb("drive", "move", String(x), String(y));
			};
			const cursorTo = async (id: string) => {
				for (let st = drive(s); st.cursor !== id; st = drive(s)) {
					const at = st.rows.findIndex((r) => r.kind === "session" && r.id === id);
					s.keys(at > st.cursorRow ? "j" : "k");
					await Bun.sleep(300);
				}
			};
			await waitDrive(s, "the Deck up", (x) => x.ready);
			const [refactor, notes, flaky] = [idOf("Refactor"), idOf("Draft"), idOf("Fix")];
			await cursorTo(flaky);
			// Leave the cursor's own Peek to the keys, for now.
			await point("Refactor");
			await waitDrive(s, "Refactor's Peek, the cursor still on Fix", (x) => x.peek?.id === refactor && x.cursor === flaky);
			await Bun.sleep(2500);
			await point("Wake w", true);
			await Bun.sleep(2500);
			const [x, y] = await onScreen(s, "Wake w", 1000, 43);
			s.swb("drive", "click", String(x), String(y));
			await waitDrive(s, "Refactor woken from its Peek", (st) => st.peek?.lines.some((line) => line.includes("Stop x")) === true);
			await Bun.sleep(2500);
			s.swb("drive", "move", "100", "30");
			await waitDrive(s, "the Peek gone with the pointer", (st) => st.peek === null && st.hover === null);
			await Bun.sleep(2000);
			// The tabs under the roster light up under the pointer too.
			await point("editor");
			await Bun.sleep(2500);
			await cursorTo(notes);
			await waitDrive(s, "the cursor's Peek", (st) => st.peek?.id === notes && st.peek.source === "cursor");
			await Bun.sleep(3000);

			// Wide enough for split: the Peek over pi, the editor beside it.
			s.swb("drive", "resize", "180x45");
			await waitDrive(s, "a wide Deck", (st) => st.layout.width === 180);
			s.keys("M-a", "v");
			await waitDrive(s, "split", (st) => st.layout.split && st.staged.view === "split");
			await Bun.sleep(1500);
			await point("Fix");
			await waitDrive(s, "Fix's Peek beside the split", (st) => st.peek?.id === flaky);
			await Bun.sleep(3000);

			// Too short for the Peek beside its row: it stays on the Stage, as close to the row as fits.
			s.swb("drive", "resize", "180x14");
			await waitDrive(s, "a short Deck", (st) => !st.layout.rosterOnly);
			await Bun.sleep(1000);
			await point("Fix");
			await waitDrive(s, "Fix's Peek in a short Deck", (st) => st.peek?.id === flaky);
			await Bun.sleep(3000);
			s.swb("drive", "move", "150", "10");
			await waitDrive(s, "gone", (st) => st.peek === null);
		},
	},

	startup: {
		packages: ["pi-sessions"],
		setup: async (s) => {
			await seed(s, { turns: ["one"], title: "alpha" }, { turns: ["two"], title: "bravo" });
		},
		run: async (s) => {
			const id = (title: string) => s.ls().find((e) => e.title === title)?.id;
			await waitLs(s, "an Operator after its first turn", (ls) => ls.some((e) => e.operator && e.activity === "idle"));
			const first = await waitDeck(s, "alpha under the cursor", (x) => x.cursor === id("alpha") && x.filter === "");
			const restored = await waitDeck(s, "a second Deck", (x) => x.deck !== first.deck && x.ready && x.cursor !== null);
			expect(restored).toMatchObject({ cursor: id("alpha"), focus: "roster" });
			const continued = await waitDeck(
				s,
				"swb -c in pi",
				(x) => x.deck !== restored.deck && x.staged.kind === "live" && x.focus === "stage",
			);
			expect(continued.staged.id).toBe(id("bravo") as string);
		},
	},
};
