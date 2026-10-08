import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const repo = resolve(import.meta.dir, "../../..");
export const PI_VERSION = "1.0.4";

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
	const piCli =
		process.env.SWB_E2E_PI_CLI ?? join(run(["mise", "x", "--", "npm", "root", "-g"]), "@earendil-works/pi-coding-agent/dist/bundle/cli.js");
	const version = run([node, piCli, "--version"]);
	if (version !== PI_VERSION) throw new Error(`e2e needs pi ${PI_VERSION}, found ${version} at ${piCli}`);
	return { node, tmux, wt, piCli };
})();

export type HostPackage = "pi-sessions" | "@thurstonsand/pi-wt";
const overrides: Record<HostPackage, string> = { "pi-sessions": "SWB_E2E_PI_SESSIONS", "@thurstonsand/pi-wt": "SWB_E2E_PI_WT" };

/** The host's own install of a pi package, as its pi settings name it; null when it has none. */
function hostPackage(name: HostPackage): string | null {
	const override = process.env[overrides[name]];
	if (override) return override;
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
	const settings = join(agentDir, "settings.json");
	if (!existsSync(settings)) return null;
	const packages = (JSON.parse(readFileSync(settings, "utf8")) as { packages?: (string | { source: string })[] }).packages ?? [];
	const repoName = name.slice(name.lastIndexOf("/") + 1);
	for (const entry of packages) {
		const source = typeof entry === "string" ? entry : entry.source;
		if (source === `npm:${name}`) return join(agentDir, "npm/node_modules", name);
		if (source.replace(/\/$/, "").endsWith(`/${repoName}`)) return source.replace(/^~/, homedir());
	}
	return null;
}

export type LsEntry = {
	id: string;
	title: string | null;
	project: string;
	cwd: string;
	branch: string | null;
	open: boolean;
	live: boolean;
	activity: "idle" | "working" | "blocked";
	unseen: boolean;
	interrupted: boolean;
	inactive: boolean;
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
	save: (file: string, content: string) => void;
	cleanup: () => Promise<void>;
};

const servers = new Set<string>();

/**
 * `packages` installs the host's real copies of those pi packages; a scenario that asks for one the host lacks throws.
 * Without `recorder`, pi starts with no recorder until the scenario installs one.
 */
export function scenario(
	phase: string,
	name: string,
	options: { packages: HostPackage[]; recorder: boolean } = { packages: [], recorder: true },
): Scenario {
	const root = mkdtempSync(join(tmpdir(), "swb-e2e-"));
	const home = join(root, "home");
	const bin = join(root, "bin");
	const project = join(root, "project");
	const instance = `e2e-${root.slice(-6).toLowerCase()}`;
	const artifacts = join(repo, "test/e2e/artifacts", phase, name);
	const agentDir = join(home, ".pi/agent");
	rmSync(artifacts, { recursive: true, force: true });
	for (const dir of [home, bin, project, agentDir, join(root, "tmux"), artifacts]) mkdirSync(dir, { recursive: true });

	writeFileSync(join(bin, "pi"), `#!/bin/sh\nPI_OFFLINE=1 exec ${tools.node} ${tools.piCli} "$@"\n`);
	chmodSync(join(bin, "pi"), 0o755);
	symlinkSync(tools.tmux, join(bin, "tmux"));
	symlinkSync(join(repo, "dist/swb"), join(bin, "swb"));
	symlinkSync(tools.wt, join(bin, "wt"));

	const path = `${bin}:/usr/local/bin:/usr/bin:/bin`;
	const profile = `export PATH=${path}\n`;
	writeFileSync(join(home, ".zshenv"), profile);
	writeFileSync(join(home, ".bash_profile"), profile);
	writeFileSync(join(home, ".profile"), profile);
	// pi 1.0.4 marks a freshly registered native provider usable at startup only if it has a stored
	// credential; otherwise initial model selection races an async auth check and intermittently finds no model.
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux" } }));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			packages: [...(options.recorder ? [join(repo, "dist/pi")] : []), ...options.packages.map(requireHostPackage)],
			...(options.packages.includes("pi-sessions")
				? // Only what subagents and handoffs need: the rest would spend faux turns on titles and indexing.
					{ sessions: { autoTitle: { enable: false }, ask: { enable: false }, search: { enable: false } } }
				: {}),
			extensions: [join(repo, "test/e2e/scenario-extension.ts")],
			defaultProvider: "faux",
			defaultModel: "faux-1",
			quietStartup: true,
			tuiMode: "regular",
		}),
	);

	const env: Record<string, string> = {
		PATH: path,
		HOME: home,
		SHELL: "/bin/sh",
		TERM: "xterm-256color",
		LANG: "C.UTF-8",
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_STATE_HOME: join(home, ".local/state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PI_CODING_AGENT_DIR: agentDir,
		TMUX_TMPDIR: join(root, "tmux"),
		SWB_INSTANCE: instance,
	};

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
		save: (file, content) => writeFileSync(join(artifacts, file), content),
		cleanup: async () => {
			const pids: number[] = [];
			for (const key of [...servers]) {
				const [tmpdir, server] = key.split("\0") as [string, string];
				if (tmpdir !== env.TMUX_TMPDIR) continue;
				servers.delete(key);
				const probe = Bun.spawnSync([tools.tmux, "-L", server, "display", "-p", "#{pid}"], { env });
				if (probe.exitCode !== 0) continue;
				pids.push(Number(probe.stdout.toString().trim()));
				const panes = Bun.spawnSync([tools.tmux, "-L", server, "list-panes", "-a", "-F", "#{pane_pid}"], { env });
				pids.push(...panes.stdout.toString().trim().split("\n").filter(Boolean).map(Number));
				Bun.spawnSync([tools.tmux, "-L", server, "kill-server"], { env });
			}
			await until(() => pids.every((pid) => !alive(pid)), 5000, `pids ${pids.join(",")} to die`);
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

function requireHostPackage(name: HostPackage): string {
	const path = hostPackage(name);
	if (!path) throw new Error(`this scenario needs ${name}, and this host's pi settings install none (set ${overrides[name]})`);
	return path;
}

export function git(s: Scenario, cwd: string, ...args: string[]): string {
	return run(["git", "-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], s.env, cwd);
}

export const budgets = { piReady: 30_000, settle: 10_000, deckReady: 5_000 };
