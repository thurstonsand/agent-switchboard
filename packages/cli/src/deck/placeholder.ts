import { parseArgs } from "node:util";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { span } from "@swb/shared/trace";
import { UsageError } from "../errors.ts";
import type { Card, Turn } from "./protocol.ts";
import { bold, dim, gray, yellow } from "./style.ts";

const { values: args } = parseArgs({ args: process.argv.slice(3), options: { sock: { type: "string" } } });
if (!args.sock) throw new UsageError("__placeholder: --sock is required");
const sock = args.sock;

let card: Card = { head: [], lines: [], turns: null, tail: [], ending: null, agent: "" };
let typedAt = 0;
/** How long a keystroke's notice stays. */
const TYPED_MS = 1500;
let frame = "";

/**
 * The roster streams the Stage's card, a line of JSON each time it changes, for as long as its Deck lives. The stream
 * ending or failing means the Deck is gone, so this placeholder goes too, as does one the Deck's worker started again
 * just after the Deck's exit killed it.
 */
async function follow(): Promise<never> {
	try {
		const response = await fetch("http://deck/card", { unix: sock, timeout: false });
		let buffer = "";
		for await (const chunk of response.body?.pipeThrough(new TextDecoderStream()) ?? []) {
			buffer += chunk;
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				card = JSON.parse(buffer.slice(0, nl)) as Card;
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
				span("placeholder.draw", draw);
			}
		}
	} catch (error) {
		// A card that won't parse is a bug, not a Deck going away.
		if (error instanceof SyntaxError) throw error;
	}
	process.exit(0);
}

function turnLines(turn: Turn, width: number): string[] {
	const wrapped = turn.text.split("\n").flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width - 5)));
	const who = turn.who === "you" ? "you" : card.agent;
	const label = bold(who);
	// One column for both labels, so the conversation lines up.
	const pad = Math.max(4, card.agent.length) + 1;
	return wrapped.map((line, i) => `${i === 0 ? `${label}${" ".repeat(pad - who.length)}` : " ".repeat(pad)}${line}`);
}

function endingRule(label: string, width: number): string {
	const side = Math.max(2, Math.floor((width - visibleWidth(label) - 2) / 2));
	return `${gray("─".repeat(side))} ${label} ${gray("─".repeat(side))}`;
}

function draw(): void {
	const cols = process.stdout.columns;
	const rows = process.stdout.rows;
	const width = Math.max(10, cols - 4);
	const now = Date.now();
	const head = card.head.flatMap((line) => wrapTextWithAnsi(line, width).slice(0, 2));
	if (head.length > 0 && card.lines.length > 0) head.push("");
	for (const line of card.lines) head.push(...(line === "" ? [""] : wrapTextWithAnsi(dim(line), width)));
	const foot: string[] = [];
	if (typedAt > now - TYPED_MS) foot.push("", yellow(`input ignored until ${card.agent || "the session"} is up`));

	// The conversation fills the room left between the head and the foot, newest at the bottom.
	const room = Math.max(0, rows - 2 - head.length - foot.length - 1);
	let conversation: string[] = [];
	if (card.turns === null) conversation = ["", dim("reading transcript…")];
	else if (card.turns.length > 0 || card.ending) {
		const pad = " ".repeat(Math.max(4, card.agent.length) + 1);
		const all = [
			...card.turns.flatMap((turn, i) => [...(i > 0 ? [""] : []), ...turnLines(turn, width)]),
			// The calls it was making hang off its last text, so an unfinished turn reads as one.
			...card.tail.map((step) => `${pad}${step}`),
			...(card.ending ? ["", endingRule(card.ending, width)] : []),
		];
		conversation = ["", ...(all.length > room - 1 ? [gray("…"), ...all.slice(all.length - (room - 2))] : all)];
	}
	if (room <= 2) conversation = [];
	const body = [...head, ...conversation, ...foot];
	const top = Math.max(0, Math.floor((rows - body.length) / 2));
	const left = Math.max(0, Math.floor((cols - width) / 2));
	// Each row is overwritten in place inside one synchronized update; clearing the screen first flickers.
	let out = "\x1b[?2026h";
	for (let y = 0; y < rows; y++) {
		const line = body[y - top];
		out += `\x1b[${y + 1};1H\x1b[2K`;
		if (line !== undefined) out += `\x1b[${y + 1};${left + 1}H${truncateToWidth(line, cols - left, "…")}`;
	}
	out += "\x1b[?2026l";
	if (out === frame) return;
	frame = out;
	process.stdout.write(out);
}

async function send(cmd: "esc" | "wake"): Promise<void> {
	// The Deck may be gone; the placeholder dies with it.
	await fetch("http://deck/cmd", { unix: sock, method: "POST", body: JSON.stringify({ cmd, args: [] }) }).catch(() => undefined);
}

process.stdout.write("\x1b[?1049h\x1b[?25l");
process.stdin.setRawMode(true);
process.stdin.on("data", (data: Buffer) => {
	const text = data.toString("utf8");
	if (matchesKey(text, "escape")) {
		void send("esc");
		return;
	}
	void send("wake");
	typedAt = Date.now();
	draw();
	setTimeout(draw, TYPED_MS + 20);
});
process.on("SIGWINCH", () => {
	frame = "";
	draw();
});
process.on("SIGHUP", () => process.exit(0));

draw();
void follow();
