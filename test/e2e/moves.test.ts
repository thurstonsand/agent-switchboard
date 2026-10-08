import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { entry, reply, state, waitState } from "./harness/deck.ts";
import { budgets, git, type Scenario, scenario, until } from "./harness/index.ts";

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
	await until(() => entry(s, id)?.activity === "idle", budgets.settle, "idle");
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
	s.tmux(s.servers.sessions, "kill-session", "-t", `=${host}`);
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

test("/mv to another directory: swb follows the session there, and it wakes there with its conversation", async () => {
	s = scenario("phase6", "mv", { packages: ["@thurstonsand/pi-wt"], recorder: true });
	const elsewhere = join(s.root, "elsewhere");
	mkdirSync(elsewhere);
	const { id, from, cwd } = await moved(`/mv ${elsewhere}`);
	expect(cwd).toBe(elsewhere);
	expect(existsSync(from)).toBe(false);
	await until(() => existsSync(transcript(id)), budgets.settle, "the transcript column pointing at the moved file");
	expect(entry(s, id)).toMatchObject({ cwd: elsewhere, project: s.project, open: true, live: true });
	await wakesWhereItWent(id, elsewhere);
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
