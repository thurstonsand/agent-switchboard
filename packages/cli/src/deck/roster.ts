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
import { mark } from "@swb/shared/trace";
import { displayName, openDescendants, projectName } from "../derive.ts";
import { targetName } from "../dirs.ts";
import { type Choice, presetLabels } from "../harnesses.ts";
import { presetUntil } from "../schedules.ts";
import { newer } from "../sessions.ts";
import { SESSIONS, tmux } from "../tmux.ts";
import { VERSION } from "../version.ts";
import { DECK } from "./conf.ts";
import { rosterPane, sock } from "./env.ts";
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
	matches,
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
	type RowAct,
	type SessionRow,
} from "./model.ts";
import { type Overlay, type OverlayButton, Overlays, type OverlayView } from "./overlay.ts";
import { PRESET_HEADER, presetColumns } from "./preset-table.ts";
import type { DeckState, Entry, PickerState, State } from "./protocol.ts";
import {
	age,
	attention,
	blockedMark,
	blue,
	bold,
	cyan,
	dim,
	gray,
	green,
	key,
	keyName,
	magenta,
	red,
	shortPath,
	spinnerFrame,
	underline,
	wakeAt,
} from "./style.ts";

function glyph(state: State, now: number): string {
	switch (state) {
		case "loading":
			return cyan(spinnerFrame(now));
		case "blocked":
			return blockedMark("◆");
		case "working":
			return bold(cyan("◐"));
		case "unseen":
			return green("●");
		case "idle":
			return "○";
		case "dormant":
			return "–";
		case "cut-off":
			return bold(red("!"));
		case "errored":
			return bold(red("×"));
		case "archived":
			return "✓";
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
	get capturesViewportInput(): boolean {
		return panes.narrow && model.details.expanded && model.mode.kind === "roster";
	}

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
		frame.promptGap = null;
		frame.details = null;
		const prompt = promptOverlay(width, height)[0];
		const reserved = prompt?.x === 0 ? prompt.view.lines.length : 0;
		const detail = detailView(rows[index], width, Math.max(1, height - reserved - 8));
		const tag = filterTag(width);
		frame.listTop = tag === null ? 0 : 1;
		const detailLines = 1 + (detail?.lines.length ?? 0);
		const bodyHeight = Math.max(1, height - frame.listTop - 3 - detailLines - reserved);
		const lines = tag === null ? [] : [tag];
		const beforeScroll = frame.scrollTop;
		lines.push(...list(rows, index, width, bodyHeight, now));
		if (prompt && reserved) {
			prompt.y = Math.max(frame.listTop, Math.min(frame.listTop + frame.listHeight, prompt.y + beforeScroll - frame.scrollTop));
			frame.promptGap = { at: prompt.y, rows: reserved };
			for (const target of frame.targets) if (target.y >= prompt.y) target.y += reserved;
			lines.splice(prompt.y, 0, ...Array<string>(reserved).fill(""));
		}
		const detailTop = height - detailLines - 2;
		const tabs = detailRows(width, detailTop, detail !== null);
		if (detail) {
			const y = detailTop + 1;
			frame.details = { y, height: detail.lines.length, total: detail.total };
			for (const b of detail.buttons) {
				frame.targets.push({ y: y + b.y, from: b.from, to: b.to, command: b.command });
				const p = model.pointer;
				if (p?.y === y + b.y && p.x >= b.from && p.x < b.to) detail.lines[b.y] = b.hot;
			}
		}
		lines.push(
			overflowRule(rows.slice(frame.scrollTop + frame.listHeight), "↓", width),
			...tabs,
			...(detail?.lines ?? []),
			messageLine(now, height - 2),
			hints(height - 1, width),
		);
		place(
			lines,
			[...peekOverlays(rows, width, height), ...(prompt ? [prompt] : []), ...toastOverlay(now, width, height - 2)],
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

/** Puts in place what the last frame wants: the Peek, tmux's pointer watch, and what floats over the Stage. */
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

/** Shared contents of the row-anchored Archive, Group, and Snooze forms. */
function pickerParts(width: number, height: number): Part[] {
	if (snoozeMode()) return snoozeMenu(width);
	if (model.mode.kind === "archive") {
		const e = model.entries.get(model.mode.id);
		if (!e) return [];
		return [
			[`Archive ${displayName(e)}`, null],
			...archiveNotes(e).map((note): Part => [` ${note}`, null]),
			...keymap()
				.filter((b) => b.label !== null && b.command?.kind !== "cancel")
				.map(
					(b): Part => [
						` ${bold(b.name.padEnd(3))} ${b.label?.replace("delete clean worktree", bold(red("delete clean worktree")))}`,
						b.command,
					],
				),
		];
	}
	const naming = nameMode();
	if (!naming) return [];
	const choices = nameChoices();
	const shown = Math.max(1, Math.min(choices.length, height - 3));
	const from = Math.max(0, Math.min(naming.choice - shown + 1, choices.length - shown));
	const title = `${naming.renaming ? "Rename Group" : "Group for"} ${naming.title}`;
	const out: Part[] = [[title, null]];
	for (let i = from; i < from + shown; i++) {
		const choice = choices[i] as { label: string; name: string | null };
		const label = choice.name === null ? dim(choice.label) : choice.label.startsWith("+ ") ? green(choice.label) : choice.label;
		const line = truncateToWidth(`   ${label}`, width, "…", true);
		out.push([i === naming.choice ? cursorLine(line, true) : line, { kind: "choose", index: i }]);
	}
	const input = naming.input.render(Math.max(10, width - 2))[0] ?? "";
	out.push([` ${input}`, null]);
	return out;
}

function promptTitle(title: string, width: number): string {
	const label = truncateToWidth(` ${title} `, width - 7, "…");
	return `${gray("╭─")}${label}${gray("─".repeat(Math.max(0, width - visibleWidth(label) - 7)))} ✕ ${gray("─╮")}`;
}

function promptOverlay(width: number, height: number): Overlay[] {
	const mode = model.mode;
	if (mode.kind !== "archive" && mode.kind !== "name" && mode.kind !== "snooze") return [];
	const rosterWidth = width;
	const insert = panes.narrow || mode.kind === "name";
	width = insert ? width : Math.min(Math.max(width, 54), panes.width - rosterWidth - 1);
	if (width < PEEK_MIN_COLS) return [];
	const parts = pickerParts(width - 2, height - 2);
	const row = (line: string) => `${gray("│")}${truncateToWidth(line, width - 2, "…", true)}${gray("│")}`;
	const title = parts[0]?.[0] ?? "";
	const lines = [promptTitle(title, width), ...parts.slice(1).map(([line]) => row(line)), gray(`╰${"─".repeat(width - 2)}╯`)];
	const buttons: OverlayButton[] = parts.flatMap(([line, command], y) =>
		command ? [{ y, from: 1, to: width - 1, command, hot: row(cursorLine(truncateToWidth(line, width - 2, "…", true), true)) }] : [],
	);
	buttons.push({ y: 0, from: width - 4, to: width - 1, command: { kind: "cancel" }, hot: lines[0] as string });
	const x = insert ? 0 : Math.max(rosterWidth + 1, Math.min(mode.at.x, panes.width - width));
	const y = insert
		? frame.listTop + rosterRows().findIndex((r) => r.key === mode.at.row) - frame.scrollTop + 1
		: Math.max(0, Math.min(mode.at.y + lines.length <= height ? mode.at.y : mode.at.y - lines.length, height - lines.length));
	return [{ id: "prompt", about: mode.kind, x, y, width, view: { lines, buttons }, leaves: false, hovers: null }];
}

function snoozeMenu(width: number): Part[] {
	const snoozing = snoozeMode();
	if (!snoozing) return [];
	const now = Date.now();
	const out: Part[] = [[`Snooze ${snoozing.title}`, null]];
	SNOOZE_CHOICES.forEach((choice, i) => {
		const until = presetUntil(choice.snooze, now);
		const at = until === null ? "↘" : wakeAt(until, now);
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
	const card = launchOnStage(width) || width < PEEK_MIN_COLS ? null : launchCard(choosing, Math.min(LAUNCH_COLS, width));
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
	// Leave room below the list for its path, a blank line, and the footer.
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
		detail = row?.kind === "target" ? ` ${shortPath(row.target.path)}` : model.dirTrees === null ? ` ${dim("finding directories…")}` : "";
	} else {
		const listed = listedDirs();
		const matches = completedRows();
		body = matches.map((path, i): Part => {
			const name = `${basename(path)}/`;
			const line = truncateToWidth(`   ${listed.has(path) ? dim(name) : name}`, width, "…", true);
			return [i === choosing.choice ? cursorLine(line, true) : line, { kind: "choose", index: i }];
		});
		detail = ` ${shortPath(addTarget())}`;
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
	if (choosing.confirm) {
		while (out.length < bodyHeight) out.push("");
		overlayConfirm(out, width, choosing.confirm, frame.pickerListY, keymap(), frame.targets);
	}
	lines.push(...out.map(muted), "", muted(detail));
	while (lines.length < height - 2) lines.push("");
	lines.push(messageLine(Date.now()));
	// The remove prompt carries its own keys.
	lines.push(choosing.confirm || choosing.menu ? "" : legend(lines.length, keymap(), width, []));
	return lines.map((line) => truncateToWidth(line, width, "…", true));
}

/** The filter's tag, atop the list while one applies, is a button that clears it. */
function filterTag(width: number): string | null {
	if (query() === "" || filtering()) return null;
	const parts: Part[] = [
		[" ", null],
		[`${magenta(`/${model.filter.getValue()}`)} ✕`, { kind: "clearFilter" }],
		[` · ${filterCount()} · ${bold("Esc")} clears`, { kind: "clearFilter" }],
	];
	return truncateToWidth(clickable(0, parts), width, "…");
}

function filterCount(): string {
	const entries = [...model.entries.values()];
	return gray(`${entries.filter(matches).length} of ${entries.length}`);
}

function matchedText(text: string): string {
	const q = query();
	if (!q) return text;
	let out = "";
	let from = 0;
	for (let at = text.toLowerCase().indexOf(q); at !== -1; at = text.toLowerCase().indexOf(q, from)) {
		out += text.slice(from, at) + underline(text.slice(at, at + q.length));
		from = at + q.length;
	}
	return out + text.slice(from);
}

function list(rows: Row[], index: number, width: number, full: number, now: number): string[] {
	let height = full;
	if (index < frame.scrollTop) frame.scrollTop = index;
	if (index >= frame.scrollTop + height) frame.scrollTop = index - height + 1;
	frame.scrollTop = Math.max(0, Math.min(frame.scrollTop, Math.max(0, rows.length - height)));
	const pinned: string[] = [];
	if (frame.scrollTop > 0 && full > 2) {
		height--;
		if (index >= frame.scrollTop + height) frame.scrollTop = index - height + 1;
		const first = rows[frame.scrollTop];
		const header = first?.kind === "session" ? rows.find((r) => r.key === first.header) : undefined;
		const name = header?.kind === "header" ? (header.group ?? projectName(header.project)) : header?.kind === "section" ? header.label : "";
		pinned.push(overflowRule(rows.slice(0, frame.scrollTop), "↑", width, name));
		frame.listTop++;
	}
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
		else if (i === index) out.push(cursorLine(row.kind === "session" ? line : `▌${line.slice(1)}`, model.focus === "roster"));
		else out.push(line);
		if (row.kind === "session" && row.family.length > 0) {
			const at = foldColumn(row);
			frame.targets.push({ y, from: at - 1, to: at + 1, command: { kind: "fold", id: row.key } });
		}
	}
	out.length = height;
	if (rows.length === 0) {
		out[0] = model.snapshot ? (query() ? "   No matching sessions" : "   no sessions yet · n new") : dim("   loading…");
	}
	return [...pinned, ...out];
}

function overflowRule(hidden: Row[], arrow: string, width: number, section = ""): string {
	if (hidden.length === 0) return gray("─".repeat(width));
	const states = hidden.flatMap((r) => (r.kind === "session" ? [stateOf(r.entry)] : []));
	const counts = (["blocked", "cut-off", "errored", "unseen"] as State[]).flatMap((state) => {
		const n = states.filter((s) => s === state).length;
		return n ? [`${glyph(state, Date.now())}${n}`] : [];
	});
	const label = ` ${arrow} ${hidden.length} ${counts.join(" ")}${section ? ` · ${section}` : ""} `;
	return `${label}${gray("─".repeat(Math.max(0, width - visibleWidth(label))))}`;
}

/** What the prompt says above its answers: what goes with the session, or the schedules archiving cancels. */
function archiveNotes(e: Entry): string[] {
	const mode = model.mode;
	if (mode.kind === "archive" && mode.chosen) {
		const groups = archiveCancels(e, mode.chosen.all);
		const recurring = new Set(
			[...model.entries.values()].flatMap((entry) => entry.schedules.filter((s) => s.cron !== null).map((s) => s.id)),
		);
		return [
			bold("Cancels schedules:"),
			...groups.flatMap(({ entry, schedules }) => [
				// One session's schedules need no title; several are told apart by theirs.
				...(groups.length > 1 ? [` ${displayName(entry)}`] : []),
				...schedules.slice(0, ARCHIVE_SCHEDULES).map((p) => `  ${recurring.has(p.id) ? cyan("↻") : "◷"} ${p.scheduleLabel}`),
				...(schedules.length > ARCHIVE_SCHEDULES ? [gray(`  … ${schedules.length - ARCHIVE_SCHEDULES} more`)] : []),
			]),
		];
	}
	const family = openDescendants(model.entries.values(), e.id);
	return [family.length > 0 ? `${family.length} child session${family.length === 1 ? "" : "s"}` : "Branch kept with either choice"];
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

/** Narrow details reuse the Peek, with scrolling when a short terminal cannot show it all. */
function detailView(row: Row | undefined, width: number, height: number): (OverlayView & { total: number }) | null {
	// tmux resizes the unzoomed panes before the narrow layout zooms the roster; details need the same room as a floating Peek.
	if (width < PEEK_MIN_COLS || !panes.narrow || !model.details.expanded || row?.kind !== "session" || model.mode.kind !== "roster")
		return null;
	const view = peekView(row, width, Infinity, "right");
	const top = Math.min(model.details.top, Math.max(0, view.lines.length - height));
	return {
		total: view.lines.length,
		lines: view.lines.slice(top, top + height),
		buttons: view.buttons.filter((b) => b.y >= top && b.y < top + height).map((b) => ({ ...b, y: b.y - top })),
	};
}

/** The Stage's views and, without a Stage beside it, a disclosure for the selected session. */
function detailRows(width: number, top: number, expanded: boolean): string[] {
	const e = cursorEntry() ?? (model.stage.staged === null ? null : (model.entries.get(model.stage.staged) ?? null));
	if (!e) return [""];
	const parts: Part[] = [[" ", null]];
	if (model.stage.staged === e.id && e.open) {
		parts.push([gray(`${keyName(model.config.prefix)} → `), null]);
		const editor = panes.applied.view === "editor";
		const splitting = viewOf(e) === "split";
		const label = `${bold("e")} editor`;
		if (!splitting) parts.push([editor ? cursorLine(label, true) : label, { kind: "view", view: editor ? "agent" : "editor" }]);
		const split = `${splitting ? "" : "  "}${bold("v")} split`;
		parts.push([panes.applied.view === "split" ? cursorLine(split, true) : split, { kind: "view", view: splitting ? "agent" : "split" }]);
		// The shell is a toggle beside the views, not one of them.
		const shell = `  ${bold("s")} shell`;
		if (!panes.narrow) parts.push([panes.applied.shell ? cursorLine(shell, true) : shell, { kind: "shell" }]);
	}
	if (panes.narrow && cursorEntry())
		parts.push(
			["  ", null],
			[`${bold("i")} ${expanded ? "▾" : "▸"} details`, { kind: "details" }],
			...(expanded ? ([[gray(" · PgUp/PgDn scroll"), null]] as Part[]) : []),
		);
	return [truncateToWidth(clickable(top, parts), Math.max(0, width - 1), "…")];
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
	if (archiving() !== null)
		return legend(
			y,
			keymap().filter((b) => b.command?.kind === "cancel"),
			cols,
			[],
		);
	if (filtering()) {
		const hint = ` · ${filterCount()} · ${bold("Esc")} clears`;
		return clickable(y, [
			[` ${model.filter.render(Math.max(10, cols - visibleWidth(hint) - 1))[0] ?? ""}`, null],
			[hint, { kind: "clearFilter" }],
		]);
	}
	if (nameMode()) return legend(y, keymap(), cols, []);
	const drag = dragging();
	if (drag?.moved) {
		if (!drag.drop) return ` ${red("✗ not here")}`;
		return drag.drop.name === null ? ` ⇢ out of its Group` : ` ⇢ into ${bold(drag.drop.name)}`;
	}
	const arrows: Part[] = [];
	if (model.mode.kind === "roster" && model.focus === "stage") {
		if (historyStep(-1) !== -1) arrows.push([`${bold("[")} ${dim("back")} `, { kind: "history", step: -1 }]);
		if (historyStep(1) !== -1) arrows.push([`${bold("]")} ${dim("forward")}`, { kind: "history", step: 1 }]);
	}
	let bindings = model.focus === "stage" ? stageKeys() : keymap();
	if (model.focus === "roster" && (model.peek.settled || frame.details)) {
		const row = rosterRows().find((r) => r.key === (model.peek.settled?.id ?? cursorEntry()?.id));
		const actions = row ? peekButtons(row).map(([, , act]) => act) : [];
		bindings = bindings.filter((b) => {
			const c = b.command;
			return !(c?.kind === "activate" && c.enter) && !(c?.kind === "row" && actions.includes(c.act));
		});
	}
	return legend(y, bindings, cols, arrows);
}

/**
 * A keymap's labelled bindings as buttons, in its order, and `trailing` at the right end. What doesn't fit goes whole,
 * from the end.
 */
function legend(y: number, bindings: Binding<Command>[], cols: number, trailing: Part[]): string {
	if (model.mode.kind === "roster" && model.focus === "roster") {
		const fixed = ["n", "?", ","];
		trailing = fixed.flatMap((name, i): Part[] => {
			const b = bindings.find((b) => b.name === name);
			const label = name === "n" ? "new" : name === "?" ? "keys" : "settings";
			const text = key(name, label);
			return [
				[i === 0 ? "" : "  ", null],
				[b?.label ? text : " ".repeat(visibleWidth(text)), b?.label ? b.command : null],
			];
		});
		bindings = bindings.filter((b) => !fixed.includes(b.name));
	}
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
		const name = row.group === null ? matchedText(projectName(row.project)) : matchedText(row.group);
		const title = row.group === null && row.depth === 0 ? bold(name) : name;
		return `${" ".repeat(1 + row.depth * 2)}${row.collapsed ? "▸" : "▾"} ${title}${count}`;
	}
	if (row.kind === "section") {
		const label = ` ${row.expanded ? "▾" : "▸"} ${row.label} ${gray(`(${row.count})`)} `;
		return `${label}${gray("─".repeat(Math.max(0, width - visibleWidth(label) - 1)))}`;
	}
	const e = row.entry;
	// Mid-drag, the session being carried is a hollow outline of itself.
	const drag = dragging();
	if (drag?.moved && drag.id === e.id) {
		const lead = `${gray("┆")}${rowLead(row)}`;
		return `${lead}${gray("◌")} ${gray(truncateToWidth(displayName(e), width - visibleWidth(lead) - 2, "…"))}`;
	}
	const mark = model.stage.staged === e.id ? (model.focus === "stage" ? cyan("▌") : cursorEntry() ? "▌" : dim("▌")) : " ";
	const lead = `${mark}${rowLead(row)}`;
	// A snoozed row says when it wakes instead: ↘ for its next message. Mid-turn, the glyph already says it's active.
	const when = !e.open
		? age(archivedKey(e), now)
		: e.snoozed
			? e.snoozedUntil === null
				? "↘"
				: `◷ ${wakeAt(e.snoozedUntil, now)}`
			: e.activity === "working"
				? ""
				: age(e.activityAt, now);
	const state = stateOf(e);
	const meta = [!row.nest ? originMark(origin(e)).trim() : "", e.cwd !== e.project ? gray("⎇") : ""].filter(Boolean).join(" ");
	const time = when.padStart(3);
	const right = ` ${meta || " "} ${e.open && e.activity === "blocked" ? attention(time) : state === "dormant" || state === "archived" ? dim(time) : time} `;
	const hidden = row.folded ? ` ${foldedTally(row.family.map((p) => p.entry))}` : "";
	const titleWidth = width - visibleWidth(lead) - 2 - visibleWidth(hidden) - visibleWidth(right);
	const paint = ["blocked", "unseen", "cut-off", "errored"].includes(state)
		? bold
		: e.provisional || state === "archived"
			? gray
			: (s: string) => s;
	const hovered = model.peek.settled?.source === "pointer" && model.peek.settled.id === e.id;
	const name = hovered ? displayName(e) : matchedText(displayName(e));
	let title = truncateToWidth(matches(e) || !e.live ? paint(name) : gray(name), titleWidth, "…");
	if (hovered) title = underline(title);
	title += " ".repeat(Math.max(0, titleWidth - visibleWidth(title)));
	return `${lead}${glyph(state, now)} ${title}${hidden}${right}`;
}

/**
 * A session row's left edge, after the cursor's bar: a nested row hangs from its parent's glyph on its family's guides;
 * a family's root leaves the gutter clear. Origin and folded counts sit beside the age.
 */
function rowLead(row: SessionRow): string {
	const indent = " ".repeat(row.depth * 2);
	if (row.nest) {
		const guides = row.nest.continues.map((on) => (on ? "│  " : "   ")).join("");
		return `${indent}  ${gray(`${guides}${row.nest.last ? "└" : "├"}─`)} `;
	}
	return `${indent}  `;
}

function originMark(from: "session" | "operator" | null): string {
	return from === "operator" ? blue("↳") : from === "session" ? "↳" : " ";
}

/** Where a row's fold is: the column a click on it folds or opens its family from. */
function foldColumn(row: SessionRow): number {
	return row.nest ? 4 + row.depth * 2 + 3 * row.nest.continues.length : 2 + row.depth * 2;
}

/** State counts exposed by deck state; the confirmation itself names the family in words. */
function familyTally(family: Entry[]): string {
	const states = family.map(stateOf);
	const tally: [State[], string][] = [
		[["working", "loading"], "◐"],
		[["blocked"], "◆"],
		[["cut-off"], "!"],
		[["errored"], "×"],
		[["unseen"], "●"],
		[["idle"], "○"],
		[["dormant"], "–"],
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
// covers the roster. A narrow Deck uses its bottom particulars instead. tmux puts a hover Peek away when
// the pointer leaves (see deck.ts).

const PEEK_COLS = 72;

/** The most of a folded family a Peek lists. */
const PEEK_FOLD_ROWS = 8;

/**
 * The settled Peek, beside its row on the Stage. While the pointer is on it, it holds as if on its row.
 */
function peekOverlays(rows: Row[], width: number, height: number): Overlay[] {
	const spot = model.peek.settled;
	const row = spot && rows.find((r) => r.key === spot.id);
	if (panes.narrow || !spot || row?.kind !== "session") return [];
	const w = Math.min(PEEK_COLS, panes.width - width - 1);
	if (w < PEEK_MIN_COLS || width < PEEK_MIN_COLS) return [];
	const view = peekView(row, w, height, "left");
	return [
		{
			id: "peek",
			about: spot.id,
			x: width + 1,
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
			view: launchCard(choosing, w),
			leaves: false,
			hovers: null,
		});
	}
	if (choosing.menu) {
		const field = onStage ? { x: width + 1, y: 1 } : { x: 0, y: 2 };
		const w = Math.min(LAUNCH_COLS, (onStage ? panes.width : width) - field.x);
		if (w < PEEK_MIN_COLS) return want;
		const y = field.y + 1;
		const view = launchMenu(choosing, w, height - y);
		want.push({ id: "menu", about: "launch", x: field.x, y, width: w, view, leaves: false, hovers: null });
	}
	return want;
}

/** A path too long for the Peek keeps its end, where the directories that tell sessions apart are. */
function tailOf(path: string, width: number): string {
	if (visibleWidth(path) <= width) return path;
	const parts = path.split("/");
	while (parts.length > 1) {
		parts.shift();
		const tail = `…/${parts.join("/")}`;
		if (visibleWidth(tail) <= width) return tail;
	}
	return truncateToWidth(`…/${parts[0]}`, width, "…");
}

function ago(at: number, now: number): string {
	const a = age(at, now);
	return a === "now" ? "just now" : `${a} ago`;
}

function peekFrame(inner: number): (content: string) => string {
	return (content) => `${gray("│")} ${truncateToWidth(content, inner, "…", true)} ${gray("│")}`;
}

/** What a session from the picker starts on, as the launch card's field says it. */
function presetField(c: Choice): string {
	const p = c.preset;
	return `${p.harness} · ${bold(p.agent ?? p.model ?? "")}${p.agent ? " · agent" : ""}`;
}

function presetNote(note: string, width: number): string[] {
	const lines = wrapTextWithAnsi(note.replaceAll(" · ", "\n"), width);
	return lines.length <= 3 ? lines : [...lines.slice(0, 2), truncateToWidth(lines.slice(2).join(" "), width, "…")];
}

/**
 * The launch card: what a session from the picker starts on, its harness first, and the preset's note; its field opens
 * the menu. It sits beside the roster, or above the directory list in a narrow Deck.
 */
function launchCard(choosing: Choosing, width: number): OverlayView {
	const inner = width - 4;
	const presets = pickerPresets();
	const chosen = presets[chosenPreset(choosing)];
	const menu = choosing.menu;
	let value: string;
	if (menu) value = menu.query === "" ? gray("type to filter presets") : `${menu.query}▌`;
	else if (chosen) value = presetField(chosen);
	else {
		const target = pickerTarget(choosing);
		value =
			target === null
				? gray("finding harnesses…")
				: typeof target === "string"
					? red(target)
					: `${cyan(target.harness)} ${gray("· its own defaults")}`;
	}
	const arrow = presets.length === 0 ? " " : menu ? "▴" : "▾";
	const field = `${truncateToWidth(value, inner - 2, "…", true)} ${gray(arrow)}`;
	const frame = peekFrame(inner);
	const target = pickRows()[choosing.choice];
	const destination = choosing.mode === "add" ? shortPath(addTarget()) : target?.kind === "target" ? targetName(target.target) : "";
	const heading = menu
		? panes.narrow && destination
			? `Presets · ${destination}`
			: "Presets"
		: presets.length === 0
			? "Harness"
			: choosing.mode === "pick"
				? "Preset · Tab change"
				: "Preset";
	const lines = [
		promptTitle(heading, width),
		frame(field),
		...(menu
			? []
			: [
					...(panes.narrow ? [] : presetNote(chosen?.note ?? "", inner).map(frame)),
					...(chosen
						? [frame(gray(`${chosen.preset.effort ?? "default"} effort${chosen.preset.provider ? ` · ${chosen.preset.provider}` : ""}`))]
						: []),
					gray(`╰${"─".repeat(width - 2)}╯`),
				]),
	];
	const margin = 2;
	return {
		lines,
		buttons: [
			{ y: 0, from: width - 4, to: width - 1, command: { kind: "cancel" }, hot: lines[0] as string },
			...(presets.length === 0
				? []
				: [{ y: 1, from: margin, to: margin + inner, command: { kind: "menu" } as Command, hot: frame(cursorLine(field, true)) }]),
		],
	};
}

/**
 * The launch card's menu, hung from its field: every preset in shortlist order, numbered for one key to pick until
 * something's typed, and the highlighted one's note. Too long for the room it has, it scrolls to keep its highlight in view.
 */
function launchMenu(choosing: Choosing, width: number, maxHeight: number): OverlayView {
	const menu = choosing.menu as Menu;
	const inner = width - 4;
	const presets = pickerPresets();
	const shown = menuPresets(menu.query);
	const items: string[] = [];
	const itemAt: number[] = [];
	shown.forEach((index, n) => {
		const p = (presets[index] as Choice).preset;
		const cells = presetColumns(p.harness, p.agent ?? p.model ?? "", p.agent ? "agent" : (p.effort ?? "default"), p.provider ?? "");
		itemAt.push(items.length);
		items.push(
			`${menu.query === "" && n < 9 ? bold(String(index + 1)) : " "} ${p.default ? "★" : " "} ${cells.harness}${bold(cells.model)}${cells.effort}${cells.provider}`,
		);
	});
	if (shown.length === 0) items.push(gray("nothing matches"));
	const note = presetNote(presets[shown[menu.cursor] ?? -1]?.note ?? "", inner);
	const room = Math.max(1, maxHeight - 7 - note.length);
	const from = Math.min(Math.max(0, (itemAt[menu.cursor] ?? 0) - room + 1), Math.max(0, items.length - room));
	const to = Math.min(items.length, from + room);
	const row = (content: string) => `${gray("│")} ${truncateToWidth(content, inner, "…", true)} ${gray("│")}`;
	const lines = [gray(`├${"─".repeat(width - 2)}┤`), row("★ default preset"), row(PRESET_HEADER)];
	const buttons: OverlayButton[] = [];
	items.slice(from, to).forEach((line, i) => {
		const n = itemAt.indexOf(from + i);
		const content = truncateToWidth(line, inner, "…", true);
		if (n !== -1)
			buttons.push({ y: lines.length, from: 2, to: 2 + inner, command: { kind: "choose", index: n }, hot: row(hoverLine(content)) });
		lines.push(row(n === menu.cursor ? cursorLine(content, true) : content));
	});
	lines.push(gray(`├${"─".repeat(width - 2)}┤`), ...note.map(row), row(""));
	const hints = legendParts(keymap(), inner);
	let x = 2;
	for (const [text, command] of hints) {
		const w = visibleWidth(text);
		if (command)
			buttons.push({
				y: lines.length,
				from: x,
				to: x + w,
				command,
				hot: row(hints.map(([s, c]) => (c === command ? cursorLine(s, true) : s)).join("")),
			});
		x += w;
	}
	lines.push(row(hints.map(([text]) => text).join("")), gray(`╰${"─".repeat(width - 2)}╯`));
	return { lines, buttons };
}

/**
 * A session's particulars and actions, beside its row or in expanded narrow details. A floating Peek too short for
 * everything loses the last turn first; narrow details scroll the complete view.
 */
function peekView(row: SessionRow, width: number, maxHeight: number, open: "left" | "right"): OverlayView {
	const e = row.entry;
	const now = Date.now();
	const inner = width - 4;
	const rule = gray("─".repeat(inner));
	const head: string[] = [];
	const title = wrapTextWithAnsi(displayName(e), inner);
	const titleLines = title.length > 2 ? [title[0] as string, truncateToWidth(title.slice(1).join(" "), inner, "…")] : title;
	if (!Bun.stripANSI(rowLine(row, panes.narrow ? width : panes.rosterWidth(), now)).includes(displayName(e)))
		head.push(...titleLines.map((line) => bold(line)));
	const state = `${glyph(stateOf(e), now)} ${status(e)}${e.snoozed ? " · snoozed" : ""}${launchElapsed(e, now)}`;
	const times = `${gray("created")} ${ago(e.createdAt, now)} · ${e.open ? `${gray("active")} ${e.activity !== "idle" ? "now" : ago(e.activityAt, now)}` : `${gray("archived")} ${ago(archivedKey(e), now)}`}`;
	if (panes.narrow && visibleWidth(`${state} · ${times}`) <= inner) head.push(`${state} · ${times}`);
	else head.push(...wrapTextWithAnsi(state, inner), times);
	const harness = `${e.harness} · `;
	if (!panes.narrow) head.push(rule);
	head.push(`${harness}${tailOf(shortPath(e.cwd), inner - visibleWidth(harness))}`);
	const info = model.peek.info.get(e.id)?.info;
	if (e.branch) {
		const diff = info?.diff;
		const changes = diff
			? `  ${(diff.add ? green : gray)(`+${diff.add}`)} ${(diff.del ? red : gray)(`−${diff.del}`)}${gray(" uncommitted")}`
			: "";
		head.push(`${gray("⎇")}  ${matchedText(e.branch)}${changes}`);
	}
	const group = groupOf(e);
	const visible = panes.narrow ? [] : rosterRows().slice(frame.scrollTop, frame.scrollTop + frame.listHeight);
	if (group !== null && !visible.some((r) => r.key === row.header)) head.push(`${gray("Group")} ${group}`);
	// On a fold, each hidden session is a button that reveals it.
	const links: { at: number; command: Command }[] = [];
	const parent = parentOf(e);
	if (parent && !(row.nest && visible.some((r) => r.key === parent.id))) {
		const label = `${gray("started by")} ${originMark(origin(e))}${origin(e) === "operator" ? "  " : " "}`;
		head.push(`${label}${truncateToWidth(displayName(parent), inner - visibleWidth(label), "…")}`);
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
		head.push(rule, "Schedules");
		// The soonest few, and always the last that ran, so it shows one ran however many are pending.
		const shown = [...e.schedules.filter((v) => v.nextAt !== null).slice(0, 3), ...e.schedules.filter((v) => v.nextAt === null)];
		for (const v of shown) {
			const line =
				v.nextAt === null
					? `${green("✓")} ${v.scheduleLabel} · ran ${ago(v.lastFiredAt as number, now)}`
					: v.cron
						? `${cyan("↻")} ${v.scheduleLabel} · next ${wakeAt(v.nextAt, now)}${v.lastFiredAt === null ? "" : ` · last ${ago(v.lastFiredAt, now)}`}`
						: `◷ ${v.scheduleLabel} · ${wakeAt(v.nextAt, now)}`;
			head.push(truncateToWidth(` ${line}`, inner, "…"));
		}
	}
	const turn: string[] = [];
	if (info?.error) turn.push(rule, ...wrapTextWithAnsi(red(`✗ ${info.error}`), inner).slice(0, 3));
	else if (panes.narrow && stateOf(e) === "errored" && info?.ending?.kind === "error")
		turn.push(rule, ...wrapTextWithAnsi(`Error · ${info.ending.message}`, inner).slice(0, 2));
	else if (
		info?.last &&
		(panes.narrow || !(panes.applied.id === e.id && panes.applied.view !== "editor" && panes.applied.shell?.at !== "replace"))
	) {
		const label = `${(info.last.who === "you" ? "you" : e.harness).padEnd(Math.max(3, e.harness.length))} `;
		const pad = visibleWidth(label);
		const text = wrapTextWithAnsi(info.last.text.replace(/\s+/g, " ").trim(), inner - pad);
		const shown = text.length > 3 ? [...text.slice(0, 2), truncateToWidth(text.slice(2).join(" "), inner - pad, "…")] : text;
		turn.push(rule, ...shown.map((line, i) => `${gray(i === 0 ? label : " ".repeat(pad))}${line}`));
	}
	const buttons: { y: number; from: number; to: number; command: Command; text: string }[] = [];
	const buttonLines: string[] = [];
	const actions = peekButtons(row);
	const session = actions.filter(([, , act]) => ["focus", "stop", "wake", "reload", "new", "parent"].includes(act));
	const organize = actions.filter(([, , act]) => ["snooze", "archive", "group", "unseen"].includes(act));
	const col = Math.max(Math.floor(inner / 2), ...session.map(([label, k]) => visibleWidth(` ${k} ${label}`) + 3));
	const stacked = col + Math.max(...organize.map(([label, k]) => visibleWidth(` ${k} ${label}`))) > inner;
	const button = (action: [string, string, RowAct] | undefined, from: number, width: number): string => {
		if (!action) return " ".repeat(width);
		const [label, k, act] = action;
		const text = truncateToWidth(act === "focus" ? bold(` ${k} ${label}`) : ` ${bold(k)} ${label}`, width, "…", true);
		buttons.push({ y: buttonLines.length, from, to: from + width, command: { kind: "row", act, row: row.key }, text });
		return text;
	};
	if (stacked) {
		for (const [heading, group] of [
			["Session", session],
			["Organize", organize],
		] as const) {
			buttonLines.push(` ${heading}`);
			for (const action of group) buttonLines.push(button(action, 0, inner));
		}
	} else {
		buttonLines.push(`${" Session".padEnd(col)} Organize`);
		for (let i = 0; i < Math.max(session.length, organize.length); i++)
			buttonLines.push(`${button(session[i], 0, col - 3)}   ${button(organize[i], col, inner - col)}`);
	}
	const body = [...head, ...(head.length + turn.length + 1 + buttonLines.length + 2 <= maxHeight ? turn : []), rule];
	const buttonsAt = body.length;
	body.push(...buttonLines);
	const box = peekFrame(inner);
	const edge = "─".repeat(width - 2);
	const lines = [
		open === "left" ? promptTitle("Peek", width) : gray(`╭${edge}╮`),
		...body.slice(0, maxHeight - 2).map(box),
		gray(`╰${edge}╯`),
	];
	const margin = 2;
	return {
		lines,
		buttons: [
			...(open === "left"
				? [{ y: 0, from: width - 4, to: width - 1, command: { kind: "dismissPeek" } as Command, hot: lines[0] as string }]
				: []),
			...links
				.filter((link) => 1 + link.at < lines.length - 1)
				.map((link) => ({
					y: 1 + link.at,
					from: margin,
					to: margin + inner,
					command: link.command,
					hot: box(cursorLine(truncateToWidth(body[link.at] as string, inner, "…", true), true)),
				})),
			...buttons
				.filter((b) => 1 + buttonsAt + b.y < lines.length - 1)
				.map((b) => {
					const y = 1 + buttonsAt + b.y;
					// The line again with this one button lit, for the pointer resting on it.
					const lit = (buttonLines[b.y] as string).replace(b.text, cursorLine(b.text, true));
					return { y, from: margin + b.from, to: margin + b.to, command: b.command, hot: box(lit) };
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
					: model.focusedPane === panes.main.pane && editorShown(applied)
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
	deck: `=${DECK}:`,
	failed: (message) => toast(message, "error"),
	left: onPointerOut,
	pressed: onOverlayPress,
	hovered: onOverlayHover,
	changed: () => commit(),
});

tui.setFocus(roster);

tui.start();

// Inside tmux pi-tui asks only for motion with a button down. The roster wants every motion, for the hover, the Peek,
// and the picker's highlight, and asking for it here is what makes tmux pass the pointer's motion on.
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
tmux(SESSIONS, "set", "-p", "-t", rosterPane, "@swb_label", "swb");

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
