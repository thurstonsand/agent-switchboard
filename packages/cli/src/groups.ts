import { operatorDir } from "@swb/shared";
import { SwbError } from "./errors.ts";

// A name goes to tmux and a launch's environment as it is, and tmux ends a command at an argument ending in ";".
const NAME_CHAR = /[\p{L}\p{N} ._-]/u;

/** The characters in `text` a Group's name can't hold, once each, in the order they appear. */
export function unnameable(text: string): string[] {
	return [...new Set([...text].filter((char) => !NAME_CHAR.test(char)))];
}

/** A Group's name as typed, trimmed; refused when empty, or with anything but letters, digits, spaces, and - _ . */
export function groupName(name: string): string {
	const trimmed = name.trim();
	if (trimmed === "") throw new SwbError("a Group needs a name; null means no Group");
	if (unnameable(trimmed).length > 0) throw new SwbError("a Group's name takes only letters, digits, spaces, and - _ .");
	return trimmed;
}

/** The Group asked for a session in `dir`: a name, checked, null for none, or undefined when none was asked for. */
export function requestedGroup(group: string | null | undefined, dir: string): string | null | undefined {
	if (group === undefined || group === null) return group;
	if (dir === operatorDir()) throw new SwbError("an Operator belongs to no Project, so it takes no Group");
	return groupName(group);
}
