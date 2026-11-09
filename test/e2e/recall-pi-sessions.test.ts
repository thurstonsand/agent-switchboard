import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settled } from "./harness/agents.ts";
import { entry, piSessions, reply, sessionRows, state, waitState } from "./harness/deck.ts";
import { budgets, release, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	if (!s) return;
	try {
		s.save("final-screen.txt", s.screen());
	} catch {}
	await s.cleanup();
});

function enableRecall(): void {
	// The shared harness disables recall for its coordination tests. This workflow needs it enabled.
	const file = join(s.home, ".pi/agent/settings.json");
	const settings = JSON.parse(readFileSync(file, "utf8"));
	settings.sessions.search.enable = true;
	settings.sessions.ask.enable = true;
	writeFileSync(file, JSON.stringify(settings));
}

async function tools(label: string): Promise<string[]> {
	s.keys("-l", `tools ${label}`, "Enter");
	await until(() => s.signal(`tools.${label}`) !== "", budgets.settle, `the ${label} tool list`);
	const names = JSON.parse(s.signal(`tools.${label}`)) as string[];
	s.save(`${label}-tools.json`, JSON.stringify(names, null, 2));
	console.log(`${label}: ${names.join(", ")}`);
	return names;
}

function history(): string {
	return s.tmux(s.servers.sessions, "capture-pane", "-p", "-S", "-", "-t", s.pane(state(s).staged.host as string));
}

test("managed pi yields recall to swb, keeps subagents, and stays yielded after /reload; its unmanaged child retains recall", async () => {
	s = scenario("recall", "pi-sessions", { packages: ["pi-sessions"], recorder: true });
	enableRecall();
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the managed pi live", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await reply(s, "SWB-parent-mark");
	const parent = s.ls()[0]?.id as string;
	const managed = await tools("managed");
	// session_search and session_recall are swb's own, registered at load beside pi-sessions without a conflict.
	for (const name of ["session_search", "session_recall"]) expect(managed.filter((tool) => tool === name)).toEqual([name]);
	for (const name of [
		"session_list",
		"session_send_message",
		"session_launch",
		"swb_update_session",
		"subagent_list",
		"subagent_send",
		"subagent_cancel",
		"subagent_launch",
	])
		expect(managed).toContain(name);
	expect(managed).not.toContain("session_handoff");
	// Answered by swb's reader, whose recall_read reads swb's own record of the session.
	const asked = Date.now();
	s.keys("-l", `ask-id ${parent} :: what did it say?`, "Enter");
	await until(
		() => s.screen().includes("asked: reader found: SWB-parent-mark"),
		budgets.settle,
		"swb's reader answering in a pi with pi-sessions",
	);
	await settled(s, parent, "parent idle after asking", asked);
	const starts = s.signal("session_start");
	s.keys("-l", "/reload", "Enter");
	await until(() => s.signal("session_start").length > starts.length, budgets.piReady, "reload session_start");
	// pi drops what's typed until it says the reload is done.
	await until(() => s.screen().includes("Reloaded keybindings"), budgets.piReady, "pi's reloaded notice");
	const reloaded = await tools("reloaded");
	expect([...reloaded].sort()).toEqual([...managed].sort());
	expect(new Set(reloaded).size).toBe(reloaded.length);
	await until(() => entry(s, parent).activity === "idle", budgets.settle, "reloaded parent idle");
	s.keys("-l", "subagent recall", "Enter");
	await until(() => s.signal("child.recall.entered") !== "", budgets.piReady, "unmanaged child's first turn");
	const child = JSON.parse(s.signal("child.recall.tools")) as string[];
	s.save("child-tools.json", JSON.stringify(child, null, 2));
	console.log(`unmanaged child: ${child.join(", ")}`);
	for (const name of ["session_search", "session_recall", "submit_task_report"]) expect(child).toContain(name);
	expect(child).not.toContain("swb_update_session");
	expect(s.ls().map((e) => e.id)).toEqual([parent]);
	expect(sessionRows(state(s)).map((r) => r.id)).toEqual([parent]);
	expect(piSessions(s)).toHaveLength(1);
	expect(s.tmux("default", "list-sessions", "-F", "#{session_name}")).toMatch(/^pi-[0-9a-f]+$/m);
	const screen = s.screen();
	expect(history()).not.toContain("Invalid host");
	expect(history()).not.toContain("conflict");
	s.save("managed-history.txt", history());
	s.save("managed-reloaded.txt", screen);
	release(s, "child.recall");
	// The subagent's conversation is the parent's evidence: search finds the parent, in the subagent.
	const found = await until(
		() => {
			const search = Bun.spawnSync([`${s.bin}/swb`, "search", "--from", "nobody"], { env: s.env, stdin: Buffer.from('"child recall"') });
			const out = search.stdout.toString();
			return out.includes('in subagent \\"child recall\\"') && out;
		},
		budgets.piReady,
		"the subagent's turn in the index",
	);
	s.save("subagent-search.json", found);
	expect(JSON.parse(found).details.sessions.map((x: { id: string }) => x.id)).toEqual([parent]);
});
