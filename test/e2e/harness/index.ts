import { Database } from "bun:sqlite";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const repo = resolve(import.meta.dir, "../../..");

function run(argv: string[], env?: Record<string, string>, cwd?: string): string {
	const result = Bun.spawnSync(argv, { env, cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${result.exitCode}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

/** A mise-managed tool's path, resolved before any scenario swaps HOME. */
export function which(tool: string): string {
	return run(["mise", "which", tool]);
}

// Resolved once, before any scenario swaps HOME: the mise shims stop working under a disposable HOME.
const tools = (() => {
	const node = which("node");
	const tmux = which("tmux");
	const wt = which("wt");
	const npmRoot = run(["mise", "x", "--", "npm", "root", "-g"]);
	const piCli = process.env.SWB_E2E_PI_CLI ?? join(npmRoot, "@earendil-works/pi-coding-agent/dist/bundle/cli.js");
	// The native binaries, not npm's node wrappers, so a pane's pid is the harness itself.
	const claude = join(npmRoot, "@anthropic-ai/claude-code/bin/claude.exe");
	const codexVendor = join(npmRoot, "@openai/codex/node_modules/@openai");
	const codex = existsSync(codexVendor)
		? ([...new Bun.Glob("codex-*/vendor/*/bin/codex").scanSync({ cwd: codexVendor, absolute: true })][0] ?? "")
		: "";
	return { node, tmux, wt, piCli, claude, codex, bun: process.execPath };
})();

export type PiPackage = "pi-sessions" | "@thurstonsand/pi-wt";
const overrides: Record<PiPackage, string> = { "pi-sessions": "SWB_E2E_PI_SESSIONS", "@thurstonsand/pi-wt": "SWB_E2E_PI_WT" };

/** A pi package at the version bun.lock pins, or the checkout its override names. */
function piPackage(name: PiPackage): string {
	return process.env[overrides[name]] || join(repo, "node_modules", name);
}

export type LsEntry = {
	id: string;
	harness: "pi" | "claude" | "codex";
	parentId: string | null;
	title: string | null;
	project: string;
	cwd: string;
	branch: string | null;
	group: string | null;
	operator: boolean;
	open: boolean;
	live: boolean;
	activity: "idle" | "working" | "blocked";
	unseen: boolean;
	cutOff: "shutdown" | "killed" | "restart" | null;
	errored: boolean;
	inactive: boolean;
	reload: "continue" | "idle" | null;
	activityAt: number;
	archivedAt: number | null;
};

export type Scenario = {
	name: string;
	root: string;
	home: string;
	bin: string;
	instance: string;
	artifacts: string;
	env: Record<string, string>;
	/** A plain directory to run sessions in. */
	project: string;
	tmux: (server: string, ...args: string[]) => string;
	/** The real swb binary under this scenario's environment, run in the project dir; throws on a non-zero exit. */
	swb: (...args: string[]) => string;
	swbTry: (...args: string[]) => { code: number; out: string; err: string };
	ls: () => LsEntry[];
	/** A fresh read connection to the scenario's db; the caller closes it. */
	db: () => Database;
	dbFile: string;
	query: <T>(sql: string, ...params: (string | number | null)[]) => T[];
	screen: () => string;
	keys: (...keys: string[]) => void;
	signal: (name: string) => string;
	servers: { sessions: string; ui: string; drive: string };
	/** Every request the fake model servers saw, one JSON object each, for the harnesses this scenario runs. */
	requests: (harness: "claude" | "codex") => Record<string, unknown>[];
	/** Trusts a directory for Claude Code and Codex, as a person would have once. */
	trust: (dir: string) => void;
	save: (file: string, content: string) => void;
	cleanup: () => Promise<void>;
};

const servers = new Set<string>();

/**
 * `packages` installs those pi packages, at the versions bun.lock pins.
 * Without `recorder`, pi starts with no recorder until the scenario installs one.
 * `dist` is the build of swb and the pi line to run, this checkout's by default.
 */
export function scenario(
	phase: string,
	name: string,
	options: { packages: PiPackage[]; recorder: boolean; harnesses?: ("claude" | "codex")[]; dist?: string } = {
		packages: [],
		recorder: true,
	},
): Scenario {
	// Not tmpdir(): macOS's /var/folders/... pushes tmux sockets under root past the 104-byte sun_path limit.
	// Resolved because /tmp is a symlink there, and swb records the real cwd.
	const root = realpathSync(mkdtempSync("/tmp/swb-e2e-"));
	const home = join(root, "home");
	const bin = join(root, "bin");
	const project = join(root, "project");
	const instance = `e2e-${root.slice(-6).toLowerCase()}`;
	const artifacts = join(repo, "test/e2e/artifacts", phase, name);
	const agentDir = join(home, ".pi/agent");
	const dist = options.dist ?? join(repo, "dist");
	rmSync(artifacts, { recursive: true, force: true });
	for (const dir of [home, bin, project, agentDir, join(root, "tmux"), artifacts]) mkdirSync(dir, { recursive: true });

	writeFileSync(join(bin, "pi"), `#!/bin/sh\nPI_OFFLINE=1 exec ${tools.node} ${tools.piCli} "$@"\n`);
	chmodSync(join(bin, "pi"), 0o755);
	symlinkSync(tools.tmux, join(bin, "tmux"));
	symlinkSync(join(dist, "swb"), join(bin, "swb"));
	symlinkSync(tools.wt, join(bin, "wt"));
	const harnesses = options.harnesses ?? [];
	for (const harness of harnesses) {
		if (!tools[harness]) throw new Error(`this scenario needs ${harness}, and this host has no npm-global install of it`);
		symlinkSync(tools[harness], join(bin, harness));
	}

	const path = `${bin}:/usr/local/bin:/usr/bin:/bin`;
	const profile = `export PATH=${path}\n`;
	// Only the user's real login shell sets the marker; /bin/sh reads just .profile.
	writeFileSync(join(home, ".zshenv"), `${profile}export SWB_E2E_LOGIN_SHELL=1\n`);
	// macOS's /etc/zprofile runs path_helper after .zshenv, which puts /usr/bin ahead of this PATH; .zprofile runs after it.
	writeFileSync(join(home, ".zprofile"), profile);
	// One short prompt on every host. A shell's pane passes through narrow widths as the Deck rearranges, and the shell
	// redraws its prompt at each: one wider than the narrowest, such as a CI runner's user@host:path, can overwrite the line above.
	const prompt = "PS1='$ '\n";
	writeFileSync(join(home, ".bash_profile"), `${profile}${prompt}export SWB_E2E_LOGIN_SHELL=1\n`);
	// macOS's /etc/zshrc sets its own prompt after .zprofile.
	writeFileSync(join(home, ".zshrc"), prompt);
	writeFileSync(join(home, ".profile"), profile);
	// pi 1.0.4 marks a freshly registered native provider usable at startup only if it has a stored
	// credential; otherwise initial model selection races an async auth check and intermittently finds no model.
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux" } }));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			// The pi line last, as `pi install` leaves it when added after pi-sessions: its handlers then run after theirs.
			packages: [...options.packages.map(piPackage), ...(options.recorder ? [join(dist, "pi")] : [])],
			...(options.packages.includes("pi-sessions")
				? // Only what subagents and handoffs need: the rest would spend faux turns on titles and indexing.
					{ sessions: { autoTitle: { enable: false }, ask: { enable: false }, search: { enable: false } } }
				: {}),
			extensions: [join(repo, "test/e2e/scenario-extension.ts")],
			defaultProvider: "faux",
			defaultModel: "faux-1",
			quietStartup: true,
			tuiMode: "regular",
			theme: "system",
		}),
	);

	const env: Record<string, string> = {
		PATH: path,
		HOME: home,
		SHELL: "/bin/sh",
		TERM: "xterm-256color",
		LANG: "C.UTF-8",
		// swb reads local time in the test's zone: bun test runs in UTC whatever the machine's zone is.
		TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_STATE_HOME: join(home, ".local/state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PI_CODING_AGENT_DIR: agentDir,
		TMUX_TMPDIR: join(root, "tmux"),
		SWB_INSTANCE: instance,
		// No session bus here: without an address, every Claude Code and Codex start autolaunches a dbus-daemon that
		// outlives the scenario. One that doesn't exist makes them go without.
		DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, "no-session-bus")}`,
	};
	const fakes = startFakes(root, home, harnesses, env);
	const trust = (dir: string) => trustHarnesses(home, harnesses, dir);
	trust(project);

	const tmux = (server: string, ...args: string[]) => {
		servers.add(`${env.TMUX_TMPDIR}\0${server}`);
		return run([tools.tmux, "-L", server, ...args], env);
	};
	const named = { sessions: `swb-${instance}`, ui: `swb-ui-${instance}`, drive: `swb-drive-${instance}` };
	for (const server of Object.values(named)) servers.add(`${env.TMUX_TMPDIR}\0${server}`);
	const swbTry = (...args: string[]) => {
		const result = Bun.spawnSync([join(bin, "swb"), ...args], { env, cwd: project, stdout: "pipe", stderr: "pipe" });
		return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
	};
	const swb = (...args: string[]) => {
		const result = swbTry(...args);
		if (result.code !== 0) throw new Error(`swb ${args.join(" ")} exited ${result.code}: ${result.err}`);
		return result.out;
	};
	const dbFile = join(home, ".local/state/agent-switchboard/swb.db");
	const db = () => new Database(dbFile, { readwrite: true, create: false });
	const query = <T>(sql: string, ...params: (string | number | null)[]): T[] => {
		const conn = db();
		try {
			// A write waits out swb's, as swb's own connections do.
			conn.exec("PRAGMA busy_timeout = 5000");
			return conn.prepare(sql).all(...params) as T[];
		} finally {
			conn.close();
		}
	};

	return {
		name,
		root,
		home,
		bin,
		instance,
		artifacts,
		env,
		project,
		tmux,
		swb,
		swbTry,
		ls: () => JSON.parse(swb("ls", "--json")) as LsEntry[],
		db,
		dbFile,
		query,
		screen: () => swb("drive", "capture"),
		keys: (...keys) => {
			swb("drive", "keys", ...keys);
		},
		signal: (name) => {
			const file = join(home, "e2e-signals", name);
			return existsSync(file) ? readFileSync(file, "utf8") : "";
		},
		servers: named,
		requests: (harness) => {
			const log = join(root, `${harness}-requests.jsonl`);
			if (!existsSync(log)) return [];
			// The fake server may be partway through appending a line: only whole lines are requests yet.
			const text = readFileSync(log, "utf8");
			return text
				.slice(0, text.lastIndexOf("\n") + 1)
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		},
		trust,
		save: (file, content) => writeFileSync(join(artifacts, file), content),
		cleanup: async () => {
			// The sessions server last, once everything on the others is dead: a Deck still running restarts it.
			const sessions = `${env.TMUX_TMPDIR}\0${named.sessions}`;
			const keys = [...servers].sort((a, b) => Number(a === sessions) - Number(b === sessions));
			for (const key of keys) {
				const [tmpdir, server] = key.split("\0") as [string, string];
				if (tmpdir !== env.TMUX_TMPDIR) continue;
				servers.delete(key);
				const probe = Bun.spawnSync([tools.tmux, "-L", server, "display", "-p", "#{pid}"], { env });
				if (probe.exitCode !== 0) continue;
				const pids = [Number(probe.stdout.toString().trim())];
				const panes = Bun.spawnSync([tools.tmux, "-L", server, "list-panes", "-a", "-F", "#{pane_pid}"], { env });
				pids.push(...panes.stdout.toString().trim().split("\n").filter(Boolean).map(Number));
				Bun.spawnSync([tools.tmux, "-L", server, "kill-server"], { env });
				await until(() => pids.every((pid) => !alive(pid)), 5000, `${server}: pids ${pids.join(",")} to die`);
			}
			// A harness killed mid-tool leaves its held command running, and a test that failed before releasing it would
			// leave it waiting forever on a directory that's about to go.
			const signals = join(home, "e2e-signals");
			for (const held of existsSync(signals) ? readdirSync(signals).filter((f) => f.endsWith(".entered")) : [])
				writeFileSync(join(signals, held.replace(/\.entered$/, ".release")), "");
			await until(() => !Bun.spawnSync(["ps", "-eo", "args="]).stdout.toString().includes(signals), 5000, "the held commands to finish");
			for (const fake of fakes) fake.kill();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function until<T>(
	probe: () => T | undefined | false | Promise<T | undefined | false>,
	timeoutMs: number,
	what: string,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await Bun.sleep(50);
	}
}

export function capture(s: Scenario, server: string, target: string): string {
	return s.tmux(server, "capture-pane", "-p", "-J", "-t", target);
}

export function release(s: Scenario, name: string): void {
	mkdirSync(join(s.home, "e2e-signals"), { recursive: true });
	writeFileSync(join(s.home, "e2e-signals", `${name}.release`), "");
}

export function git(s: Scenario, cwd: string, ...args: string[]): string {
	return run(["git", "-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], s.env, cwd);
}

/** A git repository at dir with one empty commit on main. */
export function gitRepo(s: Scenario, dir: string): string {
	mkdirSync(dir, { recursive: true });
	git(s, dir, "init", "-q", "-b", "main");
	git(s, dir, "commit", "-q", "--allow-empty", "-m", "init");
	return dir;
}

/** A worktree of main on a new branch, beside it by default. */
export function gitWorktree(s: Scenario, main: string, branch: string, path = `${main}-${branch}`): string {
	git(s, main, "worktree", "add", "-q", "-b", branch, path);
	return path;
}

export const budgets = { piReady: 30_000, settle: 10_000, deckReady: 5_000 };

/** A port nothing listens on, from the kernel. */
function freePort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
	const port = probe.port as number;
	probe.stop(true);
	return port;
}

/**
 * The fake model servers that script Claude Code and Codex, each logging every request it answers. Their env reaches
 * every pane through the sessions server.
 */
function startFakes(root: string, home: string, harnesses: ("claude" | "codex")[], env: Record<string, string>): Bun.Subprocess[] {
	const signals = join(home, "e2e-signals");
	mkdirSync(signals, { recursive: true });
	return harnesses.map((harness) => {
		const port = freePort();
		const fake = Bun.spawn([tools.bun, join(repo, `test/e2e/fakes/${harness === "claude" ? "anthropic" : "openai"}.ts`)], {
			env: { ...process.env, FAKE_PORT: String(port), FAKE_LOG: join(root, `${harness}-requests.jsonl`), FAKE_SIGNALS: signals },
			stdout: "ignore",
			stderr: "inherit",
		});
		if (harness === "claude") {
			env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
			env.ANTHROPIC_API_KEY = CLAUDE_KEY;
			env.DISABLE_AUTOUPDATER = "1";
			// Offline: no plugin marketplace download.
			env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = "1";
			mkdirSync(join(home, ".claude"), { recursive: true });
			writeFileSync(
				join(home, ".claude/settings.json"),
				JSON.stringify({ permissions: { allow: ["Bash", "mcp__plugin_swb_swb"], defaultMode: "default" } }),
			);
		} else {
			env.FAKE_OPENAI_KEY = "fake";
			mkdirSync(join(home, ".codex"), { recursive: true });
			writeFileSync(
				join(home, ".codex/config.toml"),
				[
					'model = "gpt-5.5"',
					'model_provider = "fake"',
					'approval_policy = "never"',
					'sandbox_mode = "danger-full-access"',
					"",
					"[model_providers.fake]",
					'name = "fake"',
					`base_url = "http://127.0.0.1:${port}/v1"`,
					'wire_api = "responses"',
					'env_key = "FAKE_OPENAI_KEY"',
					"requires_openai_auth = false",
					"",
					// Without these, every new TUI stops on a model announcement first.
					"[notice.model_migrations]",
					'"gpt-5.5" = "gpt-6-sol"',
					"",
					"[tui.model_availability_nux]",
					'"gpt-6-sol" = 1',
					'"gpt-6.1-sol" = 1',
					"",
				].join("\n"),
			);
		}
		return fake;
	});
}

const CLAUDE_KEY = "sk-ant-api03-e2e-fake-key-0000000000000000";

function trustHarnesses(home: string, harnesses: ("claude" | "codex")[], dir: string): void {
	if (harnesses.includes("claude")) {
		const path = join(home, ".claude.json");
		const config = existsSync(path)
			? (JSON.parse(readFileSync(path, "utf8")) as { projects: Record<string, unknown> })
			: {
					hasCompletedOnboarding: true,
					theme: "dark",
					customApiKeyResponses: { approved: [CLAUDE_KEY.slice(-20)], rejected: [] },
					projects: {} as Record<string, unknown>,
				};
		config.projects[dir] = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
		writeFileSync(path, JSON.stringify(config));
	}
	if (harnesses.includes("codex")) {
		const path = join(home, ".codex/config.toml");
		writeFileSync(path, `${readFileSync(path, "utf8")}\n[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`);
	}
}
