import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "@swb/shared";
import { parse } from "smol-toml";
import { SwbError } from "./errors.ts";

export type Config = {
	hover: "lazy" | "eager";
	editor: string;
	inactiveAfterMs: number;
	reapAfterMs: number;
	clipboard: string;
	prefix: string;
};

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
		hover: "lazy",
		editor: process.env.EDITOR || "nvim",
		inactiveAfterMs: UNITS.h * 72,
		reapAfterMs: UNITS.m * 30,
		clipboard: defaultClipboard(),
		prefix: "M-a",
	};
	for (const [key, value] of Object.entries(raw)) {
		switch (key) {
			case "hover":
				if (value !== "lazy" && value !== "eager")
					throw new SwbError(`config: hover must be "lazy" or "eager", got ${JSON.stringify(value)}`);
				config.hover = value;
				break;
			case "editor":
				config.editor = string(key, value);
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
