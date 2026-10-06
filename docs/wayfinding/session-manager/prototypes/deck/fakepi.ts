// PROTOTYPE, never ships. A fake pi for the Deck mock: a pi-like screen built from pi-tui's own Editor, with
// canned replies, a working/blocked/idle activity it reports through a runtime file, and a 1.5 s startup delay.
// It's a black box to the Deck, like real pi: swb never draws into it. Like Thurston's pi it runs fullscreen
// (`"tuiMode": "fullscreen"`: own mouse selection, copy on select) and themes itself from the colors the
// terminal reports, as `"theme": "system"` does.
// Usage: bun fakepi.ts <session id>
//   env SWB_TMUX_NAME, optional FAKEPI_PRESTART=working|blocked|idle, FAKEPI_TUI=fullscreen|regular

import { existsSync } from "node:fs";
import {
	Container,
	Editor,
	Loader,
	matchesKey,
	ProcessTerminal,
	type RgbColor,
	ScrollView,
	Spacer,
	type TerminalColors,
	Text,
	TuiAltScreen,
	TuiMainScreen,
	VStack,
} from "@earendil-works/pi-tui";
import {
	type Activity,
	bold,
	cyan,
	dim,
	gray,
	green,
	paths,
	type Runtime,
	readJson,
	red,
	type SeedSession,
	STARTUP_DELAY_MS,
	shortPath,
	type Turn,
	writeJsonAtomic,
	yellow,
} from "./shared.ts";

const id = process.argv[2]!;
const seed = readJson<SeedSession[]>(paths.seed).find((s) => s.id === id);
if (!seed) throw new Error(`fakepi: no seeded session ${id}`);
const tmuxName = process.env.SWB_TMUX_NAME ?? "";
const prestart = process.env.FAKEPI_PRESTART as Activity | undefined;

const previous = existsSync(paths.runtime(id)) ? readJson<Runtime>(paths.runtime(id)) : null;
const transcript: Turn[] = existsSync(paths.transcript(id)) ? readJson<Turn[]>(paths.transcript(id)) : [...seed.history];
const tuiMode = process.env.FAKEPI_TUI === "regular" ? "regular" : "fullscreen";

const rt: Runtime = {
	id,
	tmux: tmuxName,
	pid: process.pid,
	ready: false,
	activity: "idle",
	activityAt: previous?.activityAt ?? seed.activityAt,
	lastPromptAt: previous?.lastPromptAt ?? 0,
	theme: null,
};
const writeRt = () => writeJsonAtomic(paths.runtime(id), rt);
writeRt();

let started: TuiMainScreen | TuiAltScreen | undefined;
function exit(code: number): never {
	rt.ready = false;
	writeRt();
	started?.stop();
	process.exit(code);
}
process.on("SIGHUP", () => exit(0));
process.on("SIGTERM", () => exit(0));

// The pretend cost of starting pi: extensions, session load, first render.
await Bun.sleep(STARTUP_DELAY_MS);

// ── screen ──────────────────────────────────────────────────────────────

// ── theme ───────────────────────────────────────────────────────────────

// pi's system theme, reduced to its decision: the reported background wins; without one, the terminal's
// light/dark report (mode 2031), then COLORFGBG, then dark. Panels are mixed from the reported colors, or
// fall back to fixed sets per appearance. See packages/coding-agent/src/modes/interactive/theme/theme.ts.
type Appearance = "dark" | "light";
const PANELS: Record<Appearance, { user: RgbColor; tool: RgbColor; perm: RgbColor }> = {
	dark: { user: { r: 48, g: 48, b: 48 }, tool: { r: 28, g: 40, b: 30 }, perm: { r: 48, g: 40, b: 20 } },
	light: { user: { r: 232, g: 232, b: 236 }, tool: { r: 226, g: 240, b: 226 }, perm: { r: 246, g: 236, b: 206 } },
};
let panels = PANELS.dark;

const luminance = ({ r, g, b }: RgbColor) => {
	const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const mixRgb = (a: RgbColor, b: RgbColor, t: number): RgbColor => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
const hex = ({ r, g, b }: RgbColor) => `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

function colorFgBg(): Appearance | null {
	const bg = process.env.COLORFGBG?.split(";").at(-1)?.trim();
	if (!bg || !/^\d{1,2}$/.test(bg) || Number(bg) > 15) return null;
	return Number(bg) <= 6 || Number(bg) === 8 ? "dark" : "light";
}

function applyTheme(colors: TerminalColors, reported: Appearance | null): void {
	const { background, foreground, palette } = colors;
	if (background) {
		const appearance: Appearance = luminance(background) > 0.18 ? "light" : "dark";
		const fg = foreground ?? (appearance === "light" ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 });
		panels = {
			user: mixRgb(background, palette?.[4] ?? fg, 0.12),
			tool: mixRgb(background, palette?.[2] ?? fg, 0.12),
			perm: mixRgb(background, palette?.[3] ?? fg, 0.18),
		};
		rt.theme = { appearance, source: palette ? "background+palette" : "background", background: hex(background) };
	} else {
		const hint = reported ?? colorFgBg();
		const appearance = hint ?? "dark";
		panels = PANELS[appearance];
		rt.theme = { appearance, source: reported ? "2031" : hint ? "COLORFGBG" : "default", background: null };
	}
	writeRt();
}

const bgOf = (pick: () => RgbColor) => (s: string) => {
	const { r, g, b } = pick();
	return `\x1b[48;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m${s}\x1b[49m`;
};
const userBg = bgOf(() => panels.user);
const toolBg = bgOf(() => panels.tool);
const permBg = bgOf(() => panels.perm);

function copySelection(text: string): Promise<boolean> {
	const p = Bun.spawn(["pbcopy"], { stdin: "pipe" });
	p.stdin.write(text);
	p.stdin.end();
	return p.exited.then((code) => code === 0);
}

const tui =
	tuiMode === "fullscreen"
		? new TuiAltScreen(new ProcessTerminal(), true, undefined, { mouse: true, copyOnSelect: true, copySelection })
		: new TuiMainScreen(new ProcessTerminal(), true);
const header = new Text(
	`${bold("pi")} ${gray("v0.99.2 (mock)")}\n${gray("escape interrupt · ctrl+c clear · ctrl+d exit · /quit · /long for a 30 s turn")}`,
	1,
	0,
);
const messages = new Container();
const status = new Container();
const editor = new Editor(tui, {
	borderColor: gray,
	selectList: { selectedPrefix: cyan, selectedText: cyan, description: gray, scrollInfo: gray, noMatch: gray },
});
const footer = new Text("", 1, 0);
if (tui instanceof TuiAltScreen) {
	// pi's fullscreen layout (chat-viewport.ts): the transcript scrolls, the editor and footer stay docked.
	const document = new Container();
	for (const c of [header, new Spacer(1), messages]) document.addChild(c);
	const transcript = new ScrollView(document, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
	const dock = new VStack([
		{ component: status, shrink: 1, minSize: 0 },
		{ component: editor, shrink: 1, minSize: 3 },
		{ component: footer, shrink: 1, minSize: 0 },
	]);
	tui.setLayoutRoot(
		new VStack([
			{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]),
	);
} else {
	for (const c of [header, new Spacer(1), messages, status, editor, footer]) tui.addChild(c);
}

function turnComponent(turn: Turn): Text {
	if (turn.who === "you") return new Text(turn.text, 1, 1, userBg);
	if (turn.who === "tool") {
		const [cmd, ...out] = turn.text.split("\n");
		return new Text([bold(cmd!), ...out.map(gray)].join("\n"), 1, 1, toolBg);
	}
	return new Text(turn.text, 1, 0);
}

function addTurn(turn: Turn, persist = true): Text {
	if (messages.children.length > 0) messages.addChild(new Spacer(1));
	const c = turnComponent(turn);
	messages.addChild(c);
	if (persist) {
		transcript.push(turn);
		writeJsonAtomic(paths.transcript(id), transcript);
	}
	return c;
}

function renderFooter(): void {
	const branch = seed!.branch ?? "main";
	const left = gray(`↑${(12 + transcript.length * 1.7).toFixed(1)}k ↓${(3 + transcript.length * 0.6).toFixed(1)}k $${(0.04 * transcript.length).toFixed(2)}`);
	footer.setText(`${gray(`${shortPath(seed!.cwd)} (${branch})`)}\n${left}  ${gray("·")}  ${dim(seed!.title)}  ${gray("·")}  ${gray(seed!.model)}`);
}

function setActivity(activity: Activity): void {
	rt.activity = activity;
	rt.activityAt = Date.now();
	writeRt();
}

for (const turn of transcript) addTurn(turn, false);
renderFooter();

// ── turns ───────────────────────────────────────────────────────────────

let loader: Loader | null = null;
let abort: (() => void) | null = null;
let permission: { onAnswer: (yes: boolean) => void } | null = null;
let replyIndex = transcript.length;

function startWorking(message: string): void {
	setActivity("working");
	status.clear();
	loader = new Loader(tui, cyan, gray, message);
	status.addChild(loader);
	status.addChild(new Spacer(1));
	loader.start();
}

function stopWorking(): void {
	loader?.stop();
	loader = null;
	status.clear();
	abort = null;
}

async function stream(text: string, signal: { aborted: boolean }): Promise<void> {
	const turn: Turn = { who: "agent", text: "" };
	if (messages.children.length > 0) messages.addChild(new Spacer(1));
	const c = turnComponent(turn);
	messages.addChild(c);
	for (const word of text.split(" ")) {
		if (signal.aborted) break;
		turn.text = turn.text === "" ? word : `${turn.text} ${word}`;
		c.setText(turn.text);
		tui.requestRender();
		await Bun.sleep(35);
	}
	transcript.push(turn);
	writeJsonAtomic(paths.transcript(id), transcript);
}

async function runTurn(steps: (signal: { aborted: boolean }) => Promise<void>): Promise<void> {
	const signal = { aborted: false };
	startWorking("Working… (esc to interrupt)");
	abort = () => {
		signal.aborted = true;
	};
	await steps(signal);
	stopWorking();
	if (signal.aborted) {
		messages.addChild(new Spacer(1));
		messages.addChild(new Text(red("Operation aborted"), 1, 0));
	}
	setActivity("idle");
	renderFooter();
	tui.requestRender();
}

async function sleepUnless(ms: number, signal: { aborted: boolean }): Promise<void> {
	const until = Date.now() + ms;
	while (!signal.aborted && Date.now() < until) await Bun.sleep(50);
}

function promptTurn(text: string): void {
	rt.lastPromptAt = Date.now();
	addTurn({ who: "you", text });
	const long = text.trim() === "/long";
	void runTurn(async (signal) => {
		await sleepUnless(600, signal);
		if (signal.aborted) return;
		addTurn({ who: "tool", text: `$ rg -n "${text.split(" ")[0]}" src\nsrc/main.ts:2:export function main(): void {` });
		tui.requestRender();
		await sleepUnless(long ? 30_000 : 900, signal);
		if (signal.aborted) return;
		await stream(seed!.replies[replyIndex++ % seed!.replies.length]!, signal);
	});
}

function longPrestartTurn(): void {
	void runTurn(async (signal) => {
		const tool = addTurn({ who: "tool", text: "$ mise run e2e\nscenario 1/40 · deck starts" }, false);
		for (let i = 2; i <= 40 && !signal.aborted; i++) {
			await sleepUnless(6000, signal);
			tool.setText(`${bold("$ mise run e2e")}\n${gray(`scenario ${i}/40 · ${green("✓")} ${i - 1} passed`)}`);
			tui.requestRender();
		}
		if (!signal.aborted) await stream("All 40 scenarios pass. The driver held up: every capture matched its golden.", signal);
	});
}

function askPermission(): void {
	setActivity("blocked");
	status.clear();
	status.addChild(
		new Text(
			`${bold(yellow("Permission"))} ${gray("· bash")}\n${"kubectl -n staging delete pod integration-eu-west-7c9"}\n${gray("y allow · n deny")}`,
			1,
			1,
			permBg,
		),
	);
	status.addChild(new Spacer(1));
	permission = {
		onAnswer: (yes) => {
			permission = null;
			status.clear();
			if (!yes) {
				addTurn({ who: "agent", text: "Denied. I'll leave the pod alone and look at the config map instead." });
				setActivity("idle");
				return;
			}
			void runTurn(async (signal) => {
				addTurn({ who: "tool", text: "$ kubectl -n staging delete pod integration-eu-west-7c9\npod \"integration-eu-west-7c9\" deleted" });
				await sleepUnless(1200, signal);
				await stream("Deleted. The new pod is Running 1/1, and the eu-west test passed three runs in a row.", signal);
			});
		},
	};
}

editor.onSubmit = (text) => {
	const value = text.trim();
	if (value === "") return;
	editor.addToHistory(value);
	editor.setText("");
	if (value === "/quit") exit(0);
	if (rt.activity !== "idle") {
		addTurn({ who: "you", text: `${value}  ${gray("(queued as a follow-up)")}` });
		return;
	}
	promptTurn(value);
	tui.requestRender();
};

tui.addInputListener((data) => {
	if (permission) {
		if (data === "y" || data === "n") {
			permission.onAnswer(data === "y");
			tui.requestRender();
			return { consume: true };
		}
	}
	if (matchesKey(data, "escape") && abort) {
		abort();
		return { consume: true };
	}
	if (matchesKey(data, "ctrl+c")) {
		editor.setText("");
		tui.requestRender();
		return { consume: true };
	}
	if (matchesKey(data, "ctrl+d") && editor.getText() === "") exit(0);
	return undefined;
});

tui.setFocus(editor);
// Like pi: query once at start, and again whenever the terminal reports a light/dark switch.
let reportedScheme: Appearance | null = null;
async function retheme(): Promise<void> {
	applyTheme(await tui.queryTerminalColors({ timeoutMs: 100 }), reportedScheme);
	tui.requestRender(true);
}
tui.onTerminalColorSchemeChange((scheme) => {
	reportedScheme = scheme;
	void retheme();
});
tui.setTerminalColorSchemeNotifications(true);
tui.start();
started = tui;
await retheme();
rt.ready = true;
if (prestart === "working") longPrestartTurn();
else if (prestart === "blocked") askPermission();
writeRt();
