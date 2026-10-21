import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA_VERSION } from "../../packages/shared/src/index.ts";
import { budgets, release, repo, type Scenario, scenario, until, which } from "./harness/index.ts";
import { entry, prompt, runtimes, startManaged, waitFor } from "./harness/recorder.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
		s.save("final-tmux.txt", s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name} #{session_attached} #{@swb_kind}"));
	} catch {}
	await s.cleanup();
});

type SessionRow = { session_id: string; phase: string; title: string | null; last_prompt_at: number; last_settled_at: number | null };

const rows = () => s.query<SessionRow>("SELECT * FROM sessions");

/** Phase 1's first turn: a provisional runtime becomes a Session that works, settles, and takes its title. */
async function firstTurn(): Promise<void> {
	const runtime = await startManaged(s);
	expect(s.ls()).toEqual([]);
	expect(runtime.cwd).toBe(s.project);

	await prompt(s, "hold first");
	await waitFor(s, "first.entered");
	const working = entry(s, runtime.session_id);
	expect(working).toMatchObject({ live: true, open: true, activity: "working", cutOff: null, project: s.project, cwd: s.project });
	expect(working.title).toBeNull();

	// Unfocused, so the Deck watching the turn land doesn't Visit it.
	s.swb("drive", "focus", "out");
	release(s, "first");
	const idle = await until(() => entry(s, runtime.session_id).activity === "idle" && entry(s, runtime.session_id), budgets.settle, "idle");
	expect(idle).toMatchObject({ live: true, unseen: true });

	await prompt(s, "/name Recorder smoke");
	await until(() => entry(s, runtime.session_id).title === "Recorder smoke", budgets.settle, "the title");
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
	const runtime = await startManaged(s);
	await prompt(s, "attention gate");
	await waitFor(s, "gate.entered");
	await until(() => entry(s, runtime.session_id)?.activity === "blocked", budgets.settle, "blocked");
	release(s, "gate");
	await until(() => entry(s, runtime.session_id).activity === "idle", budgets.settle, "idle");
	expect(entry(s, runtime.session_id).unseen).toBe(true);
});

test("blocked while pi's own dialog waits on me mid-turn, idle once answered and settled", async () => {
	s = scenario("phase1", "dialog");
	const runtime = await startManaged(s);
	await prompt(s, "confirm deploy");
	await waitFor(s, "deploy.entered");
	await until(() => entry(s, runtime.session_id)?.activity === "blocked", budgets.settle, "blocked on the dialog");
	await until(() => s.screen().includes("Confirm deploy?"), budgets.settle, "the dialog on screen");
	s.save("dialog.txt", s.screen());
	s.keys("Enter");
	await until(() => entry(s, runtime.session_id).activity === "idle", budgets.settle, "idle once answered");
	expect(s.screen()).toContain("tool done deploy");
});

test("a dialog inside a Glimpse span: still blocked after the dialog closes, until the span resolves", async () => {
	s = scenario("phase1", "dialog-and-attention");
	const runtime = await startManaged(s);
	await prompt(s, "both gate");
	await waitFor(s, "gate.entered");
	await until(() => entry(s, runtime.session_id)?.activity === "blocked", budgets.settle, "blocked");
	await until(() => s.screen().includes("Confirm gate?"), budgets.settle, "the dialog on screen");
	s.keys("Enter");
	await waitFor(s, "gate.answered");
	// The dialog's end reaches the line a microtask later; long enough for it to have cleared a lone wait.
	await Bun.sleep(1000);
	expect(entry(s, runtime.session_id).activity).toBe("blocked");
	release(s, "gate");
	await until(() => entry(s, runtime.session_id).activity === "idle", budgets.settle, "idle once the span resolves");
});

test("/reload keeps recording, /new moves the runtime row to a new id and leaves the old session dormant", async () => {
	s = scenario("phase1", "reload-new");
	const runtime = await startManaged(s);
	await prompt(s, "reply before");
	await until(() => entry(s, runtime.session_id)?.activity === "idle", budgets.settle, "first turn");
	await prompt(s, "/reload");
	await Bun.sleep(1000);
	await prompt(s, "/name after reload");
	await until(() => entry(s, runtime.session_id).title === "after reload", budgets.settle, "title after reload");

	await prompt(s, "/new");
	const moved = await until(() => runtimes(s).find((r) => r.session_id !== runtime.session_id), budgets.settle, "the runtime to move");
	expect(moved.tmux_session).toBe(runtime.tmux_session);
	expect(runtimes(s)).toHaveLength(1);
	expect(entry(s, runtime.session_id)).toMatchObject({ live: false, activity: "idle", cutOff: null, open: true });
	await prompt(s, "reply second");
	await until(() => entry(s, moved.session_id)?.activity === "idle", budgets.settle, "second session idle");
	expect(s.ls()).toHaveLength(2);
});

test("a migration under a running recorder turns its footer red at the next write, and it stays red through /reload", async () => {
	s = scenario("phase1", "version-mismatch");
	const runtime = await startManaged(s);
	await prompt(s, "reply one");
	await until(() => entry(s, runtime.session_id)?.activity === "idle", budgets.settle, "first turn");
	const before = rows();
	const conn = s.db();
	conn.exec("PRAGMA user_version = 99");
	conn.close();
	await prompt(s, "reply two");
	await until(() => s.screen().includes("swb: not recording: db schema is v99"), budgets.settle, "the red footer");
	const conn2 = s.db();
	conn2.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	conn2.close();
	const starts = s.signal("session_start");
	await prompt(s, "/reload");
	await until(() => s.signal("session_start").length > starts.length, budgets.settle, "the reload");
	await prompt(s, "reply three");
	await waitFor(s, "replied.three");
	const screen = s.screen();
	s.save("screen.txt", screen);
	expect(screen).toContain("swb: not recording");
	expect(rows()).toEqual(before);
});

test("swb refuses a db newer than itself, and a recorder started against a mismatched db goes red at once", async () => {
	s = scenario("phase1", "mismatch-at-start");
	s.swb("migrate");
	const conn = s.db();
	conn.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
	conn.close();
	const refused = s.swbTry("ls");
	expect(refused.code).toBe(1);
	expect(refused.err).toContain(`is schema v${SCHEMA_VERSION + 1}, newer than this swb (v${SCHEMA_VERSION})`);

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
			return text.includes(`swb: not recording: db schema is v${SCHEMA_VERSION + 1}`) && text;
		},
		budgets.piReady,
		"the red footer",
	);
	s.save("screen.txt", screen);
	expect(runtimes(s)).toEqual([]);
});

test("kill-server leaves an idle session dormant and a mid-turn one cut off", async () => {
	s = scenario("phase1", "kill-server");
	const first = await startManaged(s);
	await prompt(s, "reply idle one");
	await until(() => entry(s, first.session_id)?.activity === "idle", budgets.settle, "first idle");
	s.swb("drive", "stop");
	s.swb("drive", "start", "--", "new");
	const second = await until(() => runtimes(s).find((r) => r.tmux_session !== first.tmux_session), budgets.piReady, "second runtime");
	await until(() => s.screen().includes("faux-1"), budgets.piReady, "second pi ready");
	await prompt(s, "hold forever");
	await waitFor(s, "forever.entered");
	s.tmux(s.servers.sessions, "kill-server");
	await until(() => !entry(s, second.session_id).live, budgets.settle, "dead");
	expect(entry(s, first.session_id)).toMatchObject({ live: false, activity: "idle", cutOff: null });
	expect(entry(s, second.session_id)).toMatchObject({ live: false, activity: "idle" });
	// Losing its terminal, pi may or may not record its shutdown before it dies; either way the turn was cut off.
	expect(entry(s, second.session_id).cutOff).not.toBeNull();
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
	expect(runtimes(s)).toEqual([]);
	expect(rows()).toEqual([]);
});
