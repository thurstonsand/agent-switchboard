import type { Scenario } from "../../e2e/harness/index.ts";
import { dormant, host, launched, stop } from "../fleet.ts";
import { exits, onScreen, type Probe, suite, when } from "../probe.ts";

// Messages between sessions, as session_send_message sends them: the agent waits for the tool to return, the
// recipient's line puts the message in front of its model, and the recipient answers.

type Ctx = { from: string; live: string; asleep: string };

function send(name: string, feels: string, target: (ctx: Ctx) => string, before: (s: Scenario, ctx: Ctx) => void): Probe<Ctx> {
	return {
		name,
		feels,
		primary: "delivered",
		runs: 6,
		sample: async ({ s }, ctx, i) => {
			before(s, ctx);
			const to = target(ctx);
			const body = `reply sent-${i}-${crypto.randomUUID().slice(0, 4)}`;
			const { t0, ms } = await exits(s, ["send", "--from", ctx.from, "--to", to], body);
			const delivered = () => s.query<{ at: number | null }>("SELECT delivered_at AS at FROM messages WHERE body = ?", body)[0]?.at ?? null;
			await when(() => delivered() !== null, "the message delivered");
			const answer = body.slice("reply ".length);
			const answered = await when(() => {
				const name = host(s, to);
				return name !== null && onScreen(s, s.servers.sessions, `=${name}:`, answer) >= 2;
			}, "the recipient's answer");
			return { t0, metrics: { returned: ms, delivered: (delivered() as number) - t0, answered: answered - t0 } };
		},
	};
}

export const tools = suite<Ctx>({
	name: "tools",
	setup: async ({ s }) => ({
		from: await dormant(s, "pi", "reply sender"),
		live: await launched(s, "pi", "reply live"),
		asleep: await dormant(s, "pi", "reply asleep"),
	}),
	probes: [
		send(
			"tool.send.live",
			"session_send_message to an idle live pi: until the tool returns, the line delivers it, and pi answers.",
			(ctx) => ctx.live,
			() => {},
		),
		send(
			"tool.send.dormant",
			"session_send_message to a dormant pi: until the tool returns, pi wakes and takes it, and answers.",
			(ctx) => ctx.asleep,
			(s, ctx) => stop(s, ctx.asleep),
		),
	],
});
