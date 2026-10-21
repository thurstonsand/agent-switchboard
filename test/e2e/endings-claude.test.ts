import { afterEach, test } from "bun:test";
import { cardEndings } from "./harness/agents.ts";
import { type Scenario, scenario } from "./harness/index.ts";

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

test("a dormant claude session's card ends where its last turn stopped: cut off, stopped, or errored; waking it continues only a cut-off turn", async () => {
	s = scenario("harnesses", "endings-claude", { packages: [], recorder: true, harnesses: ["claude"] });
	await cardEndings(s, "claude");
});
