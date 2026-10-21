import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { budgets, repo, type Scenario, scenario, until } from "./harness/index.ts";
import { entry, prompt, runtimes, startManaged, waitFor } from "./harness/recorder.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
		s.save("final-tmux.txt", s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name} #{session_attached} #{@swb_kind}"));
	} catch {}
	await s.cleanup();
});

test("a never-prompted session is killed when its last viewer detaches; a prompted one survives", async () => {
	s = scenario("phase1", "detach");
	const blank = await startManaged(s);
	s.swb("drive", "stop");
	await until(
		() => !s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name}").includes(blank.tmux_session),
		budgets.settle,
		"the provisional session to die",
	);

	s.swb("drive", "start", "--", "new");
	const kept = await until(() => runtimes(s).find((r) => r.tmux_session !== blank.tmux_session), budgets.piReady, "second runtime");
	await until(() => s.screen().includes("faux-1"), budgets.piReady, "pi ready");
	await prompt(s, "reply keep me");
	await until(() => entry(s, kept.session_id)?.activity === "idle", budgets.settle, "idle");
	s.swb("drive", "stop");
	await Bun.sleep(1000);
	expect(entry(s, kept.session_id).live).toBe(true);
});

test("re-running swb against a server started with an older embedded config re-sources it, and the hooks call the new path", async () => {
	s = scenario("phase1", "config-resource");
	await startManaged(s);
	s.tmux(s.servers.sessions, "set", "-g", "@swb_conf_version", "stale");
	s.tmux(s.servers.sessions, "set-hook", "-gu", "client-detached");
	s.swb("drive", "stop");

	const moved = `${s.root}/moved/swb`;
	mkdirSync(dirname(moved));
	copyFileSync(`${s.bin}/swb`, moved);
	rmSync(`${s.bin}/swb`);
	symlinkSync(moved, `${s.bin}/swb`);
	await startManaged(s);

	const hooks = s.tmux(s.servers.sessions, "show-hooks", "-g");
	s.save("hooks.txt", hooks);
	expect(hooks).toContain(`client-detached[0] run-shell -b "${moved} detached`);
	expect(hooks).not.toContain(`${repo}/dist/swb`);
	expect(s.tmux(s.servers.sessions, "show", "-gqv", "@swb_conf_version")).not.toBe("stale");
});

test("Alt+Enter arrives as CSI-u and Shift+Enter still works", async () => {
	s = scenario("phase1", "alt-enter");
	await startManaged(s);
	expect(await typed("M-Enter")).toEqual(["\x1b[13;3u"]);
	expect(await typed("S-Enter")).toEqual(["\x1b[13;2u"]);
});

test("clicking a link in fullscreen pi opens it, though pi started with no client to ask whether tmux forwards hyperlinks", async () => {
	s = scenario("phase1", "links");
	const settings = join(s.env.PI_CODING_AGENT_DIR as string, "settings.json");
	writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), tuiMode: "fullscreen" }));
	const opened = join(s.home, "opened");
	for (const opener of ["xdg-open", "open"]) {
		writeFileSync(join(s.bin, opener), `#!/bin/sh\nprintf %s "$1" > ${opened}\n`, { mode: 0o755 });
	}
	await startManaged(s);
	await prompt(s, "reply see [the docs](mailto:ops@example.com)");
	await waitFor(s, "replied.see [the docs](mailto:ops@example.com)");
	const lines = await until(
		() => {
			const screen = s.screen().split("\n");
			return screen.findLastIndex((line) => line.includes("see the docs")) >= 0 && screen;
		},
		budgets.settle,
		"the reply's link",
	);
	const row = lines.findLastIndex((line) => line.includes("see the docs"));
	s.swb("drive", "click", `${(lines[row] as string).indexOf("the docs") + 1}`, `${row}`);
	await until(() => existsSync(opened), budgets.settle, "the opener");
	expect(readFileSync(opened, "utf8")).toBe("mailto:ops@example.com");
});

test("a user tmux.conf binding M-z and setting window-style changes nothing inside pi", async () => {
	s = scenario("phase1", "user-tmux-conf");
	const conf = "bind -n M-z display-message hijacked\nset -g window-style bg=red\n";
	writeFileSync(`${s.home}/.tmux.conf`, conf);
	mkdirSync(`${s.home}/.config/tmux`, { recursive: true });
	writeFileSync(`${s.home}/.config/tmux/tmux.conf`, conf);
	await startManaged(s);
	expect(await typed("M-z")).toEqual(["\x1b[122;3u"]);
	const replies = await typed("-l", "/e2e-bg", "Enter");
	expect(replies).toContain("\x1b]11;rgb:f9f9/f5f5/d7d7\x1b\\");
});

test("a session live in one managed pi cannot be opened in another", async () => {
	s = scenario("phase1", "single-host");
	const first = await startManaged(s);
	await prompt(s, "/name Only here");
	await prompt(s, "reply once");
	await until(() => entry(s, first.session_id)?.activity === "idle", budgets.settle, "the first turn");

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
	expect(runtimes(s).filter((r) => r.session_id === first.session_id)).toEqual([first]);
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
