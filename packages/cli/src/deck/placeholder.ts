import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { UsageError } from "../errors.ts";
import type { Card, Turn } from "./protocol.ts";
import { cyan, dim, gray, yellow } from "./style.ts";

const { values: args } = parseArgs({ args: process.argv.slice(3), options: { card: { type: "string" }, sock: { type: "string" } } });
if (!args.card || !args.sock) throw new UsageError("__placeholder: --card and --sock are required");
const cardPath = args.card;
const sock = args.sock;

let card: Card = { head: [], lines: [], turns: null };
let raw = "";
let typedAt = 0;
let frame = "";

function load(): boolean {
	let next: string;
	try {
		next = readFileSync(cardPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	if (next === raw) return false;
	raw = next;
	card = JSON.parse(raw) as Card;
	return true;
}

function turnLines(turn: Turn, width: number): string[] {
	const wrapped = turn.text.split("\n").flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width - 5)));
	const label = turn.who === "you" ? cyan("you") : gray("pi");
	return wrapped.map((line, i) => `${i === 0 ? `${label}${" ".repeat(5 - turn.who.length)}` : "     "}${line}`);
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
	if (typedAt > now - 1500) foot.push("", yellow("input ignored: pi isn't running here"));

	// The conversation fills the room left between the head and the foot, newest at the bottom.
	const room = Math.max(0, rows - 2 - head.length - foot.length - 1);
	let conversation: string[] = [];
	if (card.turns === null) conversation = ["", dim("reading transcript…")];
	else if (card.turns.length > 0) {
		const all = card.turns.flatMap((turn, i) => [...(i > 0 ? [""] : []), ...turnLines(turn, width)]);
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

async function esc(): Promise<void> {
	// The Deck may be gone; the placeholder dies with it.
	await fetch("http://deck/cmd", { unix: sock, method: "POST", body: JSON.stringify({ cmd: "esc", args: [] }) }).catch(() => undefined);
}

process.stdout.write("\x1b[?1049h\x1b[?25l");
process.stdin.setRawMode(true);
process.stdin.on("data", (data: Buffer) => {
	const text = data.toString("utf8");
	if (matchesKey(text, "escape")) {
		void esc();
		return;
	}
	typedAt = Date.now();
	draw();
});
process.on("SIGWINCH", () => {
	frame = "";
	draw();
});
process.on("SIGHUP", () => process.exit(0));

load();
draw();
setInterval(() => {
	const changed = load();
	if (changed || typedAt > Date.now() - 2000) draw();
}, 80);
