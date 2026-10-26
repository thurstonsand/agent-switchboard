import type { DeckState } from "../../../packages/cli/src/deck/protocol.ts";
import { entry, reply, waitState } from "./deck.ts";
import { budgets, type Scenario, until } from "./index.ts";

type Pane = { index: number; width: number; active: boolean };

function panes(s: Scenario, st: DeckState): Pane[] {
	return s
		.tmux(
			s.servers.ui,
			"list-panes",
			"-t",
			`=${st.deck}:`,
			"-f",
			"#{!:#{pane_floating_flag}}",
			"-F",
			"#{pane_index} #{pane_width} #{pane_active}",
		)
		.split("\n")
		.map((line) => line.split(" ").map(Number) as [number, number, number])
		.map(([index, width, active]) => ({ index, width, active: active === 1 }));
}

function savedView(s: Scenario, id: string): string | undefined {
	return s.query<{ view: string }>("SELECT view FROM marks WHERE session_id = ?", id)[0]?.view;
}

/** A new session started in a Deck, prompted once so it has a row to remember its view. */
async function started(s: Scenario, ...args: string[]): Promise<DeckState> {
	s.swb("drive", "start", ...args);
	const st = await waitState(
		s,
		"the new pi live with the keyboard",
		(x) => x.staged.kind === "live" && x.focus === "stage",
		budgets.piReady,
	);
	await reply(s, "hello");
	await until(() => entry(s, st.staged.id as string)?.activity === "idle", budgets.settle, "a session row");
	return st;
}

async function prefixKeys(s: Scenario, prefix: string, key: string, what: string, probe: (st: DeckState) => boolean): Promise<DeckState> {
	s.keys(prefix, key);
	return waitState(s, what, probe);
}

export { type Pane, panes, prefixKeys, savedView, started };
