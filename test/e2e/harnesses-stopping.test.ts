import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { host, launched, pane, ready, type } from "./harness/agents.ts";
import { config, cursorTo, entry, seed, waitState } from "./harness/deck.ts";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";

// Claude Code and Codex, as swb hosts them: the real TUIs in the sessions server, scripted by fake model servers.

let s: Scenario;
afterEach(async () => {
	try {
		for (const { session_id, tmux_session } of s.query<{ session_id: string; tmux_session: string }>(
			"select session_id, tmux_session from runtimes",
		))
			s.save(`pane-${session_id}.txt`, s.tmux(s.servers.sessions, "capture-pane", "-p", "-J", "-S", "-200", "-t", `=${tmux_session}:`));
		s.save("ls.json", JSON.stringify(s.ls(), null, 2));
		for (const harness of ["claude", "codex"] as const) s.save(`${harness}-requests.json`, JSON.stringify(s.requests(harness), null, 1));
	} catch {}
	await s.cleanup();
});

test("Claude Code waiting on a permission prompt reads as blocked, and an upgrade's stop keeps its unsent draft", async () => {
	s = scenario("harnesses", "claude-blocked", { packages: [], recorder: true, harnesses: ["claude"] });
	const claude = await launched(s, "claude", "reply claude up");
	const note = `${s.project}/note.txt`;
	type(s, claude.id, `call Write {"file_path":"${note}","content":"hi"}`);
	await until(() => entry(s, claude.id).activity === "blocked", budgets.settle, "Claude blocked on the prompt");
	// Blocked is recorded before the dialog shows, and Claude Code drops a key sent the moment it does.
	await until(() => pane(s, claude.id).includes("Do you want to create note.txt?"), budgets.settle, "the permission dialog");
	Bun.sleepSync(1000);
	s.save("blocked.txt", pane(s, claude.id));
	// The first choice allows it.
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(s, claude.id)}:`, "Enter");
	await until(() => entry(s, claude.id).activity === "idle", budgets.settle, "Claude's turn done");
	expect(existsSync(note)).toBe(true);

	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(s, claude.id)}:`, "-l", "half a thought");
	await until(() => pane(s, claude.id).includes("half a thought"), budgets.settle, "the draft typed");
	// A newer swb stops idle sessions, as an upgrade does.
	s.tmux(s.servers.sessions, "set", "-gu", "@swb_version");
	s.swb("drive", "start");
	await until(() => !entry(s, claude.id).live, budgets.settle, "Claude stopped");
	s.swb("wake", claude.id);
	await until(() => entry(s, claude.id).live && pane(s, claude.id).includes("half a thought"), ready, "the draft back");
	s.save("draft-restored.txt", pane(s, claude.id));

	// A prompt cleared, or sent, is no draft for the next stop to keep.
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(s, claude.id)}:`, "-l", ", finished");
	await until(() => pane(s, claude.id).includes("half a thought, finished"), budgets.settle, "the draft edited");
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(s, claude.id)}:`, "Escape");
	Bun.sleepSync(300);
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(s, claude.id)}:`, "Escape");
	await until(() => !pane(s, claude.id).includes("half a thought"), budgets.settle, "the draft cleared");
	s.tmux(s.servers.sessions, "set", "-gu", "@swb_version");
	s.swb("drive", "start");
	await until(() => !entry(s, claude.id).live, budgets.settle, "Claude stopped again");
	expect(readFileSync(`${s.env.XDG_STATE_HOME}/agent-switchboard/drafts/${claude.id}`, "utf8")).toBe("");
});

test("an idle Codex session nobody is viewing is reaped after reap_after, as pi and Claude Code are", async () => {
	s = scenario("harnesses", "codex-reap", { packages: [], recorder: true, harnesses: ["codex"] });
	const [other] = (await seed(s, { turns: ["first"] })) as [string];
	const codex = await launched(s, "codex", "reply codex up");
	const hostName = host(s, codex.id);
	config(s, 'reap_after = "2s"\n');
	s.swb("drive", "start");
	await waitState(s, "ready", (x) => x.ready);
	await cursorTo(s, other);
	await until(() => !entry(s, codex.id).live, 15_000, "Codex reaped");
	expect(entry(s, codex.id)).toMatchObject({ open: true, cutOff: null });
	// Launched outside this Deck, its pane stays on exit until the Deck's orphan sweep, ten seconds on, closes it.
	await until(
		() => !s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name}").split("\n").includes(hostName),
		10_000 + budgets.settle,
		"its pane closed",
	);
});

test("Codex's own /archive archives in swb, and a Claude session archiving itself quits when its turn ends", async () => {
	s = scenario("harnesses", "archive", { packages: [], recorder: true, harnesses: ["claude", "codex"] });
	const [claude, codex] = await Promise.all([launched(s, "claude", "reply claude up"), launched(s, "codex", "reply codex up")]);

	type(s, codex.id, "/archive");
	await until(() => pane(s, codex.id).includes("Archive this session"), budgets.settle, "Codex asking to confirm");
	// The digit picks "Yes, archive" at once.
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host(s, codex.id)}:`, "2");
	await until(() => !entry(s, codex.id).open && !entry(s, codex.id).live, budgets.settle, "Codex archived in swb and stopped");
	// Codex moved its rollout to archived_sessions/; the card still reads it.
	s.swb("drive", "start", "--size", "160x40");
	await waitState(s, "ready", (x) => x.ready);
	s.keys("G", "l", "j");
	await waitState(s, "the archived card", (x) => x.staged.id === codex.id && x.staged.kind === "dormant");
	await until(() => /codex\s+codex up/.test(s.screen()), budgets.settle, "Codex's reply on the archived card");
	s.save("codex-archived-card.txt", s.screen());
	// swb's unarchive unarchives in Codex too: the rollout is back where Codex resumes it from.
	const [{ transcript }] = s.query<{ transcript: string }>("select transcript from sessions where session_id = ?", codex.id) as [
		{ transcript: string },
	];
	expect(existsSync(transcript)).toBe(false);
	s.swb("unarchive", codex.id);
	expect(entry(s, codex.id).open).toBe(true);
	expect(existsSync(transcript)).toBe(true);

	type(s, claude.id, `call swb_update_session {"archived":true}`);
	await until(() => !entry(s, claude.id).open && !entry(s, claude.id).live, ready, "Claude archived and quit");
	expect(entry(s, claude.id).cutOff).toBeNull();

	// pi archiving itself from its shell, not its tool, quits when the turn ends too.
	const pi = await launched(s, "pi", "reply pi up");
	type(s, pi.id, `call bash {"command":"${s.bin}/swb archive ${pi.id} --from ${pi.id}"}`);
	await until(() => !entry(s, pi.id).open && !entry(s, pi.id).live, ready, "pi archived and quit");
	expect(entry(s, pi.id).cutOff).toBeNull();
});
