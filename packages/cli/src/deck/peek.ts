import { readFileSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { parseArgs } from "node:util";
import { UsageError } from "../errors.ts";
import type { PeekButton, PeekView } from "./protocol.ts";

// `swb __peek`: the Peek's popup on the Stage's own client. The roster writes what it shows; this draws it, lights the
// button under the pointer, and posts a click on one back to the Deck.

const { values } = parseArgs({ args: process.argv.slice(3), options: { file: { type: "string" }, sock: { type: "string" } } });
if (!values.file || !values.sock) throw new UsageError("__peek --file PATH --sock PATH");
const file = values.file;
const sock = values.sock;

/** Motion after this long without any means the pointer came back into the Peek, which the roster wants to know. */
const REENTRY_MS = 150;

let view = JSON.parse(readFileSync(file, "utf8")) as PeekView;
let hot = -1;
let lastMotion = 0;

function draw(): void {
	const button = view.buttons[hot];
	const lines = view.lines.map((line, y) => (button?.y === y ? button.hot : line));
	process.stdout.write(`\x1b[H${lines.join("\x1b[K\r\n")}\x1b[K\x1b[J`);
}

function post(cmd: string, args: string[]): void {
	void fetch("http://deck/cmd", { unix: sock, method: "POST", body: JSON.stringify({ cmd, args }) });
}

watch(dirname(file), (_event, name) => {
	if (name !== basename(file)) return;
	view = JSON.parse(readFileSync(file, "utf8")) as PeekView;
	hot = -1;
	draw();
});

process.stdin.setRawMode(true);
process.stdin.on("data", (data: Buffer) => {
	// SGR mouse reports; `[<` after the ESC is unambiguous on their own.
	for (const [, code, col, row, kind] of data.toString().matchAll(/\[<(\d+);(\d+);(\d+)([Mm])/g)) {
		const x = Number(col) - 1;
		const y = Number(row) - 1;
		const at = view.buttons.findIndex((b) => b.y === y && x >= b.from && x < b.to);
		if (code === "35") {
			const now = Date.now();
			if (now - lastMotion > REENTRY_MS) post("peek-in", [view.id]);
			lastMotion = now;
			if (at !== hot) {
				hot = at;
				draw();
			}
		} else if (code === "0" && kind === "M" && at !== -1) post("key", [(view.buttons[at] as PeekButton).key, view.id]);
	}
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGHUP", () => process.exit(0));

process.stdout.write("\x1b[?25l\x1b[?1003h\x1b[?1006h");
draw();
