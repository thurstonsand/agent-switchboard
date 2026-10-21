import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSION } from "../../packages/cli/src/version.ts";
import { cursorTo, entry, piSessions, reply, seed, sessionRows, state, waitState } from "./harness/deck.ts";
import { alive, budgets, release, repo, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
	} catch {}
	await s.cleanup();
});

test("a pi-sessions subagent never becomes a Session and runs on the default tmux server; swb's tools replace pi-sessions' peer tools", async () => {
	s = scenario("phase5", "subagents", { packages: ["pi-sessions"], recorder: true });
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the parent live", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await reply(s, "parent");
	const [parent] = s.ls().map((e) => e.id) as [string];

	s.keys("-l", "tools", "Enter");
	await until(() => s.signal("tools") !== "", budgets.settle, "the tool list");
	const tools = JSON.parse(s.signal("tools")) as string[];
	for (const name of ["session_reachable", "session_send_message", "session_cancel", "session_launch", "swb_update_session"])
		expect(tools).toContain(name);
	for (const name of ["subagent_list", "subagent_send", "subagent_cancel", "subagent_launch"]) expect(tools).toContain(name);
	expect(tools).not.toContain("session_handoff");

	s.keys("-l", "subagent s1", "Enter");
	await until(() => s.signal("child.s1.entered") !== "", budgets.piReady, "the subagent's turn");
	// The sessions server keeps the caller's TMUX_TMPDIR, so "default" here is the scenario's own default server.
	const defaultServer = s.tmux("default", "list-sessions", "-F", "#{session_name}");
	expect(defaultServer).toMatch(/^pi-[0-9a-f]+$/m);
	expect(piSessions(s)).toHaveLength(1);
	expect(s.ls().map((e) => e.id)).toEqual([parent]);
	expect(sessionRows(state(s)).map((r) => r.id)).toEqual([parent]);
	expect(s.query("select 1 from runtimes")).toHaveLength(1);
	s.save("subagent-running.txt", `${s.screen()}\n--- default tmux server\n${defaultServer}`);
	release(s, "child.s1");
});

test("session_launch starts a managed pi Session that records its parent, and messaging it while dormant wakes it", async () => {
	s = scenario("phase5", "swb-host", { packages: ["pi-sessions"], recorder: true });
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the parent live", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await reply(s, "parent");
	const [parent] = s.ls().map((e) => e.id) as [string];

	s.keys("-l", "handoff h1", "Enter");
	await until(() => s.signal("child.h1.entered") !== "", budgets.piReady, "the handoff child's first turn");
	const child = await until(() => s.ls().find((e) => e.id !== parent), budgets.settle, "the child tracked");
	expect(child).toMatchObject({ harness: "pi", parentId: parent, open: true, live: true, cwd: s.project });
	await until(() => entry(s, child.id).title === "child h1", budgets.settle, "the child titled");
	expect(piSessions(s)).toHaveLength(2);
	await waitState(s, "the child on the Roster", (x) => sessionRows(x).some((r) => r.id === child.id));
	s.save("handoff-running.txt", s.screen());
	// pi to pi, mid-turn: the message steers the child's held turn, which answers it once released.
	s.keys("-l", `message ${child.id} m1`, "Enter");
	await until(
		() => s.query("select 1 from messages where target_id = ? and delivered_at is not null", child.id).length === 1,
		budgets.settle,
		"the message delivered mid-turn",
	);
	expect(entry(s, child.id).activity).toBe("working");
	release(s, "child.h1");
	await until(() => s.signal("replied.m1") !== "", budgets.settle, "the child's answer to the steer");
	await until(() => entry(s, child.id).activity === "idle", budgets.settle, "the child idle");
	// And idle: the message starts the child's next turn.
	s.keys("-l", `message ${child.id} i1`, "Enter");
	await until(() => s.signal("replied.i1") !== "", budgets.settle, "the idle child's answer");
	await until(() => entry(s, child.id).activity === "idle", budgets.settle, "the child idle again");

	const host = s.query<{ tmux_session: string }>("select tmux_session from runtimes where session_id = ?", child.id)[0]?.tmux_session;
	s.tmux(s.servers.sessions, "kill-session", "-t", `=${host}`);
	await until(() => !entry(s, child.id).live, budgets.settle, "the child dormant");
	s.keys("-l", `message ${child.id} w1`, "Enter");
	await until(() => s.signal("replied.w1") !== "", budgets.piReady, "the woken child's reply");
	expect(entry(s, child.id)).toMatchObject({ open: true, live: true });
	expect(piSessions(s)).toHaveLength(2);
	s.save("woken.txt", `${s.screen()}\n${JSON.stringify(s.ls(), null, 2)}`);

	await until(() => entry(s, child.id).activity === "idle", budgets.settle, "the woken child idle");

	// A clean quit closes the pane of a child no Deck started, as it does one a Deck did.
	const woken = s.query<{ tmux_session: string }>("select tmux_session from runtimes where session_id = ?", child.id)[0]
		?.tmux_session as string;
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${woken}:`, "-l", "archive a1");
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${woken}:`, "Enter");
	await until(() => !entry(s, child.id).open && !entry(s, child.id).live, budgets.settle, "the child archived and quit");
	await until(
		() => !s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name}").split("\n").includes(woken),
		budgets.settle,
		"the child's pane closed",
	);
	s.swb("unarchive", child.id);
	s.keys("-l", `message ${child.id} w2`, "Enter");
	await until(() => s.signal("replied.w2") !== "", budgets.piReady, "the unarchived child woken");
	expect(entry(s, child.id)).toMatchObject({ open: true, live: true });
	await until(() => entry(s, child.id).activity === "idle", budgets.settle, "the rewoken child idle");
	s.swb("archive", child.id);
	expect(s.swbTry("wake", child.id).err.trim()).toBe(`swb: wake: ${child.id} is archived; swb unarchive ${child.id}`);
});

test("a pi that dies before it's ready says failed to start, and w retries once pi works again", async () => {
	s = scenario("phase5", "failed-start");
	const [a] = (await seed(s, { turns: ["fails"] })) as [string];
	const pi = join(s.bin, "pi");
	const script = readFileSync(pi, "utf8");
	writeFileSync(pi, "#!/bin/sh\necho 'pi: broken on purpose' >&2\nexit 1\n");
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("w");
	const failed = await waitState(s, "failed", (x) => x.staged.kind === "failed", budgets.piReady);
	expect(failed.toasts).toEqual([]);
	await until(() => s.screen().includes("pi quit before it was ready"), budgets.settle, "the failed card");
	expect(s.screen().split("pi: broken on purpose")).toHaveLength(2);
	expect(entry(s, a).live).toBe(false);
	expect(piSessions(s)).toHaveLength(0);
	s.save("failed.txt", s.screen());

	writeFileSync(pi, script);
	s.keys("w");
	const retried = await waitState(s, "a live after the retry", (x) => x.staged.id === a && x.staged.kind === "live", budgets.piReady);
	const remain = () => s.tmux(s.servers.sessions, "show", "-p", "-v", "-t", `=${retried.staged.host}:`, "remain-on-exit");
	await until(() => remain() === "", budgets.settle, "remain-on-exit cleared once pi registered");
	s.save("retried.txt", s.screen());
});

test("a newer swb takes over: idle pis stop, a working one keeps its turn, and empty servers restart; an older swb leaves a newer server alone and its Deck says so", async () => {
	s = scenario("phase5", "upgrade");
	const { sessions, ui } = s.servers;
	const [a, b] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	s.swb("wake", a);
	s.swb("wake", b);
	await until(() => entry(s, a).live && entry(s, b).live, budgets.piReady, "both live");
	const hostOf = (id: string) =>
		s.query<{ tmux_session: string }>("SELECT tmux_session FROM runtimes WHERE session_id = ?", id)[0]?.tmux_session;
	const [hostA, hostB] = [hostOf(a), hostOf(b)] as [string, string];
	const draft = join(s.env.XDG_STATE_HOME as string, "agent-switchboard", "drafts", a);
	s.tmux(sessions, "send-keys", "-t", `=${hostA}:`, "-l", "half a thought");
	await until(
		() => s.tmux(sessions, "capture-pane", "-p", "-t", `=${hostA}:`).includes("half a thought"),
		budgets.settle,
		"a's draft typed",
	);
	s.tmux(sessions, "send-keys", "-t", `=${hostB}:`, "-l", "hold u1");
	s.tmux(sessions, "send-keys", "-t", `=${hostB}:`, "Enter");
	await until(() => s.signal("u1.entered") !== "", budgets.piReady, "b mid-turn");
	const names = (server: string) => s.tmux(server, "list-sessions", "-F", "#{session_name}").split("\n");
	const pid = (server: string) => s.tmux(server, "display", "-p", "#{pid}");

	for (const server of [sessions, ui]) s.tmux(server, "set", "-gu", "@swb_version");
	const uiBefore = pid(ui);
	s.swb("drive", "start");
	await waitState(s, "the Deck up", (x) => sessionRows(x).length === 2);
	expect(names(sessions)).not.toContain(hostA);
	expect(names(sessions)).toContain(hostB);
	expect(entry(s, a).live).toBe(false);
	await until(() => existsSync(draft) && readFileSync(draft, "utf8") === "half a thought", budgets.settle, "a's draft saved");
	expect(entry(s, b).activity).toBe("working");
	expect(s.tmux(sessions, "show", "-gv", "@swb_version")).toBe(VERSION);
	expect(pid(ui)).not.toBe(uiBefore);
	release(s, "u1");
	await until(() => entry(s, b).activity === "idle", budgets.settle, "b's turn done");
	s.save("upgraded.txt", s.screen());

	s.tmux(sessions, "set", "-g", "@swb_version", "99.0.0");
	await until(() => s.screen().includes("swb 99.0.0 is in; reopen the Deck"), budgets.settle, "the outdated Deck warning");
	s.save("outdated.txt", s.screen());
	s.swb("wake", a);
	expect(s.tmux(sessions, "show", "-gv", "@swb_version")).toBe("99.0.0");
	await until(
		() => entry(s, a).live && s.tmux(sessions, "capture-pane", "-p", "-t", `=${hostOf(a)}:`).includes("half a thought"),
		budgets.piReady,
		"a's draft back",
	);
	s.save("draft-restored.txt", s.tmux(sessions, "capture-pane", "-p", "-t", `=${hostOf(a)}:`));
	expect(existsSync(draft)).toBe(false);

	s.swb("drive", "stop");
	// The Deck takes its placeholder down after drive stop returns; killing it here too would race that.
	await until(
		() => names(ui).every((name) => name === "swb-ctl") && !names(sessions).some((name) => name.startsWith("placeholder-")),
		budgets.settle,
		"the Deck and its placeholder gone",
	);
	for (const name of names(sessions)) if (name !== "swb-ctl") s.tmux(sessions, "kill-session", "-t", `=${name}`);
	for (const server of [sessions, ui]) s.tmux(server, "set", "-gu", "@swb_version");
	const before = [pid(sessions), pid(ui)];
	s.swb("drive", "start");
	await waitState(s, "the Deck up again", (x) => sessionRows(x).length === 2);
	expect([pid(sessions), pid(ui)]).not.toContain(before[0]);
	expect(pid(ui)).not.toBe(before[1]);
});

test("cleanup leaves nothing running: a Deck open on a live pi can't restart the sessions server, and a late gc can't recreate the db", async () => {
	s = scenario("phase6", "cleanup");
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the new pi live with the keyboard", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await reply(s, "one");
	const root = dirname(s.env.HOME as string);
	const server = Number(s.tmux(s.servers.sessions, "display", "-p", "#{pid}"));

	await s.cleanup();
	// Past a Deck worker's tick, which restarts a sessions server it finds down.
	await Bun.sleep(1000);
	expect(alive(server)).toBe(false);
	const flag = `-L ${s.servers.sessions}`;
	const procs = Bun.spawnSync(["ps", "-eo", "args="]).stdout.toString().split("\n");
	expect(procs.filter((args) => args.includes(`${flag} `) || args.endsWith(flag))).toEqual([]);
	expect(existsSync(root)).toBe(false);

	// The sessions server's session-closed hook, landing after its world is gone, fails instead of bringing it back.
	const gc = Bun.spawnSync([join(repo, "dist/swb"), "gc"], { env: s.env, cwd: "/", stderr: "pipe" });
	expect(gc.exitCode).not.toBe(0);
	expect(existsSync(root)).toBe(false);
});
