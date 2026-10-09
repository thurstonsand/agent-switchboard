import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA_VERSION } from "../../packages/shared/src/index.ts";
import { budgets, type LsEntry, release, repo, type Scenario, scenario, until, which } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
		s.save("final-tmux.txt", s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name} #{session_attached} #{@swb_kind}"));
	} catch {}
	await s.cleanup();
});

type Runtime = { tmux_session: string; session_id: string; cwd: string; pid: number };
type SessionRow = { session_id: string; phase: string; title: string | null; last_prompt_at: number; last_settled_at: number | null };

const runtimes = () => s.query<Runtime>("SELECT * FROM runtimes");
const rows = () => s.query<SessionRow>("SELECT * FROM sessions");
const entry = (id: string) => s.ls().find((e) => e.id === id) as LsEntry;

/** `swb new` in the drive harness, waiting until pi is ready and its runtime row exists. */
async function startManaged(): Promise<Runtime> {
	s.swb("drive", "start", "--", "new");
	await until(() => s.screen().includes("faux-1"), budgets.piReady, "managed pi to be ready");
	return until(() => runtimes()[0], budgets.settle, "the runtime row");
}

async function prompt(text: string): Promise<void> {
	s.keys("-l", text, "Enter");
}

async function waitFor(name: string): Promise<void> {
	await until(() => s.signal(name) !== "", budgets.settle, name);
}

/** Phase 1's first turn: a provisional runtime becomes a Session that works, settles, and takes its title. */
async function firstTurn(): Promise<void> {
	const runtime = await startManaged();
	expect(s.ls()).toEqual([]);
	expect(runtime.cwd).toBe(s.project);

	await prompt("hold first");
	await waitFor("first.entered");
	const working = entry(runtime.session_id);
	expect(working).toMatchObject({ live: true, open: true, activity: "working", interrupted: false, project: s.project, cwd: s.project });
	expect(working.title).toBeNull();

	release(s, "first");
	const idle = await until(() => entry(runtime.session_id).activity === "idle" && entry(runtime.session_id), budgets.settle, "idle");
	expect(idle).toMatchObject({ live: true, unseen: true });

	await prompt("/name Recorder smoke");
	await until(() => entry(runtime.session_id).title === "Recorder smoke", budgets.settle, "the title");
	s.save("screen.txt", s.screen());
}

test("the first prompt turns a provisional runtime into a Session that works, settles, and takes its title", async () => {
	s = scenario("phase1", "first-turn");
	await firstTurn();
});

test("the dist:pi bundle, packed and installed with pi install as npm publishes it, records the first turn", async () => {
	s = scenario("phase7", "installed-bundle", { packages: [], recorder: false });
	// pi install shells out to npm, which the scenario's PATH leaves out; node's own bin dir carries both.
	const nodeBin = dirname(which("node"));
	const withNode = { ...s.env, PATH: `${nodeBin}:${s.env.PATH}` };
	const pack = Bun.spawnSync([join(nodeBin, "npm"), "pack", join(repo, "dist/pi"), "--pack-destination", s.root], {
		env: withNode,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (pack.exitCode !== 0) throw new Error(`npm pack: ${pack.stderr.toString()}`);
	const tarball = join(s.root, pack.stdout.toString().trim());
	const install = Bun.spawnSync([join(s.root, "bin/pi"), "install", `npm:${tarball}`], {
		env: withNode,
		stdout: "pipe",
		stderr: "pipe",
	});
	s.save("pi-install.txt", install.stdout.toString() + install.stderr.toString());
	if (install.exitCode !== 0) throw new Error(`pi install: ${install.stderr.toString()}`);
	const settingsPath = join(s.env.PI_CODING_AGENT_DIR as string, "settings.json");
	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	expect(settings.packages).toEqual([`npm:${tarball}`]);
	// pi 1.0.4 installs an npm:<tarball> spec but never loads it; name the package as installing from the registry would.
	settings.packages = ["npm:@thurstonsand/pi-agent-switchboard"];
	writeFileSync(settingsPath, JSON.stringify(settings));
	await firstTurn();
});

test("blocked during an attention span, working after it, idle only once the turn settles", async () => {
	s = scenario("phase1", "attention");
	const runtime = await startManaged();
	await prompt("attention gate");
	await waitFor("gate.entered");
	await until(() => entry(runtime.session_id)?.activity === "blocked", budgets.settle, "blocked");
	release(s, "gate");
	await until(() => entry(runtime.session_id).activity === "idle", budgets.settle, "idle");
	expect(entry(runtime.session_id).unseen).toBe(true);
});

test("/reload keeps recording, /new moves the runtime row to a new id and leaves the old session dormant", async () => {
	s = scenario("phase1", "reload-new");
	const runtime = await startManaged();
	await prompt("reply before");
	await until(() => entry(runtime.session_id)?.activity === "idle", budgets.settle, "first turn");
	await prompt("/reload");
	await Bun.sleep(1000);
	await prompt("/name after reload");
	await until(() => entry(runtime.session_id).title === "after reload", budgets.settle, "title after reload");

	await prompt("/new");
	const moved = await until(() => runtimes().find((r) => r.session_id !== runtime.session_id), budgets.settle, "the runtime to move");
	expect(moved.tmux_session).toBe(runtime.tmux_session);
	expect(runtimes()).toHaveLength(1);
	expect(entry(runtime.session_id)).toMatchObject({ live: false, activity: "idle", interrupted: false, open: true });
	await prompt("reply second");
	await until(() => entry(moved.session_id)?.activity === "idle", budgets.settle, "second session idle");
	expect(s.ls()).toHaveLength(2);
});

test("a migration under a running recorder turns its footer red at the next write, and it stays red through /reload", async () => {
	s = scenario("phase1", "version-mismatch");
	const runtime = await startManaged();
	await prompt("reply one");
	await until(() => entry(runtime.session_id)?.activity === "idle", budgets.settle, "first turn");
	const before = rows();
	const conn = s.db();
	conn.exec("PRAGMA user_version = 99");
	conn.close();
	await prompt("reply two");
	await until(() => s.screen().includes("swb: not recording: db schema is v99"), budgets.settle, "the red footer");
	const conn2 = s.db();
	conn2.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	conn2.close();
	const starts = s.signal("session_start");
	await prompt("/reload");
	await until(() => s.signal("session_start").length > starts.length, budgets.settle, "the reload");
	await prompt("reply three");
	await waitFor("replied.three");
	const screen = s.screen();
	s.save("screen.txt", screen);
	expect(screen).toContain("swb: not recording");
	expect(rows()).toEqual(before);
});

test("swb refuses a db newer than itself, and a recorder started against a mismatched db goes red at once", async () => {
	s = scenario("phase1", "mismatch-at-start");
	s.swb("migrate");
	const conn = s.db();
	conn.exec("PRAGMA user_version = 7");
	conn.close();
	const refused = s.swbTry("ls");
	expect(refused.code).toBe(1);
	expect(refused.err).toContain(`is schema v7, newer than this swb (v${SCHEMA_VERSION})`);

	// Launched exactly as swb launches it, but against the db swb refused.
	const server = `stale-${s.instance}`;
	const db = `${s.home}/.local/state/agent-switchboard/swb.db`;
	s.tmux(
		server,
		"-f",
		"/dev/null",
		"new-session",
		"-d",
		"-s",
		"pi",
		"-x",
		"140",
		"-y",
		"40",
		"-c",
		s.project,
		"-e",
		"SWB_MANAGED=1",
		"-e",
		`SWB_DB=${db}`,
		"-e",
		"SWB_TMUX_SESSION=stale-pi",
		"-e",
		`SWB_BIN=${s.bin}/swb`,
		`${s.bin}/pi`,
	);
	const screen = await until(
		() => {
			const text = s.tmux(server, "capture-pane", "-p", "-t", "pi");
			return text.includes("swb: not recording: db schema is v7") && text;
		},
		budgets.piReady,
		"the red footer",
	);
	s.save("screen.txt", screen);
	expect(runtimes()).toEqual([]);
});

test("kill-server leaves an idle session dormant and a mid-turn one interrupted", async () => {
	s = scenario("phase1", "kill-server");
	const first = await startManaged();
	await prompt("reply idle one");
	await until(() => entry(first.session_id)?.activity === "idle", budgets.settle, "first idle");
	s.swb("drive", "stop");
	s.swb("drive", "start", "--", "new");
	const second = await until(() => runtimes().find((r) => r.tmux_session !== first.tmux_session), budgets.piReady, "second runtime");
	await until(() => s.screen().includes("faux-1"), budgets.piReady, "second pi ready");
	await prompt("hold forever");
	await waitFor("forever.entered");
	s.tmux(s.servers.sessions, "kill-server");
	await until(() => !entry(second.session_id).live, budgets.settle, "dead");
	expect(entry(first.session_id)).toMatchObject({ live: false, activity: "idle", interrupted: false });
	expect(entry(second.session_id)).toMatchObject({ live: false, activity: "idle", interrupted: true });
});

test("a never-prompted session is killed when its last viewer detaches; a prompted one survives", async () => {
	s = scenario("phase1", "detach");
	const blank = await startManaged();
	s.swb("drive", "stop");
	await until(
		() => !s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name}").includes(blank.tmux_session),
		budgets.settle,
		"the provisional session to die",
	);

	s.swb("drive", "start", "--", "new");
	const kept = await until(() => runtimes().find((r) => r.tmux_session !== blank.tmux_session), budgets.piReady, "second runtime");
	await until(() => s.screen().includes("faux-1"), budgets.piReady, "pi ready");
	await prompt("reply keep me");
	await until(() => entry(kept.session_id)?.activity === "idle", budgets.settle, "idle");
	s.swb("drive", "stop");
	await Bun.sleep(1000);
	expect(entry(kept.session_id).live).toBe(true);
});

test("bare pi, without the token, writes nothing", async () => {
	s = scenario("phase1", "bare-pi");
	s.swb("migrate");
	const server = `bare-${s.instance}`;
	s.tmux(server, "-f", "/dev/null", "new-session", "-d", "-s", "pi", "-x", "120", "-y", "40", "-c", s.project, `${s.bin}/pi`);
	const capture = () => s.tmux(server, "capture-pane", "-p", "-t", "pi");
	await until(() => capture().includes("faux-1"), budgets.piReady, "bare pi");
	s.tmux(server, "send-keys", "-t", "pi", "-l", "reply bare");
	s.tmux(server, "send-keys", "-t", "pi", "Enter");
	await until(() => capture().split("bare").length > 2, budgets.settle, "the reply");
	expect(runtimes()).toEqual([]);
	expect(rows()).toEqual([]);
});

test("re-running swb against a server started with an older embedded config re-sources it, and the hooks call the new path", async () => {
	s = scenario("phase1", "config-resource");
	await startManaged();
	s.tmux(s.servers.sessions, "set", "-g", "@swb_conf_version", "stale");
	s.tmux(s.servers.sessions, "set-hook", "-gu", "client-detached");
	s.swb("drive", "stop");

	const moved = `${s.root}/moved/swb`;
	mkdirSync(dirname(moved));
	copyFileSync(`${s.bin}/swb`, moved);
	rmSync(`${s.bin}/swb`);
	symlinkSync(moved, `${s.bin}/swb`);
	await startManaged();

	const hooks = s.tmux(s.servers.sessions, "show-hooks", "-g");
	s.save("hooks.txt", hooks);
	expect(hooks).toContain(`client-detached[0] run-shell -b "${moved} detached`);
	expect(hooks).not.toContain(`${repo}/dist/swb`);
	expect(s.tmux(s.servers.sessions, "show", "-gqv", "@swb_conf_version")).not.toBe("stale");
});

test("Alt+Enter arrives as CSI-u and Shift+Enter still works", async () => {
	s = scenario("phase1", "alt-enter");
	await startManaged();
	expect(await typed("M-Enter")).toEqual(["\x1b[13;3u"]);
	expect(await typed("S-Enter")).toEqual(["\x1b[13;2u"]);
});

test("a user tmux.conf binding M-z and setting window-style changes nothing inside pi", async () => {
	s = scenario("phase1", "user-tmux-conf");
	const conf = "bind -n M-z display-message hijacked\nset -g window-style bg=red\n";
	writeFileSync(`${s.home}/.tmux.conf`, conf);
	mkdirSync(`${s.home}/.config/tmux`, { recursive: true });
	writeFileSync(`${s.home}/.config/tmux/tmux.conf`, conf);
	await startManaged();
	expect(await typed("M-z")).toEqual(["\x1b[122;3u"]);
	const reply = (await typed("-l", "/e2e-bg", "Enter")).at(-1);
	expect(reply).toBe("\x1b]11;rgb:f9f9/f5f5/d7d7\x1b\\");
});

test("a session live in one managed pi cannot be opened in another", async () => {
	s = scenario("phase1", "single-host");
	const first = await startManaged();
	await prompt("/name Only here");
	await prompt("reply once");
	await until(() => entry(first.session_id)?.activity === "idle", budgets.settle, "the first turn");

	const second = launchBeside("second", "");
	await until(() => second().includes("faux-1"), budgets.piReady, "the second pi");
	s.tmux(s.servers.sessions, "send-keys", "-t", "second", "-l", "/resume");
	s.tmux(s.servers.sessions, "send-keys", "-t", "second", "Enter");
	await until(() => second().includes("Only here"), budgets.settle, "the picker");
	s.tmux(s.servers.sessions, "send-keys", "-t", "second", "-l", "Only here");
	s.tmux(s.servers.sessions, "send-keys", "-t", "second", "Enter");
	const refused = await until(() => second().includes("already open in another pi") && second(), budgets.settle, "the /resume refusal");
	s.save("resume-refused.txt", refused);

	const third = launchBeside("third", `--session-id ${first.session_id}`);
	const red = await until(
		() => third().includes(`swb: not recording: session ${first.session_id} is already open`) && third(),
		budgets.piReady,
		"the red footer",
	);
	s.save("session-id-refused.txt", red);
	expect(runtimes().filter((r) => r.session_id === first.session_id)).toEqual([first]);
});

/** Raw terminal input pi receives for one `drive keys` call. */
async function typed(...keys: string[]): Promise<string[]> {
	const log = `${s.home}/e2e-signals/input.log`;
	writeFileSync(log, "");
	s.keys(...keys);
	await Bun.sleep(500);
	return readFileSync(log, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/** A managed pi on the sessions server with no viewer, launched with swb's token; returns its screen. */
function launchBeside(name: string, args: string): () => string {
	const db = `${s.home}/.local/state/agent-switchboard/swb.db`;
	s.tmux(
		s.servers.sessions,
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
		"-e",
		"SWB_MANAGED=1",
		"-e",
		`SWB_DB=${db}`,
		"-e",
		`SWB_TMUX_SESSION=${name}`,
		"-e",
		`SWB_BIN=${s.bin}/swb`,
		`${s.bin}/pi ${args}`,
	);
	return () => s.tmux(s.servers.sessions, "capture-pane", "-p", "-t", name);
}
