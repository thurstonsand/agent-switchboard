import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeckState, HeaderStateRow, SessionStateRow } from "../../../packages/cli/src/deck/protocol.ts";
import { budgets, type LsEntry, type Scenario, until } from "./index.ts";

export function sessionRows(st: DeckState): SessionStateRow[] {
	return st.rows.flatMap((row) => (row.kind === "session" ? [row] : []));
}

export function headerRows(st: DeckState): HeaderStateRow[] {
	return st.rows.flatMap((row) => (row.kind === "header" ? [row] : []));
}

export function state(s: Scenario): DeckState {
	return JSON.parse(s.swb("drive", "state"));
}

export function entry(s: Scenario, id: string): LsEntry {
	return s.ls().find((e) => e.id === id) as LsEntry;
}

export function piSessions(s: Scenario): string[] {
	return s
		.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name} #{@swb_kind}")
		.split("\n")
		.filter((line) => line.endsWith(" pi"))
		.map((line) => line.split(" ")[0] as string);
}

export function config(s: Scenario, toml: string): void {
	const dir = join(s.env.XDG_CONFIG_HOME as string, "agent-switchboard");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.toml"), toml);
}

export async function waitState(s: Scenario, what: string, probe: (st: DeckState) => boolean, ms = budgets.settle): Promise<DeckState> {
	return until(
		() => {
			const st = state(s);
			return probe(st) && st;
		},
		ms,
		what,
	);
}

/** Prompts in the focused pi and waits for the scripted reply. */
export async function reply(s: Scenario, text: string): Promise<void> {
	s.keys("-l", `reply ${text}`, "Enter");
	await until(() => s.signal(`replied.${text}`) !== "", budgets.settle, `reply ${text}`);
}

/** Dormant, Unseen sessions with a conversation each: started in a Deck, prompted, then their pi killed while idle. */
export async function seed(s: Scenario, ...conversations: string[][]): Promise<string[]> {
	const ids: string[] = [];
	for (const turns of conversations) {
		s.swb("drive", "start", "--", "new");
		const st = await waitState(s, "the new pi live on the Stage", (x) => x.staged.kind === "live");
		// Unfocused, so watching the turns land doesn't Visit them.
		s.swb("drive", "focus", "out");
		for (const turn of turns) await reply(s, turn);
		const id = st.staged.id as string;
		await until(() => entry(s, id)?.activity === "idle" && entry(s, id).unseen === true, budgets.settle, "idle");
		s.tmux(s.servers.sessions, "kill-session", "-t", `=${st.staged.host}`);
		await until(() => !entry(s, id).live, budgets.settle, "dormant");
		ids.push(id);
	}
	s.swb("drive", "stop");
	return ids;
}

export function rowIndex(st: DeckState, id: string): number {
	return st.rows.findIndex((row) => row.kind === "session" && row.id === id);
}

/** Moves the roster cursor onto a session's row with j/k, one step at a time, so rows moving underneath don't overshoot. */
export async function cursorTo(s: Scenario, id: string): Promise<void> {
	const deadline = Date.now() + budgets.settle;
	for (let st = state(s); st.cursor !== id; ) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for cursor on ${id}`);
		const from = st.rows.findIndex((row) => row.kind === "session" && row.id === st.cursor);
		const before = st.cursor;
		s.keys(from === -1 || rowIndex(st, id) > from ? "j" : "k");
		st = await waitState(s, `cursor off ${before}`, (x) => x.cursor !== before || x.cursor === id);
	}
}

export type Terminal = {
	server: string;
	deck: () => string;
	state: () => DeckState;
	/** Waits until a ready Deck is attached to this terminal. */
	ready: () => Promise<void>;
	screen: () => string;
	keys: (...keys: string[]) => void;
};

/** Another terminal beside the drive harness: its own tmux server running `command`; `state` reads the Deck attached there. */
export function terminal(s: Scenario, name: string, command: string, size = "140x40"): Terminal {
	const server = `term-${name}-${s.instance}`;
	const [x, y] = size.split("x") as [string, string];
	s.tmux(server, "new-session", "-d", "-s", "t", "-c", s.project, "-x", x, "-y", y, command);
	s.tmux(server, "set", "-s", "escape-time", "0", ";", "set", "-g", "status", "off", ";", "set", "-g", "remain-on-exit", "on");
	const deck = () => {
		const tty = s.tmux(server, "display", "-p", "-t", "=t:", "#{pane_tty}");
		const line = s
			.tmux(s.servers.ui, "list-clients", "-F", "#{client_tty}\t#{session_name}")
			.split("\n")
			.find((l) => l.split("\t")[0] === tty);
		if (!line) throw new Error(`no Deck on terminal ${name}`);
		return line.split("\t")[1] as string;
	};
	const state = (): DeckState => JSON.parse(s.swb("deck", "state", "--deck", deck(), "--json"));
	return {
		server,
		deck,
		state,
		ready: async () => {
			await until(
				() => {
					try {
						return state().ready;
					} catch {
						return false;
					}
				},
				budgets.piReady,
				`a ready Deck on terminal ${name}`,
			);
		},
		screen: () => s.tmux(server, "capture-pane", "-p", "-t", "=t:"),
		/** As `s.keys`: `-l TEXT` is literal text, anything else a tmux key name. */
		keys: (...keys) => {
			for (let i = 0; i < keys.length; i++) {
				if (keys[i] === "-l") s.tmux(server, "send-keys", "-t", "=t:", "-l", keys[++i] as string);
				else s.tmux(server, "send-keys", "-t", "=t:", keys[i] as string);
			}
		},
	};
}
