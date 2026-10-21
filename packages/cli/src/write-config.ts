import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { patch, stringify } from "@decimalturn/toml-patch";
import { ConfigProblem, checkConfig, configPath, fromRaw, type Loaded, type Setting } from "./config.ts";
import { SwbError } from "./errors.ts";
import { randomHex } from "./sessions.ts";

// Settings writes config.toml through toml-patch, which edits only what changed and keeps every other line and
// comment as it was. Each write is one change, made from the file as Settings last read it.

/** The parsed file with one key set, or removed when `value` is undefined; a table left empty goes too. */
export function withValue(raw: Record<string, unknown>, key: string[], value: unknown): Record<string, unknown> {
	const next = structuredClone(raw);
	const [first, second] = key as [string, string | undefined];
	if (second === undefined) {
		if (value === undefined) delete next[first];
		else next[first] = value;
		return next;
	}
	const table = { ...((next[first] as Record<string, unknown> | undefined) ?? {}) };
	if (value === undefined) delete table[second];
	else table[second] = value;
	if (Object.keys(table).length === 0) delete next[first];
	else next[first] = table;
	return next;
}

/** A value equal to the setting's default is no value at all: the key comes out of the file. */
export function setOrReset(raw: Record<string, unknown>, s: Setting, value: unknown): Record<string, unknown> {
	return withValue(raw, s.key, value === undefined || Bun.deepEquals(value, s.fallback().value) ? undefined : value);
}

/**
 * Writes `updated` over the file Settings read as `from`. A file changed since then is left alone, so a hand edit is never
 * lost; the new file is validated whole and checked to parse back to exactly `updated` before it replaces the old one.
 * `reorder` lets toml-patch move [[presets]] entries to match.
 */
export function writeConfig(from: Loaded, updated: Record<string, unknown>, reorder = false): Loaded {
	const path = configPath();
	let current = "";
	try {
		current = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (current !== from.text) throw new SwbError("config.toml changed since Settings read it; nothing saved");
	try {
		fromRaw(updated);
	} catch (error) {
		if (error instanceof ConfigProblem) throw new SwbError(error.message);
		throw error;
	}
	let text: string;
	try {
		// toml-patch can't start an array of tables, so the first [[presets]] is appended as its own text.
		if (updated.presets !== undefined && from.raw.presets === undefined) {
			const { presets, ...rest } = updated;
			const body = patch(current, rest).trimEnd();
			text = `${body}${body === "" ? "" : "\n\n"}${stringify({ presets }).trimEnd()}\n`;
		} else text = patch(current, updated, { updateOrder: reorder });
	} catch (error) {
		throw new SwbError(`toml-patch couldn't make this edit (${(error as Error).message}); nothing saved. Edit config.toml by hand instead`);
	}
	if (text !== "" && !text.endsWith("\n")) text += "\n";
	const written = checkConfig(text);
	if (!Bun.deepEquals(written.raw, updated))
		throw new SwbError("the edit came out different from the change; nothing saved. Edit config.toml by hand instead");
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomHex(4)}.tmp`;
	writeFileSync(temp, text);
	const mode = statSync(path, { throwIfNoEntry: false })?.mode;
	if (mode !== undefined) chmodSync(temp, mode & 0o777);
	renameSync(temp, path);
	return written;
}
