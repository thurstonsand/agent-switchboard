import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexClient, type Notification } from "../../packages/cli/src/codex/client.ts";
import { host, launched, pane, ready, type } from "./harness/agents.ts";
import { entry } from "./harness/deck.ts";
import { type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	if (!s) return;
	s.save("requests.json", JSON.stringify(s.requests("codex"), null, 2));
	s.save("ls.json", JSON.stringify(s.ls(), null, 2));
	for (const row of s.query<{ session_id: string; tmux_session: string }>("select session_id, tmux_session from runtimes")) {
		try {
			s.save(`pane-${row.session_id}.txt`, pane(s, row.session_id));
			s.save(
				`host-${row.session_id}.log`,
				readFileSync(join(s.env.XDG_STATE_HOME as string, "agent-switchboard/codex", `${row.tmux_session}.log`), "utf8"),
			);
		} catch {}
	}
	await s.cleanup();
});

function rollouts(): string[] {
	return readdirSync(join(s.home, ".codex/sessions"), { recursive: true })
		.filter((p): p is string => typeof p === "string" && p.endsWith(".jsonl"))
		.sort();
}

async function observer(id: string): Promise<CodexClient> {
	return CodexClient.connect(join(s.env.XDG_STATE_HOME as string, "agent-switchboard/codex", `${host(s, id)}.sock`), "swb-evidence");
}

/** What a reader is offered: Codex's own tools, which the sandbox keeps read-only, and recall_read. */
const READER_OFFERED = ["exec_command", "write_stdin", "apply_patch", "view_image", "recall_read"];

const readerRequests = () => s.requests("codex").filter((r) => (r.texts as string[]).at(-1)?.startsWith("Question about session"));

function codexScenario(name: string): Scenario {
	const scenarioState = scenario("recall", name, { packages: [], recorder: true, harnesses: ["codex"] });
	// The test harness launches the native binary rather than npm's wrapper, which normally installs this argv0 alias.
	if (process.platform === "linux")
		symlinkSync(realpathSync(join(scenarioState.bin, "codex")), join(scenarioState.bin, "codex-linux-sandbox"));
	return scenarioState;
}

test("Codex asks live Codex, pi, and archived sessions without a rollout, roster row, or TUI switch", async () => {
	s = codexScenario("codex");
	const target = await launched(s, "codex", "reply SWB-codex-secret");
	const pi = await launched(s, "pi", "reply SWB-pi-secret", undefined, ["--title", "pi target"]);
	const caller = await launched(s, "codex", "reply caller-up");
	const before = rollouts();
	const runtime = s.query("select * from runtimes where session_id = ?", caller.id);
	const client = await observer(caller.id);
	const notes: (Notification & { at: number })[] = [];
	client.onNotification((note) => notes.push({ at: Date.now(), ...note }));
	try {
		for (const [prompt, marker] of [
			[`ask ${target.title} :: what marker?`, "SWB-codex-secret"],
			[`ask ${pi.title} :: what marker?`, "SWB-pi-secret"],
			[`ask-id ${target.id} :: what archived marker?`, "SWB-codex-secret"],
		] as const) {
			if (prompt.startsWith("ask-id")) s.swb("archive", target.id);
			const start = s.requests("codex").length;
			type(s, caller.id, prompt);
			const asking = await until(
				() =>
					s
						.requests("codex")
						.slice(start)
						.find((r) => String(r.toolOutput).includes(`reader found: ${marker}`)),
				ready,
				"the reader's answer returned to the caller's model",
			);
			await until(() => pane(s, caller.id).includes(`asked: reader found: ${marker}`), ready, "the reader's answer in the caller TUI");
			await until(() => entry(s, caller.id).activity === "idle", ready, "the caller idle");
			const requests = s.requests("codex").slice(start);
			const first = requests.find((r) => (r.texts as string[]).at(-1)?.startsWith("Question about session"));
			s.save(
				`latency-${marker}-${start}.json`,
				JSON.stringify(
					{
						callMs: Number(/Wall time: ([\d.]+) seconds/.exec(String(asking.toolOutput))?.[1]) * 1000,
						readerToResultMs: Number(asking.at) - Number(first?.at),
						prompt,
					},
					null,
					2,
				),
			);
		}
		const readers = readerRequests();
		expect(readers.length).toBeGreaterThanOrEqual(6);
		for (const request of readers) {
			expect(request.tools).toEqual(READER_OFFERED);
			expect(request.model).toBe("gpt-5.5");
		}
		const readerThreads = notes.filter((n) => n.method === "thread/started").map((n) => n.params.thread as { id: string });
		expect(readerThreads).toHaveLength(3);
		for (const reader of readerThreads) {
			expect(reader).toMatchObject({ ephemeral: true, path: null, model: "gpt-5.5", modelProvider: "fake", cwd: s.project });
			expect(s.query("select session_id from sessions where session_id = ?", reader.id)).toEqual([]);
			expect(s.query("select session_id from runtimes where session_id = ?", reader.id)).toEqual([]);
		}
		expect(rollouts()).toEqual(before);
		expect(
			s
				.ls()
				.map((e) => e.id)
				.sort(),
		).toEqual([target.id, pi.id, caller.id].sort());
		expect(s.query("select * from runtimes where session_id = ?", caller.id)).toEqual(runtime);
		const title = s.tmux(s.servers.sessions, "display", "-p", "-t", `=${host(s, caller.id)}:`, "#{pane_title}");
		expect(title.startsWith(caller.id.slice(0, 25))).toBe(true);
		expect(pane(s, caller.id)).not.toContain("Question about session");
		s.save("rollouts.json", JSON.stringify(before, null, 2));
		s.save(
			"isolation.json",
			JSON.stringify(
				{
					readerThreads,
					callerRuntimeBefore: runtime,
					callerRuntimeAfter: s.query("select * from runtimes where session_id = ?", caller.id),
					paneTitle: title,
				},
				null,
				2,
			),
		);
		s.save("notifications.json", JSON.stringify(notes, null, 2));
		s.save("caller.txt", pane(s, caller.id));
	} finally {
		client.close();
	}
});

test("Codex's reader reads with its own shell under a read-only sandbox, with none of swb's or the person's tools", async () => {
	s = codexScenario("codex-reader-shell");
	// A person's own MCP server, which the caller has and the reader mustn't: swb's, under another name.
	const config = join(s.home, ".codex/config.toml");
	writeFileSync(
		config,
		`${readFileSync(config, "utf8")}\n[mcp_servers.person]\ncommand = "${join(s.bin, "swb")}"\nargs = ["mcp"]\nomit_tools_from = ["deferred"]\n`,
	);
	const caller = await launched(s, "codex", "reply SWB-shell");
	writeFileSync(join(s.project, "notes.txt"), "first\nSWB-file-line\nlast\n");
	type(s, caller.id, `ask-id ${caller.id} :: reader-shell notes.txt`);
	const read = await until(
		() => s.requests("codex").find((r) => String(r.toolOutput).includes("reader shell:")),
		ready,
		"the reader's shell read",
	);
	expect(String(read.toolOutput)).toContain("2:SWB-file-line");
	expect(read.tools as string[]).toContain("list_mcp_resources");
	expect((read.tools as string[]).filter((tool) => tool === "session_ask")).toHaveLength(2);
	const offered = [...new Set(readerRequests().flatMap((r) => r.tools as string[]))];
	s.save("reader-tools.json", JSON.stringify(offered, null, 2));
	expect(offered).toEqual(READER_OFFERED);
	await until(() => entry(s, caller.id).activity === "idle", ready, "the caller idle");
	const path = join(s.project, "reader-write.txt");
	type(s, caller.id, `ask-id ${caller.id} :: reader-exec ${path}`);
	const refused = await until(
		() => s.requests("codex").find((r) => String(r.toolOutput).includes("reader exec:")),
		ready,
		"the reader's refused writes",
	);
	s.save("refused.txt", String(refused.toolOutput));
	expect(String(refused.toolOutput)).toContain("Read-only file system");
	expect(existsSync(path)).toBe(false);
	s.save("shell.txt", pane(s, caller.id));
	await until(() => entry(s, caller.id).activity === "idle", ready, "the caller idle");
	type(s, caller.id, `run echo caller-wrote > ${path}`);
	await until(() => existsSync(path), ready, "the caller's control write");
	expect(readFileSync(path, "utf8")).toBe("caller-wrote\n");
});

/** Holds a reader that never finishes on its own, and returns its thread once it's running. */
async function heldReader(caller: string, client: CodexClient, notes: (Notification & { at: number })[]): Promise<string> {
	type(s, caller, `ask-id ${caller} :: reader-hold`);
	await until(() => s.signal("reader-hold.entered"), ready, "the private reader holding");
	const started = await until(
		() => notes.find((n) => n.method === "thread/started" && (n.params.thread as { ephemeral: boolean }).ephemeral),
		ready,
		"the reader's thread",
	);
	const readerId = (started.params.thread as { id: string }).id;
	expect((await client.request<{ data: string[] }>("thread/loaded/list", {})).data).toContain(readerId);
	return readerId;
}

/** When the reader's status last went idle, after `since`. */
function readerIdle(notes: (Notification & { at: number })[], readerId: string, since: number): number | undefined {
	return notes.find(
		(n) =>
			n.at >= since &&
			n.method === "thread/status/changed" &&
			n.params.threadId === readerId &&
			(n.params.status as { type: string }).type === "idle",
	)?.at;
}

test("Esc in the caller stops its reader at once: no more model requests, no terminal, and the caller carries on", async () => {
	s = codexScenario("codex-escape");
	const caller = await launched(s, "codex", "reply SWB-cancel");
	const client = await observer(caller.id);
	const notes: (Notification & { at: number })[] = [];
	client.onNotification((note) => notes.push({ at: Date.now(), ...note }));
	try {
		const readerId = await heldReader(caller.id, client, notes);
		// It holds well past any deadline the reader used to have.
		await Bun.sleep(3000);
		expect(readerIdle(notes, readerId, 0)).toBeUndefined();
		const escaped = Date.now();
		s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(s, caller.id)}:`, "Escape");
		const idle = await until(() => readerIdle(notes, readerId, escaped), 5000, "the reader interrupted");
		expect(idle - escaped).toBeLessThan(1500);
		const requests = readerRequests().length;
		await Bun.sleep(3000);
		expect(readerRequests().length).toBe(requests);
		expect(readerRequests().at(-1)?.at as number).toBeLessThan(idle);
		const terminals = await client.request<{ data: unknown[] }>("thread/backgroundTerminals/list", { threadId: readerId });
		expect(terminals.data).toEqual([]);
		await until(() => entry(s, caller.id).activity === "idle", ready, "the caller stopped by Esc");
		s.save("escape.txt", pane(s, caller.id));
		s.save(
			"cancellation.json",
			JSON.stringify(
				{
					readerId,
					escaped,
					readerIdle: idle,
					stopMs: idle - escaped,
					readerRequests: requests,
					terminals,
					loaded: await client.request("thread/loaded/list", {}),
				},
				null,
				2,
			),
		);
		type(s, caller.id, "reply SWB-after-escape");
		await until(() => pane(s, caller.id).includes("SWB-after-escape"), ready, "the caller's next turn");
		await until(() => entry(s, caller.id).activity === "idle", ready, "the caller idle again");
		expect(s.ls()).toHaveLength(1);
	} finally {
		s.save("notifications.json", JSON.stringify(notes, null, 2));
		client.close();
	}
});

test("A reader whose swb mcp dies is stopped by the host once the caller's turn ends", async () => {
	s = codexScenario("codex-orphan");
	const caller = await launched(s, "codex", "reply SWB-orphan");
	const client = await observer(caller.id);
	const notes: (Notification & { at: number })[] = [];
	client.onNotification((note) => notes.push({ at: Date.now(), ...note }));
	try {
		const readerId = await heldReader(caller.id, client, notes);
		// The caller's own swb mcp: a descendant of its pane, beside other scenarios' running in parallel.
		const procs = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,args="])
			.stdout.toString()
			.split("\n")
			.map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
			.filter((m): m is RegExpExecArray => m !== null);
		const tree = new Set([s.tmux(s.servers.sessions, "display", "-p", "-t", `=${host(s, caller.id)}:`, "#{pane_pid}").trim()]);
		for (let size = 0; size !== tree.size; ) {
			size = tree.size;
			for (const [, pid, ppid] of procs) if (tree.has(ppid as string)) tree.add(pid as string);
		}
		const mcp = procs
			.filter(([, pid, , args]) => tree.has(pid as string) && /\/swb mcp$/.test(args as string))
			.map(([, pid]) => pid as string);
		expect(mcp.length).toBeGreaterThan(0);
		const killed = Date.now();
		Bun.spawnSync(["kill", "-9", ...mcp]);
		const idle = await until(() => readerIdle(notes, readerId, killed), ready, "the orphaned reader interrupted");
		const requests = readerRequests().length;
		await Bun.sleep(3000);
		expect(readerRequests().length).toBe(requests);
		await until(() => entry(s, caller.id).activity === "idle", ready, "the caller idle");
		s.save("orphan.json", JSON.stringify({ readerId, killed, readerIdle: idle, stopMs: idle - killed, mcp }, null, 2));
		s.save("orphan.txt", pane(s, caller.id));
	} finally {
		s.save("notifications.json", JSON.stringify(notes, null, 2));
		client.close();
	}
});
