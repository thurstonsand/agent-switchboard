import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, HARNESSES, type Harness } from "@swb/shared";
import { parse } from "smol-toml";
import type { DirsConfig } from "./dirs.ts";
import { SwbError } from "./errors.ts";

export type Config = {
	/** The cursor resting 500 ms on a dormant session starts its pi in the background. */
	wakeOnHighlight: boolean;
	editor: string;
	inactiveAfterMs: number;
	reapAfterMs: number;
	clipboard: string;
	prefix: string;
	rosterWidth: RosterWidth;
	/** Where the directory picker looks for places to start sessions, beyond the ones sessions have used. */
	dirs: DirsConfig;
	/** What `n` starts by default; the picker's Tab cycles it. */
	harness: Harness;
};

/** The roster's width: columns, or a share of the Deck. */
export type RosterWidth = { cols: number } | { percent: number };

type Unit = "s" | "m" | "h" | "d";
const UNITS: Record<Unit, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function duration(key: string, value: unknown): number {
	const match = typeof value === "string" ? /^(\d+)([smhd])$/.exec(value) : null;
	if (!match) throw new SwbError(`config: ${key} must be a duration like "30m", got ${JSON.stringify(value)}`);
	return Number(match[1]) * UNITS[match[2] as Unit];
}

function string(key: string, value: unknown): string {
	if (typeof value !== "string" || value === "")
		throw new SwbError(`config: ${key} must be a non-empty string, got ${JSON.stringify(value)}`);
	return value;
}

function defaultClipboard(): string {
	if (Bun.which("wl-copy")) return "wl-copy";
	if (Bun.which("xclip")) return "xclip -selection clipboard";
	return "pbcopy";
}

export function loadConfig(): Config {
	const path = join(configDir(), "config.toml");
	let raw: Record<string, unknown> = {};
	try {
		raw = parse(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SwbError(`config: ${path}: ${(error as Error).message}`);
	}
	const config: Config = {
		wakeOnHighlight: false,
		editor: process.env.EDITOR || "nvim",
		inactiveAfterMs: UNITS.h * 72,
		reapAfterMs: UNITS.m * 30,
		clipboard: defaultClipboard(),
		prefix: "M-a",
		rosterWidth: { cols: 42 },
		dirs: { scan: [], depth: 2, exclude: [], include: [], sort: "name" },
		harness: "pi",
	};
	for (const [key, value] of Object.entries(raw)) {
		switch (key) {
			case "wake_on_highlight":
				if (typeof value !== "boolean") throw new SwbError(`config: wake_on_highlight must be true or false, got ${JSON.stringify(value)}`);
				config.wakeOnHighlight = value;
				break;
			case "editor":
				config.editor = string(key, value);
				break;
			case "harness":
				if (!(HARNESSES as readonly unknown[]).includes(value))
					throw new SwbError(`config: harness must be one of ${HARNESSES.join(", ")}, got ${JSON.stringify(value)}`);
				config.harness = value as Harness;
				break;
			case "inactive_after":
				config.inactiveAfterMs = duration(key, value);
				break;
			case "reap_after":
				config.reapAfterMs = duration(key, value);
				break;
			case "clipboard":
				config.clipboard = string(key, value);
				break;
			case "roster_width": {
				const percent = typeof value === "string" ? /^(\d+)%$/.exec(value) : null;
				if (Number.isInteger(value) && (value as number) >= 20) config.rosterWidth = { cols: value as number };
				else if (percent && Number(percent[1]) >= 5 && Number(percent[1]) <= 80) config.rosterWidth = { percent: Number(percent[1]) };
				else throw new SwbError(`config: roster_width must be columns (20 or more) or a share like "25%", got ${JSON.stringify(value)}`);
				break;
			}
			case "dirs":
				if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SwbError("config: dirs must be a table");
				for (const [sub, subValue] of Object.entries(value as Record<string, unknown>)) {
					if (sub === "depth") {
						if (!Number.isInteger(subValue) || (subValue as number) < 1 || (subValue as number) > 10)
							throw new SwbError(`config: dirs.depth must be 1 to 10, got ${JSON.stringify(subValue)}`);
						config.dirs.depth = subValue as number;
					} else if (sub === "sort") {
						if (subValue !== "name" && subValue !== "recent")
							throw new SwbError(`config: dirs.sort must be "name" or "recent", got ${JSON.stringify(subValue)}`);
						config.dirs.sort = subValue;
					} else if (sub === "scan" || sub === "exclude" || sub === "include") {
						if (!Array.isArray(subValue) || subValue.some((v) => typeof v !== "string" || v === ""))
							throw new SwbError(`config: dirs.${sub} must be a list of paths, got ${JSON.stringify(subValue)}`);
						config.dirs[sub] = subValue as string[];
					} else throw new SwbError(`config: unknown key dirs.${sub}`);
				}
				break;
			case "keys":
				if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SwbError("config: keys must be a table");
				for (const [sub, subValue] of Object.entries(value as Record<string, unknown>)) {
					if (sub !== "prefix") throw new SwbError(`config: unknown key keys.${sub}`);
					config.prefix = string("keys.prefix", subValue);
				}
				break;
			default:
				throw new SwbError(`config: unknown key ${key}`);
		}
	}
	return config;
}
