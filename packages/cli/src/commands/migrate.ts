import { SCHEMA_VERSION } from "@swb/shared";
import { openStore } from "../store.ts";

export function migrate(): void {
	const db = openStore();
	console.log(`${db.path}: schema v${SCHEMA_VERSION}`);
}
