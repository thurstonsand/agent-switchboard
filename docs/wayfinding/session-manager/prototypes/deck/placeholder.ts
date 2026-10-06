// PROTOTYPE, never ships. The placeholder: a per-Deck session on the mock sessions server that the right pane
// shows whenever there is no live pi to show (loading, idle, not running, archived). It renders whatever card
// the Deck last wrote to deck-<id>.stage.json, and swallows input.
// Usage: bun placeholder.ts <deck id>

import { existsSync, readFileSync, watch } from "node:fs";
import { dirname } from "node:path";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { bold, cyan, dim, gray, paths, red, spinnerFrame, yellow } from "./shared.ts";

export interface StageCard {
	tone: "loading" | "idle" | "interrupted" | "not-running" | "archived" | "empty";
	headline: string;
	title: string;
	path: string;
	lines: string[];
	// The last prompt and the last reply, from the transcript. The db holds both, so a card costs nothing.
	excerpts: { prompt: string; reply: string } | null;
	keys: string;
	since: number;
}

const deck = process.argv[2]!;
const file = paths.deckStage(deck);

let card: StageCard = { tone: "empty", headline: "", title: "", path: "", lines: [], excerpts: null, keys: "", since: Date.now() };
let raw = "";
let typedAt = 0;

function load(): boolean {
	if (!existsSync(file)) return false;
	const next = readFileSync(file, "utf8");
	if (next === raw) return false;
	raw = next;
	card = JSON.parse(raw) as StageCard;
	return true;
}

const TONE: Record<StageCard["tone"], (s: string) => string> = {
	loading: cyan,
	idle: (s) => s,
	interrupted: red,
	"not-running": red,
	archived: yellow,
	empty: gray,
};

// A labelled, wrapped, clipped excerpt: `you  …` / `pi   …`.
function excerpt(label: string, text: string, width: number, maxLines: number): string[] {
	const wrapped = wrapTextWithAnsi(text.replaceAll("\n", " "), width - 5);
	const shown = wrapped.slice(0, maxLines);
	if (wrapped.length > maxLines) shown[maxLines - 1] = truncateToWidth(`${shown[maxLines - 1]!} …`, width - 5, "…");
	return shown.map((line, i) => `${i === 0 ? gray(label.padEnd(5)) : "     "}${line}`);
}

function draw(): void {
	const cols = process.stdout.columns ?? 80;
	const rows = process.stdout.rows ?? 24;
	const width = Math.min(cols - 4, 68);
	const now = Date.now();
	const glyph = card.tone === "loading" ? spinnerFrame(now) : "";
	const elapsed = card.tone === "loading" ? gray(`  ${((now - card.since) / 1000).toFixed(1)} s`) : "";
	const body: string[] = [];
	if (card.headline !== "") body.push(TONE[card.tone](bold(`${glyph}${glyph ? " " : ""}${card.headline}`)) + elapsed, "");
	if (card.title !== "") body.push(...wrapTextWithAnsi(bold(card.title), width).slice(0, 2));
	if (card.path !== "") body.push(gray(card.path));
	for (const line of card.lines) body.push(...(line === "" ? [""] : wrapTextWithAnsi(dim(line), width)));
	if (card.excerpts) {
		body.push("", ...excerpt("you", card.excerpts.prompt, width, 2), "", ...excerpt("pi", card.excerpts.reply, width, 4));
	}
	if (card.keys !== "") body.push("", card.keys);
	if (typedAt > now - 1500) body.push("", yellow("input ignored: pi isn't running here"));
	const top = Math.max(0, Math.floor((rows - body.length) / 2) - 1);
	const left = Math.max(0, Math.floor((cols - width) / 2));
	let out = "\x1b[H\x1b[2J";
	body.forEach((line, i) => {
		out += `\x1b[${top + i + 1};${left + 1}H${truncateToWidth(line, cols - left, "…")}`;
	});
	process.stdout.write(out);
}

process.stdout.write("\x1b[?1049h\x1b[?25l");
process.stdin.setRawMode?.(true);
process.stdin.on("data", () => {
	typedAt = Date.now();
	draw();
});
process.on("SIGWINCH", draw);
process.on("SIGHUP", () => process.exit(0));

load();
draw();
watch(dirname(file), (_event, name) => {
	if (name === null || file.endsWith(name)) {
		if (load()) draw();
	}
});
setInterval(() => {
	const changed = load();
	if (changed || card.tone === "loading" || typedAt > Date.now() - 2000) draw();
}, 80);
