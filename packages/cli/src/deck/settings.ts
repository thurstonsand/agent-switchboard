import {
	decodeKittyPrintable,
	Editor,
	Input,
	matchesKey,
	parseKey,
	type TUI,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { HARNESSES, type Harness } from "@swb/shared";
import {
	type ConfigError,
	configPath,
	durationWords,
	type Effort,
	HARNESS_EFFORTS,
	type Loaded,
	lineOf,
	type Preset,
	SECTIONS,
	SETTINGS,
	type Section,
	type Setting,
	setting,
} from "../config.ts";
import { type Catalog, type Choice, effortLevels, effortMark, type Model, presetLabel, searchMatch, shortlist } from "../harnesses.ts";
import { setOrReset, withValue } from "../write-config.ts";
import { type Binding, bindingFor, legendParts } from "./model.ts";
import { PRESET_HEADER, presetColumns } from "./preset-table.ts";
import type { SettingsState } from "./protocol.ts";
import { bold, cyan, gray, green, red, shortPath, yellow } from "./style.ts";

// Settings: every key of config.toml as a list to read and change, drawn by the roster across the whole Deck.
// Setting a value back to the default takes the key out of the file.

/** What Settings needs from the roster that draws it. */
export type SettingsHost = {
	loaded: () => Loaded;
	/** What's wrong with the file on disk, which a running Deck reports instead of applying. */
	error: () => ConfigError | null;
	/** Writes the parsed file with one change; returns what's wrong when it can't. */
	save: (updated: Record<string, unknown>, reorder?: boolean) => string | null;
	catalog: () => Catalog | null;
	/** Asks the harnesses again, and their model lists too when `models`. */
	refresh: (models: boolean) => void;
	/** config.toml in the editor, at a line. */
	open: (line: number | null) => void;
	close: () => void;
	help: () => void;
	paint: { cursor: (line: string, focused: boolean) => string; hover: (line: string) => string };
	message: (now: number, withConfigError: boolean) => string;
	requestRender: () => void;
	/** Runs a change the pane starts on its own, as its save timer does, the way the Deck runs every change. */
	dispatch: (change: () => void) => void;
};

type Item =
	| { kind: "heading"; text: string }
	| { kind: "blank" }
	| { kind: "setting"; s: Setting }
	/** One path in a path list. */
	| { kind: "entry"; s: Setting; index: number }
	| { kind: "addEntry"; s: Setting }
	| { kind: "harness"; harness: Harness }
	| { kind: "shortlist" }
	| { kind: "preset"; index: number }
	| { kind: "addPreset" }
	| { kind: "warning"; count: number };

const selectable = (item: Item | undefined) =>
	item !== undefined && item.kind !== "heading" && item.kind !== "blank" && item.kind !== "warning";

type TextTarget =
	| { kind: "setting"; s: Setting }
	| { kind: "entry"; s: Setting; index: number }
	| { kind: "addEntry"; s: Setting }
	| { kind: "note"; index: number };

type Editing =
	| { kind: "text"; target: TextTarget; input: Input; error: string | null }
	| { kind: "choices"; s: Setting; choice: number }
	| { kind: "chord"; captured: string | null; error: string | null };

/** A prose setting's editor, the whole of its section: saved a second after the last edit, and on the way out. */
type Prose = {
	s: Setting;
	max: number;
	editor: Editor;
	view: { rows: number };
	/** The saved text the editor last matched; it follows a hand edit to the file while nothing here is unsaved. */
	synced: string;
	timer: Timer | null;
	/** Until a key changes the text, [ and ] still move between sections, so passing through never writes them in. */
	typed: boolean;
};

/** Adding a preset: search the catalog, then pick its effort, then write its note. */
type Adding = {
	step: "search" | "effort" | "note";
	query: Input;
	choice: number;
	top: number;
	picked: Model | null;
	effort: number;
	note: Input;
	error: string | null;
};

type AddRow = { kind: "group"; text: string; depth: number } | { kind: "model"; model: Model } | { kind: "custom"; model: Model };

/**
 * What a key, a click, or a legend button asks Settings to do. Keys find theirs in the mode's keymap, and every button
 * carries one, so a click goes through the same checks its key does.
 */
type SettingsCommand =
	/** The mode's highlight: the list's cursor, an open choice list's, the model search's, or the effort's. */
	| { kind: "step"; by: number }
	/** ⏎ in an edit, the search, or a step of adding, or a click on one of its choices; null is the highlighted one. */
	| { kind: "choose"; index: number | null }
	/** esc: back out of an edit or a step of adding, clear the search, or drop the filter, else close. */
	| { kind: "cancel" }
	/** A key no binding takes, typed into the mode's field. */
	| { kind: "type"; data: string }
	/** ⏎ on a list item, the cursor's when null; a click on one puts the cursor there first. */
	| { kind: "activate"; at: number | null }
	/** A click on a list row: the cursor goes there. */
	| { kind: "select"; at: number }
	/** A section by its place, the keyboard to `area` with it, or left where it is when null. */
	| { kind: "section"; to: number; area: "rail" | "list" | null }
	| { kind: "area"; to: "rail" | "list" }
	| { kind: "search" }
	| { kind: "filter"; changed: boolean }
	/** ← and → on an item, the cursor's when null; `wrap` cycles past the last level back to the first. */
	| { kind: "adjust"; by: number; at: number | null; wrap: boolean }
	| { kind: "choices" }
	| { kind: "reset"; at: number | null }
	| { kind: "add" }
	| { kind: "remove" }
	| { kind: "shift"; by: number }
	| { kind: "star"; at: number | null }
	| { kind: "refresh" }
	| { kind: "open"; line: number | null }
	| { kind: "close" }
	| { kind: "help" };

type ClickTarget = { y: number; from: number; to: number; command: SettingsCommand };
type Part = [text: string, command: SettingsCommand | null];

/** What the left button is in the middle of: a press on a button, which its click runs, or dragging a list item. */
type Gesture =
	| { kind: "none" }
	| { kind: "press"; target: ClickTarget }
	| { kind: "drag"; item: number; over: number | null; target: ClickTarget | null };

const CHOOSE: SettingsCommand = { kind: "choose", index: null };
const CANCEL: SettingsCommand = { kind: "cancel" };
const CLOSE: SettingsCommand = { kind: "close" };
const step = (by: number): SettingsCommand => ({ kind: "step", by });
const bind = (keys: string[], name: string, label: string | null, command: SettingsCommand | null): Binding<SettingsCommand> => ({
	keys,
	name,
	label,
	command,
});

type SettingsMode = { kind: "browse" } | { kind: "search" } | { kind: "edit"; edit: Editing } | { kind: "add"; add: Adding };

const RAIL = 18;
const NARROW_BELOW = 100;
const LONG_LIST = 10;
const SAVE_AFTER = 1000;

// The editor's autocomplete list, which Settings never opens.
const SELECT_THEME = { selectedPrefix: cyan, selectedText: cyan, description: gray, scrollInfo: gray, noMatch: gray };

/** Prose a save couldn't write, by setting key, for the next Settings to open on. */
const drafts = new Map<string, string>();

const SECTION_ABOUT: Record<Section, string> = {
	General: "How the roster looks and when sessions move or stop.",
	Harnesses: "What new sessions start in.",
	Operators: "Tell your Operators how to speak, behave, and work with you.",
	Directories: "Where n looks for places to start sessions.",
	"Keys & commands": "The prefix key and the commands swb runs for you.",
};

function rawAt(raw: Record<string, unknown>, key: string[]): unknown {
	const [first, second] = key as [string, string | undefined];
	const top = raw[first];
	if (second === undefined) return top;
	return top && typeof top === "object" && !Array.isArray(top) ? (top as Record<string, unknown>)[second] : undefined;
}

function show(s: Setting, value: unknown): string {
	switch (s.control.kind) {
		case "bool":
			return value ? "on" : "off";
		case "width":
			return typeof value === "number" ? `${value} columns` : `${value} of the Deck`;
		case "paths": {
			const list = value as string[];
			return list.length === 0 ? "none" : `${list.length} path${list.length === 1 ? "" : "s"}`;
		}
		case "harnesses":
			return (value as string[]).join(", ");
		case "prose": {
			const lines = (value as string).split("\n");
			if (value === "") return "none";
			return `${lines.length} line${lines.length === 1 ? "" : "s"}, ${(value as string).length.toLocaleString("en-US")} characters`;
		}
		default:
			return String(value);
	}
}

/** A key as the terminal sent it, spelled the way tmux names it: M-a, C-b, F12. */
export function tmuxKey(data: string): string | null {
	const parsed = parseKey(data);
	if (!parsed) return null;
	const parts = parsed.split("+");
	const base = parts.pop() as string;
	const names: Record<string, string> = {
		space: "Space",
		enter: "Enter",
		tab: "Tab",
		escape: "Escape",
		backspace: "BSpace",
		delete: "DC",
		insert: "IC",
		home: "Home",
		end: "End",
		pageUp: "PPage",
		pageDown: "NPage",
		up: "Up",
		down: "Down",
		left: "Left",
		right: "Right",
	};
	const name = names[base] ?? (/^f\d+$/.test(base) ? base.toUpperCase() : base.length === 1 ? base : null);
	if (!name) return null;
	const mods = parts.map((m) => ({ ctrl: "C-", alt: "M-", shift: "S-", super: "" })[m] ?? "").join("");
	return `${mods}${name}`;
}

/** The levels a preset's harness and model take. */
function effortsFor(preset: Preset, catalog: Catalog | null): (Effort | null)[] {
	if (preset.agent) return [];
	const listed = catalog?.models[preset.harness].find((m) => m.model === preset.model && m.provider === preset.provider);
	return listed ? effortLevels(listed) : HARNESS_EFFORTS[preset.harness];
}

/** A preset as [[presets]] writes it: no empty note, and the ★ only where it is. */
function toToml(p: Preset): Record<string, unknown> {
	return {
		harness: p.harness,
		...(p.provider ? { provider: p.provider } : {}),
		...(p.agent ? { agent: p.agent } : { model: p.model, ...(p.effort ? { effort: p.effort } : {}) }),
		...(p.use ? { use: p.use } : {}),
		...(p.default ? { default: true } : {}),
	};
}

/** Prose as it saves: no blank lines around it, but a first line's indent kept. */
function tidy(text: string): string {
	return text.replace(/^\s*\n/, "").trimEnd();
}

/** A paste's printable text, as pi's own paste keeps it, cut to `room` without splitting a character. */
function pasteable(text: string, room: number): string {
	let out = "";
	for (const c of text.replace(/\r\n?/g, "\n")) {
		if (c !== "\n" && c !== "\t" && c.charCodeAt(0) < 32) continue;
		if (out.length + c.length > room) break;
		out += c;
	}
	return out;
}

/** A field holding `value`, ready to type at its end; setValue alone leaves the cursor at the start. */
function prefill(input: Input, value: string): void {
	input.setValue(value);
	input.handleInput("\x05");
}

export class SettingsPane {
	section = 0;
	/** The rail or the list, as last chosen; a narrow pane, which has no rail, keeps the keyboard in the list. */
	private chosenArea: "rail" | "list" = "list";
	get area(): "rail" | "list" {
		return this.narrow ? "list" : this.chosenArea;
	}
	set area(area: "rail" | "list") {
		this.chosenArea = area;
	}
	search = new Input({ prompt: "" });
	changedOnly = false;
	cursor = 0;
	scroll = 0;
	/** What the keyboard is doing. One mode at a time: an edit, an add, and the search can't stack. */
	mode: SettingsMode = { kind: "browse" };
	get searching(): boolean {
		return this.mode.kind === "search";
	}
	get editing(): Editing | null {
		return this.mode.kind === "edit" ? this.mode.edit : null;
	}
	get adding(): Adding | null {
		return this.mode.kind === "add" ? this.mode.add : null;
	}
	/** The wheel scrolled the list during an edit, which stays on its item; the next key brings it back into view. */
	scrolledAway = false;
	prose: Prose | null = null;
	/** The list row under the pointer; null once a key is pressed or the pointer leaves. */
	hover: number | null = null;
	pointer: { x: number; y: number } | null = null;
	targets: ClickTarget[] = [];
	gesture: Gesture = { kind: "none" };
	listTop = 2;
	listHeight = 0;
	itemRows = new Map<number, number>();
	listLeft = 0;
	narrow = false;
	/** The items as last drawn. */
	shown: Item[] = [];

	constructor(readonly host: SettingsHost) {
		this.cursor = this.firstSelectable(this.items());
	}

	setMode(next: SettingsMode): void {
		this.mode = next;
		this.scrolledAway = false;
	}

	// ── model ──────────────────────────────────────────────────────────

	raw(): Record<string, unknown> {
		return this.host.loaded().raw;
	}

	/** Written in the file with a value other than its default; one written as the default reads as unset. */
	isSet(s: Setting): boolean {
		const value = rawAt(this.raw(), s.key);
		return value !== undefined && !Bun.deepEquals(value, s.fallback().value);
	}

	valueOf(s: Setting): unknown {
		return rawAt(this.raw(), s.key) ?? s.fallback().value;
	}

	choices(): Choice[] {
		return shortlist(this.host.loaded().config, this.host.catalog()) ?? [];
	}

	/** The shortlist as it would be written: yours, or the automatic one, which an edit makes yours. */
	presets(): Preset[] {
		return this.choices().map((c) => c.preset);
	}

	query(): string {
		return this.search.getValue().trim().toLowerCase();
	}

	matches(s: Setting): boolean {
		if (this.changedOnly && !this.isSet(s)) return false;
		const q = this.query();
		if (q === "") return true;
		const text = `${s.label} ${s.description} ${s.synonyms.join(" ")} ${s.key.join(".")} ${s.section}`.toLowerCase();
		return q.split(/\s+/).every((word) => text.includes(word));
	}

	/** One section's items, or, while searching or filtering, every match under its section's name. */
	items(): Item[] {
		const filtered = this.query() !== "" || this.changedOnly;
		if (!filtered) return this.sectionItems(SECTIONS[this.section] as Section, (s) => s.section === SECTIONS[this.section]);
		const out: Item[] = [];
		for (const section of SECTIONS) {
			const items = this.sectionItems(section, (s) => s.section === section && this.matches(s));
			if (items.length === 0) continue;
			if (out.length > 0) out.push({ kind: "blank" });
			out.push({ kind: "heading", text: section }, ...items);
		}
		return out;
	}

	sectionItems(section: Section, keep: (s: Setting) => boolean): Item[] {
		const out: Item[] = [];
		for (const s of SETTINGS.filter(keep)) {
			if (s.control.kind === "harnesses") {
				out.push(...(["claude", "codex", "pi"] as const).map((harness): Item => ({ kind: "harness", harness })));
				continue;
			}
			if (s.control.kind === "presets") {
				if (out.length > 0) out.push({ kind: "blank" });
				const count = this.presets().length;
				out.push(
					{ kind: "shortlist" },
					{ kind: "heading", text: PRESET_HEADER },
					...Array.from({ length: count }, (_, index): Item => ({ kind: "preset", index })),
					{
						kind: "addPreset",
					},
				);
				continue;
			}
			if (s.key.join(".") === "warn_long_shortlist") {
				const count = this.presets().length;
				if (count > LONG_LIST && this.host.loaded().config.warnLongShortlist) out.push({ kind: "warning", count }, { kind: "setting", s });
				else if (this.isSet(s)) out.push({ kind: "setting", s });
				continue;
			}
			out.push({ kind: "setting", s });
			if (s.control.kind === "paths") {
				const list = this.valueOf(s) as string[];
				out.push(...list.map((_, index): Item => ({ kind: "entry", s, index })), { kind: "addEntry", s });
			}
		}
		return section === "Harnesses" || out.length > 0 ? out : [];
	}

	firstSelectable(items: Item[]): number {
		return Math.max(0, items.findIndex(selectable));
	}

	current(): Item | undefined {
		const items = this.items();
		if (!selectable(items[this.cursor])) this.cursor = this.firstSelectable(items);
		return items[this.cursor];
	}

	/** The setting an item belongs to, for its description, its reset, and where O opens the file. */
	settingOf(item: Item | undefined): Setting | null {
		if (!item) return null;
		if (item.kind === "setting" || item.kind === "entry" || item.kind === "addEntry") return item.s;
		if (item.kind === "harness") return setting("harnesses");
		if (item.kind === "shortlist" || item.kind === "preset" || item.kind === "addPreset") return setting("presets");
		if (item.kind === "warning") return setting("warn_long_shortlist");
		return null;
	}

	// ── changes ────────────────────────────────────────────────────────

	/** A failed save shows where the edit was made: in its field while one is open, else on the message line. */
	save(updated: Record<string, unknown>, reorder = false): string | null {
		const error = this.host.save(updated, reorder);
		if (error !== null && this.editing?.kind !== "text" && !this.adding) this.flash(error);
		return error;
	}

	set(s: Setting, value: unknown): string | null {
		return this.save(setOrReset(this.raw(), s, value));
	}

	reset(item = this.current()): void {
		const s = this.settingOf(item);
		if (!s) return;
		if (s.control.kind === "presets") {
			if (this.host.loaded().config.presets !== null) this.save(withValue(this.raw(), ["presets"], undefined));
			return;
		}
		// A page of writing is never one key from gone; emptying it in its editor clears it.
		if (s.control.kind === "prose") return;
		if (this.isSet(s)) this.set(s, undefined);
	}

	/** An edit to the shortlist: the first one writes the automatic list out with it. Removing the last entry resets it. */
	editPresets(change: (list: Preset[]) => Preset[] | string, reorder = false): string | null {
		const next = change(this.presets().map((p) => ({ ...p })));
		if (typeof next === "string") return next;
		if (next.length > 0 && !next.some((p) => p.default)) (next[0] as Preset).default = true;
		const value = next.length === 0 ? undefined : next.map(toToml);
		return this.save(withValue(this.raw(), ["presets"], value), reorder);
	}

	toggleHarness(harness: Harness): void {
		const on = this.host.loaded().config.harnesses;
		const next = on.includes(harness) ? on.filter((h) => h !== harness) : HARNESSES.filter((h) => on.includes(h) || h === harness);
		if (next.length === 0) {
			this.flash("at least one harness stays on");
			return;
		}
		this.set(setting("harnesses"), next);
	}

	/** ⏎ on an item: toggles and cycles save at once, the rest open an editor. */
	activate(item = this.current()): void {
		if (!item) return;
		switch (item.kind) {
			case "setting": {
				const c = item.s.control;
				if (c.kind === "bool") this.set(item.s, !this.valueOf(item.s));
				else if (c.kind === "enum") this.cycle(item.s, 1);
				else if (c.kind === "chord") this.setMode({ kind: "edit", edit: { kind: "chord", captured: null, error: null } });
				else if (c.kind === "paths") this.startText({ kind: "addEntry", s: item.s }, "");
				else if (c.kind === "prose") {
					this.setSection(SECTIONS.indexOf(item.s.section));
					this.area = "list";
				} else this.startText({ kind: "setting", s: item.s }, String(this.valueOf(item.s)));
				break;
			}
			case "entry":
				this.startText(item, (this.valueOf(item.s) as string[])[item.index] ?? "");
				break;
			case "addEntry":
				this.startText(item, "");
				break;
			case "harness":
				this.toggleHarness(item.harness);
				break;
			case "preset":
				this.startText({ kind: "note", index: item.index }, this.presets()[item.index]?.use ?? "");
				break;
			case "addPreset":
				this.startAdding();
				break;
			case "shortlist":
				break;
		}
	}

	cycle(s: Setting, step: number): void {
		if (s.control.kind !== "enum") return;
		const values = s.control.choices.map((c) => c.value);
		const at = values.indexOf(String(this.valueOf(s)));
		this.set(s, values[(at + step + values.length) % values.length]);
	}

	/**
	 * ← and →: a number steps, a choice cycles, and a preset's effort moves through what its harness and model take.
	 * `wrap` cycles past the last level back to the first, as a click on the effort does.
	 */
	adjust(delta: number, item: Item | undefined, wrap: boolean): void {
		if (item?.kind === "setting" && item.s.control.kind === "int") {
			const { min, max } = item.s.control;
			const value = this.valueOf(item.s) as number;
			const next = Math.max(min, Math.min(max, value + delta));
			if (next !== value) this.set(item.s, next);
		} else if (item?.kind === "setting" && item.s.control.kind === "enum") this.cycle(item.s, delta);
		else if (item?.kind === "preset") {
			const preset = this.presets()[item.index];
			if (!preset) return;
			const levels = effortsFor(preset, this.host.catalog());
			const at = levels.indexOf(preset.effort);
			const next = wrap
				? levels[(at + delta + levels.length) % levels.length]
				: levels[Math.max(0, Math.min(levels.length - 1, at + delta))];
			if (next === undefined || next === preset.effort) return;
			this.editPresets((list) => {
				(list[item.index] as Preset).effort = next;
				return list;
			});
		}
	}

	starPreset(index: number): void {
		if (this.presets()[index]?.default) return;
		this.editPresets((list) => list.map((p, i) => ({ ...p, default: i === index })));
	}

	removeItem(item = this.current()): void {
		if (item?.kind === "entry") {
			const list = [...(this.valueOf(item.s) as string[])];
			list.splice(item.index, 1);
			this.set(item.s, list);
		} else if (item?.kind === "preset") {
			const removed = this.presets()[item.index];
			const error = this.editPresets((list) => {
				list.splice(item.index, 1);
				// The ★ passes to the first entry left.
				if (removed?.default && list[0]) list[0].default = true;
				return list;
			});
			if (error === null && item.index >= this.presets().length) this.move(-1);
		}
	}

	/** J and K: an entry or preset swaps with its neighbour, and the cursor goes with it. */
	shift(delta: number, item = this.current()): void {
		if (item?.kind === "entry") this.moveEntry(item, item.index + delta);
		else if (item?.kind === "preset") this.movePreset(item.index, item.index + delta);
	}

	moveEntry(item: { s: Setting; index: number }, to: number): void {
		const list = [...(this.valueOf(item.s) as string[])];
		if (to < 0 || to >= list.length || to === item.index) return;
		const [moved] = list.splice(item.index, 1);
		list.splice(to, 0, moved as string);
		if (this.set(item.s, list) === null) this.cursor += to - item.index;
	}

	movePreset(from: number, to: number): void {
		const count = this.presets().length;
		if (to < 0 || to >= count || to === from) return;
		const error = this.editPresets((list) => {
			const [moved] = list.splice(from, 1);
			list.splice(to, 0, moved as Preset);
			return list;
		}, true);
		if (error === null) this.cursor += to - from;
	}

	flashText: { text: string; until: number } | null = null;
	flash(text: string): void {
		this.flashText = { text, until: Date.now() + 3500 };
	}

	// ── text editing ───────────────────────────────────────────────────

	startText(target: TextTarget, value: string): void {
		const input = new Input({ prompt: "" });
		prefill(input, value);
		this.setMode({ kind: "edit", edit: { kind: "text", target, input, error: null } });
	}

	commitText(): void {
		const editing = this.editing;
		if (editing?.kind !== "text") return;
		const text = editing.input.getValue().trim();
		const t = editing.target;
		let error: string | null;
		if (t.kind === "note") {
			error = this.editPresets((list) => {
				(list[t.index] as Preset).use = text;
				return list;
			});
		} else if (t.kind === "entry" || t.kind === "addEntry") {
			const list = [...(this.valueOf(t.s) as string[])];
			if (t.kind === "addEntry" && text === "") {
				this.setMode({ kind: "browse" });
				return;
			}
			if (t.kind === "entry" && text === "") list.splice(t.index, 1);
			else if (t.kind === "entry") list[t.index] = text;
			else list.push(text);
			error = this.set(t.s, list);
		} else {
			const c = t.s.control.kind;
			const value = (c === "int" || c === "width") && /^\d+$/.test(text) ? Number(text) : text;
			error = this.set(t.s, value);
		}
		if (error === null) this.setMode({ kind: "browse" });
		else editing.error = error;
	}

	/** What the field says about what's typed so far: a duration read back, or what's wrong. */
	textNote(editing: Editing & { kind: "text" }): string {
		if (editing.error) return red(`✗ ${editing.error}`);
		const t = editing.target;
		if (t.kind === "setting" && t.s.control.kind === "duration") {
			try {
				return gray(`= ${durationWords(editing.input.getValue().trim())}`);
			} catch {
				return gray("a whole number then s, m, h, or d: 30m, 72h, 3d");
			}
		}
		return gray("⏎ saves · esc cancels");
	}

	// ── prose ──────────────────────────────────────────────────────────

	/** The prose setting this section is, when it's shown whole rather than as a search result. */
	proseShown(): Setting | null {
		if (this.query() !== "" || this.changedOnly) return null;
		return SETTINGS.find((s) => s.section === SECTIONS[this.section] && s.control.kind === "prose") ?? null;
	}

	proseFocused(): boolean {
		return this.proseShown() !== null && this.area === "list" && !this.searching;
	}

	/** pi's own prompt editor on the setting, from a draft a failed save left, else the saved text. */
	proseFor(s: Setting): Prose {
		if (this.prose?.s === s) return this.prose;
		if (s.control.kind !== "prose") throw new Error(`${s.key.join(".")} isn't prose`);
		// The editor asks its TUI only for terminal.rows, to show a third of them, and requestRender. Settings sets rows
		// so that third is the room it has.
		const view = { rows: 0 };
		const tui = { terminal: view, requestRender: this.host.requestRender } as unknown as TUI;
		const editor = new Editor(tui, { borderColor: gray, selectList: SELECT_THEME }, { paddingX: 1 });
		const synced = this.valueOf(s) as string;
		editor.setText(drafts.get(s.key.join(".")) ?? synced);
		this.prose = { s, max: s.control.max, editor, view, synced, timer: null, typed: false };
		return this.prose;
	}

	/** Writes the editor's text if it changed. A failed save says why on the message line and keeps the text as a draft. */
	saveProse(): void {
		const prose = this.prose;
		if (!prose) return;
		if (prose.timer) clearTimeout(prose.timer);
		prose.timer = null;
		const text = tidy(prose.editor.getText());
		const key = prose.s.key.join(".");
		if (text !== this.valueOf(prose.s) && this.set(prose.s, text) !== null) {
			drafts.set(key, prose.editor.getText());
			return;
		}
		prose.synced = text;
		drafts.delete(key);
	}

	/** Every key its keymap leaves is the editor's. Text past the cap is never let in, so there's nothing to refuse. */
	proseInput(s: Setting, data: string): void {
		const prose = this.proseFor(s);
		const editor = prose.editor;
		const before = editor.getText();
		const room = prose.max - before.length;
		// pi-tui hands a paste over whole, between these.
		const paste = data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~");
		const typed = paste
			? undefined
			: (decodeKittyPrintable(data) ?? (!data.startsWith("\x1b") && data.charCodeAt(0) >= 32 && data !== "\x7f" ? data : undefined));
		// Writing wants new lines more than it wants to submit, and a paste in full, not pi's [paste #1] marker.
		if (matchesKey(data, "enter") || matchesKey(data, "shift+enter")) {
			if (room > 0) editor.handleInput("\n");
		} else if (paste) editor.insertTextAtCursor(pasteable(data.slice(6, -6), room));
		else if (typed === undefined || typed.length <= room) editor.handleInput(data);
		// A yank is the one other way text comes in; one that won't fit is taken back whole.
		if (editor.getText().length > prose.max && editor.getText().length > before.length) editor.setText(before);
		if (editor.getText() === before) return;
		prose.typed = true;
		if (prose.timer) clearTimeout(prose.timer);
		prose.timer = setTimeout(() => this.host.dispatch(() => this.saveProse()), SAVE_AFTER);
	}

	/** What's being written and how much room is left, then the editor, rules above and below, filling the rest. */
	proseRows(s: Setting, width: number, height: number): string[] {
		const title = ` ${bold(s.label)}  ${gray(SECTION_ABOUT[s.section])}`;
		const counter = this.proseCounter(s);
		const head = `${title}${" ".repeat(Math.max(1, width - visibleWidth(title) - visibleWidth(counter) - 1))}${counter}`;
		return [head, ...this.proseEditorRows(s, width, height - 1)];
	}

	/** The editor, its rules above and below. */
	proseEditorRows(s: Setting, width: number, height: number): string[] {
		const prose = this.proseFor(s);
		const saved = this.valueOf(s) as string;
		if (saved !== prose.synced && tidy(prose.editor.getText()) === prose.synced) {
			prose.editor.setText(saved);
			prose.synced = saved;
		}
		// It shows floor(rows × 0.3) lines of text: all the room between its rules.
		prose.view.rows = Math.ceil((height - 1.5) / 0.3);
		prose.editor.borderColor = this.proseFocused() ? cyan : gray;
		const rows = prose.editor.render(width);
		const bottom = rows.pop() as string;
		while (rows.length < height - 1) rows.push("");
		return [...rows.slice(0, height - 1), bottom];
	}

	proseCounter(s: Setting): string {
		const prose = this.proseFor(s);
		const used = prose.editor.getText().length;
		const count = `${used.toLocaleString("en-US")} / ${prose.max.toLocaleString("en-US")}`;
		return used >= prose.max ? red(count) : gray(count);
	}

	// ── adding a preset ────────────────────────────────────────────────

	startAdding(): void {
		this.host.refresh(false);
		const add: Adding = {
			step: "search",
			query: new Input({ prompt: "" }),
			choice: 0,
			top: 0,
			picked: null,
			effort: 0,
			note: new Input({ prompt: "" }),
			error: null,
		};
		this.setMode({ kind: "add", add });
		add.choice = this.firstModel();
	}

	/** Matches grouped by harness, then provider or kind; typing a full id also offers it as one. */
	addRows(): AddRow[] {
		const adding = this.adding as Adding;
		const catalog = this.host.catalog();
		const enabled = this.host.loaded().config.harnesses;
		const q = adding.query.getValue().trim().toLowerCase();
		const words = q.split(/\s+/).filter(Boolean);
		const rows: AddRow[] = [];
		const typed = adding.query.getValue().trim();
		// What's typed is offered as a model id only once no listed model matches it.
		const unlisted =
			typed !== "" &&
			!/\s/.test(typed) &&
			!HARNESSES.some((h) => enabled.includes(h) && (catalog?.models[h] ?? []).some((m) => searchMatch(m, words)));
		for (const harness of HARNESSES) {
			if (!enabled.includes(harness)) continue;
			const models = (catalog?.models[harness] ?? []).filter((m) => searchMatch(m, words));
			const custom: Model[] = [];
			if (unlisted) {
				const [provider, model] =
					harness === "pi" && typed.includes("/") ? [typed.split("/")[0] as string, typed.slice(typed.indexOf("/") + 1)] : [null, typed];
				if (harness !== "pi" || provider)
					custom.push({
						harness,
						provider,
						model,
						agent: null,
						group: "models",
						note: "",
						effort: "medium",
						efforts: HARNESS_EFFORTS[harness],
						isDefault: false,
						superseded: false,
					});
			}
			if (models.length === 0 && custom.length === 0) continue;
			rows.push({ kind: "group", text: harness, depth: 0 });
			let group = "";
			for (const m of models) {
				if (m.group !== group) {
					group = m.group;
					rows.push({ kind: "group", text: group, depth: 1 });
				}
				rows.push({ kind: "model", model: m });
			}
			for (const m of custom) rows.push({ kind: "custom", model: m });
		}
		return rows;
	}

	firstModel(): number {
		return Math.max(
			0,
			this.addRows().findIndex((r) => r.kind !== "group"),
		);
	}

	moveAdd(delta: number): void {
		const adding = this.adding as Adding;
		const rows = this.addRows();
		for (let i = adding.choice + delta; i >= 0 && i < rows.length; i += delta) {
			if ((rows[i] as AddRow).kind !== "group") {
				adding.choice = i;
				return;
			}
		}
	}

	pickModel(row: AddRow | undefined): void {
		const adding = this.adding as Adding;
		if (!row || row.kind === "group") return;
		adding.picked = row.model;
		// An agent's own definition sets its effort.
		adding.step = row.model.agent ? "note" : "effort";
		adding.effort = Math.max(0, effortLevels(row.model).indexOf(row.model.effort));
		prefill(adding.note, row.model.note);
	}

	finishAdding(): void {
		const adding = this.adding as Adding;
		const m = adding.picked as Model;
		const effort = m.agent ? null : (effortLevels(m)[adding.effort] ?? null);
		const preset: Preset = {
			harness: m.harness,
			provider: m.provider,
			model: m.model,
			effort,
			agent: m.agent,
			use: adding.note.getValue().trim(),
			default: false,
		};
		const error = this.editPresets((list) => [...list, preset]);
		if (error !== null) {
			adding.error = error;
			return;
		}
		this.setMode({ kind: "browse" });
		const items = this.items();
		this.cursor = items.findIndex((i) => i.kind === "preset" && i.index === this.presets().length - 1);
	}

	// ── keys ───────────────────────────────────────────────────────────

	move(delta: number): void {
		const items = this.items();
		let i = this.cursor;
		for (let n = Math.abs(delta); n > 0; n--) {
			let next = i + Math.sign(delta);
			while (next >= 0 && next < items.length && !selectable(items[next])) next += Math.sign(delta);
			if (next < 0 || next >= items.length) break;
			i = next;
		}
		this.cursor = i;
	}

	setSection(index: number): void {
		this.saveProse();
		if (this.prose) this.prose.typed = false;
		this.section = (index + SECTIONS.length) % SECTIONS.length;
		this.search.setValue("");
		if (this.searching) this.setMode({ kind: "browse" });
		this.changedOnly = false;
		this.cursor = this.firstSelectable(this.items());
		this.scroll = 0;
	}

	handleInput(data: string): void {
		this.hover = null;
		this.pointer = null;
		this.scrolledAway = false;
		if (this.adding) this.adding.error = null;
		const binding = bindingFor(this.keymap(), data);
		if (binding?.command) this.run(binding.command);
		else if (!binding && this.typing()) this.run({ kind: "type", data });
	}

	/** Whether the mode has a field that takes the keys its keymap doesn't. */
	typing(): boolean {
		if (this.host.error()) return false;
		if (this.adding) return this.adding.step !== "effort";
		const editing = this.editing;
		if (editing) return editing.kind !== "choices";
		return this.searching || this.proseFocused();
	}

	/** The keys Settings takes in its mode, in the order its legend shows the ones it labels. */
	keymap(): Binding<SettingsCommand>[] {
		const error = this.host.error();
		if (error)
			return [
				bind(["O", "enter"], "O", "open config.toml at that line", { kind: "open", line: error.line }),
				bind(["escape"], "esc", "sessions", CLOSE),
			];
		const adding = this.adding;
		if (adding?.step === "search") {
			const page = Math.max(1, this.listHeight - 2);
			return [
				bind(["enter"], "⏎", "choose", CHOOSE),
				bind([], "↑ ↓", "move", null),
				bind(["ctrl+r"], "C-r", "refresh", { kind: "refresh" }),
				bind(["escape"], "esc", "cancel", CANCEL),
				bind(["up"], "↑", null, step(-1)),
				bind(["down"], "↓", null, step(1)),
				bind(["pageUp"], "PgUp", null, step(-page)),
				bind(["pageDown"], "PgDn", null, step(page)),
			];
		}
		if (adding?.step === "effort")
			return [
				bind(["enter"], "⏎", "next", CHOOSE),
				bind(["escape"], "esc", "back", CANCEL),
				bind(["up", "left"], "↑", null, step(-1)),
				bind(["down", "right"], "↓", null, step(1)),
			];
		if (adding) return [bind(["enter"], "⏎", "add", CHOOSE), bind(["escape"], "esc", "back", CANCEL)];
		const editing = this.editing;
		if (editing) {
			// Until a chord is caught, ⏎ is one it can catch.
			const save = editing.kind !== "chord" || editing.captured ? [bind(["enter"], "⏎", "save", CHOOSE)] : [];
			const arrows = editing.kind === "choices" ? [bind(["up"], "↑", null, step(-1)), bind(["down"], "↓", null, step(1))] : [];
			return [...save, bind(["escape"], "esc", "cancel", CANCEL), ...arrows];
		}
		if (this.searching) return [bind(["enter", "down"], "⏎", "done", CHOOSE), bind(["escape"], "esc", "clear", CANCEL)];
		const sections = [
			bind(["]"], "[ ]", "section", { kind: "section", to: this.section + 1, area: null }),
			bind(["["], "[", null, { kind: "section", to: this.section - 1, area: null }),
		];
		const prose = this.proseFocused() ? this.proseShown() : null;
		if (prose)
			return [
				bind(["tab", "shift+tab"], "⇥", this.narrow ? null : "sections", { kind: "area", to: "rail" }),
				// pi's editor binds it; the legend's button types it.
				bind([], "C--", "undo", { kind: "type", data: "\x1f" }),
				bind(["escape"], "esc", "sessions", CLOSE),
				// Once writing starts, [ and ] are part of it.
				...(this.proseFor(prose).typed ? [] : sections),
			];
		const item = this.current();
		const s = this.settingOf(item);
		const area = bind(["tab", "shift+tab"], "⇥", this.narrow ? null : "area", {
			kind: "area",
			to: this.area === "rail" ? "list" : "rail",
		});
		const tail = [
			bind(["escape"], "esc", this.query() !== "" || this.changedOnly ? "clear" : "sessions", CANCEL),
			bind(["/"], "/", "search", { kind: "search" }),
			bind(["O"], "O", "file", { kind: "open", line: s ? lineOf(this.host.loaded().text, s.key) : null }),
			bind(["c"], "c", null, { kind: "filter", changed: !this.changedOnly }),
			bind(["?"], "?", null, { kind: "help" }),
		];
		if (this.area === "rail")
			return [
				area,
				...sections,
				...tail,
				bind(["down", "j"], "j", null, { kind: "section", to: this.section + 1, area: null }),
				bind(["up", "k"], "k", null, { kind: "section", to: this.section - 1, area: null }),
				bind(["enter", "right", "l"], "⏎", null, { kind: "area", to: "list" }),
			];
		const control = item?.kind === "setting" ? item.s.control.kind : null;
		const listed = item?.kind === "preset" || item?.kind === "entry";
		let enter: string | null = "edit";
		if (item?.kind === "preset") enter = "note";
		else if (item?.kind === "harness") enter = null;
		else if (control === "bool") enter = "toggle";
		else if (control === "enum") enter = "next";
		else if (item?.kind === "shortlist" || item?.kind === "addPreset") enter = "add";
		const resettable =
			s !== null &&
			s.control.kind !== "prose" &&
			(this.isSet(s) || (s.control.kind === "presets" && this.host.loaded().config.presets !== null));
		const page = Math.max(1, this.listHeight - 1);
		const activate: SettingsCommand = { kind: "activate", at: null };
		return [
			area,
			...sections,
			bind(["enter"], "⏎", enter, activate),
			...(item?.kind === "harness" || control === "bool" || control === "enum"
				? [bind([" "], "space", item?.kind === "harness" ? "on/off" : null, activate)]
				: []),
			bind(["right", "l"], "← →", item?.kind === "preset" ? "effort" : control === "int" ? "step" : null, {
				kind: "adjust",
				by: 1,
				at: null,
				wrap: false,
			}),
			bind(["left", "h"], "←", null, { kind: "adjust", by: -1, at: null, wrap: false }),
			bind(["*"], "*", item?.kind === "preset" ? "default" : null, { kind: "star", at: null }),
			bind(["J"], "J K", listed ? "move" : null, { kind: "shift", by: 1 }),
			bind(["K"], "K", null, { kind: "shift", by: -1 }),
			bind(["x"], "x", listed ? "remove" : null, { kind: "remove" }),
			bind(["e"], "e", control === "enum" ? "choices" : null, { kind: "choices" }),
			bind(["a"], "a", item?.kind === "harness" ? "add preset" : null, { kind: "add" }),
			bind(["r"], "r", resettable ? "reset" : null, { kind: "reset", at: null }),
			...tail,
			bind(["down", "j"], "j", null, step(1)),
			bind(["up", "k"], "k", null, step(-1)),
			bind(["g"], "g", null, step(Number.NEGATIVE_INFINITY)),
			bind(["G"], "G", null, step(Number.POSITIVE_INFINITY)),
			bind(["pageDown"], "PgDn", null, step(page)),
			bind(["pageUp"], "PgUp", null, step(-page)),
			bind(["R"], "R", null, { kind: "refresh" }),
		];
	}

	/** Every key, click, and legend button ends here. */
	run(c: SettingsCommand): void {
		switch (c.kind) {
			case "step":
				this.stepMode(c.by);
				break;
			case "choose":
				this.choose(c.index);
				break;
			case "cancel":
				this.cancel();
				break;
			case "type":
				this.type(c.data);
				break;
			case "activate":
				if (c.at !== null) this.select(c.at);
				this.activate();
				break;
			case "select":
				this.select(c.at);
				break;
			case "section":
				this.setSection(c.to);
				if (c.area) this.area = c.area;
				break;
			case "area":
				this.saveProse();
				if (!this.narrow) this.area = c.to;
				break;
			case "search":
				this.setMode({ kind: "search" });
				this.area = "list";
				break;
			case "filter":
				this.changedOnly = c.changed;
				this.cursor = this.firstSelectable(this.items());
				break;
			case "adjust":
				this.adjust(c.by, this.itemOf(c.at), c.wrap);
				break;
			case "choices": {
				const item = this.current();
				if (item?.kind !== "setting" || item.s.control.kind !== "enum") break;
				const values = item.s.control.choices.map((choice) => choice.value);
				this.setMode({
					kind: "edit",
					edit: { kind: "choices", s: item.s, choice: Math.max(0, values.indexOf(String(this.valueOf(item.s)))) },
				});
				break;
			}
			case "reset":
				this.reset(this.itemOf(c.at));
				break;
			case "add": {
				const s = this.settingOf(this.current());
				if (s?.control.kind === "paths") this.startText({ kind: "addEntry", s }, "");
				else if (s?.control.kind === "presets" || s?.control.kind === "harnesses") this.startAdding();
				break;
			}
			case "remove":
				this.removeItem();
				break;
			case "shift":
				this.shift(c.by);
				break;
			case "star": {
				const item = this.itemOf(c.at);
				if (item?.kind === "preset") this.starPreset(item.index);
				break;
			}
			case "refresh":
				this.host.refresh(true);
				break;
			case "open":
				this.host.open(c.line);
				break;
			case "close":
				this.host.close();
				break;
			case "help":
				this.host.help();
				break;
		}
	}

	/** A list item as last drawn, or the cursor's when null. */
	itemOf(at: number | null): Item | undefined {
		return at === null ? this.current() : this.shown[at];
	}

	select(at: number): void {
		this.cursor = at;
		this.area = "list";
		if (this.searching) this.setMode({ kind: "browse" });
	}

	stepMode(by: number): void {
		const adding = this.adding;
		const editing = this.editing;
		if (adding?.step === "search") this.moveAdd(by);
		else if (adding?.step === "effort")
			adding.effort = Math.max(0, Math.min(effortLevels(adding.picked as Model).length - 1, adding.effort + by));
		else if (editing?.kind === "choices") {
			const count = editing.s.control.kind === "enum" ? editing.s.control.choices.length : 0;
			editing.choice = Math.max(0, Math.min(count - 1, editing.choice + by));
		} else if (!adding) this.move(by);
	}

	choose(index: number | null): void {
		const adding = this.adding;
		const editing = this.editing;
		if (adding?.step === "search") {
			if (index !== null) adding.choice = index;
			this.pickModel(this.addRows()[adding.choice]);
		} else if (adding?.step === "effort") {
			if (index !== null) adding.effort = index;
			adding.step = "note";
		} else if (adding) this.finishAdding();
		else if (editing?.kind === "text") this.commitText();
		else if (editing?.kind === "chord" && editing.captured) {
			const error = this.set(setting("keys.prefix"), editing.captured);
			if (error === null) this.setMode({ kind: "browse" });
			else editing.error = error;
		} else if (editing?.kind === "choices") {
			const choices = editing.s.control.kind === "enum" ? editing.s.control.choices : [];
			this.set(editing.s, choices[index ?? editing.choice]?.value);
			this.setMode({ kind: "browse" });
		} else if (this.searching) this.setMode({ kind: "browse" });
	}

	cancel(): void {
		const adding = this.adding;
		if (adding) {
			if (adding.step === "search") this.setMode({ kind: "browse" });
			else if (adding.step === "effort") adding.step = "search";
			else adding.step = adding.picked?.agent ? "search" : "effort";
		} else if (this.editing) this.setMode({ kind: "browse" });
		else if (this.searching) {
			this.search.setValue("");
			this.setMode({ kind: "browse" });
		} else if (this.query() !== "" || this.changedOnly) {
			this.search.setValue("");
			this.changedOnly = false;
			this.cursor = this.firstSelectable(this.items());
		} else this.host.close();
	}

	type(data: string): void {
		const adding = this.adding;
		const editing = this.editing;
		if (adding?.step === "search") {
			adding.query.handleInput(data);
			adding.choice = this.firstModel();
			adding.top = 0;
		} else if (adding) adding.note.handleInput(data);
		else if (editing?.kind === "text") {
			editing.input.handleInput(data);
			editing.error = null;
		} else if (editing?.kind === "chord") {
			const name = tmuxKey(data);
			if (name) editing.captured = name;
			editing.error = name ? null : "that key has no tmux name";
		} else if (this.searching) {
			this.search.handleInput(data);
			this.cursor = this.firstSelectable(this.items());
			this.scroll = 0;
		} else if (this.proseFocused()) this.proseInput(this.proseShown() as Setting, data);
	}

	// ── mouse ──────────────────────────────────────────────────────────

	targetAt(p: { x: number; y: number } | null): ClickTarget | undefined {
		return p ? this.targets.find((t) => t.y === p.y && p.x >= t.from && p.x < t.to) : undefined;
	}

	/** The list item under a screen row, if any. */
	itemAt(y: number): number | null {
		if (this.adding || y < this.listTop || y >= this.listTop + this.listHeight) return null;
		const i = this.itemRows.get(y);
		return i !== undefined && selectable(this.shown[i]) ? i : null;
	}

	handleMouse(event: TuiMouseEvent): { handled: boolean; render?: boolean; capture?: boolean } {
		if (event.type === "move") {
			const before = this.targetAt(this.pointer);
			const hover = this.itemAt(event.y);
			this.pointer = { x: event.x, y: event.y };
			const relit = this.targetAt(this.pointer) !== before || hover !== this.hover;
			this.hover = hover;
			return { handled: true, render: relit };
		}
		const prose = this.adding || this.host.error() ? null : this.proseShown();
		const inEditor = prose !== null && event.x >= this.listLeft && event.y >= this.listTop && event.y < this.listTop + this.listHeight;
		if (event.type === "wheel") {
			const delta = Math.sign(event.wheelDelta ?? 0);
			if (inEditor) this.proseFor(prose).editor.handleInput(delta < 0 ? "\x1b[A" : "\x1b[B");
			else if (this.editing) {
				// What's being edited stays on its item; the list scrolls under it.
				this.scroll = Math.max(0, this.scroll + delta);
				this.scrolledAway = true;
			} else this.run(step(delta));
			return { handled: true, render: true };
		}
		if (event.button !== "left") return { handled: true };
		if (event.type === "press") {
			const target = this.targetAt({ x: event.x, y: event.y }) ?? null;
			const at = this.itemAt(event.y);
			const item = at === null ? undefined : this.shown[at];
			if (at !== null && !this.editing && (item?.kind === "preset" || item?.kind === "entry")) {
				this.gesture = { kind: "drag", item: at, over: null, target };
				return { handled: true, capture: true };
			}
			this.gesture = target ? { kind: "press", target } : { kind: "none" };
			return { handled: true, capture: false };
		}
		if (event.type === "drag" && this.gesture.kind === "drag") {
			this.gesture.over = this.itemAt(event.y);
			return { handled: true, render: true };
		}
		if (event.type === "release" && this.gesture.kind === "drag") {
			const { item, over, target } = this.gesture;
			// A drag that lands nowhere new is a press, and its click runs the button under it.
			this.gesture = target ? { kind: "press", target } : { kind: "none" };
			const from = this.shown[item];
			const to = over === null ? undefined : this.shown[over];
			if (from?.kind === "preset" && to?.kind === "preset" && from.index !== to.index) {
				this.cursor = item;
				this.movePreset(from.index, to.index);
				this.gesture = { kind: "none" };
			} else if (from?.kind === "entry" && to?.kind === "entry" && from.s === to.s && from.index !== to.index) {
				this.cursor = item;
				this.moveEntry(from, to.index);
				this.gesture = { kind: "none" };
			}
			return { handled: true, render: true };
		}
		if (event.type !== "click") return { handled: true };
		const target = this.gesture.kind === "press" ? this.gesture.target : null;
		this.gesture = { kind: "none" };
		// A click anywhere but the edit's own answers is done with it, unsaved, and then does what it does.
		const answers = target?.command.kind === "choose" || target?.command.kind === "cancel";
		if (this.editing && !answers) this.setMode({ kind: "browse" });
		if (target) {
			this.run(target.command);
			return { handled: true, render: true };
		}
		if (inEditor) {
			this.area = "list";
			if (this.searching) this.setMode({ kind: "browse" });
			this.proseFor(prose).editor.handleMouse({
				...event,
				x: event.x - this.listLeft,
				// Below the title row.
				y: event.y - this.listTop - 1,
				width: event.width - this.listLeft,
			});
			return { handled: true, render: true };
		}
		const at = this.itemAt(event.y);
		if (at !== null) this.run({ kind: "select", at });
		return { handled: true, render: true };
	}

	// ── drawing ────────────────────────────────────────────────────────

	/** Joins the parts into row y's line, recording where each clickable one lands. */
	clickable(y: number, x0: number, parts: Part[]): string {
		let x = x0;
		let line = "";
		const p = this.pointer;
		for (const [text, command] of parts) {
			const w = visibleWidth(text);
			if (command) this.targets.push({ y, from: x, to: x + w, command });
			line += command && p?.y === y && p.x >= x && p.x < x + w ? this.host.paint.cursor(text, true) : text;
			x += w;
		}
		return line;
	}

	render(width: number, height: number): string[] {
		this.targets = [];
		this.itemRows.clear();
		this.narrow = width < NARROW_BELOW;
		width = Math.min(width, RAIL + 101);
		const now = Date.now();
		const lines: string[] = [this.header(width)];
		const bodyHeight = Math.max(3, height - 7);
		const error = this.host.error();
		// An editor takes the rule and the footer's rows too: its own bottom rule stands in for the one under the list.
		const prose = !error && !this.adding && this.proseShown() !== null;
		this.listTop = 2;
		this.listHeight = prose ? bodyHeight + 3 : bodyHeight;
		let body: string[];
		if (error) {
			lines.push(gray("─".repeat(width)));
			body = this.errorBody(error, width, bodyHeight);
		} else if (this.adding) {
			lines.push(this.addHeader(width));
			body = this.addBody(width, bodyHeight);
		} else {
			lines.push(this.searchLine(width));
			body = this.body(width, this.listHeight);
		}
		lines.push(...body);
		const rule =
			this.narrow || error || this.adding ? "─".repeat(width) : `${"─".repeat(RAIL)}┴${"─".repeat(Math.max(0, width - RAIL - 1))}`;
		if (!prose) lines.push(gray(rule), ...(this.adding ? this.footer(width, error) : ["", ""]));
		lines.push(this.messageLine(now), this.clickable(height - 1, 0, legendParts(this.keymap(), width)));
		return lines.map((line) => truncateToWidth(line, width, "…", true));
	}

	header(width: number): string {
		if (this.narrow) {
			const name = SECTIONS[this.section] as string;
			const left: Part[] = [
				[` ${bold("Settings")}  `, null],
				["‹", { kind: "section", to: this.section - 1, area: null }],
				[` ${name} `, null],
				["›", { kind: "section", to: this.section + 1, area: null }],
			];
			return this.clickable(0, 0, left);
		}
		const path = gray(shortPath(configPath()));
		const title = ` ${bold("Settings")}`;
		const gap = Math.max(1, Math.floor((width - visibleWidth(path)) / 2) - visibleWidth(title));
		return this.clickable(0, 0, [
			[title, null],
			[" ".repeat(gap), null],
			[path, { kind: "open", line: null }],
		]);
	}

	searchLine(width: number): string {
		const filters: Part[] = [
			[this.changedOnly ? " all " : this.host.paint.cursor(" all ", true), { kind: "filter", changed: false }],
			[" · ", null],
			[this.changedOnly ? this.host.paint.cursor(" changed ", true) : " changed ", { kind: "filter", changed: true }],
			[" ", null],
		];
		const fw = filters.reduce((n, [t]) => n + visibleWidth(t), 0);
		const fieldWidth = Math.max(10, width - fw - 4);
		const field = this.searching
			? `${cyan("/")} ${this.search.render(fieldWidth)[0] ?? ""}`
			: this.query() !== ""
				? `${cyan("/")} ${this.search.getValue()}`
				: gray("/ search");
		const pad = Math.max(1, width - 1 - visibleWidth(field) - fw);
		return this.clickable(1, 0, [[" ", null], [field, { kind: "search" }], [" ".repeat(pad), null], ...filters]);
	}

	body(width: number, height: number): string[] {
		const prose = this.proseShown();
		if (prose) {
			this.shown = [];
			this.listLeft = this.narrow ? 0 : RAIL + 1;
			return this.railed(this.proseRows(prose, width - this.listLeft, height));
		}
		const items = this.items();
		this.shown = items;
		if (!selectable(items[this.cursor])) this.cursor = this.firstSelectable(items);
		const left = this.narrow ? 0 : RAIL + 1;
		this.listLeft = left;
		const listWidth = width - left;
		// The rows an open choice list adds, below its setting.
		const extra =
			this.editing?.kind === "choices" ? (this.editing.s.control.kind === "enum" ? this.editing.s.control.choices.length : 0) : 0;
		const listHeight = Math.max(1, height - 4);
		const room = Math.max(1, listHeight - extra);
		if (!this.scrolledAway) {
			if (this.cursor < this.scroll) this.scroll = this.cursor;
			if (this.cursor >= this.scroll + room) this.scroll = this.cursor - room + 1;
		}
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, items.length - room)));
		// Headings keep their place above the first row in view.
		if (!this.scrolledAway && this.scroll > 0 && items[this.scroll - 1]?.kind === "heading" && this.cursor - this.scroll + 1 < room)
			this.scroll--;
		const labelWidth = Math.min(
			36,
			Math.max(12, ...items.map((i) => (i.kind === "setting" && i.s.control.kind !== "paths" ? visibleWidth(i.s.label) : 0))),
		);
		const rows: string[] = [];
		for (let i = this.scroll; rows.length < listHeight && i < items.length; i++) {
			const y = this.listTop + rows.length;
			this.itemRows.set(y, i);
			rows.push(this.itemLine(items[i] as Item, i, y, left, listWidth, labelWidth));
			if (this.editing?.kind === "choices" && i === this.cursor && this.editing.s.control.kind === "enum") {
				const editing = this.editing;
				editing.s.control.kind === "enum" &&
					editing.s.control.choices.forEach((c, ci) => {
						if (rows.length >= listHeight) return;
						const line = truncateToWidth(`      ${ci === editing.choice ? "●" : "○"} ${c.value}  ${gray(c.about)}`, listWidth, "…", true);
						const cy = this.listTop + rows.length;
						this.targets.push({ y: cy, from: left, to: width, command: { kind: "choose", index: ci } });
						rows.push(ci === editing.choice ? this.host.paint.cursor(line, true) : line);
					});
			}
		}
		rows.push("", ...this.footer(Math.min(80, listWidth), null));
		while (rows.length < height) rows.push("");
		if (items.length === 0) rows[0] = gray(this.changedOnly && this.query() === "" ? "   nothing changed yet" : "   no settings match");
		return this.railed(rows.slice(0, height));
	}

	/** The list's rows with the section rail beside them, when there's room for it. */
	railed(rows: string[]): string[] {
		if (this.narrow) return rows;
		return rows.map((row, r) => `${this.railCell(r, this.listTop + r)}${gray("│")}${row}`);
	}

	railCell(r: number, y: number): string {
		const section = SECTIONS[r];
		if (!section) return " ".repeat(RAIL);
		const active = r === this.section && this.query() === "" && !this.changedOnly;
		const text = truncateToWidth(` ${section}`, RAIL, "…", true);
		this.targets.push({ y, from: 0, to: RAIL, command: { kind: "section", to: r, area: "rail" } });
		if (active) return this.host.paint.cursor(text, this.area === "rail");
		return this.pointer?.y === y && this.pointer.x < RAIL ? this.host.paint.hover(text) : text;
	}

	itemLine(item: Item, i: number, y: number, left: number, width: number, labelWidth: number): string {
		const selected = i === this.cursor && this.area === "list" && !this.searching;
		const lit = selected || i === this.hover;
		const mark = i === this.cursor ? "▸" : " ";
		const dropping = this.gesture.kind === "drag" && this.gesture.over === i && this.gesture.item !== i;
		let line: string;
		const parts: Part[] = [];
		switch (item.kind) {
			case "heading":
				return truncateToWidth(` ${item.text === PRESET_HEADER ? ` ${item.text}` : bold(item.text)}`, width, "…", true);
			case "blank":
				return "";
			case "warning":
				return truncateToWidth(
					`  ${yellow(`Agents see all ${item.count} of these. More than 10 can crowd their choice; keep the ones you use.`)}`,
					width,
					"…",
					true,
				);
			case "setting":
				parts.push(...this.settingParts(item.s, i, lit, labelWidth, width));
				break;
			case "entry": {
				const value = (this.valueOf(item.s) as string[])[item.index] ?? "";
				const editing = this.editing?.kind === "text" && this.editing.target.kind === "entry" && i === this.cursor;
				parts.push([`    ${editing ? this.inputCell(width - 6) : value}`, null]);
				if (lit && !editing) parts.push(["   ", null], [gray("x remove · J K move"), null]);
				break;
			}
			case "addEntry": {
				const editing = this.editing?.kind === "text" && this.editing.target.kind === "addEntry" && i === this.cursor;
				if (editing) parts.push([`    ${this.inputCell(width - 6)}`, null]);
				else parts.push(["    ", null], [green("+ add a path"), { kind: "activate", at: i }]);
				break;
			}
			case "harness":
				parts.push(...this.harnessParts(item.harness, i));
				break;
			case "shortlist":
				parts.push(...this.shortlistParts(i));
				break;
			case "preset":
				parts.push(...this.presetParts(item.index, i, width));
				break;
			case "addPreset":
				parts.push(["  ", null], [green("+ add a preset"), { kind: "activate", at: i }]);
				break;
		}
		line = this.clickable(y, left + 1, parts);
		line = truncateToWidth(`${mark}${line}`, width, "…", true);
		if (dropping) return this.host.paint.cursor(line, true);
		if (selected) return this.host.paint.cursor(line, true);
		if (i === this.cursor) return this.host.paint.cursor(line, false);
		return i === this.hover ? this.host.paint.hover(line) : line;
	}

	inputCell(width: number): string {
		const editing = this.editing as Editing & { kind: "text" };
		return editing.input.render(Math.max(10, width))[0] ?? "";
	}

	settingParts(s: Setting, i: number, lit: boolean, labelWidth: number, width: number): Part[] {
		const set = this.isSet(s);
		const label = ` ${truncateToWidth(s.label, labelWidth, "…", true)}  `;
		const editingHere = i === this.cursor ? this.editing : null;
		if (editingHere?.kind === "text" && editingHere.target.kind === "setting")
			return [
				[label, null],
				[this.inputCell(width - labelWidth - 6), null],
			];
		if (editingHere?.kind === "chord") {
			const shown = editingHere.captured ? bold(editingHere.captured) : cyan("press a key…");
			return [
				[label, null],
				[shown, null],
				["   ", null],
				[gray(editingHere.captured ? "⏎ saves · esc cancels" : "esc cancels"), null],
			];
		}
		const value = show(s, this.valueOf(s));
		const parts: Part[] = [
			[label, null],
			[set ? bold(value) : value, s.control.kind === "paths" ? null : { kind: "activate", at: i }],
		];
		if (!set && s.control.kind !== "prose") parts.push([`  ${gray(`(${s.fallback().from ?? "default"})`)}`, null]);
		if (lit && s.control.kind !== "prose") {
			const fallback = s.fallback();
			if (set)
				parts.push(
					["   ", null],
					[gray(`default ${show(s, fallback.value)}`), null],
					["  ", null],
					[gray("↺ reset"), { kind: "reset", at: i }],
				);
		}
		return parts;
	}

	harnessParts(harness: Harness, i: number): Part[] {
		const on = this.host.loaded().config.harnesses.includes(harness);
		const status = this.host.catalog()?.status[harness];
		const box = `[${on ? "x" : " "}]`;
		const note = status === undefined ? gray("finding…") : status.problem ? red(status.problem) : "";
		return [
			[" ", null],
			[box, { kind: "activate", at: i }],
			[` ${harness.padEnd(8)} `, null],
			[note, null],
		];
	}

	shortlistParts(i: number): Part[] {
		const custom = this.host.loaded().config.presets !== null;
		const title = ` ${bold("Shortlist")}`;
		const right: Part = custom ? [gray("↺"), { kind: "reset", at: i }] : [gray("from installed harnesses"), null];
		const listed = this.host.catalog() === null && !custom ? [gray("   finding harnesses…"), null] : null;
		return [[title, null], ...(listed ? [listed as [string, null]] : []), [" ", null], right];
	}

	presetParts(index: number, i: number, width: number): Part[] {
		const choice = this.choices()[index];
		if (!choice) return [];
		const p = choice.preset;
		const star = p.default ? (choice.reason ? red("★") : "★") : choice.reason ? red("✗") : " ";
		const cells = presetColumns(p.harness, p.agent ?? p.model ?? "", p.agent ? "agent" : (p.effort ?? "default"), p.provider ?? "");
		const editing = this.editing?.kind === "text" && this.editing.target.kind === "note" && i === this.cursor;
		return [
			[`${String(index + 1).padStart(2)} `, null],
			[star, { kind: "star", at: i }],
			[` ${cells.harness}`, null],
			[cells.model, null],
			[cells.effort, { kind: "adjust", by: 1, at: i, wrap: true }],
			[cells.provider, null],
			[editing ? `  ${this.inputCell(Math.max(1, width - 45 - visibleWidth(cells.provider)))}` : "", null],
		];
	}

	errorBody(error: ConfigError, width: number, height: number): string[] {
		const rows = [
			"",
			...wrapTextWithAnsi(`  ${red(`✗ ${error.line === null ? "" : `line ${error.line}: `}${error.problem}`)}`, width - 2),
			"",
			...wrapTextWithAnsi("  This Deck keeps the settings it had until the file is fixed; new swb commands stop on it.", width - 2),
			"",
		];
		while (rows.length < height) rows.push("");
		return rows.slice(0, height);
	}

	addHeader(width: number): string {
		const adding = this.adding as Adding;
		if (adding.step !== "search") {
			const m = adding.picked as Model;
			return ` ${gray("adding")} ${bold(presetLabel({ ...m, effort: effortLevels(m)[adding.effort] ?? null, use: "", default: false }))} ${gray(`· ${m.harness}`)}`;
		}
		const catalog = this.host.catalog();
		const count = this.addRows().filter((r) => r.kind !== "group").length;
		const errors = catalog ? Object.entries(catalog.errors).filter(([, e]) => e) : [];
		const status =
			errors.length > 0
				? red(`${errors.map(([h]) => h).join(", ")} couldn't list models`)
				: gray(`${count} match${count === 1 ? "" : "es"}`);
		const field = `${cyan("›")} ${adding.query.render(Math.max(10, width - visibleWidth(status) - 6))[0] ?? ""}`;
		return `${field}${" ".repeat(Math.max(1, width - visibleWidth(field) - visibleWidth(status) - 1))}${status}`;
	}

	addBody(width: number, height: number): string[] {
		const adding = this.adding as Adding;
		this.shown = [];
		if (adding.step === "effort") {
			const m = adding.picked as Model;
			const rows = [` ${bold("Effort")}`];
			effortLevels(m).forEach((e, i) => {
				const y = this.listTop + rows.length;
				const line = truncateToWidth(
					e === null
						? `   ${"default".padEnd(8)}   ${gray(`${m.harness}'s own`)}`
						: `   ${e.padEnd(8)} ${effortMark(e) || " "}${e === m.effort ? gray("   its default") : ""}`,
					width,
					"…",
					true,
				);
				this.targets.push({ y, from: 0, to: width, command: { kind: "choose", index: i } });
				rows.push(i === adding.effort ? this.host.paint.cursor(line, true) : line);
			});
			while (rows.length < height) rows.push("");
			return rows.slice(0, height);
		}
		if (adding.step === "note") {
			const rows = [
				` ${bold("Note for agents")}  ${gray("when to use it, in a line; may be blank")}`,
				` ${adding.note.render(Math.max(10, width - 2))[0] ?? ""}`,
			];
			if (adding.error) rows.push("", ` ${red(`✗ ${adding.error}`)}`);
			while (rows.length < height) rows.push("");
			return rows;
		}
		const rows = this.addRows();
		if (adding.choice < adding.top) adding.top = adding.choice;
		if (adding.choice >= adding.top + height) adding.top = adding.choice - height + 1;
		// A group heading stays above its first model in view.
		if (adding.top > 0 && rows[adding.top - 1]?.kind === "group" && adding.choice - adding.top + 1 < height) adding.top--;
		adding.top = Math.max(0, Math.min(adding.top, Math.max(0, rows.length - height)));
		const out: string[] = [];
		const total = rows.length;
		const thumb = total > height ? Math.max(1, Math.round((height * height) / total)) : 0;
		const thumbAt = total > height ? Math.round((adding.top / (total - height)) * (height - thumb)) : 0;
		for (let r = 0; r < height; r++) {
			const row = rows[adding.top + r];
			const bar = thumb > 0 ? (r >= thumbAt && r < thumbAt + thumb ? gray("┃") : gray("│")) : "";
			const inner = width - (thumb > 0 ? 2 : 0);
			let line = "";
			if (row?.kind === "group") line = row.depth === 0 ? ` ${bold(row.text)}` : `   ${gray(row.text)}`;
			else if (row) {
				const m = row.model;
				const name = m.agent ?? `${m.model}`;
				const what = row.kind === "custom" ? green(`use "${m.provider ? `${m.provider}/` : ""}${m.model}" as a model id`) : name.padEnd(30);
				line = `     ${what}  ${gray(row.kind === "custom" ? "" : m.note)}`;
				const index = adding.top + r;
				this.targets.push({ y: this.listTop + r, from: 0, to: inner, command: { kind: "choose", index } });
			}
			line = truncateToWidth(line, inner, "…", true);
			if (adding.top + r === adding.choice) line = this.host.paint.cursor(line, true);
			out.push(thumb > 0 ? `${line} ${bar}` : line);
		}
		if (rows.length === 0) {
			const catalog = this.host.catalog();
			out[0] = gray(catalog === null ? "   finding models…" : "   no models match; type a full model id to use it as one");
		}
		return out;
	}

	footer(width: number, error: ConfigError | null): string[] {
		if (error) return ["", ""];
		if (this.adding) {
			const step = this.adding.step;
			const about =
				step === "search"
					? "Type to search every model the harnesses you've turned on offer, by harness, provider, model, or note."
					: step === "effort"
						? "The effort it starts at. Change it later from the shortlist with ← →."
						: "Agents read this note to choose among your presets.";
			return wrapTextWithAnsi(about, width - 3)
				.map((line) => `   ${line}`)
				.concat("", "")
				.slice(0, 2);
		}
		const item = this.current();
		if (item?.kind === "harness") return [];
		const s = this.settingOf(item);
		let text = s?.description ?? (this.searching ? "" : SECTION_ABOUT[SECTIONS[this.section] as Section]);
		const editing = this.editing;
		if (editing?.kind === "text") return [`   ${this.textNote(editing)}`, ""];
		if (editing?.kind === "chord")
			return [
				editing.error
					? `   ${red(`✗ ${editing.error}`)}`
					: `   ${gray("Press the new prefix. The current one and C-h j k l reach tmux first, so they can't be pressed here.")}`,
				"",
			];
		if (item?.kind === "preset") {
			const choice = this.choices()[item.index];
			text = choice?.reason ?? choice?.note ?? "";
		}
		return wrapTextWithAnsi(text, width - 2)
			.map((line) => `  ${line}`)
			.concat("", "")
			.slice(0, 2);
	}

	/** The config error has the whole list's place while it stands, so the message line doesn't repeat it. */
	messageLine(now: number): string {
		if (this.flashText && this.flashText.until > now) return ` ${red(`✗ ${this.flashText.text}`)}`;
		return this.host.message(now, this.host.error() === null);
	}

	state(): SettingsState {
		const items = this.items();
		const error = this.host.error();
		return {
			section: SECTIONS[this.section] as string,
			area: this.area,
			search: this.searching || this.query() !== "" ? this.search.getValue() : null,
			changedOnly: this.changedOnly,
			cursor: this.cursor,
			editing: this.adding ? `add:${this.adding.step}` : (this.editing?.kind ?? null),
			error: error ? error.message : null,
			items: items.map((item, i) => {
				const s = this.settingOf(item);
				const base = { selected: i === this.cursor, key: s ? s.key.join(".") : null };
				switch (item.kind) {
					case "setting":
						return { ...base, kind: item.kind, label: item.s.label, value: show(item.s, this.valueOf(item.s)), set: this.isSet(item.s) };
					case "entry":
						return {
							...base,
							kind: item.kind,
							label: "",
							value: (this.valueOf(item.s) as string[])[item.index] ?? "",
							set: this.isSet(item.s),
						};
					case "harness": {
						const status = this.host.catalog()?.status[item.harness];
						return {
							...base,
							kind: item.kind,
							label: item.harness,
							value: this.host.loaded().config.harnesses.includes(item.harness) ? "on" : "off",
							set: this.isSet(setting("harnesses")),
							problem: status?.problem ?? null,
						};
					}
					case "preset": {
						const choice = this.choices()[item.index] as Choice;
						return {
							...base,
							kind: item.kind,
							label: presetLabel(choice.preset),
							value: `${choice.preset.harness}${choice.preset.provider ? `/${choice.preset.provider}` : ""} ${choice.preset.agent ? `agent ${choice.preset.agent}` : [choice.preset.model, choice.preset.effort].filter(Boolean).join(" ")}`,
							set: this.host.loaded().config.presets !== null,
							default: choice.preset.default,
							note: choice.note,
							problem: choice.reason,
						};
					}
					case "heading":
						return { ...base, kind: item.kind, label: item.text, value: "", set: false };
					case "warning":
						return { ...base, kind: item.kind, label: `${item.count}`, value: "", set: false };
					default:
						return { ...base, kind: item.kind, label: "", value: "", set: false };
				}
			}),
			prose: (() => {
				const s = this.proseShown();
				return s ? { text: this.proseFor(s).editor.getText(), focused: this.proseFocused() } : null;
			})(),
			adding: this.adding
				? {
						step: this.adding.step,
						query: this.adding.query.getValue(),
						rows: this.addRows().map((r) =>
							r.kind === "group" ? `${"  ".repeat(r.depth)}${r.text}` : `    ${r.model.agent ?? r.model.model}`,
						),
						choice: this.adding.choice,
					}
				: null,
		};
	}
}
