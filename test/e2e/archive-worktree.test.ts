import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pane, ready, settled, type } from "./harness/agents.ts";
import { cursorTo, entry, launched, state, waitState } from "./harness/deck.ts";
import { budgets, git, gitRepo, gitWorktree, type Scenario, scenario, until } from "./harness/index.ts";
import { swbIn } from "./harness/schedules.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
		s.save("final-state.json", s.swb("drive", "state"));
	} catch {}
	s.save("final-ls.json", JSON.stringify(s.ls(), null, 2));
	await s.cleanup();
});

for (const harness of ["pi", "claude", "codex"] as const) {
	test(`${harness} sees deletion only in a linked worktree, archives itself, and keeps its final reply and branch`, async () => {
		s = scenario("archive-worktree", harness, { packages: [], recorder: true, harnesses: harness === "pi" ? [] : [harness] });
		gitRepo(s, s.project);
		const tree = gitWorktree(s, s.project, "feature");
		const subdir = join(tree, "nested");
		mkdirSync(subdir);
		s.trust(tree);
		const start = async (cwd: string, label: string, from?: string) => {
			const proc = Bun.spawn([`${s.bin}/swb`, "launch", "--harness", harness, "--cwd", cwd, ...(from ? ["--from", from] : [])], {
				env: s.env,
				cwd: s.project,
				stdin: new Blob([`tools ${label}`]),
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
			expect({ code, err }).toEqual({ code: 0, err: "" });
			const id = JSON.parse(out).details.id as string;
			await settled(s, id, `${label} ready`);
			return id;
		};
		const specs = (label: string) =>
			harness === "pi"
				? s.signal(`tool-specs.${label}`)
				: JSON.stringify(
						s
							.requests(harness)
							.findLast(
								(r) =>
									JSON.stringify(r.prompt ?? r.texts).includes(`tools ${label}`) && JSON.stringify(r.tools).includes("swb_update_session"),
							)?.toolSpecs,
					);
		const main = await start(s.project, "main");
		expect(specs("main")).toContain("swb_update_session");
		expect(specs("main")).not.toContain("delete_worktree");
		type(s, main, 'call swb_update_session {"archived":true,"delete_worktree":true}');
		await until(
			() => (harness === "pi" ? pane(s, main) : JSON.stringify(s.requests(harness))).includes("main checkout cannot be deleted"),
			ready,
			"main checkout refused",
		);
		expect(entry(s, main).open).toBe(true);
		expect(existsSync(s.project)).toBe(true);
		const id = await start(subdir, "linked");
		expect(specs("linked")).toContain("delete_worktree");
		const peer = await start(tree, "archived-peer");
		s.swb("archive", peer);
		const child = await start(tree, "child", id);
		type(s, id, 'call swb_update_session {"archived":true,"family":true,"delete_worktree":true}');
		await until(() => !entry(s, id).open && !entry(s, id).live, ready, "archived and quit");
		expect(entry(s, child)).toMatchObject({ open: false, live: false });
		expect(entry(s, id)).toMatchObject({ cutOff: null, project: s.project, branch: "feature", cwd: subdir });
		expect(existsSync(tree)).toBe(false);
		expect(git(s, s.project, "branch", "--list", "feature").trim()).toBe("feature");
		expect(git(s, s.project, "worktree", "list", "--porcelain")).not.toContain(tree);
		const search = Bun.spawnSync([`${s.bin}/swb`, "search", "--from", main], {
			env: s.env,
			cwd: s.project,
			stdin: Buffer.from('"tool done" archived:yes'),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(search.exitCode).toBe(0);
		expect(JSON.parse(search.stdout.toString()).details.sessions).toContainEqual(expect.objectContaining({ id, state: "archived" }));
		for (const [resumed, marker, previous] of [
			[id, "linked", subdir],
			[child, "child", tree],
			[peer, "archived-peer", tree],
		] as const) {
			s.swb("unarchive", resumed);
			s.swb("wake", resumed);
			await until(() => entry(s, resumed).live, ready, "resumed without a missing-directory prompt");
			await settled(s, resumed, "ready after resume");
			type(s, resumed, `reply continued-${resumed}`);
			await until(
				() => pane(s, resumed).split(`continued-${resumed}`).length >= 3 && entry(s, resumed).activity === "idle",
				ready,
				"another completed turn",
			);
			expect(entry(s, resumed)).toMatchObject({ cwd: s.project, branch: "main", cutOff: null, errored: false });
			if (harness === "pi") {
				type(s, resumed, `tools continued-${resumed}`);
				await until(() => s.signal(`context.continued-${resumed}`) !== "", ready, "recovered model context");
			}
			const context =
				harness === "pi"
					? s.signal(`context.continued-${resumed}`)
					: String(s.requests(harness).find((r) => String(r.context).includes(`reply continued-${resumed}`))?.context);
			expect(context).toContain(`tools ${marker}`);
			expect(context).toContain(`This conversation moved from ${previous} to ${s.project}`);
		}
		expect(s.ls()).toHaveLength(4);
	});
}

test("the clickable archive choice preserves ordinary archives and refuses dirty, locked, or shared worktrees", async () => {
	s = scenario("archive-worktree", "deck");
	gitRepo(s, s.project);
	const tree = gitWorktree(s, s.project, "feature");
	const id = await launched(s, "reply finished", { cwd: tree, title: "Finished feature" });
	const deck = Bun.spawnSync([`${s.bin}/swb`, "drive", "start"], { env: s.env, cwd: tree, stdout: "pipe", stderr: "pipe" });
	expect(deck.exitCode).toBe(0);
	await cursorTo(s, id);
	const ask = async () => {
		await until(() => !s.screen().includes("Archive; delete worktree"), budgets.settle, "the previous archive prompt closed");
		s.keys("a");
		await waitState(s, "archive choice", (st) => st.mode === "archive");
		await until(() => s.screen().includes("Archive; delete worktree"), budgets.settle, "delete button");
	};
	// A row moving into Archived shifts the prompt under a click aimed from the screen before it, so each waits.
	const archive = async (other: string) => {
		s.swb("archive", other);
		await waitState(
			s,
			"archived on the Deck",
			(st) => !st.rows.some((r) => r.kind === "session" && r.id === other && r.state !== "archived"),
		);
	};
	const clickDelete = () => {
		const lines = s.screen().split("\n");
		const y = lines.findIndex((line) => line.includes("Archive; delete worktree"));
		s.swb("drive", "click", String((lines[y] as string).indexOf("Archive; delete worktree") + 1), String(y));
	};
	await ask();
	s.keys("Escape");
	await waitState(s, "cancelled", (st) => st.mode === "roster");
	expect(entry(s, id).open).toBe(true);
	await ask();
	s.keys("a");
	await waitState(s, "ordinary archive shown", (st) =>
		st.rows.some((row) => row.kind === "session" && row.id === id && row.state === "archived"),
	);
	expect(entry(s, id).open).toBe(false);
	expect(existsSync(tree)).toBe(true);
	s.swb("unarchive", id);
	await waitState(s, "unarchive shown", (st) => st.rows.some((row) => row.kind === "session" && row.id === id && row.state !== "archived"));
	await cursorTo(s, id);
	writeFileSync(join(tree, "keep.txt"), "valuable work\n");
	await until(() => !s.screen().includes("Archive; delete worktree"), budgets.settle, "the previous archive prompt closed");
	s.keys("a");
	await waitState(s, "archive choice", (st) => st.mode === "archive");
	// The prompt flags a dirty worktree before asking, and doesn't offer to delete it.
	await until(() => s.screen().includes("Uncommitted changes"), budgets.settle, "the dirty worktree flagged");
	expect(s.screen()).not.toContain("delete worktree");
	s.keys("d");
	await Bun.sleep(500);
	expect(state(s)).toMatchObject({ mode: "archive" });
	expect(state(s).toasts.some((t) => t.text.includes("untracked"))).toBe(false);
	s.keys("Escape");
	await waitState(s, "cancelled", (st) => st.mode === "roster");
	expect(entry(s, id).open).toBe(true);
	expect(readFileSync(join(tree, "keep.txt"), "utf8")).toBe("valuable work\n");
	git(s, tree, "add", "keep.txt");
	git(s, tree, "commit", "-qm", "saved");
	git(s, s.project, "worktree", "lock", tree);
	await ask();
	clickDelete();
	await waitState(s, "locked refusal", (st) => st.toasts.some((t) => t.text.includes("locked")));
	expect(entry(s, id).open).toBe(true);
	git(s, s.project, "worktree", "unlock", tree);
	const other = await launched(s, "reply shared", { cwd: tree, title: "Still using it" });
	// launched() sees it in the db; its row lands on the Deck a poll later, above this one, moving the prompt under a click.
	await waitState(s, "the sharer on the Deck", (st) => st.rows.some((r) => r.kind === "session" && r.id === other));
	await cursorTo(s, id);
	await ask();
	clickDelete();
	await waitState(s, "shared refusal", (st) => st.toasts.some((t) => t.text.includes("Still using it")));
	expect(entry(s, id).open).toBe(true);
	expect(existsSync(tree)).toBe(true);
	await archive(other);
	writeFileSync(join(s.home, "e2e-signals/start.hold"), "");
	const starting = swbIn(s, "reply starting", "launch", "--harness", "pi", "--cwd", tree);
	await until(() => s.signal("start.entered") !== "", ready, "peer starting before registration");
	await ask();
	clickDelete();
	await waitState(s, "starting peer refusal", (st) => st.toasts.some((t) => t.text.includes("session starting")));
	expect(existsSync(tree)).toBe(true);
	writeFileSync(join(s.home, "e2e-signals/start.release"), "");
	const started = await starting;
	expect(started.code).toBe(0);
	const startingId = JSON.parse(started.out).details.id as string;
	await settled(s, startingId, "starting peer idle");
	await archive(startingId);
	// A launch another session set into the worktree holds it; the one the archived session sets goes with it.
	const planner = await launched(s, "reply planner", { cwd: s.project, title: "Planner" });
	const scheduling = await swbIn(
		s,
		"reply scheduled",
		"launch",
		"--from",
		planner,
		"--title",
		"Future work",
		"--cwd",
		tree,
		"--at",
		"PT1H",
		"--schedule-label",
		"Check feature",
	);
	expect(scheduling.code).toBe(0);
	const schedule = JSON.parse(scheduling.out) as { details: { id: string } };
	await cursorTo(s, id);
	await ask();
	clickDelete();
	await waitState(s, "schedule refusal", (st) => st.toasts.some((t) => t.text.includes("Check feature")));
	expect(entry(s, id).open).toBe(true);
	expect(existsSync(tree)).toBe(true);
	s.swb("unschedule", schedule.details.id, "--from", planner);
	const own = await swbIn(
		s,
		"reply own",
		"launch",
		"--from",
		id,
		"--title",
		"Own",
		"--cwd",
		tree,
		"--at",
		"PT1H",
		"--schedule-label",
		"Own follow-up",
	);
	expect(own.code).toBe(0);
	const child = await launched(s, "reply child", { from: id, cwd: tree, title: "Child" });
	const awayTree = gitWorktree(s, s.project, "elsewhere");
	const away = await launched(s, "reply away", { from: id, cwd: awayTree, title: "Elsewhere" });
	await cursorTo(s, id);
	await ask();
	// The prompt counts the family as the Deck sees it, which can be a snapshot behind the launches.
	await until(() => s.screen().includes("Family (3); delete worktree"), budgets.settle, "the whole family offered");
	const lines = s.screen().split("\n");
	const y = lines.findIndex((line) => line.includes("Family (3); delete worktree"));
	expect(y).toBeGreaterThan(0);
	s.swb("drive", "click", String((lines[y] as string).indexOf("Family (3)") + 1), String(y));
	// Its own scheduled launch goes with it, once it says so.
	await waitState(s, "the schedule it cancels", (st) => st.archive?.cancels?.includes("Own follow-up") ?? false);
	s.keys("a");
	await until(() => !entry(s, id).open, budgets.settle, "clicked archive and deletion");
	expect(entry(s, child)).toMatchObject({ open: false, live: false });
	expect(entry(s, away)).toMatchObject({ open: false, live: false });
	expect(existsSync(tree)).toBe(false);
	expect(existsSync(awayTree)).toBe(true);
	expect(git(s, s.project, "show", "feature:keep.txt")).toBe("valuable work");
	expect(s.query("SELECT cancelled_at IS NOT NULL AS cancelled FROM schedules WHERE schedule_label = 'Own follow-up'")).toEqual([
		{ cancelled: 1 },
	]);
});

test("family deletion cancels a running child before removal, and missing Project roots never launch in HOME", async () => {
	s = scenario("archive-worktree", "cancel-turns-and-missing");
	gitRepo(s, s.project);
	const tree = gitWorktree(s, s.project, "feature");
	const id = await launched(s, "reply root", { cwd: tree });
	const child = await launched(s, "reply child", { cwd: tree, from: id });
	type(s, child, "hold still-working");
	await until(() => s.signal("still-working.entered") !== "", ready, "child running");
	const refused = await swbIn(s, '{"archived":true,"family":true,"delete_worktree":true}', "update", "--from", id);
	expect(refused.code).not.toBe(0);
	expect(existsSync(tree)).toBe(true);
	writeFileSync(join(s.home, "e2e-signals/cancel.hold"), "");
	const archiving = swbIn(s, '{"archived":true,"family":true,"delete_worktree":true,"cancel_turns":true}', "update", "--from", id);
	await until(() => s.signal("cancel.entered") !== "", ready, "child cancellation in progress");
	expect(existsSync(tree)).toBe(true);
	expect(entry(s, id).open).toBe(true);
	writeFileSync(join(s.home, "e2e-signals/cancel.release"), "");
	const archived = await archiving;
	expect(archived).toMatchObject({ code: 0, err: "" });
	expect(entry(s, child)).toMatchObject({ live: false, open: false });
	expect(existsSync(tree)).toBe(false);
	// Stop the caller too: this probe invoked its tool directly, rather than from a turn that would now settle.
	s.swb("archive", id);
	const plain = join(s.root, "plain");
	mkdirSync(plain);
	const nongit = await launched(s, "reply outside-git", { cwd: plain });
	s.swb("archive", nongit);
	rmSync(s.project, { recursive: true });
	rmSync(plain, { recursive: true });
	for (const missing of [id, nongit]) {
		const run = (...args: string[]) =>
			Bun.spawnSync([`${s.bin}/swb`, ...args], { env: s.env, cwd: s.root, stdout: "pipe", stderr: "pipe" });
		expect(run("unarchive", missing).exitCode).toBe(0);
		const wake = run("wake", missing);
		expect(wake.exitCode).not.toBe(0);
		expect(wake.stderr.toString()).toContain("restore a directory before waking this conversation");
		expect(JSON.parse(run("ls", "--json").stdout.toString()).find((e: { id: string }) => e.id === missing)).toMatchObject({
			live: false,
			open: true,
		});
	}
	writeFileSync(s.project, "not a directory");
	const invalid = Bun.spawnSync([`${s.bin}/swb`, "wake", id], { env: s.env, cwd: s.root, stdout: "pipe", stderr: "pipe" });
	expect(invalid.exitCode).not.toBe(0);
	expect(invalid.stderr.toString()).toContain("restore a directory before waking this conversation");
	rmSync(s.project);
	mkdirSync(s.project);
});
