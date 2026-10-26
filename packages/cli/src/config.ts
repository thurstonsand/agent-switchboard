import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, HARNESSES, type Harness } from "@swb/shared";
import { parse, TomlError } from "smol-toml";
import type { DirsConfig } from "./dirs.ts";
import { SwbError } from "./errors.ts";

export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The levels each harness takes at launch; a Codex model may support fewer. */
export const HARNESS_EFFORTS: Record<Harness, Effort[]> = {
	pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
	claude: ["low", "medium", "high", "xhigh", "max"],
	codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
};

/** One entry on the shortlist: what a new session runs in, and a note for the agents choosing among them. */
export type Preset = {
	harness: Harness;
	/** pi's provider; the other harnesses have one each. */
	provider: string | null;
	/** Null for an agent, whose own definition sets its model and effort. */
	model: string | null;
	/** Null for the harness's own default. */
	effort: Effort | null;
	/** A Claude Code agent the whole session runs as. */
	agent: string | null;
	use: string;
	default: boolean;
};

export type Config = {
	/** The cursor resting 500 ms on a dormant session starts its pi in the background. */
	wakeOnHighlight: boolean;
	editor: string;
	inactiveAfterMs: number;
	reapAfterMs: number;
	clipboard: string;
	prefix: string;
	rosterWidth: RosterWidth;
	shellPosition: ShellPosition;
	/** Where the directory picker looks for places to start sessions, beyond the ones sessions have used. */
	dirs: DirsConfig;
	/** The harnesses new sessions may start in; resuming is never restricted. */
	harnesses: Harness[];
	/** The shortlist as written; null while it's the automatic one. */
	presets: Preset[] | null;
	warnLongShortlist: boolean;
	/** Mine, after the ones swb ships, in every Operator's AGENTS.md. */
	operatorInstructions: string;
};

/** The roster's width: columns, or a share of the Deck. */
export type RosterWidth = { cols: number } | { percent: number };

/** Where the shell opens against the agent's pane: along its longer side, or one way while there's room. */
export type ShellPosition = "auto" | "below" | "beside";

export const SECTIONS = ["General", "Harnesses", "Operators", "Directories", "Keys & commands"] as const;
export type Section = (typeof SECTIONS)[number];

export type Control =
	| { kind: "bool" }
	| { kind: "enum"; choices: { value: string; about: string }[] }
	| { kind: "duration" }
	| { kind: "int"; min: number; max: number }
	| { kind: "width" }
	| { kind: "command" }
	| { kind: "chord" }
	| { kind: "paths" }
	| { kind: "harnesses" }
	| { kind: "presets" }
	| { kind: "prose"; max: number };

/** One setting: everything Settings, search, validation, and the README know about it. */
export type Setting = {
	/** Its TOML path. */
	key: string[];
	section: Section;
	label: string;
	description: string;
	/** Other words a search for it might use. */
	synonyms: string[];
	control: Control;
	/** Its value when unset, as TOML spells it, and what chose it when that isn't fixed. */
	fallback: () => { value: unknown; from: string | null };
	/** Takes a TOML value into the config, throwing what's wrong with it. */
	apply: (config: Config, value: unknown) => void;
	/** The README's example value and comment. */
	example: unknown;
	note: string;
};

type Unit = "s" | "m" | "h" | "d";
const UNITS: Record<Unit, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const UNIT_NAMES: Record<Unit, string> = { s: "second", m: "minute", h: "hour", d: "day" };

/** A duration as written: a whole number, then s, m, h, or d. */
export function durationMs(value: unknown): number {
	const match = typeof value === "string" ? /^(\d+)([smhd])$/.exec(value) : null;
	if (!match) throw new Error(`must be a duration like "30m", got ${JSON.stringify(value)}`);
	return Number(match[1]) * UNITS[match[2] as Unit];
}

/** "72h" read back in words: "3 days". */
export function durationWords(value: string): string {
	const ms = durationMs(value);
	if (ms === 0) return "immediately";
	for (const unit of ["d", "h", "m", "s"] as Unit[]) {
		if (ms % UNITS[unit] !== 0) continue;
		const n = ms / UNITS[unit];
		return `${n} ${UNIT_NAMES[unit]}${n === 1 ? "" : "s"}`;
	}
	return value;
}

function string(value: unknown): string {
	if (typeof value !== "string" || value === "") throw new Error(`must be a non-empty string, got ${JSON.stringify(value)}`);
	return value;
}

function paths(value: unknown): string[] {
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v === ""))
		throw new Error(`must be a list of paths, got ${JSON.stringify(value)}`);
	return value as string[];
}

function oneOf<T extends string>(choices: readonly T[], value: unknown): T {
	if (!(choices as readonly unknown[]).includes(value))
		throw new Error(
			`must be ${choices.length === 2 ? `"${choices[0]}" or "${choices[1]}"` : `one of ${choices.map((c) => `"${c}"`).join(", ")}`}, got ${JSON.stringify(value)}`,
		);
	return value as T;
}

function defaultClipboard(): { value: string; from: string } {
	if (Bun.which("wl-copy")) return { value: "wl-copy", from: "found wl-copy" };
	if (Bun.which("xclip")) return { value: "xclip -selection clipboard", from: "found xclip" };
	return { value: "pbcopy", from: "neither wl-copy nor xclip found" };
}

const fixed = (value: unknown) => () => ({ value, from: null });

const OPERATOR_INSTRUCTIONS_MAX = 16_000;

export const SETTINGS: Setting[] = [
	{
		key: ["wake_on_highlight"],
		section: "General",
		label: "Wake on highlight",
		description: "Start a dormant session in the background once the cursor rests on its row for half a second.",
		synonyms: ["start", "resume", "cursor", "hover"],
		control: { kind: "bool" },
		fallback: fixed(false),
		apply: (config, value) => {
			if (typeof value !== "boolean") throw new Error(`must be true or false, got ${JSON.stringify(value)}`);
			config.wakeOnHighlight = value;
		},
		example: false,
		note: "true starts a dormant session after the cursor rests 500 ms on its row",
	},
	{
		key: ["roster_width"],
		section: "General",
		label: "Roster width",
		description: "Columns, or a share of the Deck like 25%. Never more than half the Deck; a width you drag wins.",
		synonyms: ["sidebar", "list", "columns", "size"],
		control: { kind: "width" },
		fallback: fixed(42),
		apply: (config, value) => {
			const percent = typeof value === "string" ? /^(\d+)%$/.exec(value) : null;
			if (Number.isInteger(value) && (value as number) >= 20) config.rosterWidth = { cols: value as number };
			else if (percent && Number(percent[1]) >= 5 && Number(percent[1]) <= 80) config.rosterWidth = { percent: Number(percent[1]) };
			else throw new Error(`must be columns (20 or more) or a share like "25%", got ${JSON.stringify(value)}`);
		},
		example: 42,
		note: 'columns, or a share of the Deck like "25%"; never more than half',
	},
	{
		key: ["shell_position"],
		section: "General",
		label: "Shell position",
		description:
			"Where M-a s opens the directory's shell: along the longer side of the agent's pane, or always below or beside it while both halves have room. With room for neither, it takes the agent's place.",
		synonyms: ["terminal", "split", "orientation", "vertical", "horizontal", "layout"],
		control: {
			kind: "enum",
			choices: [
				{ value: "auto", about: "beside a wide pane, below a tall one" },
				{ value: "below", about: "under the agent" },
				{ value: "beside", about: "to the agent's right" },
			],
		},
		fallback: fixed("auto"),
		apply: (config, value) => {
			config.shellPosition = oneOf(["auto", "below", "beside"], value);
		},
		example: "auto",
		note: '"below" or "beside" fixes it, except where only the other fits; with room for neither, it replaces the agent',
	},
	{
		key: ["inactive_after"],
		section: "General",
		label: "Move sessions to Inactive after",
		description:
			"An open session moves to Inactive once it, and every session it started, has had no activity for this long. Operators never do.",
		synonyms: ["idle", "stale", "old", "duration"],
		control: { kind: "duration" },
		fallback: fixed("72h"),
		apply: (config, value) => {
			config.inactiveAfterMs = durationMs(value);
		},
		example: "72h",
		note: "open sessions idle this long, with all they started, move to Inactive",
	},
	{
		key: ["reap_after"],
		section: "General",
		label: "Stop idle, unviewed sessions after",
		description: "A live session that's idle and on no one's screen is stopped after this long. It stays open, and waking it resumes it.",
		synonyms: ["reap", "kill", "memory", "duration"],
		control: { kind: "duration" },
		fallback: fixed("30m"),
		apply: (config, value) => {
			config.reapAfterMs = durationMs(value);
		},
		example: "30m",
		note: "an idle live session nobody is viewing is stopped after this long",
	},
	{
		key: ["harnesses"],
		section: "Harnesses",
		label: "Harnesses",
		description: "The harnesses new sessions may start in, yours or an agent's. Sessions already started still resume.",
		synonyms: ["pi", "claude", "codex", "enabled", "installed", "agents"],
		control: { kind: "harnesses" },
		fallback: fixed([...HARNESSES]),
		apply: (config, value) => {
			if (!Array.isArray(value) || value.length === 0) throw new Error(`must list one or more of ${HARNESSES.join(", ")}`);
			const named = value.map((v) => oneOf(HARNESSES, v));
			config.harnesses = HARNESSES.filter((h) => named.includes(h));
		},
		example: [...HARNESSES],
		note: "which harnesses new sessions may start in; all of them by default",
	},
	{
		key: ["presets"],
		section: "Harnesses",
		label: "Shortlist",
		description:
			"What n offers and agents choose from when they start a session. The ★ is the default: n opens on it, and Tab drops the whole list, a harness at a time, to pick another.",
		synonyms: ["presets", "models", "effort", "default", "launch"],
		control: { kind: "presets" },
		fallback: fixed(null),
		apply: (config, value) => {
			config.presets = value === null ? null : presets(value);
		},
		example: null,
		note: "",
	},
	{
		key: ["warn_long_shortlist"],
		section: "Harnesses",
		label: "Warn about long shortlists",
		description: "Agents see every entry. More than 10 can crowd their choice, and Settings says so while this is on.",
		synonyms: ["presets", "warning"],
		control: { kind: "bool" },
		fallback: fixed(true),
		apply: (config, value) => {
			if (typeof value !== "boolean") throw new Error(`must be true or false, got ${JSON.stringify(value)}`);
			config.warnLongShortlist = value;
		},
		example: true,
		note: "Settings warns once the shortlist passes 10 entries",
	},
	{
		key: ["operator", "instructions"],
		section: "Operators",
		label: "Instructions",
		description: `Yours, added after the ones swb ships, in the AGENTS.md every Operator reads when it starts. Up to ${OPERATOR_INSTRUCTIONS_MAX.toLocaleString("en-US")} characters.`,
		synonyms: ["agents.md", "claude.md", "prompt", "system", "rules", "dispatcher", "capcom", "custom"],
		control: { kind: "prose", max: OPERATOR_INSTRUCTIONS_MAX },
		fallback: fixed(""),
		apply: (config, value) => {
			if (typeof value !== "string") throw new Error(`must be a string, got ${JSON.stringify(value)}`);
			if (value.length > OPERATOR_INSTRUCTIONS_MAX)
				throw new Error(
					`must be ${OPERATOR_INSTRUCTIONS_MAX.toLocaleString("en-US")} characters or fewer, got ${value.length.toLocaleString("en-US")}`,
				);
			config.operatorInstructions = value;
		},
		example: "Prefer Codex for anything in Rust.",
		note: `after swb's own, in every Operator's AGENTS.md; up to ${OPERATOR_INSTRUCTIONS_MAX.toLocaleString("en-US")} characters`,
	},
	{
		key: ["dirs", "scan"],
		section: "Directories",
		label: "Scan for repositories in",
		description: "n offers the git checkouts and worktrees beneath these, beside every directory a session has used.",
		synonyms: ["code", "projects", "folders", "picker", "roots"],
		control: { kind: "paths" },
		fallback: fixed([]),
		apply: (config, value) => {
			config.dirs.scan = paths(value);
		},
		example: ["~/code"],
		note: "git checkouts and their worktrees beneath these; none by default",
	},
	{
		key: ["dirs", "depth"],
		section: "Directories",
		label: "Scan depth",
		description: "How many directories deep to look beneath each scan root, 1 to 10. A checkout is never entered.",
		synonyms: ["levels", "deep", "nested"],
		control: { kind: "int", min: 1, max: 10 },
		fallback: fixed(2),
		apply: (config, value) => {
			if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10)
				throw new Error(`must be 1 to 10, got ${JSON.stringify(value)}`);
			config.dirs.depth = value as number;
		},
		example: 2,
		note: "how far beneath each to look, 1 to 10; a checkout is never entered",
	},
	{
		key: ["dirs", "include"],
		section: "Directories",
		label: "Always offer",
		description: "Directories n always offers, git or not.",
		synonyms: ["notes", "pin", "add"],
		control: { kind: "paths" },
		fallback: fixed([]),
		apply: (config, value) => {
			config.dirs.include = paths(value);
		},
		example: ["~/notes"],
		note: "always offered, git or not",
	},
	{
		key: ["dirs", "exclude"],
		section: "Directories",
		label: "Never offer",
		description: "Like .gitignore: a bare name at any depth, a pattern with a slash under each scan root, or one ~/ or / path.",
		synonyms: ["ignore", "hide", "skip"],
		control: { kind: "paths" },
		fallback: fixed([]),
		apply: (config, value) => {
			config.dirs.exclude = paths(value);
		},
		example: ["dotfiles"],
		note: "like .gitignore: a bare name anywhere, a pattern with a slash under each scan root, or one ~/ path",
	},
	{
		key: ["dirs", "sort"],
		section: "Directories",
		label: "Sort directories by",
		description: "The order n lists directories in before you type.",
		synonyms: ["order", "recent"],
		control: {
			kind: "enum",
			choices: [
				{ value: "name", about: "alphabetically" },
				{ value: "recent", about: "latest session activity first" },
			],
		},
		fallback: fixed("name"),
		apply: (config, value) => {
			config.dirs.sort = oneOf(["name", "recent"], value);
		},
		example: "name",
		note: '"recent" puts directories with the latest session activity first',
	},
	{
		key: ["keys", "prefix"],
		section: "Keys & commands",
		label: "Prefix key",
		description: "The key before every Deck command, from any pane: prefix h for the list, prefix ? for every key.",
		synonyms: ["chord", "leader", "tmux", "shortcut", "keybinding"],
		control: { kind: "chord" },
		fallback: fixed("M-a"),
		apply: (config, value) => {
			config.prefix = string(value);
		},
		example: "M-a",
		note: "as tmux spells it",
	},
	{
		key: ["editor"],
		section: "Keys & commands",
		label: "Editor",
		description: "The command each directory's Editor runs. An nvim Editor also gets ctrl-hjkl across the Deck's panes.",
		synonyms: ["vim", "nvim", "helix", "code"],
		control: { kind: "command" },
		fallback: () =>
			process.env.EDITOR ? { value: process.env.EDITOR, from: "from $EDITOR" } : { value: "nvim", from: "$EDITOR is unset" },
		apply: (config, value) => {
			config.editor = string(value);
		},
		example: "nvim",
		note: "defaults to $EDITOR",
	},
	{
		key: ["clipboard"],
		section: "Keys & commands",
		label: "Clipboard command",
		description: "y and Y pipe what they copy into this command.",
		synonyms: ["copy", "paste", "wl-copy", "xclip", "pbcopy"],
		control: { kind: "command" },
		fallback: defaultClipboard,
		apply: (config, value) => {
			config.clipboard = string(value);
		},
		example: "wl-copy",
		note: "defaults to wl-copy, else xclip, else pbcopy",
	},
];

/** A setting by its dotted key. */
export function setting(key: string): Setting {
	const found = SETTINGS.find((s) => s.key.join(".") === key);
	if (!found) throw new Error(`no setting ${key}`);
	return found;
}

const PRESET_KEYS = ["harness", "provider", "model", "effort", "agent", "use", "default"];

function presets(value: unknown): Preset[] {
	if (!Array.isArray(value)) throw new Error("must be a list of [[presets]] tables");
	const out = value.map((raw, i): Preset => {
		const at = (key: string, message: string) => new ConfigProblem(["presets", String(i), key], message);
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ConfigProblem(["presets", String(i)], "must be a table");
		const entry = raw as Record<string, unknown>;
		for (const key of Object.keys(entry)) if (!PRESET_KEYS.includes(key)) throw at(key, `unknown key presets.${key}`);
		const fail = (key: string) => (error: unknown) => {
			throw at(key, `presets.${key} ${(error as Error).message}`);
		};
		let harness: Harness = "pi";
		try {
			harness = oneOf(HARNESSES, entry.harness);
		} catch (error) {
			fail("harness")(error);
		}
		if (harness !== "claude" && entry.agent !== undefined) throw at("agent", "only a Claude Code preset runs as an agent");
		const agent = entry.agent !== undefined;
		for (const key of ["model", "effort"])
			if (agent && entry[key] !== undefined) throw at(key, `an agent preset's ${key} comes from the agent`);
		let model: string | null = null;
		let effort: Effort | null = null;
		if (!agent) {
			try {
				model = string(entry.model);
			} catch (error) {
				fail("model")(error);
			}
			try {
				if (entry.effort !== undefined) effort = oneOf(HARNESS_EFFORTS[harness], entry.effort);
			} catch (error) {
				fail("effort")(error);
			}
		}
		if (harness === "pi" && entry.provider === undefined) throw at("harness", "a pi preset needs a provider");
		if (harness !== "pi" && entry.provider !== undefined) throw at("provider", "only a pi preset has a provider");
		const optional = (key: string) => {
			if (entry[key] === undefined) return null;
			try {
				return string(entry[key]);
			} catch (error) {
				return fail(key)(error);
			}
		};
		if (entry.use !== undefined && typeof entry.use !== "string") throw at("use", "presets.use must be a string");
		if (entry.default !== undefined && typeof entry.default !== "boolean") throw at("default", "presets.default must be true or false");
		return {
			harness,
			provider: optional("provider"),
			model,
			effort,
			agent: optional("agent"),
			use: (entry.use as string | undefined) ?? "",
			default: entry.default === true,
		};
	});
	if (out.filter((p) => p.default).length > 1) throw new Error("can have only one default");
	out.forEach((p, i) => {
		const twin = out.findIndex((q) => sameLaunch(p, q));
		if (twin !== i) throw new ConfigProblem(["presets", String(i)], `presets ${twin + 1} and ${i + 1} start the same thing`);
	});
	return out;
}

/** Two presets that start the same session; the shortlist has no names, so this is how they're told apart. */
export function sameLaunch(a: Preset, b: Preset): boolean {
	return a.harness === b.harness && a.provider === b.provider && a.model === b.model && a.effort === b.effort && a.agent === b.agent;
}

/** A bad value somewhere in the file, by its TOML path. */
export class ConfigProblem extends Error {
	constructor(
		readonly path: string[],
		message: string,
	) {
		super(message);
	}
}

/** What's wrong with config.toml, and where; a new swb process stops on it, a running Deck reports it. */
export class ConfigError extends SwbError {
	constructor(
		readonly file: string,
		readonly line: number | null,
		readonly problem: string,
	) {
		super(`${file}${line === null ? "" : `:${line}`}: ${problem}`);
	}
}

export function configPath(): string {
	return join(configDir(), "config.toml");
}

function defaults(): Config {
	const config = {} as Config;
	config.dirs = { scan: [], depth: 2, exclude: [], include: [], sort: "name" };
	for (const s of SETTINGS) {
		s.apply(config, s.fallback().value);
	}
	return config;
}

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = row[0] as number;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const next = Math.min((row[j] as number) + 1, (row[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = row[j] as number;
			row[j] = next;
		}
	}
	return row[b.length] as number;
}

function unknownKey(path: string[]): ConfigProblem {
	const name = path.join(".");
	const near = SETTINGS.map((s) => s.key.join(".")).find((key) => distance(key, name) <= 2);
	return new ConfigProblem(path, `unknown key ${name}${near ? ` (did you mean ${near}?)` : ""}`);
}

/** The config a parsed file makes; throws a ConfigProblem naming the key at fault. */
export function fromRaw(raw: Record<string, unknown>): Config {
	const config = defaults();
	for (const [key, value] of Object.entries(raw)) {
		const s = SETTINGS.find((x) => x.key.length === 1 && x.key[0] === key);
		if (s) {
			try {
				s.apply(config, value);
			} catch (error) {
				if (error instanceof ConfigProblem) throw error;
				throw new ConfigProblem([key], `${key} ${(error as Error).message}`);
			}
			continue;
		}
		const table = SETTINGS.filter((x) => x.key.length === 2 && x.key[0] === key);
		if (table.length === 0) throw unknownKey([key]);
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigProblem([key], `${key} must be a table`);
		for (const [sub, subValue] of Object.entries(value as Record<string, unknown>)) {
			const found = table.find((x) => x.key[1] === sub);
			if (!found) throw unknownKey([key, sub]);
			try {
				found.apply(config, subValue);
			} catch (error) {
				throw new ConfigProblem([key, sub], `${key}.${sub} ${(error as Error).message}`);
			}
		}
	}
	return config;
}

/** Where a key sits in the file: the line of `key =`, inside its table or its nth [[array]] entry. */
export function lineOf(text: string, path: string[]): number | null {
	const lines = text.split("\n");
	const [first, ...rest] = path;
	const index = rest[0] !== undefined && /^\d+$/.test(rest[0]) ? Number(rest[0]) : null;
	const leaf = (index === null ? rest[0] : rest[1]) ?? null;
	let table = "";
	let entry = -1;
	let header: number | null = null;
	for (const [i, line] of lines.entries()) {
		const head = /^\s*\[(\[)?\s*([^\]]+?)\s*\]/.exec(line);
		if (head) {
			table = head[2] as string;
			if (head[1] && table === first) entry++;
			if (table === first && (index === null || entry === index)) header = i + 1;
			continue;
		}
		const key = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line)?.[1];
		if (!key) continue;
		const inside = table === first && (index === null || entry === index);
		if (table === "" && rest.length === 0 && key === first) return i + 1;
		if (table === "" && leaf !== null && index === null && key === `${first}.${leaf}`) return i + 1;
		if (inside && leaf !== null && key === leaf) return i + 1;
	}
	return header;
}

/** The file as written, parsed, and the config it makes. */
export type Loaded = { text: string; raw: Record<string, unknown>; config: Config };

/** Reads config.toml; anything wrong with it is a ConfigError with the line at fault. */
export function readConfig(): Loaded {
	const path = configPath();
	let text = "";
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ConfigError(path, null, (error as Error).message);
	}
	return checkConfig(text);
}

/** Parses and validates config text, as Settings does before every write. */
export function checkConfig(text: string): Loaded {
	const path = configPath();
	let raw: Record<string, unknown>;
	try {
		raw = parse(text);
	} catch (error) {
		if (error instanceof TomlError) throw new ConfigError(path, error.line, error.message.split("\n")[0] as string);
		throw error;
	}
	try {
		return { text, raw, config: fromRaw(raw) };
	} catch (error) {
		if (!(error instanceof ConfigProblem)) throw error;
		throw new ConfigError(path, lineOf(text, error.path), error.message);
	}
}

export function loadConfig(): Config {
	return readConfig().config;
}
