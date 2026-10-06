import { afterEach, expect, test } from "bun:test";
import { alive, budgets, capture, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;
afterEach(() => s.cleanup());

test("a scripted pi turn renders in a private tmux server, and teardown leaves nothing running", async () => {
	s = scenario("phase0", "harness");
	const server = `harness-${s.instance}`;
	s.tmux(server, "-f", "/dev/null", "new-session", "-d", "-s", "pi", "-x", "120", "-y", "40", "-c", s.project, `${s.bin}/pi --offline`);
	await until(() => capture(s, server, "pi").includes("faux-1"), budgets.piReady, "pi to be ready");

	s.tmux(server, "send-keys", "-t", "pi", "-l", "reply pong-from-faux");
	s.tmux(server, "send-keys", "-t", "pi", "Enter");
	const screen = await until(
		() => {
			const text = capture(s, server, "pi");
			return text.split("pong-from-faux").length > 2 && text;
		},
		budgets.settle,
		"the scripted reply",
	);
	s.save("screen.txt", screen);

	const pid = Number(s.tmux(server, "display", "-p", "#{pid}"));
	const piPid = Number(s.tmux(server, "display", "-p", "-t", "pi", "#{pane_pid}"));
	await s.cleanup();
	expect(alive(pid)).toBe(false);
	expect(alive(piPid)).toBe(false);
});
