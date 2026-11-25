import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answered, host, launched, pane, ready, settled, type } from "./harness/agents.ts";
import { config, cursorTo, entry, reply, waitState } from "./harness/deck.ts";
import { budgets, git, gitRepo, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
	} catch {}
	try {
		for (const { session_id, tmux_session } of s.query<{ session_id: string; tmux_session: string }>(
			"select session_id, tmux_session from runtimes",
		))
			s.save(`pane-${session_id}.txt`, s.tmux(s.servers.sessions, "capture-pane", "-p", "-J", "-S", "-200", "-t", s.pane(tmux_session)));
		s.save("ls.json", JSON.stringify(s.ls(), null, 2));
		for (const harness of ["claude", "codex"] as const) s.save(`${harness}-requests.json`, JSON.stringify(s.requests(harness), null, 1));
	} catch {}
	await s.cleanup();
});

const pid = (id: string) => s.query<{ pid: number }>("select pid from runtimes where session_id = ?", id)[0]?.pid;

function setGroup(id: string, group: string | null): void {
	const proc = Bun.spawnSync([`${s.bin}/swb`, "update", "--from", id], {
		env: s.env,
		cwd: s.project,
		stdin: new Blob([JSON.stringify({ group })]),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) throw new Error(`swb update group failed: ${proc.stderr.toString()}`);
}

function transcript(id: string): string {
	const [row] = s.query<{ t: string }>("select transcript as t from sessions where session_id = ?", id) as [{ t: string }];
	return row.t;
}

async function restartedIn(id: string, beforePid: number | undefined, dest: string, what: string): Promise<void> {
	const target = realpathSync(dest);
	await until(
		() => {
			const e = entry(s, id);
			return e.live && e.activity === "idle" && e.cwd === target && pid(id) !== beforePid;
		},
		ready,
		what,
	);
}

test("native pi /mv and /wt work without pi-wt installed, using 0 LLM tokens", async () => {
	s = scenario("worktrees", "pi-native-slash", { packages: [], recorder: true });
	gitRepo(s, s.project);
	const project = realpathSync(s.project);
	const elsewhere = join(s.root, "elsewhere");
	mkdirSync(elsewhere);
	const elsewhereReal = realpathSync(elsewhere);

	s.swb("drive", "start", "--", "new");
	const st = await waitState(s, "pi live with keyboard", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await reply(s, "native-start");
	const id = st.staged.id as string;
	const origTranscript = transcript(id);

	// Group the session so cross-project /mv verifies group clearing.
	setGroup(id, "focus");
	expect(entry(s, id).group).toBe("focus");

	// /wt list works in-place without moving or calling the LLM.
	const promptsBefore = (s.query<{ n: number }>("select last_prompt_at as n from sessions where session_id = ?", id)[0] as { n: number }).n;
	s.keys("-l", "\x1b[200~/wt list\x1b[201~", "Enter");
	await until(() => pane(s, id).includes("main"), budgets.settle, "/wt list output");
	expect(entry(s, id).cwd).toBe(project);
	expect((s.query<{ n: number }>("select last_prompt_at as n from sessions where session_id = ?", id)[0] as { n: number }).n).toBe(
		promptsBefore,
	);

	// /wt fork creates a worktree and moves pi into it (same project, keeps group).
	const pidBeforeFork = pid(id);
	s.keys("-l", "\x1b[200~/wt fork feat-native\x1b[201~", "Enter");
	await until(
		() => {
			const e = entry(s, id);
			return e.live && e.activity === "idle" && e.branch === "feat-native" && pid(id) !== pidBeforeFork;
		},
		ready,
		"pi moved into feat-native worktree",
	);
	const wtPath = entry(s, id).cwd;
	expect(wtPath).not.toBe(project);
	expect(entry(s, id)).toMatchObject({ project, branch: "feat-native", group: "focus", live: true });
	expect(existsSync(origTranscript)).toBe(false);
	expect(existsSync(transcript(id))).toBe(true);
	await until(() => pane(s, id).includes("native-start"), budgets.settle, "conversation preserved after /wt fork");

	// /wt merge --staged merges back to main, removes the worktree, and moves pi back to main.
	writeFileSync(join(wtPath, "hello.txt"), "from feat-native\n");
	git(s, wtPath, "add", "hello.txt");
	git(s, wtPath, "commit", "-q", "-m", "add hello");
	const pidBeforeMerge = pid(id);
	s.keys("-l", "\x1b[200~/wt merge --staged\x1b[201~", "Enter");
	await restartedIn(id, pidBeforeMerge, project, "pi returned to main after /wt merge");
	expect(existsSync(wtPath)).toBe(false);
	expect(existsSync(join(project, "hello.txt"))).toBe(true);

	// /mv moves cross-project, clears group, and preserves conversation.
	const pidBeforeMv = pid(id);
	s.keys("-l", `\x1b[200~/mv ${elsewhere}\x1b[201~`, "Enter");
	await restartedIn(id, pidBeforeMv, elsewhereReal, "pi moved to elsewhere");
	expect(entry(s, id)).toMatchObject({ cwd: elsewhereReal, project: elsewhereReal, group: null, live: true });
	expect((s.query<{ n: number }>("select last_prompt_at as n from sessions where session_id = ?", id)[0] as { n: number }).n).toBe(
		promptsBefore,
	);
});

test("Claude Code native unprefixed /mv and /wt run with 0 LLM tokens", async () => {
	s = scenario("worktrees", "claude-native-slash", { packages: [], recorder: true, harnesses: ["claude"] });
	gitRepo(s, s.project);
	const project = realpathSync(s.project);
	const elsewhere = join(s.root, "elsewhere");
	mkdirSync(elsewhere);
	const elsewhereReal = realpathSync(elsewhere);

	const claude = await launched(s, "claude", "reply claude-ready");
	const reqsBefore = s.requests("claude").length;

	// /wt list runs without an LLM call.
	type(s, claude.id, "/wt list");
	await until(() => pane(s, claude.id).includes("main"), budgets.settle, "Claude /wt list output");
	expect(s.requests("claude").length).toBe(reqsBefore);

	// /wt fork creates worktree and restarts Claude there with 0 LLM tokens.
	const pidBeforeFork = pid(claude.id);
	type(s, claude.id, "/wt fork cc-slash");
	await until(
		() => {
			const e = entry(s, claude.id);
			return e.live && e.activity === "idle" && e.branch === "cc-slash" && pid(claude.id) !== pidBeforeFork;
		},
		ready,
		"Claude moved into cc-slash worktree",
	);
	expect(entry(s, claude.id)).toMatchObject({ project, branch: "cc-slash", live: true });
	expect(s.requests("claude").length).toBe(reqsBefore);

	// /mv moves Claude cross-project with 0 LLM tokens.
	const pidBeforeMv = pid(claude.id);
	type(s, claude.id, `/mv ${elsewhere}`);
	await restartedIn(claude.id, pidBeforeMv, elsewhereReal, "Claude moved to elsewhere via /mv");
	expect(entry(s, claude.id)).toMatchObject({ cwd: elsewhereReal, project: elsewhereReal, live: true });
	expect(s.requests("claude").length).toBe(reqsBefore);
});

test("swb_move_session moves pi, Claude Code, and Codex with wake prompt, and Operators cannot move", async () => {
	s = scenario("worktrees", "agent-move-all", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const destPi = join(s.root, "dest-pi");
	const destClaude = join(s.root, "dest-claude");
	const destCodex = join(s.root, "dest-codex");
	mkdirSync(destPi);
	mkdirSync(destClaude);
	mkdirSync(destCodex);

	const [piS, claudeS, codexS] = await Promise.all([
		launched(s, "pi", "reply pi-up"),
		launched(s, "claude", "reply claude-up"),
		launched(s, "codex", "reply codex-up"),
	]);

	for (const session of [piS, claudeS, codexS]) setGroup(session.id, "moving");

	const [piPid, claudePid, codexPid] = [pid(piS.id), pid(claudeS.id), pid(codexS.id)];
	const since = Date.now();
	type(s, piS.id, `discover swb_move_session ${JSON.stringify({ cwd: destPi })}`);
	type(s, claudeS.id, `discover swb_move_session ${JSON.stringify({ cwd: destClaude })}`);
	type(s, codexS.id, `discover swb_move_session ${JSON.stringify({ cwd: destCodex })}`);

	await Promise.all([
		restartedIn(piS.id, piPid, destPi, "pi restarted in dest-pi"),
		restartedIn(claudeS.id, claudePid, destClaude, "Claude restarted in dest-claude"),
		restartedIn(codexS.id, codexPid, destCodex, "Codex restarted in dest-codex"),
	]);

	// All three woke with the Session moved prompt and cleared their cross-project group.
	await until(() => s.signal("moved.prompt").includes(realpathSync(destPi)), ready, "pi received move wake prompt");
	await until(
		() => s.requests("claude").some((r) => String(r.prompt).includes(`Session moved to ${realpathSync(destClaude)}.`)),
		ready,
		"Claude received move wake prompt",
	);
	await until(
		() => s.requests("codex").some((r) => JSON.stringify(r.texts).includes(`Session moved to ${realpathSync(destCodex)}.`)),
		ready,
		"Codex received move wake prompt",
	);
	await Promise.all([
		settled(s, piS.id, "pi settled after move", since),
		settled(s, claudeS.id, "Claude settled after move", since),
		settled(s, codexS.id, "Codex settled after move", since),
	]);

	expect(entry(s, piS.id)).toMatchObject({ cwd: realpathSync(destPi), project: realpathSync(destPi), group: null, live: true });
	expect(entry(s, claudeS.id)).toMatchObject({ cwd: realpathSync(destClaude), project: realpathSync(destClaude), group: null, live: true });
	expect(entry(s, codexS.id)).toMatchObject({ cwd: realpathSync(destCodex), project: realpathSync(destCodex), group: null, live: true });

	// CLI refusals: nonexistent directory, non-directory file, same directory, and Operator sessions.
	const file = join(s.root, "not-a-dir.txt");
	writeFileSync(file, "x");
	expect(s.swbTry("move", piS.id, join(s.root, "missing"))).toMatchObject({ code: 1, err: expect.stringContaining("does not exist") });
	expect(s.swbTry("move", piS.id, file)).toMatchObject({ code: 1, err: expect.stringContaining("Not a directory") });
	expect(s.swbTry("move", piS.id, destPi)).toMatchObject({ code: 1, err: expect.stringContaining("Already in") });

	// Operators do not get move or worktree tools and cannot be moved.
	const operatorDir = join(s.env.XDG_CONFIG_HOME as string, "agent-switchboard", "operator");
	mkdirSync(operatorDir, { recursive: true });
	const opOut = JSON.parse(
		await Bun.spawn([`${s.bin}/swb`, "launch", "--harness", "pi", "--cwd", operatorDir, "--title", "Op"], {
			env: s.env,
			cwd: s.project,
			stdin: new Blob(["tools op"]),
			stdout: "pipe",
			stderr: "inherit",
		}).stdout.text(),
	) as { details: { id: string } };
	await until(() => s.signal("tools.op") !== "", ready, "Operator tools recorded");
	const opTools = JSON.parse(s.signal("tools.op")) as string[];
	expect(opTools).not.toContain("swb_move_session");
	expect(opTools.some((t) => t.startsWith("swb_worktree_"))).toBe(false);
	expect(s.swbTry("move", opOut.details.id, destPi)).toMatchObject({ code: 1, err: expect.stringContaining("Operator") });
});

test("deferred swb_worktree_* tools are discovered via tool_search/ToolSearch across pi, Claude Code, and Codex, and enforce safety guards", async () => {
	s = scenario("worktrees", "agent-worktree-all", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	gitRepo(s, s.project);
	const project = realpathSync(s.project);

	const [piS, claudeS, codexS] = await Promise.all([
		launched(s, "pi", "tools pi-init"),
		launched(s, "claude", "reply claude-init"),
		launched(s, "codex", "reply codex-init"),
	]);

	// Deferred check: move and worktree tools are NOT upfront active in pi; tool_search IS active.
	const piActive = JSON.parse(s.signal("tools.pi-init")) as string[];
	expect(piActive).not.toContain("swb_move_session");
	expect(piActive).toContain("tool_search");
	expect(piActive.some((t) => t.startsWith("swb_worktree_"))).toBe(false);

	// Deferred check: Claude Code defers swb_move_session and all 6 swb_worktree_* tools behind ToolSearch.
	const claudeInit = s.requests("claude").find((r) => Array.isArray(r.tools) && r.tools.length > 0);
	const claudeTools = (claudeInit?.tools ?? []) as string[];
	expect(claudeTools.some((t) => t.endsWith("__swb_move_session"))).toBe(false);
	expect(claudeTools.some((t) => t.includes("__swb_worktree_"))).toBe(false);
	const claudeCtx = String(claudeInit?.context ?? "");
	expect(claudeCtx).toContain("mcp__plugin_swb_swb__swb_move_session");
	for (const name of ["list", "fork", "checkout", "merge", "remove", "rebranch"]) {
		expect(claudeCtx).toContain(`mcp__plugin_swb_swb__swb_worktree_${name}`);
	}
	expect(claudeCtx).not.toContain("swb_worktree_rebase");

	// Deferred check: Codex hides swb_move_session and swb_worktree_* behind tool_search.
	const codexInit = s.requests("codex").find((r) => Array.isArray(r.tools) && r.tools.length > 0);
	const codexTools = (codexInit?.tools ?? []) as string[];
	expect(codexTools).not.toContain("swb_move_session");
	expect(codexTools.some((t) => t.startsWith("swb_worktree_"))).toBe(false);

	// 1. pi discovers and calls swb_worktree_fork (move_session: true), swb_worktree_list, swb_worktree_rebranch, swb_worktree_merge.
	const piPidBeforeFork = pid(piS.id);
	type(s, piS.id, `discover swb_worktree_fork ${JSON.stringify({ name: "pi-wt", clean: false, move_session: true })}`);
	await until(
		() => {
			const e = entry(s, piS.id);
			return e.live && e.activity === "idle" && e.branch === "pi-wt" && pid(piS.id) !== piPidBeforeFork;
		},
		ready,
		"pi forked and moved into pi-wt",
	);
	const piWtPath = entry(s, piS.id).cwd;
	expect(piWtPath).not.toBe(project);

	// 2. Claude Code discovers and calls swb_worktree_fork (move_session: false -> stays in main) and swb_worktree_list.
	const claudePidBefore = pid(claudeS.id);
	const claudeForkAt = type(
		s,
		claudeS.id,
		`discover swb_worktree_fork ${JSON.stringify({ name: "cc-stay", clean: true, move_session: false })}`,
	);
	await answered(s, claudeS.id, "tool done", "Claude forked without moving", claudeForkAt);
	expect(entry(s, claudeS.id).cwd).toBe(project);
	expect(pid(claudeS.id)).toBe(claudePidBefore);
	const claudeListAt = type(s, claudeS.id, `discover swb_worktree_list ${JSON.stringify({})}`);
	await answered(s, claudeS.id, "tool done", "Claude listed worktrees", claudeListAt);
	expect(s.requests("claude").some((r) => String(r.toolOutput).includes("cc-stay") && String(r.toolOutput).includes(piWtPath))).toBe(true);

	// Cross-session safety guard: Claude cannot remove pi-wt while piS is open in it.
	const claudeGuardAt = type(s, claudeS.id, `discover swb_worktree_remove ${JSON.stringify({ name: "pi-wt", preserve_branch: false })}`);
	await answered(s, claudeS.id, "tool done", "Claude remove refused by cross-session guard", claudeGuardAt);
	expect(s.requests("claude").some((r) => String(r.toolOutput).includes("still used by"))).toBe(true);
	expect(existsSync(piWtPath)).toBe(true);

	// 3. Codex discovers and calls swb_worktree_checkout (move_session: true) on a branch, then swb_worktree_remove (preserve_branch: true).
	git(s, project, "branch", "codex-branch");
	const codexPidBeforeCo = pid(codexS.id);
	type(s, codexS.id, `discover swb_worktree_checkout ${JSON.stringify({ branch: "codex-branch", move_session: true })}`);
	await until(
		() => {
			const e = entry(s, codexS.id);
			return e.live && e.activity === "idle" && e.branch === "codex-branch" && pid(codexS.id) !== codexPidBeforeCo;
		},
		ready,
		"Codex checked out and moved into codex-branch",
	);
	const codexWtPath = entry(s, codexS.id).cwd;
	expect(codexWtPath).not.toBe(project);

	const codexPidBeforeRm = pid(codexS.id);
	type(s, codexS.id, `discover swb_worktree_remove ${JSON.stringify({ name: "codex-branch", preserve_branch: true })}`);
	await restartedIn(codexS.id, codexPidBeforeRm, project, "Codex returned to main after removing its own worktree");
	expect(existsSync(codexWtPath)).toBe(false);
	expect(git(s, project, "branch", "--list", "codex-branch")).toContain("codex-branch");

	// 4. pi rebranches pi-wt -> pi-rebranched (simulating a landed PR whose remote branch was deleted), commits a file, and merges back to main.
	const bareOrigin = join(s.root, "origin.git");
	git(s, s.root, "init", "--bare", "-q", bareOrigin);
	git(s, project, "remote", "add", "origin", bareOrigin);
	git(s, project, "push", "-q", "-u", "origin", "main");
	git(s, piWtPath, "push", "-q", "-u", "origin", "pi-wt");
	git(s, piWtPath, "push", "-q", "origin", "--delete", "pi-wt");
	git(s, project, "fetch", "-q", "--prune");
	const piPidBeforeRebranch = pid(piS.id);
	type(s, piS.id, `call swb_worktree_rebranch ${JSON.stringify({ name: "pi-wt", branch: "pi-rebranched" })}`);
	await until(
		() => {
			const e = entry(s, piS.id);
			return e.live && e.activity === "idle" && e.branch === "pi-rebranched" && pid(piS.id) !== piPidBeforeRebranch;
		},
		ready,
		"pi rebranched to pi-rebranched",
	);
	const rebranchedPath = entry(s, piS.id).cwd;
	writeFileSync(join(rebranchedPath, "merged.txt"), "from rebranch\n");
	git(s, rebranchedPath, "add", "merged.txt");
	git(s, rebranchedPath, "commit", "-q", "-m", "rebranched commit");
	const piPidBeforeMerge = pid(piS.id);
	type(s, piS.id, `call swb_worktree_merge ${JSON.stringify({ name: "pi-rebranched", mode: "staged" })}`);
	await restartedIn(piS.id, piPidBeforeMerge, project, "pi merged and returned to main");
	expect(existsSync(rebranchedPath)).toBe(false);
	expect(existsSync(join(project, "merged.txt"))).toBe(true);
});

test("Deck m opens Move menu in git repos (dirty merge disables rebase/squash) and skips straight to directory picker outside git", async () => {
	s = scenario("worktrees", "deck-move", { packages: [], recorder: true });
	const plainDir = join(s.root, "plain");
	const otherDir = join(s.root, "other");
	mkdirSync(plainDir);
	mkdirSync(otherDir);
	gitRepo(s, s.project);
	const project = realpathSync(s.project);
	const plainReal = realpathSync(plainDir);
	const otherReal = realpathSync(otherDir);
	config(s, `[dirs]\ninclude = [${JSON.stringify(plainReal)}, ${JSON.stringify(otherReal)}]\n`);

	// Launch one session in the git repo and one outside git.
	const gitSession = await launched(s, "pi", "reply in-git");
	const plainOut = JSON.parse(
		await Bun.spawn([`${s.bin}/swb`, "launch", "--harness", "pi", "--cwd", plainDir, "--title", "Plain"], {
			env: s.env,
			cwd: plainDir,
			stdin: new Blob(["reply in-plain"]),
			stdout: "pipe",
			stderr: "inherit",
		}).stdout.text(),
	) as { details: { id: string } };
	await settled(s, plainOut.details.id, "plain session idle", 0);
	const plainId = plainOut.details.id;

	s.swb("drive", "start", "--size", "160x40");
	await waitState(s, "deck ready", (x) => x.ready);

	// Verify g opens Group (remapped from m).
	await cursorTo(s, gitSession.id);
	s.keys("g");
	await waitState(s, "group overlay", (x) => x.mode === "name");
	expect(s.screen()).toContain("Group");
	s.keys("Escape");
	await waitState(s, "roster", (x) => x.mode === "roster");

	// Outside git: m skips straight to directory picker (`move session to`), no Launch card.
	await cursorTo(s, plainId);
	const plainPid = pid(plainId);
	s.keys("m");
	await waitState(s, "directory picker for move", (x) => x.mode === "picker");
	expect(s.screen()).toContain("move session to");
	expect(s.screen()).not.toContain("Launch");
	s.keys("-l", "other");
	await waitState(s, "other selected in picker", (x) => x.picker?.rows[x.picker.choice]?.path === otherReal);
	s.keys("Enter");
	await restartedIn(plainId, plainPid, otherReal, "plain session moved via Deck picker");
	expect(entry(s, plainId)).toMatchObject({ cwd: otherReal, project: otherReal, live: true });

	// Dormant session outside git also moves cleanly via Deck m.
	s.tmux(s.servers.sessions, "kill-pane", "-t", s.pane(host(s, plainId)));
	await until(() => !entry(s, plainId).live, budgets.settle, "plain session dormant");
	await cursorTo(s, plainId);
	s.keys("m");
	await waitState(s, "directory picker for dormant move", (x) => x.mode === "picker");
	s.keys("-l", "plain");
	await waitState(s, "plain selected in picker", (x) => x.picker?.rows[x.picker.choice]?.path === plainReal);
	s.keys("Enter");
	await until(() => entry(s, plainId).cwd === plainReal, budgets.settle, "dormant session moved");
	expect(entry(s, plainId)).toMatchObject({ cwd: plainReal, project: plainReal, live: false });

	// Inside git repo with wt: m opens Move menu (`Move · ⎇ main`), Fork sub-form creates worktree & moves session.
	await cursorTo(s, gitSession.id);
	const gitPidBeforeFork = pid(gitSession.id);
	s.keys("m");
	await waitState(s, "move menu", (x) => x.mode === "move");
	await until(() => s.screen().includes("Move · ⎇ main") && s.screen().includes("Fork"), budgets.settle, "Move menu loaded");
	s.save("move-menu.txt", s.screen());
	s.keys("2");
	await waitState(s, "Fork sub-form", (x) => x.move?.step === "fork");
	s.keys("-l", "deck-feat");
	s.keys("Enter");
	await until(
		() => {
			const e = entry(s, gitSession.id);
			return e.live && e.activity === "idle" && e.branch === "deck-feat" && pid(gitSession.id) !== gitPidBeforeFork;
		},
		ready,
		"git session moved into deck-feat worktree",
	);
	const deckWt = entry(s, gitSession.id).cwd;

	// Make deck-feat dirty and open Merge sub-form: Rebase and Squash are dimmed/disabled (`requires clean tree`), Staged works.
	writeFileSync(join(deckWt, "dirty.txt"), "uncommitted change\n");
	// Start a second open session inside deck-feat: Deck Merge must refuse BEFORE mutating main.
	const bystanderOut = JSON.parse(
		await Bun.spawn([`${s.bin}/swb`, "launch", "--harness", "pi", "--cwd", deckWt, "--title", "Bystander"], {
			env: s.env,
			cwd: deckWt,
			stdin: new Blob(["reply bystander"]),
			stdout: "pipe",
			stderr: "inherit",
		}).stdout.text(),
	) as { details: { id: string } };
	await settled(s, bystanderOut.details.id, "bystander idle", 0);
	await cursorTo(s, gitSession.id);
	s.keys("m");
	await waitState(s, "move menu in worktree", (x) => x.mode === "move");
	await until(() => s.screen().includes("Move · ⎇ deck-feat") && s.screen().includes("Merge"), budgets.settle, "Worktree Move menu");
	s.keys("4");
	await waitState(s, "Merge sub-form", (x) => x.move?.step === "merge");
	await until(() => s.screen().includes("requires clean tree"), budgets.settle, "Dirty merge warning and disabled options");
	s.save("move-merge-dirty.txt", s.screen());
	s.keys("Enter");
	await until(() => s.screen().includes("still used by"), budgets.settle, "Deck merge refused while bystander is open");
	expect(existsSync(join(project, "dirty.txt"))).toBe(false);
	expect(existsSync(deckWt)).toBe(true);

	// Archive the bystander, then Merge succeeds cleanly and returns session to main.
	s.swb("archive", bystanderOut.details.id);
	await cursorTo(s, gitSession.id);
	s.keys("m");
	await waitState(s, "move menu in worktree after archive", (x) => x.mode === "move");
	await until(() => s.screen().includes("Move · ⎇ deck-feat") && s.screen().includes("Merge"), budgets.settle, "Worktree Move menu");
	s.keys("4");
	await waitState(s, "Merge sub-form after archive", (x) => x.move?.step === "merge");
	const gitPidBeforeMerge = pid(gitSession.id);
	s.keys("Enter");
	await restartedIn(gitSession.id, gitPidBeforeMerge, project, "git session merged back to main");
	expect(existsSync(deckWt)).toBe(false);
	expect(existsSync(join(project, "dirty.txt"))).toBe(true);
});
