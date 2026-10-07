import { gc as collect } from "../sessions.ts";
import { openStore } from "../store.ts";

export function gc(): void {
	collect(openStore());
}
