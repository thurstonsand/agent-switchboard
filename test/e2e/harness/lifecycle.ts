import { entry, reply, waitState } from "./deck.ts";
import { budgets, type Scenario, until } from "./index.ts";

/** A new session on the Stage, keyboard on pi, one turn in. */
export async function liveSession(s: Scenario, turn: string): Promise<{ id: string; host: string }> {
	s.swb("drive", "start", "--", "new");
	const st = await waitState(s, "the new pi live with the keyboard", (x) => x.staged.kind === "live" && x.focus === "stage");
	await reply(s, turn);
	const id = st.staged.id as string;
	await until(() => entry(s, id)?.activity === "idle", budgets.settle, "idle");
	return { id, host: st.staged.host as string };
}
