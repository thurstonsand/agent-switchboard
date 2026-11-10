import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { host } from "./harness/agents.ts";
import { cursorTo, entry, launched, reply, state, waitState } from "./harness/deck.ts";
import { budgets, git, gitRepo, gitWorktree, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
		s.save("final-ls.json", JSON.stringify(s.ls(), null, 2));
	} catch {}
	await s.cleanup();
});

function transcript(id: string): string {
	const [row] = s.query<{ t: string }>("select transcript as t from sessions where session_id = ?", id) as [{ t: string }];
	return row.t;
}

/** A live session on the Stage with the keyboard and one turn in, then moved by a pi-wt command until swb follows it somewhere new. */
async function moved(command: string): Promise<{ id: string; from: string; cwd: string }> {
	s.swb("drive", "start", "--", "new");
	const st = await waitState(
		s,
		"the new pi live with the keyboard",
		(x) => x.staged.kind === "live" && x.focus === "stage",
		budgets.piReady,
	);
	await reply(s, "before the move");
	const id = st.staged.id as string;
	const from = transcript(id);
	s.save("before.txt", s.screen());
	s.keys("-l", command, "Enter");
	const { cwd } = await until(
		() => entry(s, id).cwd !== s.project && entry(s, id),
		budgets.settle,
		`swb following the session after ${command}`,
	);
	s.save("after.txt", s.screen());
	return { id, from, cwd };
}

/** Quits the moved session's pi, then wakes it from the roster: it must come back where it went, with its conversation. */
async function wakesWhereItWent(id: string, cwd: string): Promise<void> {
	const host = state(s).staged.host as string;
	s.tmux(s.servers.sessions, "kill-pane", "-t", s.pane(host));
	await waitState(s, "the exited card", (x) => x.staged.id === id && x.staged.kind === "exited");
	await until(() => s.screen().includes("before the move"), budgets.settle, "the conversation on the exited card");
	s.save("exited.txt", s.screen());
	s.keys("w");
	await waitState(s, "woken", (x) => x.staged.id === id && x.staged.kind === "live", budgets.piReady);
	const shown = cwd.replace(s.env.HOME as string, "~");
	await until(() => s.screen().includes(shown) && s.screen().includes("before the move"), budgets.settle, "pi back in the new directory");
	s.save("woken.txt", s.screen());
	expect(s.query<{ cwd: string }>("select cwd from runtimes where session_id = ?", id)).toEqual([{ cwd }]);
	expect(s.ls().map((e) => e.id)).toEqual([id]);
}

test("/mv to another directory: swb follows the session there, into that directory's project, and it wakes there with its conversation", async () => {
	s = scenario("phase6", "mv", { packages: ["@thurstonsand/pi-wt"], recorder: true });
	const elsewhere = join(s.root, "elsewhere");
	mkdirSync(elsewhere);
	const { id, from, cwd } = await moved(`/mv ${elsewhere}`);
	expect(cwd).toBe(elsewhere);
	expect(existsSync(from)).toBe(false);
	await until(() => existsSync(transcript(id)), budgets.settle, "the transcript column pointing at the moved file");
	expect(entry(s, id)).toMatchObject({ cwd: elsewhere, project: elsewhere, open: true, live: true });
	await wakesWhereItWent(id, elsewhere);
});

test("a session whose directory is gone wakes into its own transcript from its project, never a fresh session under its id", async () => {
	s = scenario("phase6", "gone-cwd", { packages: [], recorder: true });
	gitRepo(s, s.project);
	const worktree = gitWorktree(s, s.project, "feature");
	s.swb("drive", "start", "--", "new", "--cwd", worktree);
	const st = await waitState(
		s,
		"the new pi live with the keyboard",
		(x) => x.staged.kind === "live" && x.focus === "stage",
		budgets.piReady,
	);
	const id = st.staged.id as string;
	await reply(s, "before the move");
	s.tmux(s.servers.sessions, "kill-pane", "-t", s.pane(st.staged.host as string));
	await waitState(s, "the exited card", (x) => x.staged.id === id && x.staged.kind === "exited");
	git(s, s.project, "worktree", "remove", "--force", worktree);
	s.keys("Enter");
	await waitState(s, "woken", (x) => x.staged.id === id && x.staged.kind === "live", budgets.piReady);
	await until(() => s.screen().includes("before the move"), budgets.settle, "the conversation, continued in the project");
	await until(() => s.screen().includes("This conversation moved from"), budgets.settle, "relocation notice");
	s.save("woken.txt", s.screen());
	expect(s.query<{ cwd: string }>("select cwd from runtimes where session_id = ?", id)).toEqual([{ cwd: realpathSync(s.project) }]);
	expect(s.ls().map((e) => e.id)).toEqual([id]);
});

test("a session resumed with Continue at pi's prompt for its gone directory wakes there, past the prompt", async () => {
	s = scenario("phase6", "continued-cwd", { packages: [], recorder: true });
	gitRepo(s, s.project);
	const worktree = gitWorktree(s, s.project, "feature");
	s.swb("drive", "start", "--", "new", "--cwd", worktree);
	const gone = await waitState(s, "pi live in the worktree", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	const id = gone.staged.id as string;
	await reply(s, "SWB-in-the-worktree");
	s.tmux(s.servers.sessions, "kill-pane", "-t", s.pane(gone.staged.host as string));
	await until(() => !entry(s, id).live, budgets.settle, "dormant");
	git(s, s.project, "worktree", "remove", "--force", worktree);

	s.swb("drive", "stop");
	s.swb("drive", "start", "--", "new");
	const other = await waitState(
		s,
		"another pi live in the project",
		(x) => x.staged.kind === "live" && x.focus === "stage" && x.staged.id !== id,
		budgets.piReady,
	);
	await reply(s, "SWB-in-the-project");
	s.keys("-l", "/resume");
	s.keys("Enter");
	await until(() => s.screen().includes("Resume Session (Current Folder)"), budgets.settle, "pi's session selector");
	s.keys("Tab");
	s.keys("-l", "SWB-in-the-worktree");
	await until(() => s.screen().includes("› reply SWB-in-the-worktree"), budgets.settle, "the worktree's session selected");
	s.keys("Enter");
	await until(() => s.screen().includes(`Session cwd does not exist: ${worktree}`), budgets.settle, "pi's prompt");
	s.keys("Enter");
	await until(() => entry(s, id).live, budgets.settle, "continued in the project");
	const project = realpathSync(s.project);
	expect(entry(s, id).cwd).toBe(project);

	s.tmux(s.servers.sessions, "kill-pane", "-t", s.pane(other.staged.host as string));
	await until(() => !entry(s, id).live, budgets.settle, "dormant again");
	s.swb("wake", id);
	await until(() => entry(s, id).live, budgets.piReady, "woken past pi's prompt");
	expect(JSON.parse(readFileSync(transcript(id), "utf8").split("\n")[0] as string).cwd).toBe(project);
	expect(s.query<{ cwd: string }>("select cwd from runtimes where session_id = ?", id)).toEqual([{ cwd: project }]);
});

test("/wt fork: swb follows the session into the new worktree, in the same project, and it wakes there", async () => {
	s = scenario("phase6", "wt-fork", { packages: ["@thurstonsand/pi-wt"], recorder: true });
	git(s, s.project, "init", "-q", "-b", "main");
	git(s, s.project, "commit", "-q", "--allow-empty", "-m", "init");
	const { id, cwd: worktree } = await moved("/wt fork feature");
	const worktrees = git(s, s.project, "worktree", "list", "--porcelain")
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
	expect(worktrees).toEqual([realpathSync(s.project), worktree]);
	expect(entry(s, id)).toMatchObject({ cwd: worktree, branch: "feature", project: realpathSync(s.project), live: true });
	await wakesWhereItWent(id, worktree);
});

test("a bare clone's worktrees are Projects of their own, and a submodule's are its: -c and a wake's fallback stay inside them", async () => {
	s = scenario("phase6", "bare-submodule", { packages: [], recorder: true });
	mkdirSync(join(s.root, "code"));
	const code = realpathSync(join(s.root, "code"));
	const src = gitRepo(s, join(code, "src"));
	git(s, code, "clone", "-q", "--bare", src, "proj.git");
	const a = gitWorktree(s, join(code, "proj.git"), "a", join(code, "proj-a"));
	const b = gitWorktree(s, join(code, "proj.git"), "b", join(code, "proj-b"));
	const superproject = gitRepo(s, join(code, "super"));
	git(s, superproject, "-c", "protocol.file.allow=always", "submodule", "add", "-q", src, "sub");
	const sub = join(superproject, "sub");
	const side = gitWorktree(s, sub, "side", join(code, "sub-side"));
	const inA = await launched(s, "reply in-a", { cwd: a });
	const inB = await launched(s, "reply in-b", { cwd: b });
	const inSub = await launched(s, "reply in-sub", { cwd: sub });
	const inSide = await launched(s, "reply in-side", { cwd: side });
	expect([inA, inB, inSub, inSide].map((id) => entry(s, id).project)).toEqual([a, b, sub, sub]);

	// -c from inside one of the bare clone's worktrees finds its session, not the other's, which ran last.
	Bun.spawnSync([join(s.bin, "swb"), "drive", "start", "--", "-c"], { env: s.env, cwd: a });
	await waitState(s, "-c on a's session", (x) => x.staged.id === inA, budgets.piReady);
	s.save("continued.txt", s.screen());
	// Its own Project, and still a linked worktree, whose archive can delete it.
	s.keys("M-a", "h");
	await waitState(s, "the roster's keyboard", (x) => x.focus === "roster");
	await cursorTo(s, inA);
	s.keys("a");
	await waitState(s, "archive choice", (x) => x.mode === "archive");
	await until(() => s.screen().includes("Archive; delete worktree"), budgets.settle, "the delete button");
	s.save("archive-prompt.txt", s.screen());
	s.keys("Escape");
	s.swb("drive", "stop");

	for (const id of [inB, inSide]) {
		s.tmux(s.servers.sessions, "kill-session", "-t", `=${host(s, id)}`);
		await until(() => !entry(s, id).live, budgets.settle, "dormant");
	}
	git(s, join(code, "proj.git"), "worktree", "remove", "--force", b);
	git(s, sub, "worktree", "remove", "--force", side);
	// A bare clone has no checkout to fall back to, never the directory that holds it.
	const refused = s.swbTry("wake", inB);
	expect(refused.code).not.toBe(0);
	expect(refused.err).toContain(`session directory ${b} and Project root ${b} are unavailable`);
	expect(entry(s, inB).live).toBe(false);
	// A submodule's worktree falls back to the submodule's checkout, never its git directory under the superproject's.
	s.swb("wake", inSide);
	await until(() => entry(s, inSide).live, budgets.piReady, "woken in the submodule");
	expect(s.query<{ cwd: string }>("select cwd from runtimes where session_id = ?", inSide)).toEqual([{ cwd: sub }]);
});
