import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HARNESSES, type Harness, pidAlive, shortlistPath, stateDir } from "@swb/shared";
import { harnessName } from "@swb/shared/mailbox";
import { type Config, EFFORTS, type Effort, HARNESS_EFFORTS, loadConfig, type Preset } from "./config.ts";
import { SwbError } from "./errors.ts";
import { loginShell, newer } from "./sessions.ts";

// What each harness can start, as the login shell that launches sessions finds it: whether it's installed and new
// enough, the models it offers, and its own short list of them, from which the automatic shortlist is made.

/** The oldest release whose line swb carries. */
export const MIN_VERSION: Record<Harness, string> = { pi: "1.2.0", claude: "2.1.300", codex: "0.149.0" };

/** `problem` says why it can't start; null when it can. */
export type HarnessStatus = { version: string | null; problem: string | null };

/** One model or agent a harness offers, as the add search lists it. */
export type Model = {
	harness: Harness;
	provider: string | null;
	/** Null for an agent, whose own definition sets its model and effort. */
	model: string | null;
	agent: string | null;
	/** Where the search lists it under its harness: a provider, aliases, models, or agents. */
	group: string;
	note: string;
	/** The effort it runs at when none is asked for. */
	effort: Effort | null;
	efforts: Effort[];
	/** What the harness starts when given no model at all. */
	isDefault: boolean;
	/** Codex lists a newer model in its place: still startable, but no longer offered. */
	superseded: boolean;
};

export type Catalog = {
	at: number;
	status: Record<Harness, HarnessStatus>;
	/** Everything the add search offers. */
	models: Record<Harness, Model[]>;
	/** The harness's own short list, in its order, which the automatic shortlist takes from. */
	curated: Record<Harness, Model[]>;
	/** Why a harness's models couldn't be read. */
	errors: Record<Harness, string | null>;
	/** When each harness's models were last read; 0 when they never were. */
	listedAt: Record<Harness, number>;
};

/** Whether a model matches every word of a search, by harness, provider, model, agent, or note. Superseded ones never do. */
export function searchMatch(m: Model, words: string[]): boolean {
	const text = `${m.harness} ${m.provider ?? ""} ${m.group} ${m.model ?? ""} ${m.agent ?? ""} ${m.note}`.toLowerCase();
	return !m.superseded && words.every((w) => text.includes(w));
}

/** The efforts a preset of this model can start at: first, when its harness doesn't say what it defaults to, its default. */
export function effortLevels(m: Model): (Effort | null)[] {
	return m.effort === null && m.efforts.length > 0 ? [null, ...m.efforts] : m.efforts;
}

/** Medium adds nothing, nor does a harness's own default; each level away from medium adds a step. */
export function effortMark(effort: Effort | null): string {
	if (effort === null) return "";
	return { off: "⁻³", minimal: "⁻²", low: "⁻¹", medium: "", high: "²", xhigh: "³", max: "⁴", ultra: "⁵" }[effort];
}

/**
 * Runs a command the way sessions launch: through the login shell, interactive, so its PATH is theirs. In a session of
 * its own: an interactive shell takes the foreground of any terminal it can reach, and the Deck's roster, reading
 * that terminal, would get EIO.
 */
async function shell(command: string, input?: string, timeoutMs = 20_000): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn([loginShell(), "-lic", command], {
		cwd: homedir(),
		detached: true,
		stdin: input === undefined ? "ignore" : new Blob([input]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => stop(proc), timeoutMs);
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	clearTimeout(timer);
	return { code, out, err };
}

/**
 * Stops everything a `shell` started. Its `exec` only replaces the shell when the harness is a binary: a zsh function
 * runs it as a child instead, and an interactive zsh ignores SIGTERM, so the whole session's group is killed.
 */
function stop(proc: Bun.Subprocess): void {
	try {
		process.kill(-proc.pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

const BINARIES: Record<Harness, string> = { pi: "pi", claude: "claude", codex: "codex" };

async function detect(harness: Harness): Promise<HarnessStatus> {
	const bin = BINARIES[harness];
	const result = await shell(`command -v ${bin} >/dev/null 2>&1 || exit 127; exec ${bin} --version`);
	if (result.code === 127) return { version: null, problem: "not found on PATH" };
	const version = /(\d+\.\d+\.\d+)/.exec(result.out)?.[1] ?? null;
	if (result.code !== 0 || !version) {
		const said = (result.err.trim() || result.out.trim()).split("\n").at(-1) ?? "";
		return { version, problem: `${bin} --version failed${said ? `: ${said}` : ""}` };
	}
	if (newer(MIN_VERSION[harness], version))
		return { version, problem: `${version} installed, needs ${MIN_VERSION[harness].replace(/\.0$/, "")}` };
	return { version, problem: null };
}

function readJson(path: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error(`${path}: ${(error as Error).message}`);
	}
}

/**
 * Starts a harness's own server through the login shell, writes it `lines`, and returns the first line it writes back
 * that `pick` takes. The server answers and then waits for more, so it's stopped once that line is in.
 */
async function serverReply<T>(command: string, lines: object[], pick: (message: Record<string, unknown>) => T | undefined): Promise<T> {
	const proc = Bun.spawn([loginShell(), "-lic", command], {
		cwd: homedir(),
		detached: true,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	proc.stdin.write(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	proc.stdin.flush();
	let reply: T | undefined;
	const timer = setTimeout(() => stop(proc), 30_000);
	let buffered = "";
	const decoder = new TextDecoder();
	for await (const chunk of proc.stdout) {
		buffered += decoder.decode(chunk, { stream: true });
		reply = buffered
			.split("\n")
			.filter((line) => line.startsWith("{"))
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as Record<string, unknown>];
				} catch {
					return [];
				}
			})
			.map(pick)
			.find((r) => r !== undefined);
		if (reply !== undefined) break;
	}
	clearTimeout(timer);
	stop(proc);
	if (reply === undefined) {
		const err = (await new Response(proc.stderr).text()).trim();
		throw new Error(`${command.replace(/^exec /, "")} gave no answer${err ? `: ${err.split("\n").at(-1)}` : ""}`);
	}
	return reply;
}

type ClaudeModel = {
	value: string;
	resolvedModel: string;
	description: string;
	supportsEffort?: boolean;
	supportedEffortLevels?: string[];
};
type ClaudeInit = { models: ClaudeModel[]; agents: { name: string; description: string }[] };

/**
 * Claude Code's own list, from the initialize request its SDK makes: the models this account may use, its default
 * among them, and its agents. Hooks and MCP servers stay off, so none of the user's run. It never says what effort a
 * model runs at by default, so that's left to Claude Code.
 */
async function claudeModels(): Promise<Model[]> {
	const reply = await serverReply(
		`exec claude -p --input-format stream-json --output-format stream-json --verbose --settings '{"disableAllHooks":true}' --strict-mcp-config --no-session-persistence`,
		[{ type: "control_request", request_id: "swb", request: { subtype: "initialize" } }],
		(m) => (m.type === "control_response" ? (m.response as { response?: ClaudeInit; error?: string }) : undefined),
	);
	if (reply.error || !reply.response) throw new Error(`claude initialize: ${reply.error ?? "no response"}`);
	const init = reply.response;
	if (init.models.length === 0) throw new Error("claude listed no models");
	const fallback = init.models.find((m) => m.value === "default")?.resolvedModel;
	const models = init.models
		.filter((m) => m.value !== "default")
		.map(
			(m, i, all): Model => ({
				harness: "claude",
				provider: null,
				model: m.value,
				agent: null,
				group: "models",
				note: m.description,
				effort: null,
				efforts:
					m.supportsEffort === false
						? []
						: (m.supportedEffortLevels?.filter((e): e is Effort => EFFORTS.includes(e as Effort)) ?? HARNESS_EFFORTS.claude),
				isDefault: all.findIndex((n) => n.resolvedModel === fallback) === i,
				superseded: false,
			}),
		);
	const agents = init.agents.map(
		(a): Model => ({
			harness: "claude",
			provider: null,
			model: null,
			agent: a.name,
			group: "agents",
			note: a.description,
			effort: null,
			efforts: [],
			isDefault: false,
			superseded: false,
		}),
	);
	return [...models, ...agents];
}

type CodexModel = {
	id: string;
	description: string;
	hidden: boolean;
	isDefault: boolean;
	upgrade: string | null;
	defaultReasoningEffort: string;
	supportedReasoningEfforts: { reasoningEffort: string }[];
};

/** A Codex the user starts at the same moment can still hold its state db, so a failure is retried. */
async function retried<T>(find: () => Promise<T>, tries = 3): Promise<T> {
	for (let i = 1; ; i++) {
		try {
			return await find();
		} catch (error) {
			if (i === tries) throw error;
			await Bun.sleep(500 * i);
		}
	}
}

/** Codex's own list, from a throwaway app-server: what this account may use, superseded models marked. */
async function codexModels(): Promise<Model[]> {
	const lines = [
		{ jsonrpc: "2.0", id: 0, method: "initialize", params: { clientInfo: { name: "swb", title: null, version: "0" }, capabilities: {} } },
		{ jsonrpc: "2.0", method: "initialized" },
		{ jsonrpc: "2.0", id: 1, method: "model/list", params: {} },
	];
	type Reply = { result?: { data: CodexModel[] }; error?: { message: string } };
	const reply = await serverReply("exec codex app-server", lines, (m) => (m.id === 1 ? (m as Reply) : undefined));
	if (reply.error || !reply.result) throw new Error(`codex model/list: ${reply.error?.message ?? "no result"}`);
	return reply.result.data
		.filter((m) => !m.hidden)
		.map((m) => {
			const efforts = m.supportedReasoningEfforts.map((e) => e.reasoningEffort).filter((e): e is Effort => EFFORTS.includes(e as Effort));
			return {
				harness: "codex",
				provider: null,
				model: m.id,
				agent: null,
				group: "models",
				note: m.description,
				effort: EFFORTS.includes(m.defaultReasoningEffort as Effort) ? (m.defaultReasoningEffort as Effort) : "medium",
				efforts,
				isDefault: m.isDefault,
				superseded: m.upgrade !== null,
			};
		});
}

function piSettings(): Record<string, unknown> {
	const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return readJson(join(dir, "settings.json")) ?? {};
}

/** pi's catalog, from `pi --list-models`: every model a provider it's logged into offers. */
async function piModels(): Promise<Model[]> {
	const settings = piSettings();
	const level = EFFORTS.includes(settings.defaultThinkingLevel as Effort) ? (settings.defaultThinkingLevel as Effort) : "medium";
	const result = await shell("exec pi --list-models", undefined, 30_000);
	if (result.code !== 0) throw new Error(`pi --list-models: ${result.err.trim().split("\n").at(-1) ?? `exited ${result.code}`}`);
	const rows = result.out.split("\n").map((line) => line.trim().split(/\s{2,}/));
	const header = rows.findIndex((cols) => cols[0] === "provider" && cols[1] === "model");
	if (header === -1) return [];
	return rows.slice(header + 1).flatMap((cols): Model[] => {
		const [provider, model, , , thinking] = cols;
		if (!provider || !model) return [];
		const efforts = thinking === "yes" ? HARNESS_EFFORTS.pi : (["off"] as Effort[]);
		return [
			{
				harness: "pi",
				provider,
				model,
				agent: null,
				group: provider,
				note: "",
				effort: efforts.includes(level) ? level : "off",
				efforts,
				isDefault: provider === settings.defaultProvider && model === settings.defaultModel,
				superseded: false,
			},
		];
	});
}

/** pi's own list: its default, then its Ctrl+P cycle. Patterns that aren't one model can't be a preset. */
function piCurated(): Model[] {
	const settings = piSettings();
	const level = EFFORTS.includes(settings.defaultThinkingLevel as Effort) ? (settings.defaultThinkingLevel as Effort) : "medium";
	const entry = (provider: string, model: string, effort: Effort, isDefault: boolean): Model => ({
		harness: "pi",
		provider,
		model,
		agent: null,
		group: provider,
		note: "",
		effort,
		efforts: HARNESS_EFFORTS.pi,
		isDefault,
		superseded: false,
	});
	const out: Model[] = [];
	if (typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string")
		out.push(entry(settings.defaultProvider, settings.defaultModel, level, true));
	const enabled = Array.isArray(settings.enabledModels) ? settings.enabledModels : [];
	for (const pattern of enabled) {
		if (typeof pattern !== "string" || /[*?[]/.test(pattern)) continue;
		const match = /^([^/:]+)\/([^:]+)(?::(\w+))?$/.exec(pattern);
		if (!match) continue;
		const [provider, model, suffix] = [match[1] as string, match[2] as string, match[3]];
		if (out.some((m) => m.provider === provider && m.model === model)) continue;
		out.push(entry(provider, model, EFFORTS.includes(suffix as Effort) ? (suffix as Effort) : level, false));
	}
	return out;
}

/** pi's own list as its catalog describes each model: a model that doesn't reason takes only off. */
function listed(curated: Model[], catalog: Model[]): Model[] {
	return curated.map((m) => {
		const found = catalog.find((c) => c.provider === m.provider && c.model === m.model);
		if (!found) return m;
		const effort = m.effort !== null && found.efforts.includes(m.effort) ? m.effort : (found.efforts.at(-1) as Effort);
		return { ...m, efforts: found.efforts, effort };
	});
}

/** Claude Code's and Codex's own short lists are their models in their order, past the superseded ones. */
function curated(models: Model[]): Model[] {
	return models.filter((m) => m.agent === null && !m.superseded);
}

const catalogPath = () => join(stateDir(), "catalog.json");

export function readCatalog(): Catalog | null {
	try {
		return JSON.parse(readFileSync(catalogPath(), "utf8")) as Catalog;
	} catch {
		return null;
	}
}

function writeAtomic(path: string, text: string): void {
	mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, text);
	renameSync(temp, path);
}

const lockPath = () => join(stateDir(), "catalog.lock");
const LOCK_WAIT_MS = 3 * 60_000;

/**
 * Makes this the only swb reading model lists until the returned release: Codex app-servers starting together on one
 * CODEX_HOME fail to open its state db. The lock holds its owner's pid, so one left by a process that died is taken over.
 */
async function lockCatalog(): Promise<() => void> {
	mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
	const path = lockPath();
	const mine = `${process.pid} ${crypto.randomUUID()}`;
	const until = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			writeFileSync(path, mine, { flag: "wx", mode: 0o600 });
			return () => {
				if (readFileSync(path, "utf8") === mine) rmSync(path);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let holder = 0;
		try {
			holder = Number(readFileSync(path, "utf8").split(" ")[0]);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			continue;
		}
		// An empty file is a lock being written.
		if (holder > 0 && !pidAlive(holder)) rmSync(path, { force: true });
		else if (Date.now() > until)
			throw new SwbError(`swb ${holder} has been reading model lists for 3 minutes; remove ${path} if it's stuck`);
		else await Bun.sleep(100);
	}
}

/**
 * Finds what each harness can start. Statuses come back first, through `onStatus`, since the slow part is the model
 * lists: `previous` keeps its lists unless `models` asks for new ones.
 */
export async function discover(
	previous: Catalog | null,
	models: boolean,
	onStatus: (provisional: Catalog) => void = () => {},
): Promise<Catalog> {
	const asked = Date.now();
	const statuses = await Promise.all(HARNESSES.map(detect));
	const status = Object.fromEntries(HARNESSES.map((h, i) => [h, statuses[i]])) as Record<Harness, HarnessStatus>;
	// pi's own list is a file; the model lists need their harnesses, so they stand as last found until then.
	onStatus({
		at: Date.now(),
		status,
		models: { claude: previous?.models.claude ?? [], pi: previous?.models.pi ?? [], codex: previous?.models.codex ?? [] },
		curated: {
			claude: curated(previous?.models.claude ?? []),
			codex: curated(previous?.models.codex ?? []),
			pi: listed(piCurated(), previous?.models.pi ?? []),
		},
		errors: { pi: null, claude: null, codex: null },
		listedAt: { claude: previous?.listedAt.claude ?? 0, pi: previous?.listedAt.pi ?? 0, codex: previous?.listedAt.codex ?? 0 },
	});
	const lists: Record<Harness, Model[]> = { pi: [], claude: [], codex: [] };
	const errors: Record<Harness, string | null> = { pi: null, claude: null, codex: null };
	const listedAt: Record<Harness, number> = { pi: 0, claude: 0, codex: 0 };
	const wanted = HARNESSES.filter((h) => status[h].problem === null);
	const usable = (c: Catalog | null, h: Harness, since: number) =>
		c !== null && c.errors[h] === null && c.models[h].length > 0 && c.listedAt[h] >= since;
	const kept = models ? null : previous;
	const take = (from: Catalog, h: Harness) => {
		lists[h] = from.models[h];
		listedAt[h] = from.listedAt[h];
	};
	const release = wanted.every((h) => usable(kept, h, 0)) ? () => {} : await lockCatalog();
	try {
		// Lists another swb read after this one was asked are as new as any it would read itself.
		const latest = readCatalog();
		await Promise.all(
			wanted.map(async (h) => {
				if (usable(latest, h, asked)) return take(latest as Catalog, h);
				if (usable(kept, h, 0)) return take(kept as Catalog, h);
				try {
					lists[h] = h === "pi" ? await piModels() : h === "claude" ? await claudeModels() : await retried(codexModels);
					listedAt[h] = Date.now();
				} catch (error) {
					errors[h] = (error as Error).message;
				}
			}),
		);
		const catalog: Catalog = {
			at: Date.now(),
			status,
			models: lists,
			curated: { claude: curated(lists.claude), codex: curated(lists.codex), pi: listed(piCurated(), lists.pi) },
			errors,
			listedAt,
		};
		writeAtomic(catalogPath(), JSON.stringify(catalog));
		return catalog;
	} finally {
		release();
	}
}

/** What a launch passes its harness; null leaves that to the harness's own default. */
export type LaunchTarget = { harness: Harness; provider: string | null; model: string | null; effort: Effort | null; agent: string | null };

/** A shortlist entry as everything that offers it sees it: what it writes, what it launches, and whether it can. */
export type Choice = {
	preset: Preset;
	launch: LaunchTarget;
	note: string;
	/** Why it can't start now; null when it can. */
	reason: string | null;
};

const PER_HARNESS: Record<Harness, number> = { claude: 4, codex: 4, pi: 2 };
const TURNS: Harness[] = ["claude", "codex", "pi"];

/** Why a harness can't start a new session now, if it can't. */
export function blocked(config: Config, catalog: Catalog | null, harness: Harness): string | null {
	if (!config.harnesses.includes(harness)) return `${harnessName(harness)} is turned off in Settings`;
	const problem = catalog?.status[harness].problem;
	return problem ? `${harnessName(harness)}: ${problem}` : null;
}

/**
 * The shortlist: the one written in config.toml, or, with none, the harnesses' own short lists taking turns, claude →
 * codex → pi, up to 4, 4, and 2. An automatic entry launches as its harness would on its own: its default model with no
 * flags, and no effort, which is shown as the harness's own default. Null until the harnesses have been found.
 */
export function shortlist(config: Config, catalog: Catalog | null): Choice[] | null {
	if (config.presets) {
		const list = config.presets.map(
			(preset): Choice => ({
				preset,
				launch: { harness: preset.harness, provider: preset.provider, model: preset.model, effort: preset.effort, agent: preset.agent },
				note: preset.use,
				reason: blocked(config, catalog, preset.harness) ?? missing(catalog, preset),
			}),
		);
		if (list.length > 0 && !list.some((c) => c.preset.default))
			(list[0] as Choice).preset = { ...(list[0] as Choice).preset, default: true };
		return list;
	}
	if (!catalog) return null;
	const lists = TURNS.filter((h) => blocked(config, catalog, h) === null).map((h) => catalog.curated[h].slice(0, PER_HARNESS[h]));
	const out: Choice[] = [];
	for (let i = 0; lists.some((list) => i < list.length); i++) {
		for (const list of lists) {
			const m = list[i];
			if (!m) continue;
			out.push({
				preset: {
					harness: m.harness,
					provider: m.provider,
					model: m.model,
					effort: m.effort,
					agent: m.agent,
					use: m.note,
					default: out.length === 0,
				},
				launch: {
					harness: m.harness,
					provider: m.isDefault ? null : m.provider,
					model: m.isDefault ? null : m.model,
					effort: null,
					agent: m.agent,
				},
				note: m.note,
				reason: null,
			});
		}
	}
	return out;
}

/** A written preset whose model its harness no longer lists. Claude Code takes full ids it doesn't list, so its are never missing. */
function missing(catalog: Catalog | null, preset: Preset): string | null {
	if (!catalog || preset.harness === "claude" || catalog.errors[preset.harness] !== null) return null;
	const listed = catalog.models[preset.harness];
	if (listed.length === 0) return null;
	if (listed.some((m) => m.model === preset.model && m.provider === preset.provider)) return null;
	return `${preset.provider ? `${preset.provider}/` : ""}${preset.model} isn't among ${harnessName(preset.harness)}'s models`;
}

/** The default first, then the rest in order, wrapping: the order n's Tab and a launch's fallback both take. */
export function fromDefault(choices: Choice[]): Choice[] {
	const at = Math.max(
		0,
		choices.findIndex((c) => c.preset.default),
	);
	return [...choices.slice(at), ...choices.slice(0, at)];
}

/**
 * What a launch that names no preset starts: the default, else the next that can start; with none, the default's
 * harness on its own defaults. When not even that harness can start, the reason.
 */
export function defaultLaunch(config: Config, catalog: Catalog | null, choices: Choice[]): LaunchTarget | string {
	const ready = fromDefault(choices).find((c) => c.reason === null);
	if (ready) return ready.launch;
	const harness = choices.find((c) => c.preset.default)?.preset.harness ?? TURNS.find((h) => blocked(config, catalog, h) === null);
	if (!harness) return "no harness can start a session: see Settings";
	const reason = blocked(config, catalog, harness);
	return reason ?? { harness, provider: null, model: null, effort: null, agent: null };
}

/** How a preset reads in a list: its model or agent, and its effort as a superscript. */
export function presetLabel(preset: Preset): string {
	return preset.agent ?? `${preset.model?.split("/").at(-1)}${effortMark(preset.effort)}`;
}

/** Labels for a set of presets, each prefixed with its harness only where two would otherwise read the same. */
export function presetLabels(presets: Preset[]): string[] {
	const plain = presets.map(presetLabel);
	return plain.map((label, i) =>
		plain.indexOf(label) !== plain.lastIndexOf(label) ? `${(presets[i] as Preset).harness}:${label}` : label,
	);
}

/** A preset as agents read it: its fields as session_launch takes them, then its note. */
function presetLine(c: Choice): string {
	const p = c.preset;
	const fields = p.agent ? [p.harness, `agent ${p.agent}`] : [p.harness, p.provider ? `${p.provider}/${p.model}` : p.model, p.effort];
	return `- ${fields.filter(Boolean).join(", ")}${c.note ? `: ${c.note}` : ""}`;
}

/** The shortlist as agents read it in session_launch's description, written for every line to pick up. */
export function writeGuide(choices: Choice[] | null): void {
	if (choices === null) return;
	const lines = choices.filter((c) => c.reason === null).map(presetLine);
	const text = lines.length === 0 ? "" : `Presets (harness, then model and effort, or agent):\n${lines.join("\n")}`;
	const path = shortlistPath();
	if (existsSync(path) && readFileSync(path, "utf8") === text) return;
	writeAtomic(path, text);
}

const STATUS_FRESH_MS = 5 * 60_000;

/** The last catalog, found again when its statuses are older than a few minutes. */
export async function currentCatalog(): Promise<Catalog> {
	const cached = readCatalog();
	if (cached && Date.now() - cached.at < STATUS_FRESH_MS && HARNESSES.every((h) => cached.errors[h] === null)) return cached;
	return discover(cached, false);
}

/** A launch's choice of preset: each field given must match; an omitted agent means a preset without one, and an agent's has no model or effort. */
export type Ask = { harness: Harness | null; model: string | null; effort: string | null; agent: string | null };

/** The session a launch comes from: its harness, and the model and effort it runs on now. */
export type Caller = { harness: Harness; model: string | null; effort: string | null };

/** Whether a preset is the model a session runs on: Claude Code records the full name behind an alias like opus. */
function runsOn(p: Preset, model: string): boolean {
	if (p.model === null) return false;
	if (p.harness === "pi" && p.provider) return model === `${p.provider}/${p.model}`;
	if (p.harness === "claude") return model === p.model || model.startsWith(`claude-${p.model.replace(/\[1m\]$/, "")}-`);
	return model === p.model;
}

/** The preset nearest what a caller runs: its model and effort, else its model, else its harness's first model. */
function carried(choices: Choice[], caller: Caller): LaunchTarget | null {
	const ready = fromDefault(choices).filter((c) => c.reason === null && c.preset.harness === caller.harness);
	const model = caller.model;
	const same = model === null ? [] : ready.filter((c) => runsOn(c.preset, model));
	const match = same.find((c) => c.preset.effort === caller.effort) ?? same[0] ?? ready.find((c) => c.preset.agent === null);
	return match?.launch ?? null;
}

/**
 * What a launch starts: the first preset, from the default on, matching what it asks. Asking nothing, the preset nearest
 * what its caller runs now; with no caller, or none on its harness, the default.
 */
export function resolveLaunch(config: Config, catalog: Catalog, choices: Choice[], ask: Ask, caller: Caller | null): LaunchTarget {
	if (ask.harness !== null || ask.model !== null || ask.effort !== null || ask.agent !== null) {
		const matches = fromDefault(choices).filter(({ preset: p }) => {
			const model = p.provider && p.model ? `${p.provider}/${p.model}` : p.model;
			return (
				(ask.harness === null || p.harness === ask.harness) &&
				(ask.model === null || (p.model !== null && (ask.model === model || ask.model === p.model))) &&
				(ask.effort === null || p.effort === ask.effort) &&
				p.agent === ask.agent
			);
		});
		const ready = matches.find((c) => c.reason === null);
		if (ready) return ready.launch;
		if (matches[0]) throw new SwbError(`that preset can't start: ${matches[0].reason}`);
		const asked = [ask.harness, ask.model, ask.effort, ask.agent && `agent ${ask.agent}`].filter(Boolean).join(", ");
		const listed = choices.filter((c) => c.reason === null).map(presetLine);
		const failed = HARNESSES.filter((h) => catalog.errors[h] !== null).map(
			(h) => `\n${harnessName(h)}'s models couldn't be listed: ${catalog.errors[h]}`,
		);
		throw new SwbError(`no preset is ${asked}. The presets:\n${listed.join("\n")}${failed.join("")}`);
	}
	const carry = caller && carried(choices, caller);
	if (carry) return carry;
	const fallback = defaultLaunch(config, catalog, choices);
	if (typeof fallback === "string") throw new SwbError(fallback);
	return fallback;
}

/** What a launch asking for a preset starts, against the shortlist as it is now. */
export async function presetLaunch(ask: Ask, caller: Caller | null): Promise<LaunchTarget> {
	const config = loadConfig();
	const catalog = await currentCatalog();
	const choices = shortlist(config, catalog) ?? [];
	writeGuide(choices);
	return resolveLaunch(config, catalog, choices, ask, caller);
}

/** A launch target as LaunchSpec takes it: only the flags it sets. */
export function launchFlags(target: LaunchTarget): {
	harness: Harness;
	provider?: string;
	model?: string;
	effort?: Effort;
	agent?: string;
} {
	return {
		harness: target.harness,
		...(target.provider ? { provider: target.provider } : {}),
		...(target.model ? { model: target.model } : {}),
		...(target.effort ? { effort: target.effort } : {}),
		...(target.agent ? { agent: target.agent } : {}),
	};
}
