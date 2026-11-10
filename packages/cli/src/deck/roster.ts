import { rmSync } from "node:fs";
import { basename } from "node:path";
import {
	type Component,
	type Focusable,
	sliceByColumn,
	stripTerminalSequences,
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
	aimed,
	archiveCancels,
	archivedKey,
	archiving,
	boot,
	caughtUp,
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
import { DeckTerminal } from "./terminal.ts";

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
	/** The lines the last frame drew, which a press aimed by `swb drive click --on` is checked against. */
	private drawn: string[] = [];
	/** A press dropped for missing its aim, whose release and click go with it. */
	private dropping = false;

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
		if (event.button === "left" && event.type === "press") this.dropping = !aimed(this.drawn[event.y] ?? "", event.x);
		if (this.dropping && event.type !== "move") {
			if (event.type === "click") this.dropping = false;
			return { handled: true };
		}
		return onMouse(event);
	}

	render(width: number): string[] {
		this.drawn = this.draw(width);
		return this.drawn;
	}

	private draw(width: number): string[] {
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
		const message = messageLine(now, height - 2);
		const messageRows = message ? 1 : 0;
		const bodyHeight = Math.max(1, height - frame.listTop - 2 - messageRows - detailLines - reserved);
		const lines = tag === null ? [] : [tag];
		const beforeScroll = frame.scrollTop;
		lines.push(...list(rows, index, width, bodyHeight, now));
		if (prompt && reserved) {
			prompt.y = Math.max(frame.listTop, Math.min(frame.listTop + frame.listHeight, prompt.y + beforeScroll - frame.scrollTop));
			frame.promptGap = { at: prompt.y, rows: reserved };
			for (const target of frame.targets) if (target.y >= prompt.y) target.y += reserved;
			lines.splice(prompt.y, 0, ...Array<string>(reserved).fill(""));
		}
		const detailTop = height - detailLines - 1 - messageRows;
		const keys = footerKeys(width);
		const tabs = [keys.views.length > 0 ? keyRow(detailTop, keys.views, keys, width, keys.prefix) : ""];
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
			overflowRule(rows.slice(frame.scrollTop + frame.listHeight), "↓", width, "", prefixAbove()),
			...tabs,
			...(detail?.lines ?? []),
			...(messageRows ? [message] : []),
			hints(height - 1, width, keys),
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
		const dirty = model.mode.dirty;
		return [
			["Archive", null],
			...archiveNotes(e).map((note): Part => [` ${gray(note)}`, null]),
			...keymap()
				.filter((b) => b.label !== null && b.command?.kind !== "cancel")
				.map((b): Part => [` ${bold(b.name)} ${b.label?.replace("delete worktree", bold(red("delete worktree")))}`, b.command]),
			...(dirty ? [[` ${attention("Uncommitted changes")}`, null] as Part] : []),
		];
	}
	const naming = nameMode();
	if (!naming) return [];
	const choices = nameChoices();
	const shown = Math.max(1, Math.min(choices.length, height - 4));
	const from = Math.max(0, Math.min(naming.choice - shown + 1, choices.length - shown));
	const title = naming.renaming ? "Rename Group" : "Group";
	const input = naming.input.render(Math.max(10, width - 2))[0] ?? "";
	const out: Part[] = [
		[title, null],
		[` ${input}`, null],
	];
	for (let i = from; i < from + shown; i++) {
		const choice = choices[i] as { label: string; name: string | null };
		const label = choice.name === null ? dim(choice.label) : choice.label.startsWith("+ ") ? green(choice.label) : choice.label;
		const digit = naming.input.getValue() === "" && i < 9 ? bold(String(i + 1)) : " ";
		const line = truncateToWidth(` ${digit} ${label}`, width, "…", true);
		out.push([i === naming.choice ? cursorLine(line, true) : line, { kind: "choose", index: i }]);
	}
	return out;
}

/** A box's top border: its title, and the key that closes it, which a click presses too. */
function promptTitle(title: string, width: number, hot = false): string {
	const label = truncateToWidth(` ${title} `, width - 9, "…");
	const close = hot ? cursorLine(" esc ", true) : ` ${bold("esc")} `;
	return `${gray("╭─")}${label}${gray("─".repeat(Math.max(0, width - visibleWidth(label) - 9)))}${close}${gray("─╮")}`;
}

/** The click target over promptTitle's esc. */
function closeButton(title: string, width: number, command: Command): OverlayButton {
	return { y: 0, from: width - 7, to: width - 2, command, hot: promptTitle(title, width, true) };
}

function promptOverlay(width: number, height: number): Overlay[] {
	const mode = model.mode;
	if (mode.kind !== "archive" && mode.kind !== "name" && mode.kind !== "snooze") return [];
	const rosterWidth = width;
	const insert = menuRow(width) !== null;
	width = insert ? width : Math.min(Math.max(width, 54), panes.width - rosterWidth - 1);
	if (width < PEEK_MIN_COLS) return [];
	const parts = pickerParts(width - 2, height - 2);
	const row = (line: string) => `${gray("│")}${truncateToWidth(line, width - 2, "…", true)}${gray("│")}`;
	const title = parts[0]?.[0] ?? "";
	const lines = [promptTitle(title, width), ...parts.slice(1).map(([line]) => row(line)), gray(`╰${"─".repeat(width - 2)}╯`)];
	const buttons: OverlayButton[] = parts.flatMap(([line, command], y) =>
		command ? [{ y, from: 1, to: width - 1, command, hot: row(cursorLine(truncateToWidth(line, width - 2, "…", true), true)) }] : [],
	);
	buttons.push(closeButton(title, width, { kind: "cancel" }));
	// Under its row, the menu carries the rest of the row's title above it, so the row reads whole.
	const subject = insert ? rosterRows().find((r) => r.key === mode.at.row) : undefined;
	if (subject?.kind === "session") {
		const rest = sessionLine(subject, rosterWidth, Date.now()).rest;
		const rows = rosterRows();
		const cursor = rows[cursorIndex(rows)]?.key === subject.key;
		lines.unshift(...rest.map((line) => (cursor ? cursorLine(line, model.focus === "roster") : line)));
		for (const b of buttons) b.y += rest.length;
	}
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
	const out: Part[] = [["Snooze", null]];
	const e = model.entries.get(snoozing.id);
	if (e?.activity === "blocked")
		out.push(...wrapTextWithAnsi("Blocked sessions stay visible until answered.", width - 2).map((line): Part => [` ${line}`, null]));
	else if (e?.cutOff || e?.errored)
		out.push(...wrapTextWithAnsi("Sessions needing attention stay visible.", width - 2).map((line): Part => [` ${line}`, null]));
	SNOOZE_CHOICES.forEach((choice, i) => {
		const until = presetUntil(choice.snooze, now);
		const at = until === null ? "↘" : wakeAt(until, now);
		const label = ` ${bold(String(i + 1))} ${choice.label}`;
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
	const noteRows = Math.max(0, height - 13 - (adding ? completedRows().length : pickRows().length));
	const card = launchOnStage(width) || width < PEEK_MIN_COLS ? null : launchCard(choosing, Math.min(LAUNCH_COLS, width), noteRows);
	for (const b of card?.buttons ?? []) frame.targets.push({ y: 1 + b.y, from: b.from, to: b.to, command: b.command });
	frame.card = card ? card.lines.map((line) => stripTerminalSequences(line)) : null;
	// While the menu is open, the rest of the picker waits behind it.
	const muted = (line: string) => (choosing.menu ? gray(stripTerminalSequences(line)) : line);
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
	lines.push(choosing.confirm || choosing.menu ? "" : legend(lines.length, keymap(), width));
	return lines.map((line) => truncateToWidth(line, width, "…", true));
}

/** The filter's tag, atop the list while one applies, is a button that clears it. */
function filterTag(width: number): string | null {
	if (filtering()) {
		const hint = ` · ${filterCount()}  ${key("esc", "clears")}`;
		return clickable(0, [
			[` ${model.filter.render(Math.max(1, width - visibleWidth(hint) - 2))[0] ?? ""}`, null],
			[hint, { kind: "clearFilter" }],
		]);
	}
	if (query() === "") return null;
	const parts: Part[] = [
		[" ", null],
		[`${magenta(`/${model.filter.getValue()}`)} ✕`, { kind: "clearFilter" }],
		[` · ${filterCount()}  ${key("esc", "clears")}`, { kind: "clearFilter" }],
	];
	return truncateToWidth(clickable(0, parts), width - 1, "…");
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
		else if (i === index) out.push(cursorLine(line, model.focus === "roster"));
		else if (row.key === peekRow(width)) out.push(hoverLine(line));
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

/**
 * A rule with what its list hides past it; `lead`, the prefix every key below it takes, heads it, and moves the count to
 * its end. Like a section's rule, it stops a column short of the roster's edge, where every row's content ends.
 */
function overflowRule(hidden: Row[], arrow: string, width: number, section = "", lead = false): string {
	const head = lead ? ` ${bold(keyName(model.config.prefix))} ` : "";
	const states = hidden.flatMap((r) => (r.kind === "session" ? [stateOf(r.entry)] : []));
	const counts = (["blocked", "cut-off", "errored", "unseen"] as State[]).flatMap((state) => {
		const n = states.filter((s) => s === state).length;
		return n ? [`${glyph(state, Date.now())}${n}`] : [];
	});
	const label = hidden.length === 0 ? "" : ` ${[arrow, hidden.length, ...counts].join(" ")}${section ? ` · ${section}` : ""} `;
	const fill = (n: number) => gray("─".repeat(Math.max(0, n)));
	const room = width - 1 - visibleWidth(head) - visibleWidth(label);
	if (lead) return `${head}${label ? `${fill(room - 1)}${label}${fill(1)}` : fill(room)}`;
	return label ? `${label}${fill(room)}` : ` ${fill(room - 1)}`;
}

/**
 * Whether every key under the roster's foot takes the prefix, as the Stage's own do while it has the keyboard; the rule
 * above them names it once. Otherwise only the views' row does, and names it itself.
 */
function prefixAbove(): boolean {
	return model.mode.kind === "roster" && model.focus === "stage" && stageKeys()[0]?.name === "tab";
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
	return family.length > 0 ? [`${family.length} child session${family.length === 1 ? "" : "s"}`] : [];
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
	const room = Math.max(1, height - 2);
	const interior = view.lines.slice(1, -1);
	const below = Math.max(0, interior.length - top - room);
	const border = (left: string, right: string, label: string) =>
		gray(`${left}${label}${"─".repeat(Math.max(0, width - 2 - visibleWidth(label)))}${right}`);
	return {
		total: view.lines.length,
		lines: [
			border("╭", "╮", top > 0 ? ` ↑ ${top} · PgUp ` : ""),
			...interior.slice(top, top + room),
			border("╰", "╯", below > 0 ? ` ↓ ${below} more · PgDn ` : ""),
		],
		buttons: view.buttons.filter((b) => b.y > top && b.y <= top + room).map((b) => ({ ...b, y: b.y - top })),
	};
}

/** The Stage's views for the session on it, as key cells. */
function viewCells(): Part[] {
	const e = cursorEntry() ?? (model.stage.staged === null ? null : (model.entries.get(model.stage.staged) ?? null));
	if (!e || model.stage.staged !== e.id || !e.open) return [];
	const editor = panes.applied.view === "editor";
	const splitting = viewOf(e) === "split";
	const cells: Part[] = [];
	const label = key("e", "editor");
	// Split, editor isn't a view to switch to; its cell stays, blank, so the keys beside it keep their columns.
	cells.push(
		splitting
			? [" ".repeat(visibleWidth(label)), null]
			: [editor ? cursorLine(label, true) : label, { kind: "view", view: editor ? "agent" : "editor" }],
	);
	const split = key("v", "split");
	cells.push([panes.applied.view === "split" ? cursorLine(split, true) : split, { kind: "view", view: splitting ? "agent" : "split" }]);
	// The shell is a toggle beside the views, not one of them.
	const shell = key("s", "shell");
	cells.push([panes.applied.shell ? cursorLine(shell, true) : shell, { kind: "shell" }]);
	return cells;
}

/**
 * The roster's two rows of keys at its foot, the Stage's views over the mode's own, laid in shared columns so each key
 * sits over the one below it: from the left while the Stage has the keyboard, else at the right end, where the
 * roster's pinned keys are and each row's left edge is its own. `legend` is null in a mode with a line of its own.
 */
type FooterKeys = {
	views: Part[];
	/** At the right end, the prefix the views take, at their row's left edge, outside the shared columns. */
	prefix: Part[];
	legend: Part[] | null;
	lead: Binding<Command>[];
	widths: number[];
	right: boolean;
};

function footerKeys(cols: number): FooterKeys {
	const below = legendKeys(cols);
	const right = below?.right ?? true;
	// From the left, nothing is pinned, so a blank cell needn't hold a column.
	let views = right ? viewCells() : viewCells().filter(([text]) => text.trim() !== "");
	let legend = below?.cells ?? [];
	const prefixed = views.length > 0 && !prefixAbove();
	const prefix: Part = [`${bold(keyName(model.config.prefix))} ${gray("→")}`, null];
	// From the left, the prefix takes a column of its own; at the right end, it keeps the row's left edge.
	if (prefixed && !right) {
		views = [prefix, ...views];
		legend = [["", null], ...legend];
	}
	const lead = prefixed && right ? visibleWidth(prefix[0]) + 2 : 0;
	const rows = [views, legend];
	for (;;) {
		const widths = columnWidths(rows, right);
		if (spanOf(widths) <= cols - 2 - lead || widths.length === 0) {
			const [v, l] = rows as [Part[], Part[]];
			return { views: v, prefix: prefixed && right ? [prefix] : [], legend: below ? l : null, lead: below?.lead ?? [], widths, right };
		}
		// What doesn't fit goes from the end; at the right end, from both rows alike, so their columns stay paired.
		for (const r of rows) if (right || r.length === widths.length) r.pop();
	}
}

/** Each shared column's width, its cells counted from the left, or from the right end with `right`. */
function columnWidths(rows: Part[][], right: boolean): number[] {
	const n = Math.max(0, ...rows.map((r) => r.length));
	return Array.from({ length: n }, (_, i) => Math.max(0, ...rows.map((r) => visibleWidth(r[right ? r.length - n + i : i]?.[0] ?? ""))));
}

function spanOf(widths: number[]): number {
	return widths.reduce((n, w) => n + w, 0) + 2 * Math.max(0, widths.length - 1);
}

/**
 * One row of footer keys in the shared columns, which end a column short of the roster's edge, where every row's content
 * does. At the right end, `lead`, the views' prefix or the mode's leading keys, keeps the row's left edge.
 */
function keyRow(y: number, cells: Part[], keys: FooterKeys, cols: number, lead: Part[] = []): string {
	const { widths, right } = keys;
	const n = widths.length;
	const parts: Part[] = [[" ", null], ...lead];
	let x = parts.reduce((w, [text]) => w + visibleWidth(text), 0);
	let column = right ? cols - 1 - spanOf(widths) : 1;
	for (let i = 0; i < n; i++) {
		const cell = cells[right ? cells.length - n + i : i];
		if (cell) {
			parts.push([" ".repeat(Math.max(0, column - x)), null], cell);
			x = Math.max(x, column) + visibleWidth(cell[0]);
		}
		column += (widths[i] as number) + 2;
	}
	return clickable(y, parts);
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
function hints(y: number, cols: number, keys: FooterKeys): string {
	if (archiving() !== null || nameMode() || snoozeMode()) return "";
	if (filtering()) {
		return legend(y, [{ keys: ["enter"], name: "⏎", label: "keep filter", command: { kind: "choose", index: null } }], cols);
	}
	const drag = dragging();
	if (drag?.moved) {
		if (!drag.drop) return ` ${red("✗ not here")}`;
		return drag.drop.name === null ? ` ⇢ out of its Group` : ` ⇢ into ${bold(drag.drop.name)}`;
	}
	if (!keys.legend) return legend(y, keymap(), cols);
	if (!keys.right) return keyRow(y, keys.legend, keys, cols);
	const start = cols - 1 - spanOf(keys.widths);
	return keyRow(y, keys.legend, keys, cols, legendParts(keys.lead, start - 1).slice(1));
}

/** The keys under the views row: the Stage's own while it has the keyboard, else the roster's, its pinned ones as cells. */
function legendKeys(cols: number): { cells: Part[]; lead: Binding<Command>[]; right: boolean } | null {
	if (model.mode.kind !== "roster") return null;
	const cell = (b: Binding<Command>): Part => [key(b.name, b.label as string), b.command];
	if (model.focus === "stage") {
		const bindings = stageKeys();
		const history: Binding<Command>[] = [];
		if (historyStep(-1) !== -1) history.push({ keys: [], name: "[", label: "back", command: { kind: "history", step: -1 } });
		if (historyStep(1) !== -1) history.push({ keys: [], name: "]", label: "forward", command: { kind: "history", step: 1 } });
		bindings.splice(1, 0, ...history);
		return { cells: bindings.filter((b) => b.label !== null).map(cell), lead: [], right: false };
	}
	const bindings = keymap();
	const fixed = ["n", "?", ","];
	const shown = cols < 38 ? fixed.slice(0, 2) : fixed;
	// Pinned keys keep their columns: one that doesn't apply leaves its cell blank rather than shifting the rest.
	const cells = shown.map((name): Part => {
		const b = bindings.find((b) => b.name === name);
		const text = key(name, name === "n" ? "new" : name === "?" ? "keys" : "settings");
		return b?.label ? [text, b.command] : [" ".repeat(visibleWidth(text)), null];
	});
	return { cells, lead: bindings.filter((b) => !fixed.includes(b.name)), right: true };
}

/** A keymap's labelled bindings as buttons, in its order. What doesn't fit goes whole, from the end. */
function legend(y: number, bindings: Binding<Command>[], cols: number): string {
	return clickable(y, legendParts(bindings, cols));
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
	return sessionLine(row, width, now).line;
}

/** Where a row-anchored menu sits in the roster, under its row's: that row's key, or null while the menu floats beside it. */
function menuRow(width: number): string | null {
	const mode = model.mode;
	if (mode.kind !== "archive" && mode.kind !== "name" && mode.kind !== "snooze") return null;
	return panes.narrow || width >= PEEK_MIN_COLS ? mode.at.row : null;
}

/** The row the Peek shows beside, when there's room on the Stage for one. */
function peekRow(width: number): string | null {
	const spot = model.peek.settled;
	if (panes.narrow || !spot || width < PEEK_MIN_COLS || Math.min(PEEK_COLS, panes.width - width) < PEEK_MIN_COLS) return null;
	return spot.id;
}

/**
 * A session's row, and the rest of a title it can't hold: while a menu sits under it, wrapped below it, since the
 * roster is still then; on the Peek's row, `over`, which the Peek carries on across the divider, and the time it keeps.
 */
function sessionLine(
	row: SessionRow,
	width: number,
	now: number,
): { line: string; rest: string[]; over: { title: string; right: string } | null } {
	const e = row.entry;
	// Mid-drag, the session being carried is a hollow outline of itself.
	const drag = dragging();
	if (drag?.moved && drag.id === e.id) {
		const lead = `${gray("┆")}${rowLead(row)}`;
		return {
			line: `${lead}${gray("◌")} ${gray(truncateToWidth(displayName(e), width - visibleWidth(lead) - 2, "…"))}`,
			rest: [],
			over: null,
		};
	}
	const mark = model.stage.staged === e.id ? cyan("▌") : " ";
	const lead = `${mark}${rowLead(row)}`;
	// A snoozed row says when it wakes instead: ↘ for its next message. Mid-turn, the glyph already says it's active.
	const when = !e.open
		? age(archivedKey(e), now)
		: e.snoozed
			? e.snoozedUntil === null
				? "↘"
				: wakeAt(e.snoozedUntil, now)
			: e.activity === "working"
				? ""
				: age(e.activityAt, now);
	const state = stateOf(e);
	const meta = [!row.nest ? originMark(origin(e)).trim() : "", e.cwd !== e.project ? gray("⎇") : ""].filter(Boolean).join(" ");
	const time = when.padStart(4);
	const right = `  ${e.open && e.activity === "blocked" ? attention(time) : state === "dormant" || state === "archived" ? dim(time) : time} `;
	const hidden = row.folded ? ` ${foldedTally(row.family.map((p) => p.entry))}` : "";
	const badge = meta ? ` ${meta}` : "";
	const titleWidth = width - visibleWidth(lead) - 2 - visibleWidth(hidden) - visibleWidth(right) - visibleWidth(badge);
	const paint = ["blocked", "unseen", "cut-off", "errored"].includes(state)
		? bold
		: e.provisional || state === "archived"
			? gray
			: (s: string) => s;
	const hovered = model.peek.settled?.source === "pointer" && model.peek.settled.id === e.id;
	const style = (text: string) => {
		const name = hovered ? text : matchedText(text);
		const styled = matches(e) || !e.live ? paint(name) : gray(name);
		return hovered ? underline(styled) : styled;
	};
	const full = displayName(e);
	let title = truncateToWidth(style(full), titleWidth, "…");
	let rest: string[] = [];
	if (row.key === menuRow(width) && visibleWidth(full) > titleWidth) {
		const first = wrapTextWithAnsi(full, titleWidth)[0] ?? "";
		title = style(first);
		const column = visibleWidth(lead) + 2;
		const room = width - column - 1;
		const more = wrapTextWithAnsi(full.slice(first.length).trimStart(), room);
		const shown = more.length > 2 ? [more[0] as string, truncateToWidth(more.slice(1).join(" "), room, "…")] : more;
		rest = shown.map((line) => truncateToWidth(`${mark}${" ".repeat(column - 1)}${style(line)}`, width, "", true));
	}
	if (row.key === peekRow(width)) {
		// The whole title, uncut, split where the roster ends; the time moves to the Peek's far edge.
		const whole = `${lead}${glyph(state, now)} ${style(full)}${badge}`;
		return {
			line: sliceByColumn(whole, 0, width),
			rest,
			over: { title: sliceByColumn(whole, width, Math.max(0, visibleWidth(whole) - width)), right: `${hidden}${right}` },
		};
	}
	const pad = " ".repeat(Math.max(0, titleWidth - visibleWidth(title)));
	return { line: `${lead}${glyph(state, now)} ${title}${badge}${pad}${hidden}${right}`, rest, over: null };
}

/**
 * A session row's left edge, after the cursor's bar: a nested row hangs from its parent's glyph on its family's guides;
 * a family's root leaves the gutter clear. Folded counts sit beside the age.
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

const PEEK_COLS = 60;

/** The most of a folded family a Peek lists. */
const PEEK_FOLD_ROWS = 8;

/**
 * The settled Peek, hung off its row at the divider, which is its left edge. Its row is one of its edges: the title runs
 * on from the roster across it, tinted as the row is, to the time at the Peek's far side, and its border, with the close
 * key, wraps one line past it. It opens down from the row, or up when only that holds it. While the pointer is on it, it
 * holds as if on its row.
 */
function peekOverlays(rows: Row[], width: number, height: number): Overlay[] {
	const spot = model.peek.settled;
	const index = rows.findIndex((r) => r.key === spot?.id);
	const row = rows[index];
	if (!spot || row?.kind !== "session" || peekRow(width) !== spot.id) return [];
	const over = sessionLine(row, width, Date.now()).over as { title: string; right: string };
	let w = Math.min(PEEK_COLS, panes.width - width);
	let view = peekView(row, w, height - 2, "left");
	const content = view.lines.slice(1, -1).map((line) => stripTerminalSequences(line).slice(2, -2).trimEnd());
	const fit = Math.max(
		PEEK_MIN_COLS,
		visibleWidth(over.title) + visibleWidth(over.right) + 1,
		// The frame and its padding, and the two columns an action row keeps free before it wraps.
		...content.filter((line) => !/^─+$/.test(line)).map((line) => visibleWidth(line) + 6),
	);
	if (fit < w) {
		w = fit;
		view = peekView(row, w, height - 2, "left");
	}
	const below = spot.y > 0 ? height - spot.y + 1 : 0;
	const above = spot.y + 2;
	const up = view.lines.length + 2 > below && above > below;
	if (view.lines.length + 2 > (up ? above : below)) view = peekView(row, w, (up ? above : below) - 2, "left");
	const border = (hot: boolean) =>
		`${gray(`${up ? "╰" : "╭"}${"─".repeat(w - 8)}`)}${hot ? cursorLine(" esc ", true) : ` ${bold("esc")} `}${gray(`─${up ? "╯" : "╮"}`)}`;
	const room = w - 1 - visibleWidth(over.right);
	// The slice leaves the title's style open, a hover's underline among it, so it's closed before the gap.
	const strip = `${truncateToWidth(over.title, room, "…")}\x1b[0m${" ".repeat(Math.max(0, room - visibleWidth(over.title)))}${over.right}`;
	const title = `${index === cursorIndex(rows) ? cursorLine(strip, model.focus === "roster") : hoverLine(strip)}${gray("│")}`;
	const rule = gray(`├${"─".repeat(w - 2)}┤`);
	const body = view.lines.slice(1, -1);
	const lines = up
		? [gray(`╭${"─".repeat(w - 2)}╮`), ...body, rule, title, border(false)]
		: [border(false), title, rule, ...body, gray(`╰${"─".repeat(w - 2)}╯`)];
	const buttons = [
		// The title is its row, run on across the divider, and a click on it is one on the row.
		{ y: up ? lines.length - 2 : 1, from: 0, to: w - 1, command: { kind: "select", key: spot.id, index } as Command, hot: title },
		...view.buttons.filter((b) => b.command.kind !== "dismissPeek").map((b) => ({ ...b, y: b.y + (up ? 0 : 2) })),
		{ y: up ? lines.length - 1 : 0, from: w - 7, to: w - 2, command: { kind: "dismissPeek" } as Command, hot: border(true) },
	];
	return [
		{
			id: "peek",
			about: spot.id,
			x: width,
			y: up ? spot.y + 2 - lines.length : spot.y - 1,
			width: w,
			view: { lines, buttons },
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
			view: launchCard(choosing, w, Infinity),
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
	return bold(`${p.harness} · ${p.agent ?? p.model ?? ""}${p.agent ? " · agent" : ""}`);
}

function presetNote(note: string, width: number): string[] {
	const lines = wrapTextWithAnsi(note.replaceAll(" · ", "\n"), width);
	return lines.length <= 3 ? lines : [...lines.slice(0, 2), truncateToWidth(lines.slice(2).join(" "), width, "…")];
}

/**
 * The launch card: what a session from the picker starts on, its harness first, and the preset's note; its field opens
 * the menu. It sits beside the roster, or above the directory list in a narrow Deck.
 */
function launchCard(choosing: Choosing, width: number, noteRows: number): OverlayView {
	const inner = width - 4;
	const presets = pickerPresets();
	const chosen = presets[chosenPreset(choosing)];
	const menu = choosing.menu;
	let value: string;
	if (menu) value = menu.query === "" ? "type to filter presets" : `${menu.query}▌`;
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
			? `Presets · ${destination} · ★ default`
			: "Presets · ★ default"
		: presets.length === 0
			? "Harness"
			: choosing.mode === "pick"
				? `Preset · ${bold("Tab")} change preset`
				: "Preset";
	const note = presetNote(chosen?.note ?? "", inner);
	const kept = noteRows === 2 && note.length > 2 ? [note[0] as string, note.at(-1) as string] : note.slice(0, noteRows);
	const lines = [
		promptTitle(heading, width),
		frame(field),
		...(menu
			? []
			: [
					...kept.map(frame),
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
			closeButton(heading, width, { kind: "cancel" }),
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
	const room = Math.max(1, maxHeight - 4 - note.length);
	const from = Math.min(Math.max(0, (itemAt[menu.cursor] ?? 0) - room + 1), Math.max(0, items.length - room));
	const to = Math.min(items.length, from + room);
	const row = (content: string) => `${gray("│")} ${truncateToWidth(content, inner, "…", true)} ${gray("│")}`;
	const rule = (label: string) => gray(`├${"─".repeat(Math.max(0, width - 2 - visibleWidth(label)))}${label}┤`);
	const lines = [rule(from > 0 ? ` ↑ ${from} more ` : ""), row(PRESET_HEADER)];
	const buttons: OverlayButton[] = [];
	items.slice(from, to).forEach((line, i) => {
		const n = itemAt.indexOf(from + i);
		const content = truncateToWidth(line, inner, "…", true);
		if (n !== -1)
			buttons.push({ y: lines.length, from: 2, to: 2 + inner, command: { kind: "choose", index: n }, hot: row(hoverLine(content)) });
		lines.push(row(n === menu.cursor ? cursorLine(content, true) : content));
	});
	lines.push(rule(to < items.length ? ` ↓ ${items.length - to} more ` : ""), ...note.map(row), gray(`╰${"─".repeat(width - 2)}╯`));
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
	if (panes.narrow && !stripTerminalSequences(rowLine(row, width, now)).includes(displayName(e)))
		head.push(...titleLines.map((line) => bold(line)));
	const state = `${glyph(stateOf(e), now)} ${status(e)}${e.snoozed ? " · snoozed" : ""}${launchElapsed(e, now)}`;
	const times = `${gray("created")} ${ago(e.createdAt, now)} · ${e.open ? `${gray("active")} ${e.activity === "working" ? "now" : ago(e.activityAt, now)}` : `${gray("archived")} ${ago(archivedKey(e), now)}`}`;
	if (panes.narrow && visibleWidth(`${state} · ${times}`) <= inner) head.push(`${state} · ${times}`);
	else head.push(...wrapTextWithAnsi(state, inner), times);
	if (e.snooze && !e.snoozed)
		head.push(
			...wrapTextWithAnsi(
				`Snoozed until ${e.snooze.until === null ? "next message" : wakeAt(e.snooze.until, now)} · visible for attention`,
				inner,
			),
		);
	const harness = `${e.harness} · `;
	if (!panes.narrow) head.push(rule);
	head.push(`${harness}${tailOf(shortPath(e.cwd), inner - visibleWidth(harness))}`);
	const info = model.peek.info.get(e.id)?.info;
	if (e.branch) {
		const diff = info?.diff;
		const changes = diff
			? `  ${(diff.add ? green : gray)(`+${diff.add}`)} ${(diff.del ? red : gray)(`−${diff.del}`)}${gray(" uncommitted")}`
			: "";
		head.push(`${gray("branch")} ${matchedText(e.branch)}${changes}`);
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
	else if (stateOf(e) === "errored" && info?.ending?.kind === "error")
		turn.push(rule, ...wrapTextWithAnsi(red(`× ${info.ending.message}`), inner).slice(0, 3));
	else if (
		info?.last &&
		(panes.narrow || !(panes.applied.id === e.id && panes.applied.view !== "editor" && panes.applied.shell?.at !== "replace"))
	) {
		const label = info.last.who === "you" ? "you " : "  › ";
		const pad = visibleWidth(label);
		const text = wrapTextWithAnsi(info.last.text.replace(/\s+/g, " ").trim(), inner - pad);
		const shown = text.length > 3 ? [...text.slice(0, 2), truncateToWidth(text.slice(2).join(" "), inner - pad, "…")] : text;
		turn.push(rule, ...shown.map((line, i) => `${gray(i === 0 ? label : " ".repeat(pad))}${line}`));
	}
	const buttons: { y: number; from: number; to: number; command: Command; text: string }[] = [];
	const buttonLines: string[] = [];
	const actions = peekButtons(row);
	const session = actions.filter(([, , act]) => ["stop", "wake", "reload", "new", "parent"].includes(act));
	const organize = actions.filter(([, , act]) => ["snooze", "archive", "group", "unseen"].includes(act));
	for (const [heading, group] of [
		["Session", session],
		["Organize", organize],
	] as const) {
		if (group.length === 0) continue;
		const gutter = 10;
		let line = heading.padEnd(gutter);
		const column = Math.max(...group.filter((_, i) => i % 2 === 0).map(([label, k]) => visibleWidth(`${k} ${label}`))) + 2;
		const paired =
			heading === "Organize" &&
			gutter + column + Math.max(...group.filter((_, i) => i % 2 === 1).map(([label, k]) => visibleWidth(`${k} ${label}`))) <= inner - 2;
		for (const [i, [label, k, act]] of group.entries()) {
			const text = key(k, label);
			if ((heading === "Organize" && i > 0 && i % 2 === 0) || visibleWidth(line) + visibleWidth(text) > inner - 2) {
				buttonLines.push(line.trimEnd());
				line = visibleWidth(text) + gutter <= inner - 2 ? " ".repeat(gutter) : visibleWidth(text) <= inner - 2 ? "  " : "";
			}
			const from = visibleWidth(line);
			buttons.push({ y: buttonLines.length, from, to: from + visibleWidth(text), command: { kind: "row", act, row: row.key }, text });
			line += text + " ".repeat(paired && i % 2 === 0 ? column - visibleWidth(text) : 2);
		}
		buttonLines.push(line.trimEnd());
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
			...(open === "left" ? [closeButton("Peek", width, { kind: "dismissPeek" })] : []),
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

function cleanup(): never {
	settingsPane()?.saveProse();
	overlays.closeAllNow();
	stopDiscovery();
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
	return o ? { about: o.about, lines: o.view.lines.map((line) => stripTerminalSequences(line)) } : overlays.painted(id);
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
			return { id: e.id, counts: stripTerminalSequences(familyTally(family)), all: family.length + 1, cancels };
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
						glyph: stripTerminalSequences(glyph(stateOf(row.entry), 0)),
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
		aim: model.aim,
		perf: {
			render: perf.render.summary(),
			switchClient: perf.switchClient.summary(),
			keyToSwitch: perf.keyToSwitch.summary(),
			keyToFrame: perf.keyToFrame.summary(),
		},
	};
}

const tui = new TuiAltScreen(new DeckTerminal(), true, undefined, { mouse: true });

const roster = new Roster();

tui.setLayoutRoot(roster);

const overlays = new Overlays({
	pane: rosterPane,
	deck: `=${DECK}:`,
	failed: (message) => toast(message, "error"),
	left: onPointerOut,
	pressed: onOverlayPress,
	aimed,
	hovered: onOverlayHover,
	changed: () => commit(),
});

tui.setFocus(roster);

const SETTLE_MS = 15_000;

/**
 * Settles once the Deck has caught up with the db and tmux as they were when asked, and come to rest: every frame that
 * brought drawn, every float placed, and every pane moved.
 */
async function settled(): Promise<void> {
	await caughtUp();
	for (let waited = true; waited; ) {
		// The frame a change asked for, drawn now rather than when the frame rate allows; its floats follow in a microtask.
		tui.renderNow();
		await Bun.sleep(0);
		waited = (await panes.settled()) || (await overlays.settled());
	}
}

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

// Only a roster starting removes the socket, and only one starts in the Deck's pane at a time. One that exits leaves it,
// refusing connections as no socket would: the roster replacing it may already listen there.
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
		if (req.method === "GET" && url.pathname === "/state") {
			if (url.searchParams.has("settled")) {
				const late = Bun.sleep(SETTLE_MS).then(() => true);
				if (await Promise.race([settled().then(() => false), late]))
					return new Response(`the Deck didn't settle within ${SETTLE_MS / 1000} s`, { status: 503 });
			}
			return Response.json(viewState());
		}
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

boot({
	requestRender: () => tui.requestRender(),
	closeOverlays: () => overlays.closeAll(),
	pointerAway: () => overlays.pointerAway(),
	disarmed: () => overlays.disarmed(),
	message: (now, withConfigError) => messageLine(now, null, withConfigError),
	recheckColors: (scheme) => void recheckColors(scheme),
});
