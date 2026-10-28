import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cursorTo, entry, reply, seed, waitState } from "./harness/deck.ts";
import { budgets, release, type Scenario, scenario, until } from "./harness/index.ts";

let s: Scenario;

afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
		s.save("final-tmux.txt", s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name} #{session_attached} #{@swb_kind}"));
	} catch {}
	await s.cleanup();
});

/** The OSC 11 or OSC 4 reply a pi gets from its terminal, asked by `/e2e-bg` typed into its tmux session on the sessions server. */
async function piColor(host: string, osc: "11" | "4;9"): Promise<string> {
	const log = join(s.home, "e2e-signals/input.log");
	let asked = 0;
	const ask = () => {
		writeFileSync(log, "");
		s.tmux(s.servers.sessions, "send-keys", "-t", `=${host}:`, "-l", "/e2e-bg");
		s.tmux(s.servers.sessions, "send-keys", "-t", `=${host}:`, "Enter");
		asked = Date.now();
	};
	ask();
	// pi-tui keeps every color reply for itself while its own query is out, as when it starts or hears the theme change;
	// one asked then never reaches the extension, so it asks again.
	return until(
		() => {
			const lines = readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as string);
			const reply = lines.find((line) => line.startsWith(`\x1b]${osc};`));
			if (reply) return reply;
			if (Date.now() - asked > 1000) ask();
			return false;
		},
		budgets.settle,
		`${host}'s OSC ${osc} reply`,
	);
}

const LIGHT_BG = "\x1b]11;rgb:f9f9/f5f5/d7d7\x1b\\";

const DARK_BG = "\x1b]11;rgb:1d1d/2020/2121\x1b\\";

const LIGHT_RED = "\x1b]4;9;rgb:9d9d/0000/0606\x1b\\";

const DARK_RED = "\x1b]4;9;rgb:fbfb/4949/3434\x1b\\";

/** The background pi paints its last user message on, read from its pane rather than asked of the terminal. */
function userMessageBg(host: string): string {
	const ansi = s.tmux(s.servers.sessions, "capture-pane", "-p", "-e", "-t", `=${host}:`);
	return [...ansi.slice(0, ansi.lastIndexOf("reply ")).matchAll(/48;2;(\d+;\d+;\d+)/g)].at(-1)?.[1] ?? "none";
}

/** The same message after the Deck renders it to the outer terminal, including inactive-pane dimming. */
function renderedMessageBg(): string {
	const ansi = s.swb("drive", "capture", "--ansi");
	return [...ansi.slice(0, ansi.lastIndexOf("reply ")).matchAll(/48;2;(\d+;\d+;\d+)/g)].at(-1)?.[1] ?? "none";
}

test("a pi follows theme changes even in copy mode, and dims only on the Deck when another pane has the keyboard", async () => {
	s = scenario("phase2", "theme-repaint");
	s.swb("drive", "start", "--", "new");
	const st = await waitState(
		s,
		"the new pi live with the keyboard",
		(x) => x.staged.kind === "live" && x.focus === "stage",
		budgets.piReady,
	);
	const host = st.staged.host as string;
	await reply(s, "one");
	await until(() => userMessageBg(host) === "219;229;229", budgets.settle, "pi's light user message");
	await until(() => renderedMessageBg() === "219;229;229", budgets.settle, "focused pi at full brightness");
	s.keys("M-a", "s");
	await waitState(s, "the shell, with the keyboard", (x) => x.layout.shell !== null && x.focus === "shell");
	await until(() => renderedMessageBg() === "186;194;194", budgets.settle, "inactive pi dimmed 15% in light mode");
	expect(s.swb("drive", "capture", "--ansi")).toMatch(/\[39m(?:.\[49m)? ▾ Operators /);

	// tmux 3.8 tells pi before the sessions server mirrors the terminal, so pi's own query would see the old colors.
	s.swb("drive", "theme", "dark");
	await until(() => userMessageBg(host) === "35;54;54", budgets.settle, "pi's dark user message");
	await until(() => renderedMessageBg() === "22;35;35", budgets.settle, "inactive pi dimmed 35% in dark mode");
	expect(s.swb("drive", "capture", "--ansi")).toMatch(/\[39m(?:.\[49m)? ▾ Operators /);
	s.save("dark.ansi", s.swb("drive", "capture", "--ansi"));

	// tmux 3.7c tells pi only once copy mode ends; swb, on 3.8, while it's still up.
	s.tmux(s.servers.sessions, "copy-mode", "-t", `=${host}:`);
	s.swb("drive", "theme", "light");
	await waitState(s, "the roster's light background", (x) => x.colors.background === "#f9f5d7");
	await Bun.sleep(500);
	expect(s.tmux(s.servers.sessions, "display", "-p", "-t", `=${host}:`, "#{pane_in_mode}")).toBe("1");
	s.tmux(s.servers.sessions, "send-keys", "-t", `=${host}:`, "-X", "cancel");
	await until(() => userMessageBg(host) === "219;229;229", budgets.settle, "pi's light user message, after copy mode");
	await until(() => renderedMessageBg() === "186;194;194", budgets.settle, "the live theme flip restores 15% dimming");
	s.save("light.ansi", s.swb("drive", "capture", "--ansi"));
	// A shell that got the report echoes it as 997;1n or 997;2n; a bare 997 could be part of a session id.
	expect(s.screen()).not.toMatch(/997;[12]n/);
	s.keys("M-a", "Tab");
	await waitState(s, "the roster, with the keyboard", (x) => x.focus === "roster");
	await until(() => renderedMessageBg() === "186;194;194", budgets.settle, "pi stays dim with the roster focused");
	s.keys("Enter");
	await waitState(s, "pi, with the keyboard again", (x) => x.focus === "stage");
	await until(() => renderedMessageBg() === "219;229;229", budgets.settle, "refocused pi returns to full brightness");
	s.keys("M-a", "z");
	await waitState(s, "the roster hidden", (x) => x.layout.rosterHidden);
	s.keys("M-a", "h");
	await waitState(s, "the roster shown and focused", (x) => !x.layout.rosterHidden && x.focus === "roster");
	await until(() => renderedMessageBg() === "186;194;194", budgets.settle, "15% dimming survives hiding and showing the roster");
});

test("the roster and a live pi report the harness terminal's background, and both follow drive theme dark", async () => {
	s = scenario("phase2", "theme");
	s.swb("drive", "start", "--", "new");
	const st = await waitState(s, "the new pi live", (x) => x.staged.kind === "live", budgets.piReady);
	await waitState(s, "the roster's light background", (x) => x.colors.background === "#f9f5d7");
	expect(await piColor(st.staged.host as string, "11")).toBe(LIGHT_BG);
	s.save("light.ansi", s.swb("drive", "capture", "--ansi"));
	s.swb("drive", "theme", "dark");
	await waitState(s, "the roster's dark background", (x) => x.colors.background === "#1d2021");
	await until(async () => (await piColor(st.staged.host as string, "11")) === DARK_BG, budgets.settle, "pi's dark background");
	s.save("dark.ansi", s.swb("drive", "capture", "--ansi"));
});

test("a pi woken with w and never viewed reports the terminal's background and palette, and re-themes while still unviewed", async () => {
	s = scenario("phase2", "unviewed-theme");
	const [a, b] = (await seed(s, { turns: ["a"] }, { turns: ["b"] })) as [string, string];
	s.swb("drive", "start");
	await cursorTo(s, a);
	s.keys("w");
	await until(() => entry(s, a).live, budgets.piReady, "a live");
	await cursorTo(s, b);
	await waitState(s, "b on view, dormant", (x) => x.staged.id === b && x.staged.kind === "dormant");
	const [{ tmux_session: host }] = s.query<{ tmux_session: string }>("SELECT tmux_session FROM runtimes WHERE session_id = ?", a) as [
		{ tmux_session: string },
	];
	expect(s.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name} #{session_attached}")).toContain(`${host} 0`);
	expect(await piColor(host, "11")).toBe(LIGHT_BG);
	expect(await piColor(host, "4;9")).toBe(LIGHT_RED);
	s.swb("drive", "theme", "dark");
	await waitState(s, "the roster's dark background", (x) => x.colors.background === "#1d2021");
	await until(async () => (await piColor(host, "11")) === DARK_BG, budgets.settle, "the unviewed pi's dark background");
	await until(async () => (await piColor(host, "4;9")) === DARK_RED, budgets.settle, "the unviewed pi's dark palette");
});

test("a working session's frames reach the terminal synchronized through both tmux layers, the cursor shown only inside one", async () => {
	s = scenario("phase2", "synchronized");
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the new pi live with the keyboard", (x) => x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	// What the Deck writes to the terminal, while pi's spinner redraws through both tmux servers.
	const stream = join(s.root, "terminal.bin");
	s.tmux(s.servers.drive, "pipe-pane", "-O", "-t", "=drive:", `cat > ${stream}`);
	s.keys("-l", "hold sync", "Enter");
	await until(() => s.signal("sync.entered") !== "", budgets.settle, "the held turn");
	await Bun.sleep(1500);
	release(s, "sync");
	await until(() => s.screen().includes("released sync"), budgets.settle, "the turn's end");
	s.tmux(s.servers.drive, "pipe-pane", "-t", "=drive:");
	const bytes = readFileSync(stream, "latin1");
	let frames = 0;
	let open = false;
	const outside: number[] = [];
	const esc = String.fromCharCode(27);
	for (const m of bytes.matchAll(new RegExp(`${esc}\\[\\?(2026|25)([hl])`, "g"))) {
		if (m[1] === "2026") {
			open = m[2] === "h";
			if (open) frames++;
		} else if (m[2] === "h" && !open) outside.push(m.index);
	}
	expect(frames).toBeGreaterThan(5);
	expect(outside).toEqual([]);
});

test("a drag in regular-mode pi reaches drive clipboard through both tmux layers", async () => {
	s = scenario("phase2", "clipboard");
	s.swb("drive", "start", "--", "new");
	await waitState(s, "the new pi live", (x) => x.staged.kind === "live", budgets.piReady);
	await reply(s, "copy-me-please");
	// The reply signals when pi asks for it, and pi draws a turn typed during startup only once startup ends.
	const rows = await until(
		() => {
			const screen = s.screen().split("\n");
			return screen.some((line) => line.includes("copy-me-please")) && screen;
		},
		budgets.settle,
		"the reply on screen",
	);
	const row = rows.findLastIndex((line) => line.includes("copy-me-please"));
	const col = (rows[row] as string).lastIndexOf("copy-me-please");
	s.swb("drive", "drag", String(col), String(row), String(col + "copy-me-please".length - 1), String(row));
	const copied = await until(() => s.swbTry("drive", "clipboard").out || false, budgets.settle, "the clipboard");
	s.save("clipboard.txt", `${copied}\n---\n${s.screen()}`);
	expect(copied).toContain("copy-me-please");
});
