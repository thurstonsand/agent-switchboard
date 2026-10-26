import { openSync, writeSync } from "node:fs";
import tty from "node:tty";
import { tmuxAsync, tmuxTry, UI } from "../tmux.ts";

// Overlays are boxes the roster puts over the Deck: a Peek, the launch card, its menu. What lies over the roster's own
// lines it draws itself; here, the rest float over the Stage. Each is a tmux floating pane in the Deck's window, which
// sits above the tiled panes without resizing them or touching the harness on the Stage, and never takes the keyboard:
// the Deck's mouse bindings pass clicks on one through without selecting it. Its program ignores its terminal; the
// roster opens that terminal itself, paints it, and reads its mouse there, so a button is a closure and nothing crosses
// a process boundary.

/** A button on an overlay: where it is, its line again with it lit, and what a click does. */
export type OverlayButton = { y: number; from: number; to: number; hot: string; act: () => void };

/** What an overlay shows: its lines, as wide as it is, and the stretches of them that are buttons. */
export type OverlayView = { lines: string[]; buttons: OverlayButton[] };

/**
 * A box over the Stage. Its corner is in the roster pane's cells; columns past the roster's own width are the Stage's.
 * One that `leaves` goes when the pointer leaves the roster for anywhere but an overlay, or a key goes elsewhere, which
 * only the UI server sees soon enough: it kills it there, and tells the roster.
 */
export type Overlay = {
	id: string;
	/** What it shows, as `deck state` reports it: a session's id, or the launch. */
	about: string;
	x: number;
	y: number;
	width: number;
	view: OverlayView;
	leaves: boolean;
	/** The pointer moving over it. */
	pointer: (() => void) | null;
};

type Shown = {
	overlay: Overlay;
	pane: string;
	fd: number;
	input: tty.ReadStream;
	x: number;
	y: number;
	width: number;
	height: number;
	/** The last frame written, so an unchanged one isn't. */
	painted: string;
	/** Where the pointer last moved over it, which lights the button there. */
	at: { x: number; y: number } | null;
	/** Killed by the roster, which expects its terminal to go. */
	killed: boolean;
};

export type OverlayHost = {
	/** The roster's pane: overlays go in its window, and their corners count from its top-left. */
	pane: string;
	/** The Deck's session, which holds the command the UI server runs to put away what `leaves`. */
	deck: string;
	failed: (message: string) => void;
	/** One that `leaves` went without the roster: the UI server saw the pointer or a key go elsewhere. */
	left: () => void;
	/** Something shown changed by itself: a click ran, or one went. */
	changed: () => void;
};

export class Overlays {
	private readonly shown = new Map<string, Shown>();
	private want: Overlay[] = [];
	private running = false;
	private dirty = false;
	/** The kill-pane commands in @swb_leave, as last set. */
	private leave = "";

	constructor(private readonly host: OverlayHost) {
		// A roster that died left its overlays behind; this one starts with none.
		const stray = tmuxTry(UI, "list-panes", "-t", host.pane, "-f", "#{pane_floating_flag}", "-F", "#{pane_id}");
		for (const pane of stray.ok ? stray.out.split("\n").filter(Boolean) : []) tmuxTry(UI, "kill-pane", "-t", pane);
		tmuxTry(UI, "set", "-u", "-t", host.deck, "@swb_leave");
	}

	/** Makes the overlays on screen these, bottom to top. What only changed what it shows is repainted at once. */
	sync(want: Overlay[]): void {
		this.want = want;
		for (const o of want) {
			const s = this.shown.get(o.id);
			if (!s) continue;
			s.overlay = o;
			if (s.height === o.view.lines.length && s.width === o.width) this.paint(s);
		}
		if (this.placed()) return;
		this.dirty = true;
		if (!this.running) void this.run();
	}

	/** What an overlay on screen shows, without its color, or null when it isn't. */
	painted(id: string): { about: string; lines: string[] } | null {
		const s = this.shown.get(id);
		return s && s.painted !== "" ? { about: s.overlay.about, lines: s.overlay.view.lines.map((line) => Bun.stripANSI(line)) } : null;
	}

	/** The pointer is on the roster, so no button of an overlay is under it. */
	pointerAway(): void {
		for (const s of this.shown.values()) {
			if (!s.at) continue;
			s.at = null;
			this.paint(s);
		}
	}

	/**
	 * Nothing of this roster stays on screen: at exit, and before its window zooms, where a float made or killed has
	 * tmux resize the zoomed pane twice. The next sync puts back what's still wanted.
	 */
	closeAll(): void {
		for (const s of this.shown.values()) {
			s.killed = true;
			s.input.destroy();
			tmuxTry(UI, "kill-pane", "-t", s.pane);
		}
		this.shown.clear();
		this.leave = "";
		tmuxTry(UI, "set", "-u", "-t", this.host.deck, "@swb_leave");
	}

	/** Whether every overlay wanted is on screen where it belongs, in order, and nothing else is. */
	private placed(): boolean {
		const order = [...this.shown.keys()];
		return (
			order.length === this.want.length &&
			this.want.every((o, i) => {
				const s = this.shown.get(o.id);
				return order[i] === o.id && s?.x === o.x && s.y === o.y && s.width === o.width && s.height === o.view.lines.length;
			})
		);
	}

	private async run(): Promise<void> {
		this.running = true;
		let failures = 0;
		while (this.dirty) {
			this.dirty = false;
			try {
				await this.place(this.want);
				failures = 0;
			} catch (error) {
				// A float the UI server killed a moment ago fails a move in the same breath; the next pass knows it's gone.
				this.forgetDead();
				if (++failures > 1) {
					this.host.failed(`overlay: ${(error as Error).message}`);
					break;
				}
				this.dirty = true;
			}
		}
		this.running = false;
	}

	/** One tmux command that kills, moves, resizes, makes, and stacks the floats to match `want`. */
	private async place(want: Overlay[]): Promise<void> {
		const commands: string[][] = [];
		for (const s of [...this.shown.values()]) {
			if (want.some((o) => o.id === s.overlay.id)) continue;
			commands.push(["kill-pane", "-t", s.pane]);
			this.drop(s);
		}
		const making = want.filter((o) => !this.shown.has(o.id));
		const moving = want.filter((o) => {
			const s = this.shown.get(o.id);
			return s && (s.x !== o.x || s.y !== o.y || s.width !== o.width || s.height !== o.view.lines.length);
		});
		const origin =
			making.length + moving.length === 0
				? { left: 0, top: 0 }
				: await tmuxAsync(UI, "display", "-p", "-t", this.host.pane, "#{pane_left} #{pane_top}").then((out) => {
						const [left, top] = out.split(" ").map(Number) as [number, number];
						return { left, top };
					});
		for (const o of moving) {
			const s = this.shown.get(o.id) as Shown;
			if (s.x !== o.x || s.y !== o.y) commands.push(["move-pane", "-t", s.pane, "-X", `${origin.left + o.x}`, "-Y", `${origin.top + o.y}`]);
			if (s.width !== o.width || s.height !== o.view.lines.length)
				commands.push(["resize-pane", "-t", s.pane, "-x", `${o.width}`, "-y", `${o.view.lines.length}`]);
		}
		// Without -A, a float made or killed in a zoomed window unzooms it for good; -B none leaves its frame to what it shows.
		for (const o of making)
			commands.push([
				"new-pane",
				"-d",
				"-A",
				"-B",
				"none",
				"-P",
				"-F",
				"#{pane_id} #{pane_tty}",
				"-X",
				`${origin.left + o.x}`,
				"-Y",
				`${origin.top + o.y}`,
				"-x",
				`${o.width}`,
				"-y",
				`${o.view.lines.length}`,
				"-t",
				this.host.pane,
				"exec tail -f /dev/null",
			]);
		// A new float is on top; any wanted above one that's new is raised again, in order.
		const first = want.findIndex((o) => making.includes(o));
		const raise = first === -1 ? [] : want.slice(first + 1).filter((o) => !making.includes(o));
		for (const o of raise) commands.push(["move-pane", "-t", (this.shown.get(o.id) as Shown).pane, "-z", "0"]);
		if (commands.length > 0) {
			const out = await tmuxAsync(UI, ...commands.flatMap((command, i) => (i === 0 ? command : [";", ...command])));
			const made = out.split("\n").filter(Boolean);
			making.forEach((o, i) => {
				const [pane, path] = (made[i] as string).split(" ") as [string, string];
				this.open(o, pane, path);
			});
		}
		for (const o of moving) {
			const s = this.shown.get(o.id) as Shown;
			Object.assign(s, { x: o.x, y: o.y, width: o.width, height: o.view.lines.length, painted: "" });
			this.paint(s);
		}
		// Map order is stacking order.
		for (const o of want) {
			const s = this.shown.get(o.id) as Shown;
			this.shown.delete(o.id);
			this.shown.set(o.id, s);
		}
		await this.syncLeave();
	}

	private open(overlay: Overlay, pane: string, path: string): void {
		const fd = openSync(path, "r+");
		const input = new tty.ReadStream(fd);
		input.setRawMode(true);
		const s: Shown = {
			overlay,
			pane,
			fd,
			input,
			x: overlay.x,
			y: overlay.y,
			width: overlay.width,
			height: overlay.view.lines.length,
			painted: "",
			at: null,
			killed: false,
		};
		this.shown.set(overlay.id, s);
		// Every motion, in SGR, and no cursor.
		this.write(s, "\x1b[?25l\x1b[?1003h\x1b[?1006h");
		this.paint(s);
		input.on("data", (data: Buffer) => this.input(s, data.toString()));
		// Its pane gone, reading its terminal fails with EIO, and the close after it says so.
		input.on("error", () => {});
		input.on("close", () => this.lost(s));
	}

	private input(s: Shown, data: string): void {
		for (const [, code, col, row, kind] of data.matchAll(/\[<(\d+);(\d+);(\d+)([Mm])/g)) {
			const at = { x: Number(col) - 1, y: Number(row) - 1 };
			const button = Number(code);
			// 32 and up is motion; 35, with no button held.
			if (button >= 32 && button < 64) {
				s.at = at;
				s.overlay.pointer?.();
				this.paint(s);
			} else if (button === 0 && kind === "M") {
				const hit = s.overlay.view.buttons.find((b) => b.y === at.y && at.x >= b.from && at.x < b.to);
				if (!hit) continue;
				hit.act();
				this.host.changed();
			}
		}
	}

	private paint(s: Shown): void {
		const { lines, buttons } = s.overlay.view;
		const at = s.at;
		const hot = at ? buttons.find((b) => b.y === at.y && at.x >= b.from && at.x < b.to) : undefined;
		const frame = `\x1b[H${lines.map((line, y) => `${hot?.y === y ? hot.hot : line}\x1b[0m\x1b[K`).join("\r\n")}\x1b[J`;
		if (frame === s.painted) return;
		s.painted = frame;
		this.write(s, frame);
	}

	private write(s: Shown, text: string): void {
		if (s.killed) return;
		try {
			writeSync(s.fd, text);
		} catch {
			// Gone mid-frame: its terminal's close is on its way to lost().
		}
	}

	/** Forgets one the roster is killing; its terminal's close is expected. */
	private drop(s: Shown): void {
		s.killed = true;
		this.shown.delete(s.overlay.id);
		s.input.destroy();
	}

	private lost(s: Shown): void {
		if (s.killed) return;
		s.killed = true;
		this.shown.delete(s.overlay.id);
		void this.syncLeave();
		if (s.overlay.leaves) this.host.left();
		this.host.changed();
	}

	/**
	 * After a command that failed partway: forgets what's shown whose pane is gone, and kills any float that isn't shown,
	 * as one made or left behind before the failure.
	 */
	private forgetDead(): void {
		const alive = tmuxTry(UI, "list-panes", "-t", this.host.pane, "-f", "#{pane_floating_flag}", "-F", "#{pane_id}");
		const panes = new Set(alive.ok ? alive.out.split("\n").filter(Boolean) : []);
		for (const s of [...this.shown.values()]) if (!panes.has(s.pane)) this.drop(s);
		const ours = new Set([...this.shown.values()].map((s) => s.pane));
		for (const pane of panes) if (!ours.has(pane)) tmuxTry(UI, "kill-pane", "-t", pane);
	}

	/** The UI server's command that puts away what leaves with the pointer; see LEAVE in deck.ts. */
	private async syncLeave(): Promise<void> {
		const leave = [...this.shown.values()]
			.filter((s) => s.overlay.leaves)
			.map((s) => `kill-pane -t ${s.pane}`)
			.join(" ; ");
		if (leave === this.leave) return;
		this.leave = leave;
		await tmuxAsync(UI, "set", "-t", this.host.deck, ...(leave === "" ? ["-u", "@swb_leave"] : ["@swb_leave", leave]));
	}
}
