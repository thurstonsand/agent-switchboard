import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { entry, reply, seed, state, waitState } from "./harness/deck.ts";
import { budgets, type Scenario, scenario } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
	} catch {}
	await s.cleanup();
});

// A user extension, so it runs after the Operator's project extension, and sees what the system prompt will carry.
const PEEK = `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default function peek(pi) {
	pi.on("before_agent_start", (event) => {
		const dir = join(process.env.HOME, "e2e-signals");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "context"), JSON.stringify((event.systemPromptOptions.contextFiles ?? []).map((f) => f.path)));
	});
}
`;

test("n on Operators starts a trusted pi in the Operator folder that reads only that folder's AGENTS.md", async () => {
	s = scenario("phase6", "operators");
	const agentDir = s.env.PI_CODING_AGENT_DIR as string;
	// A symlinked config dir, as dotfile managers leave it: pi's cwd is the physical path.
	const physical = join(s.root, "dotfiles");
	mkdirSync(physical);
	symlinkSync(physical, join(s.home, ".config-link"));
	s.env.XDG_CONFIG_HOME = join(s.home, ".config-link");
	const operator = join(physical, "agent-switchboard/operator");
	writeFileSync(join(s.home, "AGENTS.md"), "# an ancestor's instructions\n");
	writeFileSync(join(agentDir, "AGENTS.md"), "# the user's instructions\n");
	mkdirSync(join(agentDir, "extensions"));
	writeFileSync(join(agentDir, "extensions/peek.js"), PEEK);
	await seed(s, { turns: ["work"] });

	s.swb("drive", "start");
	await waitState(s, "ready", (x) => x.ready);
	s.keys("g");
	await waitState(s, "cursor on the Operators section", (x) => x.cursorRow === 0);
	s.keys("n");
	const st = await waitState(
		s,
		"the Operator's pi live with the keyboard",
		(x) => x.staged.kind === "live" && x.focus === "stage",
		budgets.piReady,
	);
	await reply(s, "ok");
	const id = st.staged.id as string;
	expect(entry(s, id)).toMatchObject({ operator: true, cwd: operator });
	expect(JSON.parse(s.signal("context"))).toEqual([join(operator, "AGENTS.md")]);
	expect(readFileSync(join(operator, "AGENTS.md"), "utf8")).toContain("CAPCOM");
	const rows = state(s).rows;
	expect(rows[0]).toMatchObject({ kind: "section", label: "Operators", count: 1 });
	expect(rows[1]).toMatchObject({ kind: "session", id });
	s.save("operator.txt", s.screen());
});

test("a new Deck restores the last one's cursor and folds in this Project; -c puts pi on its most recent session", async () => {
	s = scenario("phase6", "restore");
	const [older, newer] = (await seed(s, { turns: ["older"] }, { turns: ["newer"] })) as [string, string];

	s.swb("drive", "start");
	const first = await waitState(s, "ready", (x) => x.ready && x.cursor !== null);
	expect(first.focus).toBe("roster");
	const archived = first.rows.findIndex((r) => r.kind === "section" && r.label === "Archived");
	s.keys("G");
	await waitState(s, "cursor on Archived", (x) => x.cursorRow === archived);
	s.keys("Enter");
	await waitState(s, "Archived open", (x) => x.rows.some((r) => r.kind === "section" && r.label === "Archived" && r.expanded));
	s.keys("g");
	const target = first.cursor === older ? newer : older;
	const index = first.rows.findIndex((r) => r.kind === "session" && r.id === target);
	for (let at = 0; at < index; at++) s.keys("j");
	await waitState(s, "cursor on the other session", (x) => x.cursor === target);
	await Bun.sleep(1000);
	s.swb("drive", "stop");

	s.swb("drive", "start");
	const restored = await waitState(s, "the restored cursor", (x) => x.ready && x.cursor !== null);
	expect(restored.cursor).toBe(target);
	expect(restored.focus).toBe("roster");
	expect(restored.rows.find((r) => r.kind === "section" && r.label === "Archived")).toMatchObject({ expanded: true });
	s.save("restored.txt", s.screen());
	s.swb("drive", "stop");

	s.swb("drive", "start", "--", "-c");
	const continued = await waitState(
		s,
		"pi on the most recent session",
		(x) => x.staged.kind === "live" && x.focus === "stage",
		budgets.piReady,
	);
	expect(continued.staged.id).toBe(newer);
	s.save("continued.txt", s.screen());
});

test("-c in a Project with no sessions starts a new one there", async () => {
	s = scenario("phase6", "continue-empty");
	s.swb("drive", "start", "--", "-c");
	const st = await waitState(s, "a new pi with the keyboard", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await reply(s, "hello");
	expect(entry(s, st.staged.id as string)).toMatchObject({ cwd: s.project, operator: false });
});
