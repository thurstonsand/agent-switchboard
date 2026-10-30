import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launched, type } from "./harness/agents.ts";
import { waitState } from "./harness/deck.ts";
import { type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("screen.txt", s.screen());
		s.save("ls.json", JSON.stringify(s.ls(), null, 2));
	} finally {
		await s.cleanup();
	}
});

/** The real Codex updater and TUI, with only the package manager and its installed version faked. */
function offerUpdate(result: "success" | "failed" | "unchanged" | "repeat"): void {
	const codex = join(s.bin, "codex");
	const native = readlinkSync(codex);
	const marker = join(s.root, "installed-version");
	const cache = join(s.home, ".codex/version.json");
	writeFileSync(cache, JSON.stringify({ latest_version: "999.0.0", last_checked_at: new Date().toISOString() }));
	s.env.CODEX_MANAGED_BY_NPM = "1";
	rmSync(codex);
	writeFileSync(
		codex,
		`#!/bin/sh
if [ "$1" = --version ] && [ -e '${s.root}/no-startup-probes' ] && [ ! -e '${s.root}/updates' ]; then
  echo 'Version probes are unavailable during normal startup' >&2
  exit 42
fi
if [ "$1" = --version ] && [ -e '${marker}' ]; then cat '${marker}'; exit 0; fi
exec '${native}' "$@"
`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(s.bin, "npm"),
		`#!/bin/sh
set -eu
echo "$*" >> '${s.root}/updates'
${result === "unchanged" ? "" : `echo 'codex-cli updated' >> '${marker}'`}
${result === "success" ? `rm '${cache}'` : ""}
exit ${result === "failed" ? 42 : 0}
`,
		{ mode: 0o755 },
	);
}

async function acceptUpdate(): Promise<void> {
	await until(() => s.screen().includes("Update now"), 30_000, "Codex's update prompt");
	s.keys("Enter");
	await until(() => existsSync(join(s.root, "updates")), 10_000, "the package manager to run");
	expect(readFileSync(join(s.root, "updates"), "utf8")).toBe("install -g @openai/codex\n");
}

for (const resume of [false, true])
	test(`a Codex startup update continues ${resume ? "the resumed conversation" : "the new session"}, and quitting still exits`, async () => {
		s = scenario("codex-update", resume ? "resume" : "new", { packages: [], recorder: true, harnesses: ["codex"] });
		const previous = resume ? await launched(s, "codex", "reply before the update") : null;
		if (previous) s.swb("quit");
		offerUpdate("success");
		s.swb("drive", "start", "--", ...(previous ? ["open", previous.id] : ["new", "--harness", "codex"]));
		if (previous) {
			await waitState(s, "the dormant conversation", (x) => x.staged.kind === "dormant");
			// Discovery may probe versions, but waking the session must not depend on another probe.
			writeFileSync(join(s.root, "no-startup-probes"), "");
			s.keys("Enter");
		}
		await acceptUpdate();
		const live = await waitState(s, "Codex running after its update", (x) => x.staged.kind === "live", 30_000);
		const id = live.staged.id as string;
		if (previous) expect(id).toBe(previous.id);
		await until(() => s.screen().includes("OpenAI Codex"), 30_000, "the real TUI");
		type(s, id, "reply after the update");
		await until(
			() => s.ls().find((e) => e.id === id && e.activity === "idle") && s.screen().includes("• after the update"),
			30_000,
			"the reply in the same Stage",
		);
		expect(s.ls()).toHaveLength(1);
		if (previous) expect(s.screen()).toContain("before the update");
		type(s, id, "/quit");
		await waitState(s, "the session exited normally", (x) => x.staged.kind === "exited", 15_000);
		expect(s.ls()).toMatchObject([{ id, open: true, live: false }]);
	});

test("quitting an established Codex conversation stays quit even if another process updated Codex", async () => {
	s = scenario("codex-update", "external-update", { packages: [], recorder: true, harnesses: ["codex"] });
	const session = await launched(s, "codex", "reply already running");
	offerUpdate("success");
	writeFileSync(join(s.root, "installed-version"), "codex-cli externally-updated\n");
	s.swb("drive", "start", "--", "open", session.id);
	await waitState(s, "the existing conversation", (x) => x.staged.kind === "live");
	type(s, session.id, "/quit");
	await waitState(s, "the session exited instead of updating", (x) => x.staged.kind === "exited", 15_000);
	expect(s.ls()).toMatchObject([{ id: session.id, open: true, live: false }]);
	expect(existsSync(join(s.root, "updates"))).toBe(false);
});

for (const result of ["failed", "unchanged", "repeat"] as const)
	test(`a ${result} Codex update does not restart indefinitely`, async () => {
		s = scenario("codex-update", result, { packages: [], recorder: true, harnesses: ["codex"] });
		offerUpdate(result);
		s.swb("drive", "start", "--", "new", "--harness", "codex");
		await acceptUpdate();
		if (result === "repeat") {
			await until(() => s.screen().includes("Update now"), 30_000, "a still-outdated install's second prompt");
			s.keys("Enter");
		}
		await waitState(s, "the startup ended without another restart", (x) => x.staged.kind === "empty", 30_000);
		expect(s.ls()).toEqual([]);
		expect(readFileSync(join(s.root, "updates"), "utf8").trim().split("\n")).toHaveLength(result === "repeat" ? 2 : 1);
	});
