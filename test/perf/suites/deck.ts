import { config } from "../../e2e/harness/deck.ts";
import { type Scenario, which } from "../../e2e/harness/index.ts";
import { dormant, fleet, launched, say, stop } from "../fleet.ts";
import { cursorTo, focusRoster, onScreen, rowOf, suite, when } from "../probe.ts";
import { Terminal } from "../terminal.ts";

// The Deck as a person uses it: typed into a terminal, keys pressed, the screen watched until it stops changing.
// `settled` is from the action to the last output before the screen went still with the expected state on it.

function killServers(s: Scenario): void {
	for (const server of [s.servers.ui, s.servers.sessions]) {
		let pid: number;
		try {
			pid = Number(s.tmux(server, "display", "-p", "#{pid}"));
		} catch {
			continue;
		}
		s.tmux(server, "kill-server");
		while (alive(pid)) Bun.sleepSync(10);
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function heavyRoster(s: Scenario, longTurns: number) {
	const template = await dormant(s, "pi", "reply template");
	return { template, ...fleet(s, template, { sessions: 200, projects: 20, longTurns }) };
}

export const deckOpen = suite({
	name: "deck-open",
	setup: async ({ s }) => {
		const roster = await heavyRoster(s, 0);
		return { ...roster, t: new Terminal(s) };
	},
	probes: [
		{
			name: "deck.open.cold",
			feels: "`swb` after a reboot, no swb tmux servers running, 200 sessions: until the Deck is ready and still.",
			primary: "settled",
			runs: 6,
			sample: async ({ s }, { t }) => {
				await t.atPrompt();
				killServers(s);
				await t.type("swb");
				await Bun.sleep(50);
				const t0 = await t.press("Enter");
				const { last, doneAt } = await t.settle(t0, async () => (await t.state())?.ready === true, { what: "a ready Deck" });
				await t.quit();
				return { t0, metrics: { settled: last - t0, ready: doneAt - t0 } };
			},
		},
		{
			name: "deck.open.warm",
			feels: "`swb` with swb's servers already up, 200 sessions: until the Deck is ready and still.",
			primary: "settled",
			runs: 8,
			sample: async (_env, { t }) => {
				await t.atPrompt();
				await t.type("swb");
				await Bun.sleep(50);
				const t0 = await t.press("Enter");
				const { last, doneAt } = await t.settle(t0, async () => (await t.state())?.ready === true, { what: "a ready Deck" });
				await t.quit();
				return { t0, metrics: { settled: last - t0, ready: doneAt - t0 } };
			},
		},
		{
			name: "deck.continue",
			feels: "`swb -c` on a dormant most-recent session: until its pi has the keyboard and the screen is still.",
			primary: "settled",
			runs: 5,
			sample: async ({ s }, { t, template }) => {
				await t.atPrompt();
				stop(s, template);
				await t.type("swb -c");
				await Bun.sleep(50);
				const t0 = await t.press("Enter");
				const { last, doneAt } = await t.settle(
					t0,
					async () => {
						const st = await t.state();
						return st?.staged.id === template && st.staged.kind === "live" && st.focus === "stage";
					},
					{ what: "pi live with the keyboard", quietMs: 300 },
				);
				await t.quit();
				return { t0, metrics: { settled: last - t0, live: doneAt - t0 } };
			},
		},
		{
			name: "deck.quit",
			feels: "q in the roster: until the shell's prompt is back.",
			primary: "settled",
			runs: 8,
			sample: async (_env, { t }) => {
				await t.open();
				await focusRoster(t);
				await Bun.sleep(300);
				const t0 = await t.press("q");
				const { last, doneAt } = await t.settle(t0, () => t.deck() === null, { what: "the Deck gone" });
				await t.atPrompt();
				return { t0, metrics: { settled: last - t0, gone: doneAt - t0 } };
			},
		},
	],
});

export const deckNav = suite({
	name: "deck-nav",
	setup: async ({ s }) => {
		config(s, `editor = "${which("nvim")} --clean"`);
		const roster = await heavyRoster(s, 2000);
		const t = new Terminal(s);
		await t.open();
		const [{ transcript }] = s.query<{ transcript: string }>(
			"SELECT transcript FROM sessions WHERE session_id = ?",
			roster.long as string,
		) as [{ transcript: string }];
		return { ...roster, t, longTranscript: transcript };
	},
	probes: [
		{
			name: "deck.cursor",
			feels: "j or k between dormant sessions in a 200-session roster: until the roster, the card, and the Peek are drawn.",
			primary: "settled",
			runs: 20,
			sample: async (_env, { t }, i) => {
				await focusRoster(t);
				const before = (await t.waitState("a Deck", () => true)).cursorRow;
				const t0 = await t.press(i % 2 === 0 ? "j" : "k");
				const { first, last } = await t.settle(t0, async () => (await t.state())?.cursorRow !== before, { what: "the cursor moved" });
				const st = await t.waitState("a Deck", () => true);
				return { t0, metrics: { settled: last - t0, first: first - t0, frame: st.perf.keyToFrame.lastMs } };
			},
		},
		{
			name: "deck.card.long",
			feels: "The cursor onto a dormant session whose 2000-turn transcript changed since: until its card shows the newest turn.",
			primary: "settled",
			runs: 8,
			sample: async ({ s }, { t, long, longTranscript }, i) => {
				await cursorTo(t, long as string);
				const index = await rowOf(t, long as string);
				const st = await t.waitState("a Deck", () => true);
				const away = st.rows[index + 1]?.kind === "session" ? "j" : "k";
				await t.press(away);
				await t.waitState("the cursor off the long session", (x) => x.cursor !== long);
				const marker = `newest turn ${i}`;
				say(longTranscript, `prompt ${i}`, marker);
				await Bun.sleep(400);
				const t0 = await t.press(away === "j" ? "k" : "j");
				const { last, doneAt } = await t.settle(t0, () => onScreen(s, t.server, "=t:", marker) > 0, {
					what: "the newest turn on the card",
				});
				return { t0, metrics: { settled: last - t0, card: doneAt - t0 } };
			},
		},
		{
			name: "deck.picker",
			feels: "n: until the directory picker shows its directories.",
			primary: "settled",
			runs: 10,
			sample: async (_env, { t }) => {
				await focusRoster(t);
				const t0 = await t.press("n");
				const { last, doneAt } = await t.settle(t0, async () => ((await t.state())?.picker?.rows.length ?? 0) > 0, { what: "the picker" });
				await t.press("Escape");
				await t.waitState("the picker closed", (x) => x.picker === null);
				return { t0, metrics: { settled: last - t0, shown: doneAt - t0 } };
			},
		},
		{
			name: "deck.filter",
			feels: "A keystroke into the roster's filter over 200 sessions: until the filtered roster is drawn.",
			primary: "settled",
			runs: 10,
			sample: async (_env, { t }) => {
				await focusRoster(t);
				await t.press("/");
				await t.waitState("the filter open", (x) => x.mode === "filter");
				await Bun.sleep(200);
				const t0 = await t.type("1");
				const { last } = await t.settle(t0, async () => (await t.state())?.filter === "1", { what: "the filter applied" });
				await t.press("Escape");
				await t.waitState("the filter cleared", (x) => x.mode === "roster" && x.filter === "");
				return { t0, metrics: { settled: last - t0 } };
			},
		},
		{
			name: "deck.editor",
			feels: "M-a e on a session whose directory has no Editor yet: until nvim is drawn on the Stage.",
			primary: "settled",
			runs: 6,
			sample: async ({ s }, { t, ids }) => {
				await cursorTo(t, ids[0] as string);
				for (const [name, kind] of s
					.tmux(s.servers.sessions, "list-sessions", "-F", "#{session_name}\t#{@swb_kind}")
					.split("\n")
					.map((l) => l.split("\t")))
					if (kind === "editor") s.tmux(s.servers.sessions, "kill-session", "-t", `=${name}`);
				await Bun.sleep(300);
				const t0 = await t.press("M-a", "e");
				const { last, doneAt } = await t.settle(
					t0,
					async () => (await t.state())?.staged.view === "editor" && onScreen(s, t.server, "=t:", "NVIM v") > 0,
					{ what: "nvim on the Stage" },
				);
				await t.press("M-a", "e");
				await t.waitState("agent view again", (x) => x.staged.view === "agent");
				return { t0, metrics: { settled: last - t0, drawn: doneAt - t0 } };
			},
		},
	],
});

export const deckLive = suite({
	name: "deck-live",
	setup: async ({ s }) => {
		const a = await launched(s, "pi", "reply a");
		const b = await launched(s, "pi", "reply b");
		const t = new Terminal(s);
		await t.open();
		return { a, b, t };
	},
	probes: [
		{
			name: "deck.switch.live",
			feels: "j or k between two live pi sessions: until the other pi is on the Stage and still.",
			primary: "settled",
			runs: 12,
			sample: async (_env, { t, a, b }, i) => {
				const [from, to] = i % 2 === 0 ? [a, b] : [b, a];
				await cursorTo(t, from);
				await t.waitState("the first pi on the Stage", (x) => x.staged.id === from && x.staged.kind === "live");
				const step = (await rowOf(t, to)) - (await rowOf(t, from));
				if (Math.abs(step) !== 1) throw new Error(`the two live sessions aren't adjacent: ${step} rows apart`);
				await Bun.sleep(300);
				const t0 = await t.press(step > 0 ? "j" : "k");
				const { first, last } = await t.settle(
					t0,
					async () => {
						const st = await t.state();
						return st?.staged.id === to && st.staged.kind === "live";
					},
					{ what: "the other pi on the Stage" },
				);
				const st = await t.waitState("a Deck", () => true);
				return { t0, metrics: { settled: last - t0, first: first - t0, switch: st.perf.keyToSwitch.lastMs } };
			},
		},
		{
			name: "session.turn.pi",
			feels: "Enter on a prompt in a live pi: until the reply is on screen, and when the line recorded the turn.",
			primary: "replied",
			runs: 8,
			sample: async ({ s }, { t, a }, i) => {
				await cursorTo(t, a);
				await t.press("Enter");
				await t.waitState("pi with the keyboard", (x) => x.focus === "stage" && x.staged.id === a && x.staged.kind === "live");
				const answer = `answer-${i}-${crypto.randomUUID().slice(0, 4)}`;
				await t.type(`reply ${answer}`);
				await Bun.sleep(300);
				const t0 = await t.press("Enter");
				const { last, doneAt } = await t.settle(t0, () => onScreen(s, t.server, "=t:", answer) >= 2, { what: "the reply on screen" });
				const recorded = async (column: string) => {
					const value = () => s.query<Record<string, number>>(`SELECT ${column} AS v FROM sessions WHERE session_id = ?`, a)[0]?.v ?? 0;
					await when(() => value() >= t0 - 5, `${column} recorded`);
					return value() - t0;
				};
				const prompted = await recorded("last_prompt_at");
				const settledAt = await recorded("last_settled_at");
				await focusRoster(t);
				return { t0, metrics: { replied: doneAt - t0, settled: last - t0, recorded: prompted, recordedIdle: settledAt } };
			},
		},
	],
});
