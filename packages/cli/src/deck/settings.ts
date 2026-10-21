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
import { harnessName } from "@swb/shared/mailbox";
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
import type { SettingsState } from "./protocol.ts";
import { bold, cyan, dim, gray, green, key, red, shortPath, yellow } from "./style.ts";

// Settings: every key of config.toml as a list to read and change, drawn by the roster across the whole Deck. A value is
// dim while it's the default and bright once it's set; setting it back to the default takes the key out of the file.

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

type ClickTarget = { y: number; from: number; to: number; act: () => void };

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
	area: "rail" | "list" = "list";
	searching = false;
	search = new Input({ prompt: "" });
	changedOnly = false;
	cursor = 0;
	scroll = 0;
	editing: Editing | null = null;
	adding: Adding | null = null;
	prose: Prose | null = null;
	/** The list row under the pointer; null once a key is pressed or the pointer leaves. */
	hover: number | null = null;
	pointer: { x: number; y: number } | null = null;
	targets: ClickTarget[] = [];
	pressed: ClickTarget | null = null;
	/** A preset or path being dragged to a new place in its list. */
	dragging: { item: number; over: number | null } | null = null;
	listTop = 2;
	listHeight = 0;
	listLeft = 0;
	narrow = false;
	/** The items as last drawn. */
	shown: Item[] = [];

	constructor(readonly host: SettingsHost) {
		this.cursor = this.firstSelectable(this.items());
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
				out.push({ kind: "shortlist" }, ...Array.from({ length: count }, (_, index): Item => ({ kind: "preset", index })), {
					kind: "addPreset",
				});
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
				else if (c.kind === "chord") this.editing = { kind: "chord", captured: null, error: null };
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

	/** ← and →: a number steps, a choice cycles, and a preset's effort moves through what its harness and model take. */
	/** `wrap` cycles past the last level back to the first, as a click on the effort does. */
	step(delta: number, item = this.current(), wrap = false): void {
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
		this.editing = { kind: "text", target, input, error: null };
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
				this.editing = null;
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
		if (error === null) this.editing = null;
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
			this.host.requestRender();
			return;
		}
		prose.synced = text;
		drafts.delete(key);
	}

	/** Every key but Tab and esc is the editor's. Text past the cap is never let in, so there's nothing to refuse. */
	proseInput(s: Setting, data: string): void {
		const prose = this.proseFor(s);
		const k = decodeKittyPrintable(data) ?? data;
		if (matchesKey(data, "escape")) {
			this.host.close();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.saveProse();
			if (!this.narrow) this.area = "rail";
			return;
		}
		if (!prose.typed && (k === "[" || k === "]")) {
			this.setSection(this.section + (k === "[" ? -1 : 1));
			return;
		}
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
		prose.timer = setTimeout(() => this.saveProse(), SAVE_AFTER);
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
		this.adding = {
			step: "search",
			query: new Input({ prompt: "" }),
			choice: 0,
			top: 0,
			picked: null,
			effort: 0,
			note: new Input({ prompt: "" }),
			error: null,
		};
		this.adding.choice = this.firstModel();
	}

	/** Matches grouped by harness, then provider or kind; typing a full id also offers it as one. */
	addRows(): AddRow[] {
		const adding = this.adding as Adding;
		const catalog = this.host.catalog();
		const enabled = this.host.loaded().config.harnesses;
		const q = adding.query.getValue().trim().toLowerCase();
		const words = q.split(/\s+/).filter(Boolean);
		const rows: AddRow[] = [];
		for (const harness of HARNESSES) {
			if (!enabled.includes(harness)) continue;
			const models = (catalog?.models[harness] ?? []).filter((m) => searchMatch(m, words));
			const typed = adding.query.getValue().trim();
			const custom: Model[] = [];
			if (typed !== "" && !/\s/.test(typed) && !models.some((m) => m.model === typed || `${m.provider}/${m.model}` === typed)) {
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
		this.adding = null;
		const items = this.items();
		this.cursor = items.findIndex((i) => i.kind === "preset" && i.index === this.presets().length - 1);
	}

	addInput(data: string): void {
		const adding = this.adding as Adding;
		adding.error = null;
		if (matchesKey(data, "escape")) {
			if (adding.step === "search") this.adding = null;
			else if (adding.step === "effort") adding.step = "search";
			else adding.step = adding.picked?.agent ? "search" : "effort";
			return;
		}
		if (adding.step === "search") {
			if (matchesKey(data, "up") || matchesKey(data, "down")) this.moveAdd(matchesKey(data, "up") ? -1 : 1);
			else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))
				this.moveAdd((matchesKey(data, "pageUp") ? -1 : 1) * Math.max(1, this.listHeight - 2));
			else if (matchesKey(data, "enter")) this.pickModel(this.addRows()[adding.choice]);
			else if (matchesKey(data, "ctrl+r")) this.host.refresh(true);
			else {
				adding.query.handleInput(data);
				adding.choice = this.firstModel();
				adding.top = 0;
			}
			return;
		}
		if (adding.step === "effort") {
			const levels = effortLevels(adding.picked as Model);
			if (matchesKey(data, "up") || matchesKey(data, "left")) adding.effort = Math.max(0, adding.effort - 1);
			else if (matchesKey(data, "down") || matchesKey(data, "right")) adding.effort = Math.min(levels.length - 1, adding.effort + 1);
			else if (matchesKey(data, "enter")) adding.step = "note";
			return;
		}
		if (matchesKey(data, "enter")) this.finishAdding();
		else adding.note.handleInput(data);
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
		this.searching = false;
		this.changedOnly = false;
		this.cursor = this.firstSelectable(this.items());
		this.scroll = 0;
	}

	handleInput(data: string): void {
		this.hover = null;
		this.pointer = null;
		if (this.host.error()) {
			const k = decodeKittyPrintable(data) ?? data;
			if (k === "O" || matchesKey(data, "enter")) this.host.open(this.host.error()?.line ?? null);
			else if (matchesKey(data, "escape")) this.host.close();
			return;
		}
		if (this.adding) {
			this.addInput(data);
			return;
		}
		const editing = this.editing;
		if (editing?.kind === "text") {
			if (matchesKey(data, "escape")) this.editing = null;
			else if (matchesKey(data, "enter")) this.commitText();
			else {
				editing.input.handleInput(data);
				editing.error = null;
			}
			return;
		}
		if (editing?.kind === "chord") {
			if (matchesKey(data, "escape")) this.editing = null;
			else if (matchesKey(data, "enter") && editing.captured) {
				const error = this.set(setting("keys.prefix"), editing.captured);
				if (error === null) this.editing = null;
				else editing.error = error;
			} else {
				const name = tmuxKey(data);
				if (name) editing.captured = name;
				editing.error = name ? null : "that key has no tmux name";
			}
			return;
		}
		if (editing?.kind === "choices") {
			const choices = editing.s.control.kind === "enum" ? editing.s.control.choices : [];
			if (matchesKey(data, "escape")) this.editing = null;
			else if (matchesKey(data, "up") || matchesKey(data, "down"))
				editing.choice = Math.max(0, Math.min(choices.length - 1, editing.choice + (matchesKey(data, "up") ? -1 : 1)));
			else if (matchesKey(data, "enter")) {
				this.set(editing.s, choices[editing.choice]?.value);
				this.editing = null;
			}
			return;
		}
		if (this.searching) {
			if (matchesKey(data, "escape")) {
				this.search.setValue("");
				this.searching = false;
			} else if (matchesKey(data, "enter") || matchesKey(data, "down")) this.searching = false;
			else {
				this.search.handleInput(data);
				this.cursor = this.firstSelectable(this.items());
				this.scroll = 0;
			}
			return;
		}
		const prose = this.proseFocused() ? this.proseShown() : null;
		if (prose) {
			this.proseInput(prose, data);
			return;
		}
		const k = decodeKittyPrintable(data) ?? data;
		if (matchesKey(data, "escape")) {
			if (this.query() !== "" || this.changedOnly) {
				this.search.setValue("");
				this.changedOnly = false;
				this.cursor = this.firstSelectable(this.items());
			} else this.host.close();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			if (!this.narrow) this.area = this.area === "rail" ? "list" : "rail";
			return;
		}
		if (k === "[" || k === "]") {
			this.setSection(this.section + (k === "[" ? -1 : 1));
			return;
		}
		if (k === "/") {
			this.searching = true;
			this.area = "list";
			return;
		}
		if (k === "c") {
			this.changedOnly = !this.changedOnly;
			this.cursor = this.firstSelectable(this.items());
			return;
		}
		if (k === "?") {
			this.host.help();
			return;
		}
		if (k === "O") {
			const s = this.settingOf(this.current());
			this.host.open(s ? lineOf(this.host.loaded().text, s.key) : null);
			return;
		}
		if (this.area === "rail") {
			if (matchesKey(data, "down") || k === "j") this.setSection(this.section + 1);
			else if (matchesKey(data, "up") || k === "k") this.setSection(this.section - 1);
			else if (matchesKey(data, "enter") || matchesKey(data, "right") || k === "l") this.area = "list";
			return;
		}
		const item = this.current();
		if (matchesKey(data, "down") || k === "j") this.move(1);
		else if (matchesKey(data, "up") || k === "k") this.move(-1);
		else if (k === "g") this.move(Number.NEGATIVE_INFINITY);
		else if (k === "G") this.move(Number.POSITIVE_INFINITY);
		else if (matchesKey(data, "pageDown")) this.move(Math.max(1, this.listHeight - 1));
		else if (matchesKey(data, "pageUp")) this.move(-Math.max(1, this.listHeight - 1));
		else if (matchesKey(data, "enter")) this.activate(item);
		else if (k === " ") {
			if (item?.kind === "harness" || (item?.kind === "setting" && ["bool", "enum"].includes(item.s.control.kind))) this.activate(item);
		} else if (matchesKey(data, "left") || k === "h") {
			if (item?.kind === "setting" || item?.kind === "preset") this.step(-1, item);
		} else if (matchesKey(data, "right") || k === "l") {
			if (item?.kind === "setting" || item?.kind === "preset") this.step(1, item);
		} else if (k === "e" && item?.kind === "setting" && item.s.control.kind === "enum") {
			const values = item.s.control.choices.map((c) => c.value);
			this.editing = { kind: "choices", s: item.s, choice: Math.max(0, values.indexOf(String(this.valueOf(item.s)))) };
		} else if (k === "r") this.reset(item);
		else if (k === "a") {
			const s = this.settingOf(item);
			if (s?.control.kind === "paths") this.startText({ kind: "addEntry", s }, "");
			else if (s?.control.kind === "presets" || s?.control.kind === "harnesses") this.startAdding();
		} else if (k === "x") this.removeItem(item);
		else if (k === "J" || k === "K") this.shift(k === "J" ? 1 : -1, item);
		else if (k === "*" && item?.kind === "preset") this.starPreset(item.index);
		else if (k === "R") this.host.refresh(true);
	}

	// ── mouse ──────────────────────────────────────────────────────────

	targetAt(p: { x: number; y: number } | null): ClickTarget | undefined {
		return p ? this.targets.find((t) => t.y === p.y && p.x >= t.from && p.x < t.to) : undefined;
	}

	/** The list item under a screen row, if any. */
	itemAt(y: number): number | null {
		if (this.adding || y < this.listTop || y >= this.listTop + this.listHeight) return null;
		const i = this.scroll + (y - this.listTop);
		return selectable(this.shown[i]) ? i : null;
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
			else if (this.adding?.step === "search") this.moveAdd(delta);
			else this.move(delta);
			return { handled: true, render: true };
		}
		if (event.button !== "left") return { handled: true };
		if (event.type === "press") {
			this.pressed = this.targetAt({ x: event.x, y: event.y }) ?? null;
			const at = this.itemAt(event.y);
			const item = at === null ? undefined : this.shown[at];
			this.dragging = item?.kind === "preset" || item?.kind === "entry" ? { item: at as number, over: null } : null;
			return { handled: true, capture: this.dragging !== null };
		}
		if (event.type === "drag" && this.dragging) {
			this.dragging.over = this.itemAt(event.y);
			return { handled: true, render: true };
		}
		if (event.type === "release" && this.dragging) {
			const { item, over } = this.dragging;
			this.dragging = null;
			const from = this.shown[item];
			const to = over === null ? undefined : this.shown[over];
			if (from?.kind === "preset" && to?.kind === "preset" && from.index !== to.index) {
				this.cursor = item;
				this.movePreset(from.index, to.index);
				this.pressed = null;
			} else if (from?.kind === "entry" && to?.kind === "entry" && from.s === to.s && from.index !== to.index) {
				this.cursor = item;
				this.moveEntry(from, to.index);
				this.pressed = null;
			}
			return { handled: true, render: true };
		}
		if (event.type !== "click") return { handled: true };
		const target = this.pressed;
		this.pressed = null;
		if (target) {
			target.act();
			return { handled: true, render: true };
		}
		if (inEditor) {
			this.area = "list";
			this.searching = false;
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
		if (at !== null) {
			this.cursor = at;
			this.area = "list";
			this.searching = false;
		}
		return { handled: true, render: true };
	}

	// ── drawing ────────────────────────────────────────────────────────

	/** Joins the parts into row y's line, recording where each clickable one lands. */
	clickable(y: number, x0: number, parts: [string, (() => void) | null][]): string {
		let x = x0;
		let line = "";
		const p = this.pointer;
		for (const [text, act] of parts) {
			const w = visibleWidth(text);
			if (act) this.targets.push({ y, from: x, to: x + w, act });
			line += act && p?.y === y && p.x >= x && p.x < x + w ? this.host.paint.cursor(text, true) : text;
			x += w;
		}
		return line;
	}

	render(width: number, height: number): string[] {
		this.targets = [];
		this.narrow = width < NARROW_BELOW;
		if (this.narrow) this.area = "list";
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
		if (!prose) lines.push(gray(rule), ...this.footer(width, error));
		lines.push(this.messageLine(now), this.legend(height - 1, width, error));
		return lines.map((line) => truncateToWidth(line, width, "…", true));
	}

	header(width: number): string {
		const close: [string, (() => void) | null] = [`${bold("esc")} ${dim("sessions")} `, () => this.host.close()];
		if (this.narrow) {
			const name = SECTIONS[this.section] as string;
			const left: [string, (() => void) | null][] = [
				[` ${bold("Settings")}  `, null],
				["‹", () => this.setSection(this.section - 1)],
				[` ${name} `, null],
				["›", () => this.setSection(this.section + 1)],
			];
			const used = left.reduce((n, [t]) => n + visibleWidth(t), 0);
			return this.clickable(0, 0, [...left, [" ".repeat(Math.max(1, width - used - visibleWidth(close[0]))), null], close]);
		}
		const path = gray(shortPath(configPath()));
		const title = ` ${bold("Settings")}`;
		const gap = Math.max(1, Math.floor((width - visibleWidth(path)) / 2) - visibleWidth(title));
		const used = visibleWidth(title) + gap + visibleWidth(path);
		return this.clickable(0, 0, [
			[title, null],
			[" ".repeat(gap), null],
			[path, () => this.host.open(null)],
			[" ".repeat(Math.max(1, width - used - visibleWidth(close[0]))), null],
			close,
		]);
	}

	searchLine(width: number): string {
		const filters: [string, (() => void) | null][] = [
			[this.changedOnly ? gray("all") : bold("all"), () => this.setFilter(false)],
			["   ", null],
			[this.changedOnly ? bold("changed") : gray("changed"), () => this.setFilter(true)],
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
		return this.clickable(1, 0, [
			[" ", null],
			[
				field,
				() => {
					this.searching = true;
					this.area = "list";
				},
			],
			[" ".repeat(pad), null],
			...filters,
		]);
	}

	setFilter(changed: boolean): void {
		this.changedOnly = changed;
		this.cursor = this.firstSelectable(this.items());
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
		const room = Math.max(1, height - extra);
		if (this.cursor < this.scroll) this.scroll = this.cursor;
		if (this.cursor >= this.scroll + room) this.scroll = this.cursor - room + 1;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, items.length - room)));
		// Headings keep their place above the first row in view.
		if (this.scroll > 0 && items[this.scroll - 1]?.kind === "heading" && this.cursor - this.scroll + 1 < room) this.scroll--;
		const labelWidth = Math.min(
			36,
			Math.max(12, ...items.map((i) => (i.kind === "setting" && i.s.control.kind !== "paths" ? visibleWidth(i.s.label) : 0))),
		);
		const rows: string[] = [];
		for (let i = this.scroll; rows.length < height && i < items.length; i++) {
			const y = this.listTop + rows.length;
			rows.push(this.itemLine(items[i] as Item, i, y, left, listWidth, labelWidth));
			if (this.editing?.kind === "choices" && i === this.cursor && this.editing.s.control.kind === "enum") {
				const editing = this.editing;
				editing.s.control.kind === "enum" &&
					editing.s.control.choices.forEach((c, ci) => {
						if (rows.length >= height) return;
						const line = truncateToWidth(`      ${ci === editing.choice ? "●" : "○"} ${c.value}  ${gray(c.about)}`, listWidth, "…", true);
						const cy = this.listTop + rows.length;
						this.targets.push({
							y: cy,
							from: left,
							to: width,
							act: () => {
								this.set(editing.s, c.value);
								this.editing = null;
							},
						});
						rows.push(ci === editing.choice ? this.host.paint.cursor(line, true) : line);
					});
			}
		}
		while (rows.length < height) rows.push("");
		if (items.length === 0) rows[0] = gray(this.changedOnly && this.query() === "" ? "   nothing changed yet" : "   no settings match");
		return this.railed(rows);
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
		this.targets.push({
			y,
			from: 0,
			to: RAIL,
			act: () => {
				this.setSection(r);
				this.area = "rail";
			},
		});
		if (active) return this.host.paint.cursor(text, this.area === "rail");
		return this.pointer?.y === y && this.pointer.x < RAIL ? this.host.paint.hover(text) : text;
	}

	itemLine(item: Item, i: number, y: number, left: number, width: number, labelWidth: number): string {
		const selected = i === this.cursor && this.area === "list" && !this.searching;
		const lit = selected || i === this.hover;
		const mark = i === this.cursor ? "▸" : " ";
		const dropping = this.dragging?.over === i && this.dragging.item !== i;
		let line: string;
		const parts: [string, (() => void) | null][] = [];
		switch (item.kind) {
			case "heading":
				return truncateToWidth(` ${bold(item.text)}`, width, "…", true);
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
				parts.push([`    ${editing ? this.inputCell(width - 6) : this.isSet(item.s) ? value : dim(value)}`, null]);
				if (lit && !editing) parts.push(["   ", null], [gray("x remove · J K move"), null]);
				break;
			}
			case "addEntry": {
				const editing = this.editing?.kind === "text" && this.editing.target.kind === "addEntry" && i === this.cursor;
				if (editing) parts.push([`    ${this.inputCell(width - 6)}`, null]);
				else parts.push(["    ", null], [green("+ add a path"), () => this.activateAt(i)]);
				break;
			}
			case "harness":
				parts.push(...this.harnessParts(item.harness, i));
				break;
			case "shortlist":
				parts.push(...this.shortlistParts(width));
				break;
			case "preset":
				parts.push(...this.presetParts(item.index, i, width));
				break;
			case "addPreset":
				parts.push(["  ", null], [green("+ add a preset"), () => this.activateAt(i)]);
				break;
		}
		line = this.clickable(y, left + 1, parts);
		line = truncateToWidth(`${mark}${line}`, width, "…", true);
		if (dropping) return this.host.paint.cursor(line, true);
		if (selected) return this.host.paint.cursor(line, true);
		if (i === this.cursor) return this.host.paint.cursor(line, false);
		return i === this.hover ? this.host.paint.hover(line) : line;
	}

	activateAt(i: number): void {
		this.cursor = i;
		this.area = "list";
		this.activate(this.shown[i]);
	}

	inputCell(width: number): string {
		const editing = this.editing as Editing & { kind: "text" };
		return editing.input.render(Math.max(10, width))[0] ?? "";
	}

	settingParts(s: Setting, i: number, lit: boolean, labelWidth: number, width: number): [string, (() => void) | null][] {
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
		const shown = set ? value : dim(value);
		const parts: [string, (() => void) | null][] = [
			[label, null],
			[shown, s.control.kind === "paths" ? null : () => this.activateAt(i)],
		];
		if (lit && s.control.kind !== "prose") {
			const fallback = s.fallback();
			if (set)
				parts.push(
					["   ", null],
					[gray(`default ${show(s, fallback.value)}`), null],
					["  ", null],
					[gray("↺ reset"), () => this.reset({ kind: "setting", s })],
				);
			else parts.push(["   ", null], [gray(fallback.from ?? "default"), null]);
		}
		return parts;
	}

	harnessParts(harness: Harness, i: number): [string, (() => void) | null][] {
		const on = this.host.loaded().config.harnesses.includes(harness);
		const set = this.isSet(setting("harnesses"));
		const status = this.host.catalog()?.status[harness];
		const box = `[${on ? "x" : " "}]`;
		const note = status === undefined ? gray("finding…") : status.problem ? red(status.problem) : "";
		return [
			[" ", null],
			[set ? box : dim(box), () => this.toggleAt(i, harness)],
			[` ${(set ? (s: string) => s : dim)(harness.padEnd(8))} `, null],
			[note, null],
		];
	}

	toggleAt(i: number, harness: Harness): void {
		this.cursor = i;
		this.area = "list";
		this.toggleHarness(harness);
	}

	shortlistParts(width: number): [string, (() => void) | null][] {
		const custom = this.host.loaded().config.presets !== null;
		const title = ` ${bold("Shortlist")}`;
		const right: [string, (() => void) | null] = custom ? [gray("↺"), () => this.reset({ kind: "shortlist" })] : [gray("automatic"), null];
		const pad = Math.max(1, width - 3 - visibleWidth(title) - visibleWidth(right[0]));
		const listed = this.host.catalog() === null && !custom ? [gray("   finding harnesses…"), null] : null;
		return [[title, null], ...(listed ? [listed as [string, null]] : []), [" ".repeat(pad), null], right];
	}

	presetParts(index: number, i: number, width: number): [string, (() => void) | null][] {
		const choice = this.choices()[index];
		if (!choice) return [];
		const p = choice.preset;
		const custom = this.host.loaded().config.presets !== null;
		const paint = custom ? (s: string) => s : dim;
		const star = p.default ? (choice.reason ? red("★") : "★") : choice.reason ? red("✗") : " ";
		const where = p.provider ? `${p.harness} · ${p.provider}` : p.harness;
		// The picker draws a harness's own effort as it draws medium; here, where it's set, it says so.
		const model = p.agent ?? (p.effort === null ? `${p.model} ${gray("default")}` : `${p.model}${effortMark(p.effort)}`);
		const noteWidth = Math.max(0, width - 48);
		const note = choice.reason && i === this.cursor ? red(choice.reason) : gray(truncateToWidth(choice.note, noteWidth, "…"));
		const editing = this.editing?.kind === "text" && this.editing.target.kind === "note" && i === this.cursor;
		return [
			[`${String(index + 1).padStart(2)} `, null],
			[star, () => this.starPreset(index)],
			[` ${paint(where.padEnd(16).slice(0, 16))} `, null],
			[paint(`${model}${" ".repeat(Math.max(0, 22 - visibleWidth(model)))}`), () => this.step(1, { kind: "preset", index }, true)],
			[" ", null],
			[editing ? this.inputCell(noteWidth) : note, null],
		];
	}

	errorBody(error: ConfigError, width: number, height: number): string[] {
		const rows = [
			"",
			`  ${red(`✗ ${shortPath(error.file)}${error.line === null ? "" : `:${error.line}`}`)}`,
			...wrapTextWithAnsi(`  ${error.problem}`, width - 2),
			"",
			`  ${gray("This Deck keeps the settings it had until the file is fixed; new swb commands stop on it.")}`,
			"",
		];
		const y = this.listTop + rows.length;
		rows.push(
			this.clickable(y, 0, [
				["  ", null],
				[key("O", "open config.toml at that line"), () => this.host.open(error.line)],
			]),
		);
		while (rows.length < height) rows.push("");
		return rows.slice(0, height);
	}

	addHeader(width: number): string {
		const adding = this.adding as Adding;
		if (adding.step !== "search") {
			const m = adding.picked as Model;
			return ` ${gray("adding")} ${bold(presetLabel({ ...m, effort: effortLevels(m)[adding.effort] ?? null, use: "", default: false }))} ${gray(`· ${harnessName(m.harness)}`)}`;
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
						? `   ${"default".padEnd(8)}   ${gray(`${harnessName(m.harness)}'s own`)}`
						: `   ${e.padEnd(8)} ${effortMark(e) || " "}${e === m.effort ? gray("   its default") : ""}`,
					width,
					"…",
					true,
				);
				this.targets.push({
					y,
					from: 0,
					to: width,
					act: () => {
						adding.effort = i;
						adding.step = "note";
					},
				});
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
				this.targets.push({
					y: this.listTop + r,
					from: 0,
					to: inner,
					act: () => {
						adding.choice = index;
						this.pickModel(row);
					},
				});
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
			return wrapTextWithAnsi(`   ${about}`, width).concat("", "").slice(0, 2);
		}
		const item = this.current();
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
		if (item?.kind === "harness") {
			const status = this.host.catalog()?.status[item.harness];
			text = `${harnessName(item.harness)}${status?.version ? ` ${status.version}` : ""}. ${s?.description ?? ""}`;
		}
		if (item?.kind === "preset") {
			const choice = this.choices()[item.index];
			// The row says the note, or why it can't start; the footer, what the shortlist is.
			if (choice?.reason) text = s?.description ?? "";
		}
		return wrapTextWithAnsi(`   ${text}`, width).concat("", "").slice(0, 2);
	}

	/** The config error has the whole list's place while it stands, so the message line doesn't repeat it. */
	messageLine(now: number): string {
		if (this.flashText && this.flashText.until > now) return ` ${red(`✗ ${this.flashText.text}`)}`;
		return this.host.message(now, this.host.error() === null);
	}

	legend(y: number, width: number, error: ConfigError | null): string {
		const hints: [string, string, () => void][] = [];
		const press = (data: string) => () => this.handleInput(data);
		if (error) hints.push(["O", "open it", () => this.host.open(error.line)], ["esc", "sessions", () => this.host.close()]);
		else if (this.adding) {
			const step = this.adding.step;
			if (step === "search")
				hints.push(["⏎", "choose", press("\r")], ["↑ ↓", "move", () => {}], ["C-r", "refresh", () => this.host.refresh(true)]);
			else hints.push(["⏎", step === "effort" ? "next" : "add", press("\r")]);
			hints.push(["esc", step === "search" ? "cancel" : "back", press("\x1b")]);
		} else if (this.proseFocused()) {
			if (!this.narrow) hints.push(["⇥", "sections", press("\t")]);
			hints.push(["C--", "undo", press("\x1f")], ["esc", "sessions", press("\x1b")]);
		} else if (this.editing) hints.push(["⏎", "save", press("\r")], ["esc", "cancel", press("\x1b")]);
		else {
			const item = this.current();
			if (!this.narrow) hints.push(["⇥", "area", press("\t")]);
			hints.push(["[ ]", "section", press("]")]);
			if (item?.kind === "preset")
				hints.push(
					["⏎", "note", press("\r")],
					["← →", "effort", press("\x1b[C")],
					["*", "default", press("*")],
					["J K", "move", press("J")],
					["x", "remove", press("x")],
				);
			else if (item?.kind === "entry") hints.push(["⏎", "edit", press("\r")], ["J K", "move", press("J")], ["x", "remove", press("x")]);
			else if (item?.kind === "harness") hints.push(["space", "on/off", press(" ")], ["a", "add preset", press("a")]);
			else if (item?.kind === "setting" && item.s.control.kind === "bool") hints.push(["⏎", "toggle", press("\r")]);
			else if (item?.kind === "setting" && item.s.control.kind === "enum")
				hints.push(["⏎", "next", press("\r")], ["e", "choices", press("e")]);
			else if (item?.kind === "setting" && item.s.control.kind === "int")
				hints.push(["← →", "step", press("\x1b[C")], ["⏎", "edit", press("\r")]);
			else if (item?.kind === "shortlist" || item?.kind === "addPreset") hints.push(["⏎", "add", press("\r")]);
			else hints.push(["⏎", "edit", press("\r")]);
			const s = this.settingOf(item);
			if (
				s &&
				s.control.kind !== "prose" &&
				(this.isSet(s) || (s.control.kind === "presets" && this.host.loaded().config.presets !== null))
			)
				hints.push(["r", "reset", press("r")]);
			hints.push(["/", "search", press("/")], ["O", "file", press("O")]);
		}
		const parts = hints.flatMap(([name, label, act]): [string, (() => void) | null][] => [
			[" ", null],
			[key(name, label), act],
		]);
		// Hints that don't fit are dropped whole, from the end.
		while (parts.length > 2 && parts.reduce((n, [t]) => n + visibleWidth(t), 0) > width) parts.splice(-2, 2);
		return this.clickable(y, 0, parts);
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
