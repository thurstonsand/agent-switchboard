import { rmSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
	type Component,
	type Focusable,
	ProcessTerminal,
	sliceByColumn,
	TuiAltScreen,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Harness, VIEWS } from "@swb/shared";
import { harnessName } from "@swb/shared/mailbox";
import { mark } from "@swb/shared/trace";
import { displayName, openDescendants, projectName } from "../derive.ts";
import { targetName } from "../dirs.ts";
import { type Choice, presetLabels } from "../harnesses.ts";
import { presetUntil } from "../schedules.ts";
import { newer } from "../sessions.ts";
import { tmux, UI } from "../tmux.ts";
import { VERSION } from "../version.ts";
import { DECK } from "./deck.ts";
import { rosterPane, sock, stagePane } from "./env.ts";
import {
	addTarget,
	archiveCancels,
	archivedKey,
	archiving,
	boot,
	chosenPreset,
	commit,
	completedRows,
	ctl,
	cursorEntry,
	cursorIndex,
	cursorLine,
	dragging,
	editorShown,
	filtering,
	frame,
	groupOf,
	handleCommand,
	historyStep,
	hoverLine,
	keymap,
	launchElapsed,
	launchOnStage,
	levelOf,
	listedDirs,
	marked,
	menuPresets,
	model,
	nameChoices,
	nameMode,
	onColors,
	onFrame,
	onKey,
	onMouse,
	onOverlayHover,
	onOverlayPress,
	onPointerOut,
	origin,
	panes,
	parentOf,
	peekButtons,
	peekSpot,
	perf,
	pickerMode,
	pickerPresets,
	pickerTarget,
	pickRows,
	query,
	rosterRows,
	SNOOZE_CHOICES,
	scanBase,
	settingsPane,
	shellShownIn,
	snoozeMode,
	stageKeys,
	stateOf,
	status,
	toast,
	viewOf,
} from "./machine.ts";
import {
	type Binding,
	type Choosing,
	type ClickTarget,
	type Command,
	LAUNCH_COLS,
	legendParts,
	type Menu,
	type Part,
	PEEK_MIN_COLS,
	type PeekSpot,
	type PickRow,
	type Row,
	type SessionRow,
} from "./model.ts";
import { type Overlay, type OverlayButton, Overlays, type OverlayView } from "./overlay.ts";
import type { DeckState, Entry, PickerState, State } from "./protocol.ts";
import {
	age,
	attention,
	blue,
	bold,
	breathe,
	cyan,
	dim,
	flashOn,
	gray,
	green,
	key,
	magenta,
	red,
	shortPath,
	spinnerFrame,
	wakeAt,
} from "./style.ts";

function glyph(state: State, now: number): string {
	switch (state) {
		case "loading":
			return cyan(spinnerFrame(now));
		case "blocked":
			return flashOn(now) ? bold(attention("◆")) : dim(attention("◆"));
		case "working":
			return model.breath ? breathe(model.breath.faint, model.breath.strong, now, "◐") : cyan("◐");
		case "unseen":
			return green("●");
		case "idle":
			return "○";
		case "dormant":
			return gray("○");
		case "cut-off":
		case "errored":
			return red("⚠");
		case "archived":
			return gray("✓");
	}
}

/**
 * The Stage's card as newline-delimited JSON, for the placeholder: each line the latest card, once the placeholder has
 * taken the last one, so a burst of cursor moves sends only where it ended. It ends with the Deck.
 */
function cardStream(): Response {
	const encoder = new TextEncoder();
	let sent: string | null = null;
	let gone = false;
	const body = new ReadableStream(
		{
			async pull(controller) {
				while (!gone && model.stage.cardJson === sent) await model.stage.cardChanged.promise;
				if (gone) return;
				sent = model.stage.cardJson;
				controller.enqueue(encoder.encode(`${sent}\n`));
			},
			cancel() {
				gone = true;
			},
		},
		{ highWaterMark: 0 },
	);
	return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

/** The schedules the archive prompt names for each session before it counts the rest. */
const ARCHIVE_SCHEDULES = 3;

class Roster implements Component, Focusable {
	/**
	 * pi-tui's focus is always the roster's; it passes it on to the inputs, so the one showing places the terminal's
	 * cursor rather than drawing one of its own, and tmux shows that cursor only while the roster's pane is active.
	 */
	get focused(): boolean {
		return model.filter.focused;
	}
	set focused(on: boolean) {
		for (const input of [model.filter, model.search, model.path]) input.focused = on;
		const naming = nameMode();
		if (naming) naming.input.focused = on;
	}

	handleInput(data: string): void {
		onKey(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return onMouse(event);
	}

	render(width: number): string[] {
		const t0 = performance.now();
		const height = tui.terminal.rows;
		const settings = settingsPane();
		if (settings) {
			const lines = settings.render(width, height);
			place(lines, [], width, null);
			return lines;
		}
		const choosing = pickerMode();
		if (choosing) {
			const lines = renderPicker(width, height);
			place(lines, launchOverlays(choosing, width, height), width, null);
			return lines;
		}
		const now = Date.now();
		const rows = rosterRows();
		const index = cursorIndex(rows);
		frame.targets = [];
		// A wide Deck's Peek says what the session is; the narrow one's roster has no Stage beside it to show one.
		const detailLines = panes.narrow ? 3 : 1;
		const tag = filterTag(width);
		frame.listTop = tag === null ? 0 : 1;
		const bodyHeight = Math.max(1, height - frame.listTop - 3 - detailLines);
		const detail = detailRows(width, now, frame.listTop + bodyHeight + 1);
		const lines = tag === null ? [] : [tag];
		lines.push(...list(rows, index, width, bodyHeight, now));
		lines.push(
			gray("─".repeat(width)),
			...detail,
			messageLine(now, frame.listTop + bodyHeight + 1 + detailLines),
			hints(frame.listTop + bodyHeight + 1 + detailLines + 1, width),
		);
		place(
			lines,
			[...peekOverlays(rows, width, height), ...toastOverlay(now, width, frame.listTop + bodyHeight + 1 + detailLines)],
			width,
			peekSpot(rows, index),
		);
		const out = lines.map((line) => truncateToWidth(line, width, "…", true));
		if (perf.render.n === 0) mark("roster.first-frame");
		perf.render.add(performance.now() - t0);
		if (frame.keyAt > 0) {
			perf.keyToFrame.add(performance.now() - frame.keyAt);
			frame.keyAt = 0;
		}
		return out;
	}

	invalidate(): void {}
}

/**
 * Draws the overlays that go over the roster's own lines into them. The rest float over the Stage, which afterFrame sees
 * to once the frame is out, with the Peek wanted at spot.
 */
function place(lines: string[], want: Overlay[], width: number, spot: PeekSpot | null): void {
	frame.over = want.filter((o) => o.x + o.width <= width);
	for (const o of frame.over) drawOver(lines, o, width);
	frame.wanted = { floats: want.filter((o) => !frame.over.includes(o)), leaves: want.some((o) => o.leaves), spot };
	if (frame.frameQueued) return;
	frame.frameQueued = true;
	queueMicrotask(() => afterFrame());
}

/** Puts in place what the last frame wants: the Peek, the UI server's pointer watch, and what floats over the Stage. */
function afterFrame(): void {
	frame.frameQueued = false;
	const { floats, leaves, spot } = frame.wanted;
	// A Peek that closed or moved floats in this frame as it was; the next frame draws it as it is now.
	const moved = onFrame(spot, leaves);
	overlays.sync(moved ? floats.filter((o) => o.id !== "peek") : floats);
	if (moved) tui.requestRender();
}

/**
 * An overlay over the roster's own lines, drawn into them rather than floated: a float made or killed in a zoomed
 * window, as a narrow Deck's is, has tmux resize the zoomed pane twice. Its buttons are click targets ahead of
 * everything beneath it, and the rest of it swallows clicks.
 */
function drawOver(lines: string[], o: Overlay, width: number): void {
	const p = model.pointer;
	const hot = o.view.buttons.find((b) => p?.y === o.y + b.y && p.x >= o.x + b.from && p.x < o.x + b.to);
	while (lines.length < o.y + o.view.lines.length) lines.push("");
	o.view.lines.forEach((line, i) => {
		const under = lines[o.y + i] as string;
		lines[o.y + i] =
			`${truncateToWidth(under, o.x, "", true)}\x1b[0m${hot?.y === i ? hot.hot : line}\x1b[0m${sliceByColumn(under, o.x + o.width, width - o.x - o.width)}`;
	});
	frame.targets.unshift(
		...o.view.buttons.map((b) => ({ y: o.y + b.y, from: o.x + b.from, to: o.x + b.to, command: b.command })),
		...o.view.lines.map((_, i) => ({ y: o.y + i, from: o.x, to: o.x + o.width, command: null })),
	);
}

/** The picker's rows, which the list gives up its bottom to; each choice is a button. */
function pickerParts(width: number, height: number): Part[] {
	if (snoozeMode()) return snoozeMenu(width);
	const naming = nameMode();
	if (!naming) return [];
	const choices = nameChoices();
	const shown = Math.max(1, Math.min(choices.length, height - 4));
	const from = Math.max(0, Math.min(naming.choice - shown + 1, choices.length - shown));
	const title = ` ${naming.renaming ? "rename" : "Group for"} ${naming.title} `;
	const out: Part[] = [
		[`${gray(`─${truncateToWidth(title, width - 5, "…")}${"─".repeat(Math.max(0, width - 4 - visibleWidth(title)))}`)} ✕ `, null],
	];
	for (let i = from; i < from + shown; i++) {
		const choice = choices[i] as { label: string; name: string | null };
		const label = choice.name === null ? dim(choice.label) : choice.label.startsWith("+ ") ? green(choice.label) : choice.label;
		const line = truncateToWidth(`   ${label}`, width, "…", true);
		out.push([i === naming.choice ? cursorLine(line, true) : line, { kind: "choose", index: i }]);
	}
	return out;
}

function snoozeMenu(width: number): Part[] {
	const snoozing = snoozeMode();
	if (!snoozing) return [];
	const now = Date.now();
	const title = ` Snooze ${snoozing.title} `;
	const out: Part[] = [
		[`${gray(`─${truncateToWidth(title, width - 5, "…")}${"─".repeat(Math.max(0, width - 4 - visibleWidth(title)))}`)} ✕ `, null],
	];
	SNOOZE_CHOICES.forEach((choice, i) => {
		const until = presetUntil(choice.snooze, now);
		const at = gray(until === null ? "↘" : wakeAt(until, now));
		const label = `   ${choice.label}`;
		const line = `${label}${" ".repeat(Math.max(1, width - visibleWidth(label) - visibleWidth(at) - 1))}${at} `;
		out.push([i === snoozing.choice ? cursorLine(line, true) : line, { kind: "choose", index: i }]);
	});
	return out;
}

function renderPicker(width: number, height: number): string[] {
	const choosing = pickerMode() as Choosing;
	const adding = choosing.mode === "add";
	frame.targets = [];
	const typed = model.path.getValue();
	const absolute = typed.startsWith("/") || typed.startsWith("~");
	const prompt = gray(absolute ? "› " : `› ${shortPath(scanBase())}/`);
	const input = adding
		? `${prompt}${model.path.render(Math.max(10, width - 2 - visibleWidth(prompt)))[0] ?? ""}`
		: (model.search.render(Math.max(10, width - 2))[0] ?? "");
	// The launch card goes on the Stage; with no room there, as on a narrow Deck, the roster draws it under its title.
	const card = launchOnStage(width) ? null : launchCard(choosing, width, "right");
	for (const b of card?.buttons ?? []) frame.targets.push({ y: 1 + b.y, from: b.from, to: b.to, command: b.command });
	frame.card = card ? card.lines.map((line) => Bun.stripANSI(line)) : null;
	// While the menu is open, the rest of the picker waits behind it.
	const muted = (line: string) => (choosing.menu ? gray(Bun.stripANSI(line)) : line);
	const lines = [
		muted(` ${bold(adding ? "add a directory" : "new session in")}`),
		...(card?.lines ?? []),
		muted(` ${input}`),
		gray("─".repeat(width)),
	];
	frame.pickerListY = lines.length;
	// The picker's detail is its path and two blank lines.
	const bodyHeight = Math.max(1, height - lines.length - 6);
	let body: Part[];
	let detail: string;
	if (!adding) {
		const rows = pickRows();
		body = rows.map((row, i): Part => {
			const line = truncateToWidth(pickLine(row, width, i === choosing.choice), width, "…", true);
			return [i === choosing.choice ? cursorLine(line, true) : line, { kind: "choose", index: i }];
		});
		const row = rows[choosing.choice];
		detail =
			row?.kind === "target" ? ` ${gray(shortPath(row.target.path))}` : model.dirTrees === null ? ` ${dim("finding directories…")}` : "";
	} else {
		const listed = listedDirs();
		const matches = completedRows();
		body = matches.map((path, i): Part => {
			const name = `${basename(path)}/`;
			const line = truncateToWidth(`   ${listed.has(path) ? dim(name) : name}`, width, "…", true);
			return [i === choosing.choice ? cursorLine(line, true) : line, { kind: "choose", index: i }];
		});
		detail = ` ${gray(shortPath(addTarget()))}`;
	}
	// The window only scrolls to keep the highlight in view, so hovering never drags the list under the pointer.
	let top = Math.min(frame.pickerTop, Math.max(0, body.length - bodyHeight));
	// -1 in add mode highlights nothing, and scrolls nowhere.
	if (choosing.choice < top) top = Math.max(0, choosing.choice);
	if (choosing.choice >= top + bodyHeight) top = choosing.choice - bodyHeight + 1;
	frame.pickerTop = top;
	frame.listHeight = bodyHeight;
	const shown = body.slice(top, top + bodyHeight);
	shown.forEach(([, command], i) => {
		// The remove prompt is modal: only its own answers are buttons; and so is the menu, which a click elsewhere closes.
		if (!command || choosing.confirm || choosing.menu) return;
		const y = frame.pickerListY + i;
		// The cursor row's ✕, at its right edge, removes it.
		if (!adding && top + i === choosing.choice && pickRows()[choosing.choice]?.kind === "target")
			frame.targets.push({ y, from: width - 3, to: width, command: { kind: "remove" } });
		frame.targets.push({ y, from: 0, to: width, command });
	});
	const out = shown.map(([line]) => line);
	while (out.length < bodyHeight) out.push("");
	if (choosing.confirm) overlayConfirm(out, width, choosing.confirm, frame.pickerListY, keymap(), frame.targets);
	lines.push(...out.map(muted), gray("─".repeat(width)), muted(detail), "", "", messageLine(Date.now()));
	// The remove prompt carries its own keys.
	lines.push(choosing.confirm ? "" : legend(lines.length, keymap(), width, []));
	return lines.map((line) => truncateToWidth(line, width, "…", true));
}

/** The filter's tag, atop the list while one applies, is a button that clears it. */
function filterTag(width: number): string | null {
	if (query() === "" || filtering()) return null;
	const parts: Part[] = [
		[" ", null],
		[`${magenta(`/${model.filter.getValue()}`)} ✕`, { kind: "clearFilter" }],
	];
	return truncateToWidth(clickable(0, parts), width, "…");
}

function list(rows: Row[], index: number, width: number, full: number, now: number): string[] {
	const picker = pickerParts(width, full);
	const height = Math.max(1, full - picker.length);
	picker.forEach(([, command], i) => {
		if (command) frame.targets.push({ y: frame.listTop + height + i, from: 0, to: width, command });
	});
	// The ✕ closing the Group picker, at its title's right end.
	if (picker.length > 0) frame.targets.push({ y: frame.listTop + height, from: width - 3, to: width, command: { kind: "cancel" } });
	// The archive prompt opens beneath its row, pushing the rows after it down; its row is the cursor's.
	const asking = archiving() === null ? -1 : rows.findIndex((r) => r.key === archiving());
	const archiveEntry = model.mode.kind === "archive" ? model.entries.get(model.mode.id) : undefined;
	const prompt = asking === -1 || !archiveEntry ? 0 : archivePromptHeight(archiveEntry);
	if (index < frame.scrollTop) frame.scrollTop = index;
	if (index + prompt >= frame.scrollTop + height) frame.scrollTop = index + prompt - height + 1;
	frame.scrollTop = Math.max(0, Math.min(frame.scrollTop, Math.max(0, rows.length + prompt - height)));
	frame.listHeight = height;
	const out: string[] = [];
	for (let i = frame.scrollTop; out.length < height; i++) {
		const row = rows[i];
		if (!row) {
			out.push("");
			continue;
		}
		const y = frame.listTop + out.length;
		const line = truncateToWidth(rowLine(row, width, now), width, "…", true);
		if (dragging()?.drop?.header.key === row.key) out.push(cursorLine(line, true));
		else if (i === index) out.push(cursorLine(line, model.focus === "roster"));
		else out.push(row.key === model.hover ? hoverLine(line) : line);
		if (row.kind === "session" && row.family.length > 0) {
			const at = foldColumn(row);
			frame.targets.push({ y, from: at - 1, to: at + 1, command: { kind: "fold", id: row.key } });
		}
		if (i === asking) out.push(...archivePrompt((row as SessionRow).entry, width, frame.listTop + out.length));
	}
	out.length = height;
	if (rows.length === 0) out[0] = dim(model.snapshot ? (query() ? "   no matches" : "   no sessions yet · n new") : "   loading…");
	return [...out, ...picker.map(([line]) => line)];
}

/** What the prompt says above its answers: what goes with the session, or the schedules archiving cancels. */
function archiveNotes(e: Entry): string[] {
	const mode = model.mode;
	if (mode.kind === "archive" && mode.chosen) {
		const groups = archiveCancels(e, mode.chosen.all);
		return [
			"Cancels schedules:",
			...groups.flatMap(({ entry, schedules }) => [
				// One session's schedules need no title; several are told apart by theirs.
				...(groups.length > 1 ? [` ${displayName(entry)}`] : []),
				...schedules.slice(0, ARCHIVE_SCHEDULES).map((p) => `  ${gray("◷")} ${p.scheduleLabel}`),
				...(schedules.length > ARCHIVE_SCHEDULES ? [gray(`  … ${schedules.length - ARCHIVE_SCHEDULES} more`)] : []),
			]),
		];
	}
	const family = openDescendants(model.entries.values(), e.id);
	return [family.length > 0 ? familyTally(family) : "Branch kept; clean worktree only"];
}

/** The prompt's borders, notes, answers, and a line for each way to delete the worktree too. */
function archivePromptHeight(e: Entry): number {
	return (
		3 +
		archiveNotes(e).length +
		keymap().filter((b) => b.command?.kind === "archiveAnswer" && b.command.deleteWorktree && b.label !== null).length
	);
}

/** Archive alone, with its family, or delete this linked worktree as well: the archive keymap's answers, as buttons. */
function archivePrompt(e: Entry, width: number, top: number): string[] {
	const inner = Math.max(1, width - 4);
	const box = (text: string) => ` │${truncateToWidth(text, inner, "…", true)}│`;
	const notes = archiveNotes(e);
	const answers = keymap().filter((b) => b.label !== null);
	const keep = answers.filter((b) => b.command?.kind !== "archiveAnswer" || !b.command.deleteWorktree);
	const deleting = answers.filter((b) => b.command?.kind === "archiveAnswer" && b.command.deleteWorktree);
	const anyway = model.mode.kind === "archive" && model.mode.chosen !== null;
	const choice = clickable(top + 1 + notes.length, [
		[anyway ? " │ Archive anyway " : " │ Archive  ", null],
		...keep.flatMap((b, i): Part[] => [
			...(i > 0 ? ([["  ", null]] as Part[]) : []),
			[b.label ? key(b.name, b.label) : bold(b.name), b.command],
		]),
	]);
	const lines = deleting.map((b, i) =>
		clickable(top + 2 + notes.length + i, [
			[" │ ", null],
			[key(b.name, b.label as string), b.command],
		]),
	);
	return [
		` ┌${"─".repeat(inner)}┐`,
		...notes.map((note) => box(` ${note}`)),
		...[choice, ...lines].map((line) => `${truncateToWidth(line, inner + 2, "…", true)}│`),
		` └${"─".repeat(inner)}┘`,
	];
}

/** Joins the parts into row y's line, recording where each clickable one lands. */
function clickable(y: number, parts: Part[]): string {
	let x = 0;
	let line = "";
	const p = model.pointer;
	for (const [text, command] of parts) {
		const w = visibleWidth(text);
		if (command) frame.targets.push({ y, from: x, to: x + w, command });
		line += command && p?.y === y && p.x >= x && p.x < x + w ? cursorLine(text, true) : text;
		x += w;
	}
	return line;
}

/** The Stage's bar: its views and the shell toggle. A narrow Deck, which has no Peek, also states the session and its place. */
function detailRows(width: number, now: number, top: number): string[] {
	const e = cursorEntry() ?? (model.stage.staged === null ? null : (model.entries.get(model.stage.staged) ?? null));
	if (!e) return panes.narrow ? ["", "", ""] : [""];
	let tabs = "";
	if (model.stage.staged === e.id && e.open) {
		const parts: Part[] = [[" ", null]];
		for (const view of VIEWS) {
			// The first view is the session's own TUI, whichever harness that is.
			const label = ` ${view === "agent" ? e.harness : view} `;
			parts.push([view === panes.applied.view ? cursorLine(label, true) : gray(label), { kind: "view", view }]);
		}
		// The shell is a toggle beside the views, not one of them.
		if (!panes.narrow)
			parts.push([gray(" · "), null], [panes.applied.shell ? cursorLine(" shell ", true) : gray(" shell "), { kind: "shell" }]);
		tabs = clickable(panes.narrow ? top + 2 : top, parts);
	}
	if (!panes.narrow) return [truncateToWidth(tabs, width, "…")];
	// The first tab names the harness; without tabs, the path line does.
	const where = `${tabs ? "" : `${e.harness} · `}${shortPath(e.cwd)}${e.branch ? ` ${magenta(`⎇ ${e.branch}`)}` : ""}`;
	return [` ${status(e)}${launchElapsed(e, now)}`, ` ${gray(where)}`, tabs].map((line) => truncateToWidth(line, width, "…"));
}

/** A toast, else the config error, which stays until the file is fixed and opens it on a click; y makes it clickable. */
function messageLine(now: number, y: number | null = null, withConfigError = true): string {
	const t = model.toasts.filter((t) => t.until > now).at(-1);
	if (!t && model.configError && withConfigError) {
		const error = model.configError;
		// Like a legend entry: the key that acts on it, then what's wrong.
		const text = `${bold("O")} ${red(`config.toml${error.line === null ? "" : `:${error.line}`}: ${error.problem}`)}`;
		return y === null
			? ` ${text}`
			: clickable(y, [
					[" ", null],
					[text, { kind: "config", line: error.line }],
				]);
	}
	if (!t)
		return model.snapshot && newer(model.snapshot.swbVersion, VERSION)
			? ` ${red(`✗ swb ${model.snapshot.swbVersion} is in; reopen the Deck`)}`
			: "";
	return ` ${t.level === "error" ? red(`✗ ${t.text}`) : green(t.text)}`;
}

/** The legend line: a field being typed into, where a drag would land, or the keys the mode takes. */
function hints(y: number, cols: number): string {
	// The archive prompt carries its own keys.
	if (archiving() !== null) return "";
	if (filtering()) return ` ${model.filter.render(Math.max(10, panes.rosterWidth() - 2))[0] ?? ""}`;
	const naming = nameMode();
	if (naming) return ` ${naming.input.render(Math.max(10, panes.rosterWidth() - 2))[0] ?? ""}`;
	const drag = dragging();
	if (drag?.moved) {
		if (!drag.drop) return ` ${red("✗ not here")}`;
		return drag.drop.name === null ? ` ⇢ out of its Group` : ` ⇢ into ${bold(drag.drop.name)}`;
	}
	// `[` and `]` as buttons, at the legend's right end, gray while there's nowhere to go.
	const arrow = (glyph: string, step: -1 | 1): Part =>
		historyStep(step) === -1 ? [gray(glyph), null] : [bold(glyph), { kind: "history", step }];
	const arrows: Part[] = model.mode.kind === "roster" ? [arrow("‹", -1), [" ", null], arrow("›", 1)] : [];
	return legend(y, model.focus === "stage" ? stageKeys() : keymap(), cols, arrows);
}

/**
 * A keymap's labelled bindings as buttons, in its order, and `trailing` at the right end. What doesn't fit goes whole,
 * from the end.
 */
function legend(y: number, bindings: Binding<Command>[], cols: number, trailing: Part[]): string {
	const end = trailing.reduce((n, [text]) => n + visibleWidth(text), 0);
	// Trailing parts keep a column of their own either side.
	const parts = legendParts(bindings, trailing.length === 0 ? cols : cols - end - 2);
	if (trailing.length === 0) return clickable(y, parts);
	const used = parts.reduce((n, [text]) => n + visibleWidth(text), 0);
	return clickable(y, [...parts, [" ".repeat(Math.max(1, cols - used - end - 1)), null], ...trailing]);
}

function pickLine(row: PickRow, width: number, cursor: boolean): string {
	if (row.kind === "add") return ` ${green("+ add a directory…")}`;
	const name = marked(targetName(row.target), row.at);
	const label = row.target.repo ? `   ${name}` : ` ${row.context ? dim(name) : bold(name)}`;
	if (!cursor || row.context) return label;
	return `${truncateToWidth(label, width - 3, "…", true)} ✕ `;
}

/** The remove prompt, boxed over the middle of the list; its keymap's answers are its buttons. */
function overlayConfirm(
	out: string[],
	width: number,
	confirm: { name: string; worktrees: number },
	listY: number,
	answers: Binding<Command>[],
	targets: ClickTarget[],
): void {
	const inner = Math.min(width - 4, 34);
	const left = Math.floor((width - inner - 2) / 2);
	const pad = (text: string) => `${" ".repeat(left)}│${truncateToWidth(` ${text}`, inner, "…", true)}│`;
	const lines = [
		`${" ".repeat(left)}┌${"─".repeat(inner)}┐`,
		pad(`Remove ${bold(confirm.name)}`),
		pad(confirm.worktrees > 0 ? `and its ${confirm.worktrees} worktree${confirm.worktrees > 1 ? "s" : ""}` : ""),
		pad("from this list?"),
		pad(""),
		pad(answers.map((b) => key(b.name, b.label as string)).join("  ")),
		`${" ".repeat(left)}└${"─".repeat(inner)}┘`,
	];
	const top = Math.max(0, Math.floor((out.length - lines.length) / 3));
	lines.forEach((line, i) => {
		out[top + i] = line;
	});
	const y = listY + top + 5;
	let x = left + 2;
	for (const b of answers) {
		const w = visibleWidth(key(b.name, b.label as string));
		targets.unshift({ y, from: x, to: x + w, command: b.command });
		x += w + 2;
	}
}

function rowLine(row: Row, width: number, now: number): string {
	if (row.kind === "header") {
		const count = gray(` (${row.count})`);
		const name = row.group === null ? bold(projectName(row.project)) : row.group;
		return `${" ".repeat(1 + row.depth * 2)}${row.collapsed ? "▸" : "▾"} ${name}${count}`;
	}
	if (row.kind === "section") return ` ${row.expanded ? "▾" : "▸"} ${row.label} ${gray(`(${row.count})`)}`;
	const e = row.entry;
	// Mid-drag, the session being carried is a hollow outline of itself.
	const drag = dragging();
	if (drag?.moved && drag.id === e.id) {
		const lead = `${gray("┆")}${rowLead(row)}`;
		return `${lead}${gray("◌")} ${gray(truncateToWidth(displayName(e), width - visibleWidth(lead) - 2, "…"))}`;
	}
	const mark = model.stage.staged === e.id ? (model.focus === "stage" ? cyan("▌") : "▌") : " ";
	const lead = `${mark}${rowLead(row)}`;
	// A snoozed row says when it wakes instead: ↘ for its next message. Mid-turn, the glyph already says it's active.
	const when = !e.open
		? age(archivedKey(e), now)
		: e.snoozed
			? e.snoozedUntil === null
				? "↘"
				: wakeAt(e.snoozedUntil, now)
			: e.activity !== "idle"
				? ""
				: age(e.activityAt, now);
	const worktree = e.cwd !== e.project ? magenta("⎇") : " ";
	const right = ` ${worktree} ${gray(when.padStart(3))} `;
	const hidden = row.folded ? ` ${foldedTally(row.family.map((p) => p.entry))}` : "";
	const titleWidth = width - visibleWidth(lead) - 2 - visibleWidth(hidden) - visibleWidth(right);
	const title = truncateToWidth(e.provisional ? gray(displayName(e)) : displayName(e), titleWidth, "…", true);
	return `${lead}${glyph(stateOf(e), now)} ${title}${hidden}${right}`;
}

/**
 * A session row's left edge, after the cursor's bar: a nested row hangs from its parent's glyph on its family's guides;
 * a family's root says who started it, if a session did, and has the family's fold.
 */
function rowLead(row: SessionRow): string {
	const indent = " ".repeat(row.depth * 2);
	const fold = row.family.length === 0 ? null : gray(row.folded ? "▸" : "▾");
	if (row.nest) {
		const guides = row.nest.continues.map((on) => (on ? "│  " : "   ")).join("");
		return `${indent}  ${gray(`${guides}${row.nest.last ? "└" : "├"}`)}${fold ?? gray("─")} `;
	}
	const from = origin(row.entry);
	return `${indent}${originMark(from)}${fold ?? " "}`;
}

function originMark(from: "session" | "operator" | null): string {
	return from === "operator" ? blue("⌁") : from === "session" ? "↳" : " ";
}

/** Where a row's fold is: the column a click on it folds or opens its family from. */
function foldColumn(row: SessionRow): number {
	return row.nest ? 4 + row.depth * 2 + 3 * row.nest.continues.length : 2 + row.depth * 2;
}

/** What a family is doing, by state; ○ is every one finished, idle or not running. */
function familyTally(family: Entry[]): string {
	const states = family.map(stateOf);
	const tally: [State[], string][] = [
		[["working", "loading"], cyan("◐")],
		[["blocked"], attention("◆")],
		[["cut-off", "errored"], red("⚠")],
		[["unseen"], green("●")],
		[["idle", "dormant"], "○"],
	];
	return tally
		.flatMap(([which, mark]) => {
			const n = states.filter((state) => which.includes(state)).length;
			return n > 0 ? [`${mark}${n}`] : [];
		})
		.join(" ");
}

/** How many sessions a fold hides, and of them, as the terminal's title counts them, those that need me. */
function foldedTally(hidden: Entry[]): string {
	const states = hidden.map(stateOf);
	const count = (state: State, mark: string) => {
		const n = states.filter((s) => s === state).length;
		return n > 0 ? ` ${mark}${n}` : "";
	};
	return `${gray(`+${hidden.length}`)}${count("blocked", attention("◆"))}${count("unseen", green("●"))}`;
}

// ── Peek ────────────────────────────────────────────────────────────────

// A Peek is a session's particulars and keys in an overlay beside its row (see overlay.ts): on the Stage, so it never
// covers the roster, or on a narrow Deck, which has no Stage beside the roster, over the roster's right edge. The UI
// server puts it away when the pointer leaves (see deck.ts).

const PEEK_COLS = 48;

/** The most of a folded family a Peek lists. */
const PEEK_FOLD_ROWS = 8;

/**
 * The settled Peek, beside its row: on the Stage, opening onto the roster's border, or on a narrow Deck, which has no
 * Stage beside the roster, over the roster's right edge, leaving each row's glyph and the start of its title showing.
 * While the pointer is on it, it holds as if on its row.
 */
function peekOverlays(rows: Row[], width: number, height: number): Overlay[] {
	const spot = model.peek.settled;
	const row = spot && rows.find((r) => r.key === spot.id);
	if (!spot || row?.kind !== "session") return [];
	const w = panes.narrow ? Math.max(PEEK_MIN_COLS, Math.min(PEEK_COLS, width - 16)) : Math.min(PEEK_COLS, panes.width - width - 1);
	if (w < PEEK_MIN_COLS || width < PEEK_MIN_COLS) return [];
	const view = peekView(row, w, height, panes.narrow ? "right" : "left");
	return [
		{
			id: "peek",
			about: spot.id,
			x: panes.narrow ? width - w : width + 1,
			y: Math.max(0, Math.min(spot.y - 1, height - view.lines.length)),
			width: w,
			view,
			leaves: true,
			hovers: spot.id,
		},
	];
}

/**
 * A toast too long for the message line rises from it over the roster's bottom rows, under a rule, so none of it is
 * cut; the list beneath keeps its place.
 */
function toastOverlay(now: number, width: number, y: number): Overlay[] {
	const t = model.toasts.filter((t) => t.until > now).at(-1);
	if (!t) return [];
	const text = t.level === "error" ? `✗ ${t.text}` : t.text;
	if (visibleWidth(text) <= width - 1) return [];
	const paint = t.level === "error" ? red : green;
	const lines = [gray("─".repeat(width)), ...wrapTextWithAnsi(text, width - 1).map((line) => ` ${paint(line)}`)];
	return [{ id: "toast", about: t.text, x: 0, y: y - lines.length + 1, width, view: { lines, buttons: [] }, leaves: false, hovers: null }];
}

/** The launch card's menu, no wider than this. */
const MENU_COLS = 52;

/**
 * The launch card, on the Stage atop the roster's top row unless the roster draws it, and its menu hung from its field.
 * Both stay while the roster has the keyboard.
 */
function launchOverlays(choosing: Choosing, width: number, height: number): Overlay[] {
	if (model.focus !== "roster") return [];
	const want: Overlay[] = [];
	const onStage = launchOnStage(width);
	if (onStage) {
		const w = Math.min(LAUNCH_COLS, panes.width - width - 1);
		want.push({
			id: "launch",
			about: "launch",
			x: width + 1,
			y: 0,
			width: w,
			view: launchCard(choosing, w, "left"),
			leaves: false,
			hovers: null,
		});
	}
	if (choosing.menu) {
		const field = onStage ? { x: width + 1, y: 1 } : { x: 0, y: 2 };
		const w = Math.min(MENU_COLS, (onStage ? panes.width : width) - field.x - 4);
		const y = field.y + 1;
		const view = launchMenu(choosing, w, height - y);
		want.push({ id: "menu", about: "launch", x: field.x + 2, y, width: w, view, leaves: false, hovers: null });
	}
	return want;
}

/** A path too long for the Peek keeps its end, where the directories that tell sessions apart are. */
function tailOf(path: string, width: number): string {
	return visibleWidth(path) <= width ? path : `…${path.slice(path.length - width + 1)}`;
}

function ago(at: number, now: number): string {
	const a = age(at, now);
	return a === "now" ? "just now" : `${a} ago`;
}

/** A line of a Peek, or of the launch card, on its three framed sides: open to the left beside the roster, to the right in it. */
function peekFrame(open: "left" | "right", inner: number): (content: string) => string {
	return (content) =>
		open === "left"
			? ` ${truncateToWidth(content, inner, "…", true)} ${gray("│")}`
			: `${gray("│")} ${truncateToWidth(content, inner, "…", true)} `;
}

/** What a session from the picker starts on, as the launch card's field says it. */
function presetField(c: Choice): string {
	const p = c.preset;
	const what = p.agent ? `${p.agent} ${gray("agent")}` : `${p.model} ${gray(p.effort ?? "default")}`;
	return `${cyan(harnessName(p.harness))}  ${what}${p.provider ? gray(` · ${p.provider}`) : ""}`;
}

/**
 * The launch card: what a session from the picker starts on, its harness first, and the preset's note; its field opens
 * the menu. On the Stage it opens to the left, onto the roster's border; in a narrow Deck's roster, to the right.
 */
function launchCard(choosing: Choosing, width: number, open: "left" | "right"): OverlayView {
	const inner = width - 3;
	const presets = pickerPresets();
	const chosen = presets[chosenPreset(choosing)];
	const menu = choosing.menu;
	let value: string;
	if (menu && menu.query !== "") value = `${menu.query}▌`;
	else if (chosen) value = presetField(chosen);
	else {
		const target = pickerTarget(choosing);
		value =
			target === null
				? gray("finding harnesses…")
				: typeof target === "string"
					? red(target)
					: `${cyan(harnessName(target.harness))} ${gray("· its own defaults")}`;
	}
	const arrow = presets.length === 0 ? " " : menu ? "▴" : "▾";
	const field = `${truncateToWidth(value, inner - 2, "…", true)} ${gray(arrow)}`;
	const frame = peekFrame(open, inner);
	const edge = `─ starts ${"─".repeat(Math.max(0, width - 10))}`;
	const lines = [
		gray(open === "left" ? `${edge}╮` : `╭${edge}`),
		frame(field),
		// The open menu says the highlighted preset's note, and covers all but the edge of this one.
		frame(gray(menu ? "" : (chosen?.note ?? ""))),
		gray(open === "left" ? `${"─".repeat(width - 1)}╯` : `╰${"─".repeat(width - 1)}`),
	];
	const margin = open === "left" ? 1 : 2;
	return {
		lines,
		buttons:
			presets.length === 0
				? []
				: [{ y: 1, from: margin, to: margin + inner, command: { kind: "menu" }, hot: frame(cursorLine(field, true)) }],
	};
}

/**
 * The launch card's menu, hung from its field: every preset, a harness at a time, numbered for one key to pick until
 * something's typed, and the highlighted one's note. Too long for the room it has, it scrolls to keep its highlight in view.
 */
function launchMenu(choosing: Choosing, width: number, maxHeight: number): OverlayView {
	const menu = choosing.menu as Menu;
	const inner = width - 4;
	const presets = pickerPresets();
	const chosen = chosenPreset(choosing);
	const shown = menuPresets(menu.query);
	const items: string[] = [];
	const itemAt: number[] = [];
	let harness: Harness | null = null;
	shown.forEach((index, n) => {
		const p = (presets[index] as Choice).preset;
		if (p.harness !== harness) {
			harness = p.harness;
			items.push(cyan(harnessName(harness)));
		}
		const name = p.agent ?? p.model ?? "";
		const pad = " ".repeat(Math.max(1, 21 - visibleWidth(name)));
		const effort = (p.agent ? "agent" : (p.effort ?? "default")).padEnd(8);
		itemAt.push(items.length);
		items.push(
			`${menu.query === "" && n < 9 ? cyan(String(n + 1)) : " "} ${p.default ? "★" : " "} ${index === chosen ? cyan(name) : name}${pad}${gray(effort)}${gray(p.provider ?? "")}`,
		);
	});
	if (shown.length === 0) items.push(gray("nothing matches"));
	// Its frame, and the rule and note under the list.
	const room = Math.max(1, maxHeight - 4);
	const from = Math.min(Math.max(0, (itemAt[menu.cursor] ?? 0) - room + 1), Math.max(0, items.length - room));
	let to = Math.min(items.length, from + room);
	// A harness's name at the foot of the window, with none of its presets under it, says nothing.
	if (to < items.length && !itemAt.includes(to - 1)) to--;
	const row = (content: string) => `${gray("│")} ${truncateToWidth(content, inner, "…", true)} ${gray("│")}`;
	const lines = [gray(`┌${"─".repeat(width - 2)}┐`)];
	const buttons: OverlayButton[] = [];
	items.slice(from, to).forEach((line, i) => {
		const n = itemAt.indexOf(from + i);
		const content = truncateToWidth(line, inner, "…", true);
		if (n !== -1)
			buttons.push({ y: lines.length, from: 2, to: 2 + inner, command: { kind: "choose", index: n }, hot: row(hoverLine(content)) });
		lines.push(row(n === menu.cursor ? cursorLine(content, true) : content));
	});
	lines.push(
		gray(`├${"─".repeat(width - 2)}┤`),
		row(gray(presets[shown[menu.cursor] ?? -1]?.note ?? "")),
		gray(`└${"─".repeat(width - 2)}┘`),
	);
	return { lines, buttons };
}

/**
 * What a Peek shows, framed on three sides. Beside the roster it opens to the left, onto the roster's border; drawn by
 * the roster itself, at the terminal's right edge, it opens to the right. A Peek too short for everything loses the last
 * turn first.
 */
function peekView(row: SessionRow, width: number, maxHeight: number, open: "left" | "right"): OverlayView {
	const e = row.entry;
	const now = Date.now();
	const inner = width - 3;
	const rule = gray("─".repeat(inner));
	const head: string[] = [];
	const title = wrapTextWithAnsi(displayName(e), inner);
	const titleLines = title.length > 2 ? [title[0] as string, truncateToWidth(title.slice(1).join(" "), inner, "…")] : title;
	head.push(...titleLines.map((line) => bold(line)));
	head.push(...wrapTextWithAnsi(`${glyph(stateOf(e), now)} ${status(e)}${launchElapsed(e, now)}`, inner));
	head.push(
		gray(
			`created ${ago(e.createdAt, now)} · ${e.open ? `active ${e.activity !== "idle" ? "now" : ago(e.activityAt, now)}` : `archived ${ago(archivedKey(e), now)}`}`,
		),
	);
	head.push(rule, gray(tailOf(`${e.harness} · ${shortPath(e.cwd)}`, inner)));
	const info = model.peek.info.get(e.id)?.info;
	if (e.branch) {
		const diff = info?.diff;
		const changes = diff ? `  ${green(`+${diff.add}`)} ${red(`−${diff.del}`)}${gray(" uncommitted")}` : "";
		head.push(`${magenta(`⎇ ${e.branch}`)}${changes}`);
	}
	const group = groupOf(e);
	if (group !== null) head.push(`${gray("Group")} ${group}`);
	// Lines that are buttons: who started it, and on a fold, each session it hides.
	const links: { at: number; command: Command }[] = [];
	const parent = parentOf(e);
	if (parent) {
		const label = `${gray("started by")} ${originMark(origin(e))} `;
		links.push({ at: head.length, command: { kind: "row", act: "parent", row: e.id } });
		head.push(`${label}${truncateToWidth(displayName(parent), inner - visibleWidth(label) - 2, "…", true)} ${dim("p")}`);
		if (parent.project !== e.project && !parent.operator)
			head.push(gray(`${" ".repeat(visibleWidth(label))}in ${projectName(parent.project)}`));
	}
	if (row.folded) {
		head.push(rule, `${gray("folded")} ${foldedTally(row.family.map((p) => p.entry))}`);
		for (const { entry, nest } of row.family.slice(0, PEEK_FOLD_ROWS)) {
			const guides = `${nest.continues.map((on) => (on ? "│  " : "   ")).join("")}${nest.last ? "└─ " : "├─ "}`;
			links.push({ at: head.length, command: { kind: "reveal", id: entry.id } });
			head.push(`${gray(guides)}${glyph(stateOf(entry), now)} ${displayName(entry)}`);
		}
		const rest = row.family[PEEK_FOLD_ROWS];
		if (rest) {
			links.push({ at: head.length, command: { kind: "reveal", id: rest.entry.id } });
			head.push(gray(`… ${row.family.length - PEEK_FOLD_ROWS} more`));
		}
	}
	if (e.schedules.length > 0) {
		head.push(rule, gray("Schedules"));
		// The soonest few, and always the last that ran, so it shows one ran however many are pending.
		const shown = [...e.schedules.filter((v) => v.nextAt !== null).slice(0, 3), ...e.schedules.filter((v) => v.nextAt === null)];
		for (const v of shown) {
			const line =
				v.nextAt === null
					? `${green("✓")} ${v.scheduleLabel}${gray(` · ran ${ago(v.lastFiredAt as number, now)}`)}`
					: v.cron
						? `${cyan("↻")} ${v.scheduleLabel}${gray(` · next ${wakeAt(v.nextAt, now)}${v.lastFiredAt === null ? "" : ` · last ${ago(v.lastFiredAt, now)}`}`)}`
						: `${gray("◷")} ${v.scheduleLabel}${gray(` · ${wakeAt(v.nextAt, now)}`)}`;
			head.push(truncateToWidth(` ${line}`, inner, "…"));
		}
	}
	const turn: string[] = [];
	if (info?.error) turn.push(rule, ...wrapTextWithAnsi(red(`✗ ${info.error}`), inner).slice(0, 3));
	else if (info?.last) {
		const label = `${(info.last.who === "you" ? "you" : e.harness).padEnd(Math.max(3, e.harness.length))} `;
		const pad = visibleWidth(label);
		const text = wrapTextWithAnsi(info.last.text.replace(/\s+/g, " ").trim(), inner - pad);
		const shown = text.length > 3 ? [...text.slice(0, 2), truncateToWidth(text.slice(2).join(" "), inner - pad, "…")] : text;
		turn.push(rule, ...shown.map((line, i) => `${gray(i === 0 ? label : " ".repeat(pad))}${line}`));
	}
	// The buttons, wrapped; each is the row's key, so the Peek teaches them too.
	const buttons: { y: number; from: number; to: number; command: Command; text: string }[] = [];
	const buttonLines: string[] = [];
	let line = "";
	let x = 0;
	for (const [label, k, act] of peekButtons(row)) {
		const text = ` ${label} ${dim(k)} `;
		const w = visibleWidth(text);
		if (x > 0 && x + 1 + w > inner) {
			buttonLines.push(line);
			line = "";
			x = 0;
		}
		if (x > 0) {
			line += " ";
			x += 1;
		}
		buttons.push({ y: buttonLines.length, from: x, to: x + w, command: { kind: "row", act, row: row.key }, text });
		line += text;
		x += w;
	}
	if (line !== "") buttonLines.push(line);
	const body = [...head, ...(head.length + turn.length + 1 + buttonLines.length + 2 <= maxHeight ? turn : []), rule];
	const buttonsAt = body.length;
	body.push(...buttonLines);
	const frame = peekFrame(open, inner);
	const edge = "─".repeat(width - 1);
	const lines = [
		gray(open === "left" ? `${edge}╮` : `╭${edge}`),
		...body.slice(0, maxHeight - 2).map(frame),
		gray(open === "left" ? `${edge}╯` : `╰${edge}`),
	];
	const margin = open === "left" ? 1 : 2;
	return {
		lines,
		buttons: [
			...links
				.filter((link) => 1 + link.at < lines.length - 1)
				.map((link) => ({
					y: 1 + link.at,
					from: margin,
					to: margin + inner,
					command: link.command,
					hot: frame(cursorLine(truncateToWidth(body[link.at] as string, inner, "…", true), true)),
				})),
			...buttons
				.filter((b) => 1 + buttonsAt + b.y < lines.length - 1)
				.map((b) => {
					const y = 1 + buttonsAt + b.y;
					// The line again with this one button lit, for the pointer resting on it.
					const lit = (buttonLines[b.y] as string).replace(b.text, cursorLine(b.text, true));
					return { y, from: margin + b.from, to: margin + b.to, command: b.command, hot: frame(lit) };
				}),
		],
	};
}

/**
 * The worker's harness discovery runs each command in a session of its own, which neither the pane's SIGHUP nor this
 * process exiting reaches: a `pi --list-models` left running would outlive the Deck. Those sessions are the only
 * children here that lead their own process group.
 */
function stopDiscovery(): void {
	// biome-ignore lint/plugin: at exit, when nothing waits on the roster's keys any more.
	const children = Bun.spawnSync(["pgrep", "-P", String(process.pid)])
		.stdout.toString()
		.split("\n")
		.filter(Boolean);
	for (const pid of children) {
		try {
			process.kill(-Number(pid), "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
}

/** The socket file this roster listens on, by inode: a roster that replaced this one may have its own there by now. */
let listening: number | null = null;

function cleanup(): never {
	settingsPane()?.saveProse();
	overlays.closeAllNow();
	stopDiscovery();
	// The roster that replaces this one may already listen there.
	// biome-ignore lint/plugin: at exit, when nothing waits on the roster's keys any more.
	if (statSync(sock, { throwIfNoEntry: false })?.ino === listening) rmSync(sock, { force: true });
	ctl.close();
	process.exit(0);
}

process.on("SIGHUP", cleanup);

process.on("SIGTERM", cleanup);

// The pane gone, its terminal also reads as closed, or fails with EIO, and either can come before the SIGHUP.
process.stdin.on("close", cleanup);

process.stdin.on("error", (error: NodeJS.ErrnoException) => {
	if (error.code !== "EIO") throw error;
	cleanup();
});

/** A narrow Deck's roster is zoomed already, and stays so. */

// ── view state ──────────────────────────────────────────────────────────

function pickerState(): PickerState | null {
	const choosing = pickerMode();
	if (!choosing) return null;
	const listed = listedDirs();
	const rows =
		choosing.mode === "pick"
			? pickRows().map((row) =>
					row.kind === "add"
						? { name: "+ add a directory…", path: null, worktree: false, dim: false }
						: { name: targetName(row.target), path: row.target.path, worktree: row.target.repo !== null, dim: row.context },
				)
			: completedRows().map((path) => ({ name: `${basename(path)}/`, path, worktree: false, dim: listed.has(path) }));
	return {
		mode: choosing.mode,
		input: (choosing.mode === "pick" ? model.search : model.path).getValue(),
		rows,
		choice: choosing.choice,
		confirm: choosing.confirm?.name ?? null,
		...(() => {
			const presets = pickerPresets();
			const labels = presetLabels(presets.map((c) => c.preset));
			const target = pickerTarget(choosing);
			const menu = choosing.menu;
			return {
				preset: labels[chosenPreset(choosing)] ?? null,
				harness: target !== null && typeof target !== "string" ? target.harness : null,
				presets: menuPresets("").map((i) => labels[i] as string),
				menu: menu && { query: menu.query, cursor: menu.cursor, shown: menuPresets(menu.query).map((i) => labels[i] as string) },
			};
		})(),
	};
}

/** An overlay as it's on screen, without its color: over the roster's lines, or floating. */
function overlayShown(id: string): { about: string; lines: string[] } | null {
	const o = frame.over.find((o) => o.id === id);
	return o ? { about: o.about, lines: o.view.lines.map((line) => Bun.stripANSI(line)) } : overlays.painted(id);
}

function viewState(): DeckState {
	const rows = rosterRows();
	const labels = new Map(rows.flatMap((row) => (row.kind === "header" && row.group !== null ? [[row.key, row.group]] : [])));
	const index = cursorIndex(rows);
	const cursorRow = rows[index];
	const drag = dragging();
	const drop = drag?.moved ? drag.drop : null;
	const applied = panes.applied;
	const staged = applied.id === null ? undefined : model.entries.get(applied.id);
	return {
		ready: model.ready,
		terminalFocused: model.terminalFocused,
		cursor: cursorRow?.kind === "session" ? cursorRow.entry.id : null,
		cursorRow: index,
		mode: model.mode.kind,
		picker: pickerState(),
		archive: (() => {
			const e = model.mode.kind === "archive" ? model.entries.get(model.mode.id) : undefined;
			if (!e) return null;
			const family = openDescendants(model.entries.values(), e.id);
			const chosen = model.mode.kind === "archive" ? model.mode.chosen : null;
			const cancels = chosen ? archiveCancels(e, chosen.all).flatMap((g) => g.schedules.map((p) => p.scheduleLabel)) : null;
			return { id: e.id, counts: Bun.stripANSI(familyTally(family)), all: family.length + 1, cancels };
		})(),
		settings: settingsPane()?.state() ?? null,
		configError: model.configError?.message ?? null,
		drop: drop ? { project: projectName(drop.header.project), group: drop.header.group } : null,
		filter: query(),
		hover: model.hover,
		peek: (() => {
			const shown = overlayShown("peek");
			return shown && model.peek.settled ? { id: shown.about, source: model.peek.settled.source, lines: shown.lines } : null;
		})(),
		launch: pickerMode() && {
			card: overlayShown("launch")?.lines ?? frame.card,
			menu: overlayShown("menu")?.lines ?? null,
		},
		focus:
			model.focus === "roster"
				? "roster"
				: model.focusedPane === shellShownIn()
					? "shell"
					: model.focusedPane === stagePane && editorShown(applied)
						? "editor"
						: "stage",
		staged: {
			id: applied.id,
			host: applied.host,
			kind: applied.kind,
			view: applied.view,
			savedView: staged ? viewOf(staged) : "agent",
		},
		layout: {
			width: panes.width,
			rosterOnly: panes.shownNarrow,
			split: panes.side !== null,
			shell: applied.shell?.at === "replace" ? "replace" : (panes.shellPane?.at ?? null),
			rosterHidden: panes.rosterHidden,
		},
		waking: model.launches.map((launch) => ({ id: launch.id, keyboardWaiting: launch.keyboard })),
		rows: rows.map((row) =>
			row.kind === "session"
				? {
						kind: "session",
						id: row.entry.id,
						title: displayName(row.entry),
						glyph: Bun.stripANSI(glyph(stateOf(row.entry), 0)),
						state: stateOf(row.entry),
						provisional: row.entry.provisional,
						group: labels.get(row.header) ?? null,
						level: levelOf(row.nest),
						origin: row.nest ? null : origin(row.entry),
						folded: row.folded,
						hidden: row.folded ? row.family.length : 0,
					}
				: row.kind === "header"
					? {
							kind: "header",
							project: projectName(row.project),
							group: row.group,
							expanded: !row.collapsed,
						}
					: { kind: "section", label: row.label, count: row.count, expanded: row.expanded },
		),
		colors: model.colors,
		toasts: model.toasts.filter((t) => t.until > Date.now()).map((t) => ({ text: t.text, level: t.level })),
		perf: {
			render: perf.render.summary(),
			switchClient: perf.switchClient.summary(),
			keyToSwitch: perf.keyToSwitch.summary(),
			keyToFrame: perf.keyToFrame.summary(),
		},
	};
}

const tui = new TuiAltScreen(new ProcessTerminal(), true, undefined, { mouse: true });

const roster = new Roster();

tui.setLayoutRoot(roster);

const overlays = new Overlays({
	pane: rosterPane,
	deck: DECK,
	failed: (message) => toast(message, "error"),
	left: onPointerOut,
	pressed: onOverlayPress,
	hovered: onOverlayHover,
	changed: () => commit(),
});

tui.setFocus(roster);

tui.start();

// Inside tmux pi-tui asks only for motion with a button down. The roster wants every motion, for the hover, the Peek,
// and the picker's highlight, and asking for it here is what makes tmux pass the pointer's motion to the UI server.
process.stdout.write("\x1b[?1003h");

async function queryColors(scheme: "light" | "dark" | null): Promise<void> {
	const reported = await tui.queryTerminalColors({ timeoutMs: 200 });
	onColors(reported, scheme);
}

tui.onTerminalColorSchemeChange((scheme) => void queryColors(scheme));

// A terminal reports its scheme on every palette change, and tmux asks it for its colors again each time, but passes the
// report on only when the scheme flips: from one light theme to another, this is the roster's only word of it. tmux
// answers the first query's colors from what it had, but holds its reply until the palette's replies are back from the
// terminal, which answered tmux first, so the second sees the new colors.
async function recheckColors(scheme: "light" | "dark"): Promise<void> {
	await tui.queryTerminalColors({ timeoutMs: 200 });
	await queryColors(scheme);
}

tui.setTerminalColorSchemeNotifications(true);

void queryColors(null);

// biome-ignore-start lint/plugin: before the roster's first frame, when nothing waits on its keys yet.
tmux(UI, "set", "-p", "-t", rosterPane, "@swb_label", "swb");

rmSync(sock, { force: true });

// biome-ignore-end lint/plugin: startup
// bun-types 1.4.4 leaves idleTimeout off unix servers, but Bun applies it to them, after 10 s by default.
// @ts-expect-error
Bun.serve({
	unix: sock,
	// The placeholder's card stream stays open, idle between cards, for as long as the Deck lives.
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method === "GET" && url.pathname === "/state") return Response.json(viewState());
		if (req.method === "GET" && url.pathname === "/card") return cardStream();
		if (req.method === "POST" && url.pathname === "/cmd") {
			const body = await req.json();
			const { cmd, args: argv } = body;
			if (typeof cmd !== "string" || !Array.isArray(argv) || !argv.every((arg) => typeof arg === "string"))
				return new Response("expected {cmd: string, args: string[]}", { status: 400 });
			try {
				await handleCommand(cmd, argv);
			} catch (error) {
				return new Response((error as Error).message, { status: 400 });
			} finally {
				commit();
			}
			return new Response("ok");
		}
		return new Response("not found", { status: 404 });
	},
});

// biome-ignore lint/plugin: startup
listening = statSync(sock).ino;

boot({
	requestRender: () => tui.requestRender(),
	closeOverlays: () => overlays.closeAll(),
	pointerAway: () => overlays.pointerAway(),
	disarmed: () => overlays.disarmed(),
	message: (now, withConfigError) => messageLine(now, null, withConfigError),
	recheckColors: (scheme) => void recheckColors(scheme),
});
