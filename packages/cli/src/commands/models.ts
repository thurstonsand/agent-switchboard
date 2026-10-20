import { parseArgs } from "node:util";
import { HARNESSES, harness } from "@swb/shared";
import { discover, readCatalog, searchMatch } from "../harnesses.ts";

/** Every model each harness offers, as the shortlist's add search finds them, grouped by harness and provider. */
export async function models(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		options: { harness: { type: "string" }, json: { type: "boolean" } },
		allowPositionals: true,
	});
	const only = values.harness ? harness(values.harness) : null;
	const words = positionals.join(" ").toLowerCase().split(/\s+/).filter(Boolean);
	const catalog = await discover(readCatalog(), true);
	const shown = HARNESSES.filter((h) => only === null || h === only).map((h) => ({
		harness: h,
		problem: catalog.status[h].problem ?? catalog.errors[h],
		models: catalog.models[h].filter((m) => searchMatch(m, words)),
	}));
	if (values.json) {
		console.log(JSON.stringify(shown));
		return;
	}
	for (const { harness: h, problem, models } of shown) {
		console.log(problem ? `${h}: ${problem}` : h);
		let group = "";
		for (const m of models) {
			if (m.group !== group) {
				group = m.group;
				console.log(`  ${group}`);
			}
			console.log(`    ${(m.agent ?? `${m.model}`).padEnd(32)} ${(m.effort ?? "").padEnd(7)} ${m.note}`);
		}
	}
}
