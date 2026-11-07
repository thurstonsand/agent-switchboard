import { afterEach, expect, test } from "bun:test";
import { cursorTo, entry, launched, rowIndex, seed, state, waitState } from "./harness/deck.ts";
import { budgets, type Scenario, scenario, until } from "./harness/index.ts";
import { snoozeOf } from "./harness/schedules.ts";

let s: Scenario;
afterEach(async () => {
	try {
		s.save("final-screen.txt", s.screen());
	} catch {}
	await s.cleanup();
});

/** The column and row of `text` on screen, looking only in its first `cols` columns: the roster's, unless told otherwise. */
function find(text: string, cols = 42): [string, string] {
	const lines = s.screen().split("\n");
	const y = lines.findIndex((line) => line.slice(0, cols).includes(text));
	if (y === -1) throw new Error(`${text} not on screen:\n${lines.join("\n")}`);
	return [String((lines[y] as string).indexOf(text) + 1), String(y)];
}

/** The column and row of `text` right of the roster: on the Stage, or a Peek over it. */
function findRight(text: string): [string, string] {
	const lines = s.screen().split("\n");
	const y = lines.findIndex((line) => line.indexOf(text, 43) !== -1);
	if (y === -1) throw new Error(`${text} not right of the roster:\n${lines.join("\n")}`);
	return [String((lines[y] as string).indexOf(text, 43) + 1), String(y)];
}

/** Clicks `text` once tmux's double-click time has passed: two clicks inside it, anywhere, are a double click. */
async function click(text: string, cols = 42): Promise<void> {
	await Bun.sleep(350);
	s.swb("drive", "click", ...find(text, cols));
}

/** Rests the pointer on a session's row until its Peek is up, then clicks the Peek's button for `key`. */
async function peekButton(row: string, id: string, button: string): Promise<void> {
	s.swb("drive", "move", ...find(row));
	await waitState(s, `${row}'s Peek`, (x) => x.peek?.id === id && x.peek.lines.some((line) => line.includes(button)));
	await Bun.sleep(350);
	s.swb("drive", "move", ...findRight(button));
	s.swb("drive", "click", ...findRight(button));
}

/** Whether `text` on line `y` sits on a background fill: the last background code before it isn't a reset. */
function filled(y: number, text: string): boolean {
	const before = (s.swb("drive", "capture", "--ansi").split("\n")[y] as string).split(text)[0] as string;
	return [...before.matchAll(/\[(48;2;[\d;]+|49|0)m/g)].at(-1)?.[1]?.startsWith("48;2;") === true;
}

async function onScreen(text: string, what: string): Promise<void> {
	await until(() => s.screen().includes(text), budgets.settle, what);
}

test("the mouse reaches everything the keys do: a row's Peek, the hidden or narrow roster, the shell, the Group picker, the filter, and help", async () => {
	s = scenario("phase6", "mouse");
	const [a, b] = (await seed(s, { turns: ["alpha"], title: "alpha" }, { turns: ["bravo"], title: "bravo" })) as [string, string];
	s.swb("drive", "start");
	await waitState(s, "the Deck up", (x) => x.ready);
	await cursorTo(s, a);

	// A Peek's buttons act on its own row, wherever the cursor is.
	await peekButton("bravo", b, "w Wake");
	await until(() => entry(s, b).live, budgets.piReady, "bravo woken from its Peek");
	expect(state(s)).toMatchObject({ cursor: a, focus: "roster" });
	s.save("peek-woke.txt", s.screen());
	await peekButton("bravo", b, "x Shut down");
	await until(() => !entry(s, b).live, budgets.settle, "bravo stopped from its Peek");
	expect(state(s).cursor).toBe(a);

	const bravoY = find("bravo")[1];
	await peekButton("alpha", a, "m Group…");
	await waitState(s, "the Group picker", (x) => x.mode === "name");
	await onScreen("Group for alpha", "the Group form drawn");
	expect(Number(findRight("Group for alpha")[0])).toBeGreaterThan(42);
	expect(find("bravo")[1]).toBe(bravoY);
	s.save("group-picker.txt", s.screen());
	await click("✕", 140);
	await waitState(s, "the Group picker closed by its ✕", (x) => x.mode === "roster");
	s.keys("m", "-l", "review2", "Enter");
	await until(() => entry(s, a).group === "review2", budgets.settle, "a new Group typed into the floating form");
	s.keys("m");
	await onScreen("1 (no Group)", "numbered Group choices");
	s.keys("1");
	await until(() => entry(s, a).group === null, budgets.settle, "the number removes its Group");

	await click("alpha");
	await waitState(s, "alpha's pi focused", (x) => x.staged.id === a && x.staged.kind === "live" && x.focus === "stage", budgets.piReady);
	await click("hide");
	await waitState(s, "the roster hidden", (x) => x.layout.rosterHidden);
	await onScreen("show list", "the way back on the status line");
	s.save("hidden.txt", s.screen());
	await click("show list");
	await waitState(s, "the roster back and focused", (x) => !x.layout.rosterHidden && x.focus === "roster");
	await until(() => !s.screen().includes("show list"), budgets.settle, "the status line gone with it");

	await click(" shell ");
	await waitState(s, "the shell shown", (x) => x.layout.shell !== null && x.focus === "shell");
	s.save("shell.txt", s.screen());
	await click(" shell ");
	await waitState(s, "the shell hidden", (x) => x.layout.shell === null);

	await click("? keys");
	await onScreen("Close help", "the key help");
	s.save("help.txt", s.screen());
	await click("Close help", 140);
	await until(() => !s.screen().includes("Close help"), budgets.settle, "help closed by a click");

	// A Peek's buttons are its row's prefix keys: one closes a filter being typed, as the key does, and the query stays.
	s.keys("M-a", "/");
	await waitState(s, "filtering", (x) => x.mode === "filter");
	s.keys("-l", "a");
	await waitState(s, "typed into the filter", (x) => x.filter === "a");
	await peekButton("bravo", b, "u Keep Unseen");
	await waitState(s, "the filter closed by the Peek's button", (x) => x.mode === "roster" && x.filter === "a");
	await until(() => entry(s, b).markedUnseen, budgets.settle, "bravo marked Unseen from its Peek");
	s.keys("Escape");
	await waitState(s, "the filter cleared", (x) => x.filter === "");

	s.keys("M-a", "/");
	await waitState(s, "filtering", (x) => x.mode === "filter");
	s.keys("-l", "brav", "Enter");
	await waitState(s, "filtered to bravo", (x) => x.filter === "brav" && x.mode === "roster");
	await click("/brav ✕");
	await waitState(s, "the filter cleared by its tag", (x) => x.filter === "");

	s.swb("drive", "resize", "60x20");
	await waitState(s, "the roster alone", (x) => x.layout.rosterOnly && x.focus === "roster");
	// No Stage beside the roster: hovering never covers the list; the selected session has particulars below it.
	await onScreen("alpha", "the narrow roster drawn");
	s.swb("drive", "move", ...find("alpha", 60));
	await Bun.sleep(500);
	expect(state(s).peek).toBeNull();
	expect(s.screen()).toContain("bravo");
	expect(s.screen()).not.toContain("a Archive");
	s.save("narrow-roster.txt", s.screen());
	await click("alpha", 20);
	await waitState(s, "alpha's pi filling the Deck", (x) => x.staged.id === a && x.focus === "stage", budgets.piReady);
	await onScreen("show list", "the way back on the status line");
	s.save("narrow-pi.txt", s.screen());
	await click("show list");
	await waitState(s, "the roster again", (x) => x.focus === "roster" && x.layout.rosterOnly);
	await until(() => !s.screen().includes("show list"), budgets.settle, "the status line gone");
	expect(state(s).cursor).toBe(a);
});

test("Escape followed by mouse motion clears the filter without typing the report", async () => {
	s = scenario("phase6", "escape-mouse");
	const [a, b] = (await seed(s, { turns: ["alpha"], title: "alpha" }, { turns: ["bravo"], title: "bravo" })) as [string, string];
	s.swb("drive", "start", "--size", "80x28");
	await waitState(s, "the narrow Deck", (x) => x.ready && x.layout.rosterOnly);
	const raw = (data: string) => s.tmux(s.servers.sessions, "send-keys", "-t", "=deck:.0", "-l", data);
	const clientRaw = (data: string) =>
		s.tmux(s.servers.drive, "send-keys", "-t", "=drive:", "-H", ...[...Buffer.from(data)].map((b) => b.toString(16).padStart(2, "0")));
	for (const narrow of [true, false]) {
		s.swb("drive", "resize", narrow ? "80x28" : "140x40");
		await waitState(s, "the roster resized", (x) => x.layout.rosterOnly === narrow);
		await cursorTo(s, a);
		await onScreen("bravo", "the hover target");
		const [x, y] = find("bravo");
		const report = narrow ? "[<35;62;2M" : `[<35;${x};${y}M`;
		s.keys("/", "-l", "zzz");
		await waitState(s, "the filter before input through tmux", (x) => x.filter === "zzz");
		clientRaw(`\x1b\x1b${report}`);
		await waitState(s, "Escape and motion through the tmux client clear the filter", (x) => x.mode === "roster" && x.filter === "");
		for (const chunks of [
			[`\x1b\x1b${report}`],
			["\x1b\x1b", report],
			["\x1b", "\x1b", report.slice(0, -1), "M"],
			["\x1b[27;3u", report],
		]) {
			s.keys("/", "-l", "zzz");
			await waitState(s, "the empty filter", (x) => x.mode === "filter" && x.filter === "zzz");
			await onScreen("No matching sessions", "the empty result");
			for (const chunk of chunks) raw(chunk);
			await waitState(s, `Escape clears with ${chunks.length} input chunks`, (x) => x.mode === "roster" && x.filter === "");
			await onScreen("alpha", "the session restored");
			expect(s.screen()).not.toContain("[<35;");
		}
	}
	s.keys("Escape");
	await cursorTo(s, a);
	s.keys("m");
	await waitState(s, "the Group form", (x) => x.mode === "name");
	await onScreen("Group for alpha", "the floating form");
	const [x, y] = find("bravo");
	clientRaw(`\x1b\x1b[<35;${x};${y}M`);
	await waitState(s, "Escape closes Group and the recovered mouse opens bravo's Peek", (x) => x.mode === "roster" && x.peek?.id === b);
	s.keys("Escape", "/");
	raw("\x1b[200~literal[<35;62;2M\x1b[201~");
	await waitState(s, "pasted mouse-like text stays literal", (x) => x.mode === "filter" && x.filter === "literal[<35;62;2m");
});

test("a blocked Peek focuses its own session to respond, even while another row is selected", async () => {
	s = scenario("phase6", "peek-respond");
	const [a, b] = (await seed(s, { turns: ["alpha"], title: "alpha" }, { turns: ["bravo"], title: "bravo" })) as [string, string];
	s.swb("drive", "start");
	await waitState(s, "the Deck", (x) => x.ready);
	await cursorTo(s, a);
	s.keys("Enter");
	await waitState(s, "alpha focused", (x) => x.staged.id === a && x.focus === "stage" && x.staged.kind === "live", budgets.piReady);
	s.keys("-l", "confirm deploy", "Enter");
	await onScreen("Confirm deploy?", "the dialog");
	s.keys("M-a", "h");
	await waitState(s, "the roster", (x) => x.focus === "roster");
	await cursorTo(s, b);
	await cursorTo(s, a);
	await Bun.sleep(500);
	expect(state(s).peek).toBeNull();
	expect(s.screen()).toContain("Confirm deploy?");
	await cursorTo(s, b);
	s.swb("drive", "move", ...find("alpha"));
	const blocked = await waitState(s, "alpha's blocked Peek", (x) => x.peek?.id === a);
	expect(blocked.peek?.lines.join("\n")).toContain("waiting now");
	expect(blocked.peek?.lines.join("\n")).not.toContain("active now");
	await peekButton("alpha", a, "s Snooze…");
	await onScreen("Blocked sessions stay visible until answered.", "the snooze exception explained");
	s.keys("1");
	await waitState(s, "the snooze menu closed", (x) => x.mode === "roster");
	s.swb("drive", "move", ...find("bravo"));
	s.swb("drive", "move", ...find("alpha"));
	const snoozed = await waitState(
		s,
		"the held snooze in alpha's Peek",
		(x) => x.peek?.lines.some((l) => l.includes("s Unsnooze")) ?? false,
	);
	expect(snoozed.peek?.lines.join("\n")).toContain("Snoozed until");
	expect(snoozed.peek?.lines.join("\n")).toContain("visible for attention");
	expect(snoozeOf(s, a).snoozed).toBe(false);
	await peekButton("alpha", a, "s Unsnooze");
	await until(() => entry(s, a).snooze === null, budgets.settle, "the held snooze removed");
	expect(state(s).mode).toBe("roster");
	s.swb("drive", "move", ...find("bravo"));
	await peekButton("alpha", a, "s Snooze…");
	s.keys("4");
	await waitState(s, "the next-message snooze chosen", (x) => x.mode === "roster");
	s.swb("drive", "move", ...find("bravo"));
	s.swb("drive", "move", ...find("alpha"));
	await waitState(
		s,
		"the next-message snooze displayed",
		(x) => x.peek?.lines.some((l) => l.includes("Snoozed until next message")) ?? false,
	);
	await peekButton("alpha", a, "⏎ Focus to respond");
	await waitState(s, "alpha, not bravo, focused", (x) => x.staged.id === a && x.focus === "stage");
	await onScreen("Confirm deploy?", "the dialog ready for an answer");
	s.keys("Enter");
	await until(() => entry(s, a).activity === "idle", budgets.settle, "alpha answered");
	expect(snoozeOf(s, a).snoozed).toBe(true);
	await waitState(s, "alpha hidden in Snoozed after answering", (x) => !x.rows.some((r) => r.kind === "session" && r.id === a));
	expect(s.screen()).toContain("Snoozed (1)");
});

test("a Peek follows the pointer and the cursor keys, leaves with the pointer, and never takes pi's keys", async () => {
	s = scenario("phase6", "peek");
	const [a, b] = (await seed(s, { turns: ["alpha"], title: "alpha" }, { turns: ["bravo"], title: "bravo" })) as [string, string];
	s.swb("drive", "start");
	await waitState(s, "the Deck up", (x) => x.ready);
	await cursorTo(s, a);
	// Seeded a moment apart, both "now": either can be on top.
	const toB = rowIndex(state(s), b) < rowIndex(state(s), a) ? "k" : "j";
	const toA = toB === "k" ? "j" : "k";
	const staged = state(s).staged.id;

	// The row under the pointer gets its Peek beside it; the cursor and the Stage stay where they were.
	s.swb("drive", "move", ...find("bravo"));
	const hovered = await waitState(s, "bravo's Peek", (x) => x.hover === b && x.peek?.id === b && x.peek.source === "pointer");
	expect(hovered).toMatchObject({ cursor: a, staged: { id: staged } });
	expect(hovered.peek?.lines.join("\n")).toContain("pi  bravo");
	// The state names the Peek before its popup, a process of its own, has drawn it.
	await onScreen("a Archive", "bravo's Peek drawn");
	expect(hovered.peek?.lines.some((line) => line.trim() === "bravo")).toBe(false);
	const footer = () => s.screen().trimEnd().split("\n").at(-1) as string;
	expect(footer()).toContain("? keys");
	expect(footer()).not.toContain("archive");
	expect(hovered.peek?.lines.join("\n")).not.toContain("All keys");
	expect(s.swb("drive", "capture", "--ansi")).toMatch(/\[[\d;]*4mbravo/);
	s.save("peek-hover.txt", s.screen());

	s.keys("s");
	await waitState(s, "the hovered session's Snooze menu", (x) => x.mode === "snooze");
	await onScreen("Snooze bravo", "the prompt names the Peek's target, not alpha");
	expect(s.screen()).not.toContain("Snooze alpha");
	s.keys("Escape");
	s.swb("drive", "move", ...find("bravo"));
	await waitState(s, "bravo's Peek restored by pointer movement", (x) => x.peek?.id === b);
	s.keys(toB);
	await waitState(s, "navigation dismisses the pointer's Peek", (x) => x.hover === null && x.cursor === b && x.peek?.source !== "pointer");
	s.keys(toA, "Escape");
	s.swb("drive", "move", ...find("bravo"));
	await waitState(s, "bravo's Peek restored again", (x) => x.peek?.id === b);

	// On the Peek itself it stays; onto pi it goes, and the row's hover with it.
	s.swb("drive", "move", ...findRight("a Archive"));
	await Bun.sleep(400);
	expect(state(s).peek?.id).toBe(b);
	s.swb("drive", "move", "100", "35");
	await waitState(s, "the Peek gone with the pointer", (x) => x.peek === null && x.hover === null);
	expect(s.screen()).not.toContain("a Archive");
	expect(footer()).toContain("⏎ wake");
	expect(s.swb("drive", "capture", "--ansi")).not.toMatch(/\[[\d;]*4mbravo/);

	// A control lights only while the pointer is on it: leaving the roster for pi puts it out.
	const [tabX, tabY] = find(" editor ");
	s.swb("drive", "move", tabX, tabY);
	await until(() => filled(Number(tabY), " editor"), budgets.settle, "the editor tab lit under the pointer");
	s.swb("drive", "move", "100", "35");
	await until(() => !filled(Number(tabY), " editor"), budgets.settle, "the editor tab out once the pointer is on pi");

	// The cursor's keys bring its Peek.
	s.keys(toB);
	await waitState(s, "the cursor's Peek", (x) => x.cursor === b && x.peek?.id === b && x.peek.source === "cursor");
	s.keys(toA);
	await waitState(s, "the Peek following the cursor", (x) => x.cursor === a && x.peek?.id === a);
	s.keys("Escape");
	await waitState(s, "Escape dismisses the Peek", (x) => x.peek === null);
	s.keys(toB);
	await waitState(s, "another cursor Peek", (x) => x.peek?.id === b);
	await Bun.sleep(2000);
	expect(state(s).peek?.id).toBe(b);
	await waitState(s, "the cursor Peek expires after 30 idle seconds", (x) => x.peek === null, 32_000);

	// Clicking a row focuses its pi and puts its Peek away, though the pointer still rests on the row.
	await click("bravo");
	await waitState(s, "bravo's pi focused", (x) => x.focus === "stage" && x.staged.id === b && x.staged.kind === "live", budgets.piReady);
	await waitState(s, "no Peek over the session just opened", (x) => x.peek === null);

	// A Peek opened while pi has the keyboard closes on the first key, and every key still reaches pi.
	s.swb("drive", "move", ...find("alpha"));
	await waitState(s, "alpha's Peek over bravo's pi", (x) => x.peek?.id === a && x.focus === "stage");
	s.keys("-l", "typed past the peek");
	await waitState(s, "the Peek closed by the first key", (x) => x.peek === null);
	await onScreen("typed past the peek", "every key in pi");
});

test("Archive stays at its clicked action, Snooze stays at its row, and the Stage's last message is not repeated", async () => {
	s = scenario("phase6", "anchored-prompts");
	const parent = await launched(s, "reply parent response", { cwd: s.project, title: "parent" });
	await launched(s, "reply descendant response", { from: parent, title: "child" });
	const later = await launched(s, "reply later", { cwd: s.project, title: "later" });
	s.swb("snooze", later, "one_hour");
	s.swb("drive", "start", "--size", "175x48");
	await waitState(s, "the Deck", (x) => x.ready);
	await cursorTo(s, parent);
	await onScreen("parent response", "the parent's Stage");
	s.swb("drive", "move", ...find("parent"));
	const shown = await waitState(s, "the parent's Peek", (x) => x.peek?.id === parent);
	expect(shown.peek?.lines.join("\n")).not.toContain("parent response");
	await onScreen("a Archive", "the Archive action");
	const [x, y] = findRight("a Archive");
	s.swb("drive", "move", x, y);
	s.swb("drive", "click", x, y);
	await waitState(s, "the Archive form", (st) => st.mode === "archive");
	await onScreen("Archive parent", "the anchored form drawn");
	const [formX, formY] = find("Archive parent", 175);
	expect(Math.abs(Number(formY) - Number(y))).toBeLessThanOrEqual(1);
	expect(Math.abs(Number(formX) - Number(x))).toBeLessThanOrEqual(4);
	await click("✕", 175);
	await waitState(s, "the form closed without archiving", (st) => st.mode === "roster");
	expect(entry(s, parent).open).toBe(true);
	const row = Number(find("parent")[1]);
	s.keys("s");
	await waitState(s, "Snooze", (st) => st.mode === "snooze");
	await onScreen("Snooze parent", "the Snooze form drawn");
	expect(Number(findRight("Snooze parent")[1])).toBe(row + 1);
	expect(
		s
			.screen()
			.split("\n")
			.map((line) => line.slice(0, 42))
			.join("\n"),
	).toContain("Snoozed");
	// Exercise the client's Escape binding, not only a key injected into its pane.
	s.tmux(s.servers.sessions, "send-keys", "-K", "-c", s.tmux(s.servers.sessions, "list-clients", "-F", "#{client_tty}"), "Escape");
	await waitState(s, "Snooze canceled", (st) => st.mode === "roster");
	s.swb("drive", "resize", "85x30");
	await waitState(s, "narrow roster", (st) => st.layout.rosterOnly);
	for (const [key, title] of [
		["s", "Snooze parent"],
		["m", "Group for parent"],
		["a", "Archive parent"],
	] as const) {
		s.keys(key);
		await onScreen(title, "the narrow form");
		const screen = s.screen().split("\n");
		const form = screen.findIndex((line) => line.includes(title));
		const parentRow = screen.findIndex((line) => /[○●] parent/.test(line));
		const childRow = screen.findIndex((line) => /[○●] child/.test(line));
		expect(form).toBe(parentRow + 1);
		expect(childRow).toBeGreaterThan(form + 2);
		expect(screen.some((line) => line.includes("Snoozed"))).toBe(true);
		s.keys("Escape");
		await waitState(s, "form canceled", (st) => st.mode === "roster");
	}
	s.keys("s");
	await onScreen("2 A day", "numbered Snooze choices");
	await onScreen("⏎ choose  esc cancel", "menu-local controls");
	s.keys("2");
	await waitState(s, "number chooses Snooze", (st) => st.mode === "roster");
	await until(() => snoozeOf(s, parent).snoozed, budgets.settle, "parent snoozed by number");
	const remaining = (snoozeOf(s, parent).snoozedUntil as number) - Date.now();
	expect(remaining).toBeGreaterThan(23 * 60 * 60 * 1000);
	expect(remaining).toBeLessThan(25 * 60 * 60 * 1000);
});

test("narrow details expand by key and click, scroll, follow the selection, and keep their actions", async () => {
	s = scenario("phase6", "narrow-details");
	const parent = await launched(s, "reply parent response", { cwd: s.project, title: "parent" });
	const child = await launched(s, "reply descendant response", { from: parent, title: "child" });
	s.swb("drive", "start", "--size", "85x30");
	await waitState(s, "the Deck", (x) => x.ready && x.layout.rosterOnly);
	await cursorTo(s, child);
	await onScreen("i ▸ details", "collapsed details");
	expect(s.screen().match(/child/g)).toHaveLength(1);
	s.keys("i");
	await onScreen("got descendant", "the last turn in expanded details");
	expect(s.screen()).toContain("started by ↳ parent");
	expect(s.screen()).toContain("created");
	expect(s.screen()).toContain("a Archive");
	expect(
		s
			.screen()
			.split("\n")
			.find((line) => line.includes("created")),
	).toMatch(/^│.{83}│/);
	await click("p Parent", 85);
	await waitState(s, "the details Parent action returns to the parent", (x) => x.cursor === parent);
	await cursorTo(s, child);
	await onScreen("got descendant", "the child's details restored");
	await click("i ▾ details", 85);
	await onScreen("i ▸ details", "collapsed by click");
	expect(s.screen()).not.toContain("got descendant");
	await click("i ▸ details", 85);
	await onScreen("got descendant", "expanded by click");
	s.swb("drive", "resize", "60x18");
	await until(() => !s.screen().includes("a Archive") && s.screen().includes("PgUp/PgDn"), budgets.settle, "short details");
	s.keys("NPage");
	await onScreen("a Archive", "actions after scrolling details");
	await click("m Group…", 60);
	await onScreen("Group for child", "the details action targets its session");
	s.keys("Escape", "PPage");
	await onScreen("created", "details scrolled back");
	s.swb("drive", "resize", "85x30");
	await cursorTo(s, parent);
	await onScreen("parent response", "details follow the cursor");
	expect(s.screen()).not.toContain("got descendant");
	s.keys("i", "/", "-l", "nothingmatches");
	await onScreen("No matching sessions", "empty filter");
	expect(s.screen().match(/esc clears/g)).toHaveLength(1);
	expect(Number(find("nothingmatches", 85)[1])).toBeLessThan(Number(find("No matching sessions", 85)[1]));
	await click("esc clears", 85);
	await waitState(s, "filter cleared by its recovery action", (x) => x.filter === "");
	expect(s.screen()).toContain("parent");
});
