import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launched, pane, subagentDone, type } from "./harness/agents.ts";
import { entry } from "./harness/deck.ts";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	if (!s) return;
	try {
		s.save("ls.json", JSON.stringify(s.ls(), null, 2));
		for (const session of s.ls().filter((session) => session.live))
			s.save(`pane-${session.harness}-${session.id}.txt`, pane(s, session.id));
	} finally {
		await s.cleanup();
	}
});

type Harness = "pi" | "claude" | "codex";

/** What session_search gave the caller's model for this query, typed into the caller's own TUI. */
async function searched(caller: { id: string; harness: Harness }, query: string): Promise<string> {
	const prompt = `search ${query}`;
	const seen = () => {
		if (caller.harness === "pi")
			return s
				.signal("recall.jsonl")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { prompt: string; role: string; text: string })
				.findLast((r) => r.prompt === prompt && r.role === "toolResult")?.text;
		if (caller.harness === "claude")
			return s.requests("claude").findLast((r) => r.prompt === prompt && r.toolOutput)?.toolOutput as string | undefined;
		return s.requests("codex").findLast((r) => (r.texts as string[]).at(-1)?.trim() === prompt && r.toolOutput)?.toolOutput as
			| string
			| undefined;
	};
	const before = seen();
	type(s, caller.id, prompt);
	const output = await until(
		() => {
			const now = seen();
			return now !== before && now;
		},
		budgets.piReady,
		`${caller.harness}'s session_search for ${query}`,
	);
	await until(() => entry(s, caller.id).activity === "idle", budgets.settle, `${caller.harness} caller idle`);
	s.save(`search-${caller.harness}-${query.replace(/[^\w-]+/g, "_")}.txt`, output);
	return output;
}

function swbSearch(from: string, query: string): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn([`${s.bin}/swb`, "search", "--from", from], {
		env: s.env,
		cwd: s.project,
		stdin: new Blob([query]),
		stdout: "pipe",
		stderr: "pipe",
	});
	return Promise.all([proc.exited, proc.stdout.text(), proc.stderr.text()]).then(([code, out, err]) => ({ code, out, err }));
}

const recallDb = () => join(s.env.XDG_STATE_HOME as string, "agent-switchboard", "recall.db");

test("each harness's session_search finds the others' conversations, filters them, and sees a turn as soon as it lands", async () => {
	s = scenario("search", "harnesses", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const pi = { ...(await launched(s, "pi", "reply SWB-find-pi lantern")), harness: "pi" as const };
	const claude = { ...(await launched(s, "claude", "reply SWB-find-claude lantern")), harness: "claude" as const };
	const codex = { ...(await launched(s, "codex", "reply SWB-find-codex lantern")), harness: "codex" as const };

	// Every harness finds another's conversation through its own tool, and never lists itself.
	for (const [caller, target, marker] of [
		[pi, claude, "SWB-find-claude"],
		[claude, codex, "SWB-find-codex"],
		[codex, pi, "SWB-find-pi"],
	] as const) {
		const output = await searched(caller, marker);
		expect(output).toContain(target.id);
		expect(output).not.toContain(caller.id);
		console.log(`${caller.harness} → ${target.harness}: ${output.split("\n").slice(0, 3).join(" | ")}`);
	}

	const all = await searched(pi, "lantern");
	expect(all).toContain(claude.id);
	expect(all).toContain(codex.id);
	const onlyCodex = await searched(pi, "lantern harness:codex");
	expect(onlyCodex).toContain(codex.id);
	expect(onlyCodex).not.toContain(claude.id);
	// Claude's own conversation has the marker, as does pi's search for it; Codex's doesn't.
	const excluded = await searched(pi, "lantern -SWB-find-claude");
	expect(excluded).toContain(codex.id);
	expect(excluded).not.toContain(claude.id);

	// A file Claude Code read, by its name and by its path.
	const notes = join(s.project, "notes.md");
	writeFileSync(notes, "the notes\n");
	type(s, claude.id, `call Read ${JSON.stringify({ file_path: notes })}`);
	const [{ transcript }] = s.query<{ transcript: string }>("SELECT transcript FROM sessions WHERE session_id = ?", claude.id) as [
		{ transcript: string },
	];
	// Claude Code writes its transcript behind the idle event.
	await until(() => readFileSync(transcript, "utf8").includes("the notes"), budgets.settle, "Claude's read in its transcript");
	for (const file of ["notes.md", notes]) {
		const touched = await searched(codex, `file:${file}`);
		expect(touched).toContain(claude.id);
		expect(touched).not.toContain(pi.id);
	}

	// A turn that just landed, before anything else could have indexed it.
	type(s, codex.id, "reply SWB-fresh-codex");
	await until(() => entry(s, codex.id).activity === "idle", budgets.settle, "Codex's fresh turn");
	expect(await searched(pi, "SWB-fresh-codex")).toContain(codex.id);

	s.swb("archive", claude.id);
	await until(() => !entry(s, claude.id).live, budgets.settle, "Claude archived and quit");
	const archived = await searched(pi, "lantern archived:yes");
	expect(archived).toContain(claude.id);
	expect(archived).not.toContain(codex.id);
	const open = await searched(pi, "lantern archived:no");
	expect(open).toContain(codex.id);
	expect(open).not.toContain(claude.id);

	const malformed = await searched(pi, "lantern harness:gemini");
	expect(malformed).toContain("harness:gemini: pi, claude, or codex");
});

test("a Claude Code subagent's transcript is its parent's evidence, and session_ask's readers are never indexed", async () => {
	s = scenario("search", "claude-subagents", { packages: [], recorder: true, harnesses: ["claude"] });
	const target = await launched(s, "claude", "reply SWB-subagent-target");
	const parent = { ...(await launched(s, "claude", "reply parent ready")), harness: "claude" as const };
	const searcher = { ...(await launched(s, "pi", "reply searcher ready")), harness: "pi" as const };
	const subagent = { description: "Find the beacon", subagent_type: "general-purpose", prompt: "reply SWB-subagent-beacon" };
	type(s, parent.id, `call Agent ${JSON.stringify(subagent)}`);
	await subagentDone(s, parent.id, subagent.description);
	type(s, parent.id, `ask-id ${target.id} :: Which marker?`);
	await until(() => pane(s, parent.id).includes("asked: reader found: SWB-subagent-target"), budgets.piReady, "the reader's answer");
	await until(() => entry(s, parent.id).activity === "idle", budgets.settle, "parent idle");

	const found = await searched(searcher, "SWB-subagent-beacon");
	expect(found).toContain(parent.id);
	expect(found).toContain('in subagent "Find the beacon"');
	// The reader's prompt names its question; only the reader's own transcript holds it.
	const reader = await searched(searcher, '"Question about session"');
	expect(reader).toBe("No sessions match.");
});

test("searches started at once on an empty index all answer, and index each transcript once", async () => {
	s = scenario("search", "concurrent", { packages: [], recorder: true });
	const ids: string[] = [];
	for (const n of [1, 2, 3]) ids.push((await launched(s, "pi", `reply SWB-concurrent-${n} meadow`)).id);
	// The clock indexes new turns in the background, before anyone searches.
	await until(
		() => {
			if (!existsSync(recallDb())) return false;
			const db = new Database(recallDb(), { readonly: true });
			try {
				db.exec("PRAGMA busy_timeout = 5000");
				const indexed = db
					.query("SELECT DISTINCT s.session_id FROM chunks c JOIN sources s ON s.id = c.source WHERE c.text LIKE '%meadow%'")
					.all();
				return indexed.length === ids.length;
			} finally {
				db.close();
			}
		},
		budgets.settle,
		"the clock's background indexing",
	);
	rmSync(recallDb(), { force: true });
	rmSync(`${recallDb()}-wal`, { force: true });
	rmSync(`${recallDb()}-shm`, { force: true });
	const runs = await Promise.all(Array.from({ length: 6 }, () => swbSearch("nobody", "meadow")));
	for (const run of runs) expect(run).toMatchObject({ code: 0, err: "" });
	const listed = runs.map((run) =>
		(JSON.parse(run.out) as { details: { sessions: { id: string }[] } }).details.sessions.map((x) => x.id).sort(),
	);
	for (const list of listed) expect(list).toEqual([...ids].sort());
	const db = new Database(recallDb(), { readonly: true });
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		const sources = db.query("SELECT session_id, count(*) AS n FROM sources GROUP BY session_id ORDER BY session_id").all();
		expect(sources).toEqual([...ids].sort().map((session_id) => ({ session_id, n: 1 })));
		const twice = db.query("SELECT source, ref, kind, text, count(*) AS n FROM chunks GROUP BY source, ref, kind, text HAVING n > 1").all();
		expect(twice).toEqual([]);
		console.log(
			`6 concurrent searches: ${runs.map((r) => r.code).join(",")}; chunks: ${JSON.stringify(db.query("SELECT count(*) AS n FROM chunks").get())}`,
		);
	} finally {
		db.close();
	}
});
