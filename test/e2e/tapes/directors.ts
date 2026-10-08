import { expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeckState } from "../../../packages/cli/src/deck/protocol.ts";
import { config, seed } from "../harness/deck.ts";
import { git, type HostPackage, type LsEntry, release, type Scenario, until, which } from "../harness/index.ts";

export type Director = {
	packages?: HostPackage[];
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

const entered = (s: Scenario, name: string) => until(() => s.signal(`${name}.entered`) !== "", TAPE, `${name} held`);

function files(s: Scenario): void {
	mkdirSync(join(s.project, "src"));
	writeFileSync(join(s.project, "README.md"), "# project\n\nA small project for the switchboard to look after.\n");
	writeFileSync(join(s.project, "src/main.ts"), 'console.log("hello");\n');
}

export const directors: Record<string, Director> = {
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
			await waitDeck(s, "back to pi", (x) => x.staged.view === "pi");
			await waitDeck(s, "split", (x) => x.layout.split && x.staged.view === "split");
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

	"simulated-process-loss": {
		run: async (s) => {
			await entered(s, "long-build");
			await waitLs(s, "one idle, one working", (ls) => ls.length === 2 && ls.some((e) => e.activity === "working"));
			await Bun.sleep(2500);
			s.tmux(s.servers.sessions, "kill-server");
			const ls = await waitLs(s, "both dormant", (x) => x.every((e) => !e.live));
			expect(ls.map((e) => [e.title, e.interrupted]).sort()).toEqual([
				["Simulated: idle when killed", false],
				["Simulated: mid-turn when killed", true],
			]);
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
		setup: async (s) => {
			// session_reachable reads pi-sessions' search index, which the harness turns off.
			const path = join(s.env.PI_CODING_AGENT_DIR as string, "settings.json");
			const settings = JSON.parse(readFileSync(path, "utf8"));
			settings.sessions.search.enable = true;
			writeFileSync(path, JSON.stringify(settings));
		},
		run: async (s) => {
			await entered(s, "child.scout");
			const child = await until(() => s.ls().find((e) => e.title === "child scout"), TAPE, "the child tracked");
			await Bun.sleep(3000);
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
			await all("three Decks", "0 open");
			await Bun.sleep(1500);
			keys(0, "n");
			await until(() => screens()[0]?.includes("faux-1"), TAPE, "pi in the first Deck");
			await Bun.sleep(800);
			keys(0, "-l", "reply one session, three Decks", "Enter");
			await all("the session in every roster", "1 open");
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
			await all("archived everywhere", "1 arch");
			expect(s.ls()[0]?.open).toBe(false);
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
};
