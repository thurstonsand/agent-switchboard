import { gc as collect } from "../sessions.ts";
import { openStore } from "../store.ts";

/** A tmux hook's cleanup: it never creates the db, so one that fires after the state dir is gone can't bring it back. */
export function gc(): void {
	collect(openStore({ create: false }));
}
