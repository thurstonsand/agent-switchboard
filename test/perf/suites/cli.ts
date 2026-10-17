import { dormant, fleet } from "../fleet.ts";
import { exits, suite } from "../probe.ts";

// The scriptable surface, against a heavy roster: what a script, a line, or an agent's tool call waits for.

export const cli = suite({
	name: "cli",
	setup: async ({ s }) => {
		const template = await dormant(s, "pi", "reply template");
		fleet(s, template, { sessions: 200, projects: 20, longTurns: 0 });
		return { from: template };
	},
	probes: [
		{
			name: "cli.version",
			feels: "`swb --version`: the floor every swb process pays to start.",
			primary: "exit",
			runs: 15,
			sample: async ({ s }) => {
				const { t0, ms } = await exits(s, ["--version"]);
				return { t0, metrics: { exit: ms } };
			},
		},
		{
			name: "cli.ls",
			feels: "`swb ls --json` over 200 sessions in 20 Projects.",
			primary: "exit",
			runs: 15,
			sample: async ({ s }) => {
				const { t0, ms } = await exits(s, ["ls", "--json"]);
				return { t0, metrics: { exit: ms } };
			},
		},
		{
			name: "cli.dirs",
			feels: "`swb dirs --json`: the directories the picker offers, from 21 Projects' sessions.",
			primary: "exit",
			runs: 15,
			sample: async ({ s }) => {
				const { t0, ms } = await exits(s, ["dirs", "--json"]);
				return { t0, metrics: { exit: ms } };
			},
		},
		{
			name: "tool.reachable",
			feels: "An agent's session_reachable call: every open session but its own, over 200.",
			primary: "exit",
			runs: 15,
			sample: async ({ s }, { from }) => {
				const { t0, ms } = await exits(s, ["reachable", "--from", from]);
				return { t0, metrics: { exit: ms } };
			},
		},
	],
});
