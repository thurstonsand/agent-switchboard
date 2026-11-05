import { decodeKittyPrintable, type KeyId, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { View } from "@swb/shared";
import { key } from "./style.ts";

/** What a row can be asked to do: by its key on the cursor's row, by its Peek's buttons, or by a prefix key from anywhere. */
export type RowAct = "wake" | "stop" | "reload" | "archive" | "snooze" | "unseen" | "parent" | "copyOpen" | "copyMention" | "new" | "group";

/**
 * What a key, a click, a prefix key, or a button asks the roster to do. Keys find theirs in the mode's keymap, and every
 * button carries one, so a click goes through the same checks its key does.
 */
export type Command =
	/** The mode's highlight: the roster's cursor, or a prompt's or picker's choice. */
	| { kind: "step"; by: number }
	/** ⏎ in a prompt or picker, or a click on one of its choices; null is the highlighted one. */
	| { kind: "choose"; index: number | null }
	/** esc in a prompt or picker, or its ✕. */
	| { kind: "cancel" }
	/** A key no binding takes, typed into the mode's field. */
	| { kind: "type"; data: string }
	/** ⏎ (enter) or space on the cursor's row. */
	| { kind: "activate"; enter: boolean }
	/** l (open) or h (fold) on the cursor's row. */
	| { kind: "unfold"; open: boolean }
	/** A click on a row: the cursor goes there, and it acts as ⏎ does. */
	| { kind: "select"; key: string; index: number }
	/** A click on a session's fold mark. */
	| { kind: "fold"; id: string }
	/** J and K: the cursor to the next session that way. */
	| { kind: "moveSession"; by: 1 | -1 }
	/** On the row with this key, or the cursor's when null. */
	| { kind: "row"; act: RowAct; row: string | null }
	/** The archive prompt's answers; esc is cancel. */
	| { kind: "archiveAnswer"; all: boolean; deleteWorktree: boolean }
	| { kind: "history"; step: -1 | 1 }
	/** The cursor onto a session, wherever it is, opening what hides it. */
	| { kind: "reveal"; id: string }
	| { kind: "filter" }
	| { kind: "clearFilter" }
	/** The directory picker, straight into adding one. */
	| { kind: "addDir" }
	/** The picker: its launch card's menu, opened or closed. */
	| { kind: "menu" }
	/** The picker: Tab, completing the path typed. */
	| { kind: "complete" }
	/** The picker: asks to take the highlighted directory off its list. */
	| { kind: "remove" }
	| { kind: "view"; view: View }
	| { kind: "shell" }
	/** The roster back on screen with the keyboard, back on screen without it, or off it. */
	| { kind: "roster"; to: "focus" | "show" | "hide" }
	| { kind: "settings" }
	| { kind: "config"; line: number | null }
	| { kind: "help" }
	| { kind: "quit" };

/**
 * A key and what it does, which input runs and the legend shows: a mode's keymap is the one place both read, so the
 * legend can't offer a key that does something else.
 */
export type Binding<C> = {
	/** A printable character as typed, or a key name pi-tui's matchesKey knows; none for one only the legend shows. */
	keys: string[];
	/** How the legend writes it. */
	name: string;
	/** What the legend says it does; null keeps it out of the legend. */
	label: string | null;
	/** Null for a legend entry that names keys bound one by one beside it, as "1–9 pick" does. */
	command: C | null;
};

/** The binding a key runs, if any. */
export function bindingFor<C>(bindings: Binding<C>[], data: string): Binding<C> | undefined {
	const typed = decodeKittyPrintable(data) ?? data;
	return bindings.find((b) => b.keys.some((k) => (k.length === 1 ? typed === k : matchesKey(data, k as KeyId))));
}

/** A keymap's labelled bindings as legend buttons, in its order. What doesn't fit in `room` goes whole, from the end. */
export function legendParts<C>(bindings: Binding<C>[], room: number): [text: string, command: C | null][] {
	const shown = bindings.filter((b) => b.label !== null);
	const width = () => shown.reduce((n, b) => n + 1 + visibleWidth(key(b.name, b.label as string)), 0);
	while (shown.length > 1 && width() > room) shown.pop();
	return shown.flatMap((b): [string, C | null][] => [
		[" ", null],
		[key(b.name, b.label as string), b.command],
	]);
}
