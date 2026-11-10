import type { View } from "@swb/shared";
import { quote, SESSIONS, tmuxAsync } from "../tmux.ts";
import { DECK, deckWindow } from "./conf.ts";
import type { Control } from "./control.ts";
import { NARROW_BELOW, STAND_IN } from "./deck.ts";
import type { Card, ShellAt } from "./protocol.ts";

export type Applied = {
	kind: "live" | "loading" | "dormant" | "exited" | "failed" | "empty";
	id: string | null;
	/** pi's tmux session, when live. */
	host: string | null;
	/** What the Stage shows when pi isn't live. */
	card: Card | null;
	/** What is showing, which can differ from the session's saved view. */
	view: View;
	/** The session whose pane the Stage's first slot shows. */
	target: string;
	/** The session whose pane its second slot shows, which only split has. */
	side: string | null;
	/** Split's columns right of its divider, and agent_width's, which a drag let go near snaps back to. */
	split: { cols: number; defaultCols: number } | null;
	/** The directory's shell, and where it sits against pi's pane; replacing pi, the shell is that pane's target. */
	shell: { target: string; at: ShellAt } | null;
};

type SlotName = "main" | "side" | "shell";

/**
 * One of the Stage's slots: the pane in it, as last placed, and the session that pane belongs to, or null while the
 * slot's own stand-in holds it. A session's pane is in one place at a time, its own window or a slot; while it's in a
 * slot, that slot's stand-in holds its window, so the session lives on. tmux tags each slot's pane with @swb_slot,
 * which is what any swb reads back, as one that kills a session on view does.
 */
type Slot = { name: SlotName; pane: string; shows: string | null };

export type StageHost = {
	deck: string;
	rosterPane: string;
	ctl: Control;
	/** The pane the keyboard is on, as last read. */
	focusedPane: () => string;
	/** roster_width, as configured, in a window this wide. */
	configuredCols: (width: number) => number;
	settingsOpen: () => boolean;
	scheme: () => string | null;
	closeOverlays: () => Promise<void>;
	toast: (text: string, level: "info" | "error") => void;
	/** A swap into the Stage's first slot took ms; keyAt is when the key that asked for it came in, or 0. */
	switched: (ms: number, keyAt: number) => void;
	/** A slot's pane changed, which tmux reports to no focus hook: the keyboard's pane may be another now. */
	swapped: () => void;
	/** The window's size changed, and with it what the Stage should show. */
	resized: () => void;
	/** The roster may have come on screen or gone off it, or become the only pane shown. */
	rosterPlaced: () => void;
};

/**
 * The Stage's panes and the roster's place beside them, as tmux shows them. Every change goes on one chain, in order, and
 * each reads tmux afresh when it runs: what's wanted is `applied` as it is then, not as it was when the change was queued.
 */
export class StagePanes {
	/** What the Stage shows, as last asked. */
	applied: Applied;
	/** When the key that last moved the Stage came in, for the switch it causes; 0 once spent. */
	keyAt = 0;
	readonly main: Slot;
	side: Slot | null = null;
	/** The shell's slot, beside or below the slot that holds pi: main, or side in split. */
	shellPane: (Slot & { at: ShellAt; parent: "main" | "side" }) | null = null;
	/** Below NARROW_BELOW columns the roster stands alone. */
	narrow = false;
	/** `narrow` as the screen shows it, once a layout has put the zoom in place; what `deck state` reports. */
	shownNarrow = false;
	/** A wide Deck's roster, broken out of the Stage's window so the Stage fills the terminal. */
	rosterHidden = false;
	width = 0;
	height = 0;
	/** A cell's height in widths, as the terminal reports its pixels; most fonts are near 2. */
	cellRatio = 2;
	/** A roster width set by dragging its border, which window resizes keep instead of roster_width. */
	dragged: number | null = null;

	private ops = Promise.resolve();
	private layouts = Promise.resolve();
	/** The queues as they stood when settled() last found them in place. */
	private settledAt = { ops: this.ops, layouts: this.layouts };
	/** A layout waiting for the one running to finish; every call meanwhile shares it. */
	private layoutQueued: Promise<void> | null = null;
	/** Whether the roster should be hidden, which syncRoster makes so; rosterHidden is what tmux shows. */
	private hideWanted = false;
	/** While swb itself moves or sizes the roster, its resizes aren't drags; sizings counts each start and end. */
	private sizing = 0;
	private sizings = 0;
	/** Whether the shell's pane had the keyboard when it went, for the one that replaces it to take. */
	private shellKeys = false;
	/** The labels the Stage's panes wear on their top edges, as last set. */
	private labels = "";
	/** The split and Stage width the divider was last put in place for. */
	private splitSized = "";
	/** What each slot was last asked to show, until a placing fails; undefined asks again. */
	private asked: { main?: string; side?: string | null } = {};

	constructor(
		private readonly host: StageHost,
		applied: Applied,
		stage: { pane: string; shows: string | null },
	) {
		this.applied = applied;
		this.main = { name: "main", ...stage };
	}

	/** The columns beside the roster, or the whole Deck's while it's hidden. */
	stageCols(): number {
		return this.rosterHidden ? this.width : this.width - this.rosterWidth() - 1;
	}

	rosterWidth(): number {
		// A width dragged in a wider terminal, restored into this one, still leaves the Stage room.
		if (this.dragged !== null) return Math.max(20, Math.min(this.dragged, this.width - 21));
		return this.host.configuredCols(this.width);
	}

	/** Puts the Stage's panes in line with d; label names the harness its agent pane shows. */
	sync(d: Applied, label: string): void {
		const prev = this.applied;
		this.applied = d;
		// Split's pane is cut from the whole Stage, and leaving split gives its columns back to the Editor's pane, so a shell's pane
		// beside or below either goes first; syncShell puts it back where it now belongs.
		if ((d.side === null) !== (prev.side === null)) this.queue(() => this.dropShellPane());
		if (d.side !== this.asked.side) this.syncSide();
		const shellMoved = d.shell?.target !== prev.shell?.target || d.shell?.at !== prev.shell?.at;
		if (shellMoved || d.side !== prev.side) this.syncShell(prev.shell?.at === "replace" && d.shell?.target === prev.shell.target);
		const split = JSON.stringify([d.split, this.stageCols()]);
		if (split !== this.splitSized) {
			this.splitSized = split;
			this.sizeSplit();
		}
		if (d.target !== this.asked.main) {
			this.asked.main = d.target;
			const keyAt = this.keyAt;
			this.keyAt = 0;
			this.queue(() => this.showMain(keyAt));
		}
		this.syncLabels(label);
	}

	/** Runs op once every change queued before it is in place. */
	queue(op: () => Promise<void>): void {
		this.ops = this.ops.then(op);
	}

	/**
	 * Settles once every change and layout queued so far is in place, and every one they queued in turn; true when any
	 * was queued since the last time it settled.
	 */
	async settled(): Promise<boolean> {
		let waited = false;
		while (this.ops !== this.settledAt.ops || this.layouts !== this.settledAt.layouts) {
			waited = true;
			const at = { ops: this.ops, layouts: this.layouts };
			await Promise.allSettled([at.ops, at.layouts]);
			this.settledAt = at;
		}
		return waited;
	}

	/** In split, the keyboard goes to pi. */
	async focusStage(): Promise<void> {
		await this.ops;
		await this.read();
		await tmuxAsync(SESSIONS, "select-pane", ...(this.narrow ? ["-Z"] : []), "-t", this.side?.pane ?? this.main.pane);
	}

	/** Brings the roster on screen, with the keyboard if focus. */
	showRoster(focus: boolean): Promise<void> {
		this.hideWanted = false;
		return this.syncRoster(focus);
	}

	hideRoster(): Promise<void> {
		this.hideWanted = true;
		return this.syncRoster(false);
	}

	/**
	 * Below NARROW_BELOW columns the roster stands alone, and focus moves zoom along. One pass at a time, each reading the
	 * window afresh: two at once would each zoom or unzoom from what the window was before the other.
	 */
	layout(): Promise<void> {
		if (!this.layoutQueued) {
			const pass = this.layouts.then(() => {
				this.layoutQueued = null;
				return this.layoutOnce();
			});
			this.layoutQueued = pass;
			this.layouts = pass.catch(() => {});
		}
		return this.layoutQueued;
	}

	/** Settings takes the whole window by zooming the roster, and gives it back at the roster's width. */
	zoomRoster(on: boolean): void {
		const { rosterPane } = this.host;
		this.queue(() =>
			this.sizingRoster(async () => {
				if (this.narrow || this.rosterHidden) return;
				const zoomed = (await tmuxAsync(SESSIONS, "display", "-p", "-t", rosterPane, "#{window_zoomed_flag}")) === "1";
				if (on && !zoomed) await this.host.closeOverlays();
				if (on !== zoomed) await tmuxAsync(SESSIONS, "resize-pane", "-Z", "-t", rosterPane);
				// Back beside the Stage, at whatever width Settings left it.
				if (!on) {
					await tmuxAsync(SESSIONS, "resize-pane", "-t", rosterPane, "-x", String(this.rosterWidth()));
					this.sizeSplit();
				}
				// Bun's stdout keeps the size from before a zoom until a SIGWINCH reads it again; tmux's own one can land first.
				process.kill(process.pid, "SIGWINCH");
			}).catch((error: Error) => this.host.toast(`settings: ${error.message}`, "error")),
		);
	}

	/** The roster resized while the window didn't, and swb didn't do it: someone dragged its border. */
	async noteDrag(): Promise<void> {
		const before = this.sizings;
		if (this.sizing > 0 || this.narrow || this.rosterHidden) return;
		const sizes = await tmuxAsync(
			SESSIONS,
			"display",
			"-p",
			"-t",
			this.host.rosterPane,
			"#{window_width}\t#{pane_width}\t#{window_zoomed_flag}",
		);
		const [window, pane, zoomed] = sizes.split("\t").map(Number) as [number, number, number];
		// A roster as wide as its window has lost the Stage beside it, which no drag does.
		if (
			this.sizing > 0 ||
			this.sizings !== before ||
			window !== this.width ||
			zoomed === 1 ||
			pane === window ||
			pane === this.rosterWidth()
		)
			return;
		this.dragged = pane;
	}

	private async sizingRoster(work: () => Promise<void>): Promise<void> {
		this.sizing++;
		this.sizings++;
		try {
			await work();
		} finally {
			this.sizing--;
			this.sizings++;
		}
	}

	private layoutOnce(): Promise<void> {
		const { deck, rosterPane } = this.host;
		// The Deck's current window is the one on screen, whose size tmux keeps; a Stage pane can go home mid-pass, and a
		// hidden roster's window keeps its old size.
		return this.sizingRoster(async () => {
			const size = await tmuxAsync(
				SESSIONS,
				"display",
				"-p",
				"-t",
				`=${DECK}:`,
				"#{window_width}\t#{window_height}\t#{client_cell_width}\t#{client_cell_height}",
			);
			const [width, height, cellWidth, cellHeight] = size.split("\t").map(Number) as [number, number, number, number];
			this.width = width;
			this.height = height;
			if (cellWidth > 0 && cellHeight > 0) this.cellRatio = Math.round(cellHeight / cellWidth);
			const wasNarrow = this.narrow;
			// The prefix keys read @swb_narrow, so it changes before `deck state` can say the Deck did.
			if (width < NARROW_BELOW !== wasNarrow) {
				if (wasNarrow) await tmuxAsync(SESSIONS, "set", "-u", "-t", deck, "@swb_narrow");
				else await tmuxAsync(SESSIONS, "set", "-t", deck, "@swb_narrow", "1");
			}
			this.narrow = width < NARROW_BELOW;
			this.host.resized();
			await this.ops;
			if (this.narrow) await this.syncRoster(false);
			const zoomFlag = await tmuxAsync(SESSIONS, "display", "-p", "-t", `=${DECK}:`, "#{window_zoomed_flag}");
			if (this.narrow !== wasNarrow) {
				// What floats over the Stage goes before a zoom: the roster draws a narrow Deck's overlays itself.
				if (this.narrow) await this.host.closeOverlays();
				// The pane with the keyboard takes the window.
				if (this.narrow && zoomFlag !== "1") await tmuxAsync(SESSIONS, "resize-pane", "-Z", "-t", `=${DECK}:`);
				if (!this.narrow && zoomFlag === "1") await tmuxAsync(SESSIONS, "resize-pane", "-Z", "-t", rosterPane);
			}
			// tmux scales every pane with the window; the roster keeps its configured or dragged width instead.
			const zoomed = (await tmuxAsync(SESSIONS, "display", "-p", "-t", `=${DECK}:`, "#{window_zoomed_flag}")) === "1";
			if (!this.narrow && !this.rosterHidden && !zoomed) {
				if (this.host.settingsOpen()) await tmuxAsync(SESSIONS, "resize-pane", "-Z", "-t", rosterPane);
				else await tmuxAsync(SESSIONS, "resize-pane", "-t", rosterPane, "-x", String(this.rosterWidth()));
			}
			this.shownNarrow = this.narrow;
			this.host.rosterPlaced();
			// tmux scaled the divider with the window, and the roster's width just moved its other side.
			this.sizeSplit();
		});
	}

	/**
	 * Brings the roster in line with hideWanted, and @swb_hidden, which the bindings read, with it. Hiding breaks it out to
	 * a window of its own; showing joins the Stage's panes back into that window, because join-pane appends to the pane list
	 * and the bindings count on the roster being pane 0. A narrow Deck has no hidden roster.
	 */
	private syncRoster(toRoster: boolean): Promise<void> {
		const { deck, rosterPane } = this.host;
		this.queue(() =>
			this.sizingRoster(async () => {
				await this.read();
				const stagePane = this.main.pane;
				if (this.narrow) this.hideWanted = false;
				const want = this.hideWanted;
				let failed = false;
				if (want === this.rosterHidden) {
					if (toRoster && !want) await tmuxAsync(SESSIONS, "select-pane", ...(this.narrow ? ["-Z"] : []), "-t", rosterPane);
					return;
				}
				const { side, shellPane } = this;
				try {
					if (want) {
						// Focus moves first: breaking the active roster away hands focus to the window's last pane, and that pane's
						// focus hook can land after pi's.
						const focusPi = this.host.focusedPane() === rosterPane ? ["select-pane", "-t", side?.pane ?? stagePane, ";"] : [];
						// The roster's new window is the one the Stage's panes join back into, so it wears the Deck's options from the start.
						const out = ["set", "-t", deck, "@swb_hidden", "1", ";", "break-pane", "-d", "-s", rosterPane, ";", ...deckWindow(rosterPane)];
						await tmuxAsync(SESSIONS, ...focusPi, ...out);
					} else {
						const active = await tmuxAsync(SESSIONS, "list-panes", "-t", stagePane, "-f", "#{pane_active}", "-F", "#{pane_id}");
						const join = [
							"join-pane",
							"-h",
							"-d",
							"-l",
							String(Math.max(1, this.width - this.rosterWidth() - 1)),
							"-s",
							stagePane,
							"-t",
							rosterPane,
						];
						if (side) {
							const width = await tmuxAsync(SESSIONS, "display", "-p", "-t", side.pane, "#{pane_width}");
							join.push(";", "join-pane", "-h", "-d", "-l", width, "-s", side.pane, "-t", stagePane);
						}
						if (shellPane) {
							const beside = shellPane.at === "beside";
							const size = await tmuxAsync(SESSIONS, "display", "-p", "-t", shellPane.pane, beside ? "#{pane_width}" : "#{pane_height}");
							const parent = shellPane.parent === "side" && side ? side.pane : stagePane;
							join.push(";", "join-pane", beside ? "-h" : "-v", "-d", "-l", size, "-s", shellPane.pane, "-t", parent);
						}
						const scheme = this.host.scheme();
						if (scheme) join.push(";", "set", "-w", "-t", rosterPane, "@swb_scheme", scheme);
						// The roster's window began empty when it broke away, so it has no last pane: the Stage pane goes first, for
						// l and Tab to return to.
						const back = toRoster ? [";", "select-pane", "-t", rosterPane] : [];
						await tmuxAsync(
							SESSIONS,
							"set",
							"-u",
							"-t",
							deck,
							"@swb_hidden",
							";",
							...join,
							";",
							"select-window",
							"-t",
							rosterPane,
							";",
							"select-pane",
							"-t",
							active,
							...back,
						);
					}
				} catch (error) {
					failed = true;
					this.host.toast(`roster: ${(error as Error).message}`, "error");
				} finally {
					// A tmux sequence can fail halfway, so the windows say whether the roster is hidden, and the option follows them.
					const [rosterWindow, stageWindow] = await Promise.all(
						[rosterPane, stagePane].map((pane) => tmuxAsync(SESSIONS, "display", "-p", "-t", pane, "#{window_id}")),
					);
					this.rosterHidden = rosterWindow !== stageWindow;
					// What failed isn't still wanted; a toggle queued behind this one keeps its own.
					if (failed) this.hideWanted = this.rosterHidden;
					await tmuxAsync(SESSIONS, "set", ...(this.rosterHidden ? ["-t", deck, "@swb_hidden", "1"] : ["-u", "-t", deck, "@swb_hidden"]));
					this.host.rosterPlaced();
				}
			}),
		);
		return this.ops;
	}

	/** The panes in the Stage's slots, as tmux has them now: another swb can send a session home from one. */
	private async read(): Promise<void> {
		const listed = await this.host.ctl.run(`list-panes -s -t ${quote(`=${DECK}`)} -F '#{@swb_slot}\t#{pane_id}\t#{@swb_home}'`);
		let main = false;
		for (const [name, pane, home] of listed.split("\n").map((line) => line.split("\t"))) {
			const slot = name === "main" ? this.main : name === "side" ? this.side : name === "shell" ? this.shellPane : null;
			if (!slot || !pane) continue;
			main ||= slot === this.main;
			slot.pane = pane;
			slot.shows = home || null;
		}
		if (!main) await this.remakeMain();
	}

	/**
	 * The Stage's first slot again, beside the roster, holding a stand-in, after something outside swb closed its pane
	 * outright; what the Stage shows goes back into it with the next sync.
	 */
	private async remakeMain(): Promise<void> {
		const cols = String(Math.max(1, this.width - this.rosterWidth() - 1));
		const pane = await tmuxAsync(
			SESSIONS,
			"split-window",
			"-h",
			"-d",
			"-l",
			cols,
			"-t",
			this.host.rosterPane,
			"-P",
			"-F",
			"#{pane_id}",
			STAND_IN,
		);
		await tmuxAsync(SESSIONS, "set", "-p", "-t", pane, "@swb_slot", "main");
		this.main.pane = pane;
		this.main.shows = null;
		this.asked.main = undefined;
		this.labels = "";
		this.host.rosterPlaced();
	}

	/** Every pane on the server, by what the Stage needs to know of it to place it. */
	private async panes(): Promise<{ pane: string; session: string; home: string; slot: string; width: string; height: string }[]> {
		const listed = await this.host.ctl.run(
			"list-panes -a -F '#{pane_id}\t#{session_name}\t#{@swb_home}\t#{@swb_slot}\t#{pane_width}\t#{pane_height}'",
		);
		return listed.split("\n").map((line) => {
			const [pane = "", session = "", home = "", slot = "", width = "", height = ""] = line.split("\t");
			return { pane, session, home, slot, width, height };
		});
	}

	/**
	 * Swaps the pane of session `target` into a slot, and what held the slot back where it belongs: to its own window, kept
	 * at the slot's size so its program doesn't redraw for nothing, or to the slot the target's pane came from. Returns false
	 * while the target has no pane to show.
	 */
	private async place(slot: Slot, target: string, retried = false): Promise<boolean> {
		const panes = await this.panes();
		const held = panes.find((p) => p.session === DECK && p.slot === slot.name);
		const wanted = panes.find((p) => p.home === target);
		if (!held && slot === this.main) {
			await this.remakeMain();
			return this.place(slot, target);
		}
		if (!held) throw new Error(`the Stage has no ${slot.name} slot`);
		if (!wanted) return false;
		if (wanted.pane !== held.pane) {
			const commands = [`swap-pane -d -Z -s ${wanted.pane} -t ${held.pane}`, `set -p -t ${wanted.pane} @swb_slot ${slot.name}`];
			if (wanted.session === DECK) commands.push(`set -p -t ${held.pane} @swb_slot ${wanted.slot}`);
			else if (held.home) {
				const home = quote(`=${held.home}:`);
				// First, so a home that closed meanwhile fails the list before anything moves.
				commands.unshift(`resize-window -t ${home} -x ${held.width} -y ${held.height}`);
				commands.push(`swap-pane -d -s ${held.pane} -t ${home}`);
			}
			try {
				await this.host.ctl.run(commands.join(" ; "));
			} catch (error) {
				// Another swb sent a pane home between the listing and the swap: the listing is stale, not the Stage.
				if (retried) throw error;
				return this.place(slot, target, true);
			}
			if (wanted.session === DECK) {
				const other = [this.main, this.side, this.shellPane].find((s) => s?.name === wanted.slot);
				if (other) {
					other.pane = held.pane;
					other.shows = held.home || null;
				}
			}
			this.host.swapped();
		}
		slot.pane = wanted.pane;
		slot.shows = target;
		return true;
	}

	/** Sends what holds a slot home, its stand-in coming back to the slot, and closes the slot. */
	private async release(slot: Slot, retried = false): Promise<void> {
		const panes = await this.panes();
		const held = panes.find((p) => p.session === DECK && p.slot === slot.name);
		if (!held) return;
		const standIn = held.home ? panes.find((p) => p.session === held.home)?.pane : undefined;
		if (!standIn) {
			await tmuxAsync(SESSIONS, "kill-pane", "-t", held.pane);
			return;
		}
		const home = `=${held.home}:`;
		try {
			await tmuxAsync(
				SESSIONS,
				...["resize-window", "-t", home, "-x", held.width, "-y", held.height, ";"],
				...["swap-pane", "-d", "-s", held.pane, "-t", standIn, ";", "kill-pane", "-t", standIn],
			);
		} catch (error) {
			// Another swb closed the held pane meanwhile, leaving its stand-in in the slot instead.
			if (retried) throw error;
			await this.release(slot, true);
		}
	}

	/** Puts what's applied in the Stage's first slot; one that has no pane to show yet is asked again by the next sync. */
	private async showMain(keyAt: number): Promise<void> {
		const target = this.applied.target;
		const t0 = performance.now();
		try {
			if (!(await this.place(this.main, target))) {
				if (this.asked.main === target) this.asked.main = undefined;
				return;
			}
			this.host.switched(performance.now() - t0, keyAt);
		} catch (error) {
			if (this.asked.main === target) this.asked.main = undefined;
			this.host.toast(`stage: ${(error as Error).message}`, "error");
		}
	}

	/**
	 * Puts split's divider where what's applied says, the Editor's pane taking the rest, and tells the pane labels where
	 * agent_width would put it, for the notch a drag shows. Outside split there's no divider to drag.
	 */
	sizeSplit(): void {
		this.queue(async () => {
			const split = this.applied.split;
			try {
				if (!split || !this.side) {
					await tmuxAsync(SESSIONS, "set", "-gu", "@swb_notch");
					return;
				}
				await this.read();
				const sizes = await tmuxAsync(
					SESSIONS,
					"display",
					"-p",
					"-t",
					this.main.pane,
					"#{pane_left}\t#{window_width}\t#{window_zoomed_flag}",
				);
				const [left, window, zoomed] = sizes.split("\t").map(Number) as [number, number, number];
				// A resize unzooms; Settings, which zooms the roster, sizes the split again when it gives the window back.
				if (zoomed === 1) return;
				const editor = (cols: number) => window - left - 1 - cols;
				await tmuxAsync(
					SESSIONS,
					...["resize-pane", "-t", this.main.pane, "-x", String(editor(split.cols)), ";"],
					...["set", "-g", "@swb_notch", String(left + editor(split.defaultCols))],
				);
			} catch (error) {
				this.host.toast(`split: ${(error as Error).message}`, "error");
			}
		});
	}

	/** Split's columns right of its divider, as tmux shows them now. */
	async splitCols(): Promise<number> {
		await this.ops;
		const sizes = await tmuxAsync(SESSIONS, "display", "-p", "-t", this.main.pane, "#{pane_left}\t#{pane_width}\t#{window_width}");
		const [left, width, window] = sizes.split("\t").map(Number) as [number, number, number];
		return window - left - width - 1;
	}

	/** Creates, refills, or closes the Stage's second slot to match what is applied. Leaving it keeps the keyboard on the Stage. */
	private syncSide(): void {
		this.asked.side = this.applied.side;
		this.queue(async () => {
			const want = this.applied.side;
			try {
				await this.read();
				if (want === null) {
					if (!this.side) return;
					const { pane } = this.side;
					// Gone once tmux says so: until then, `deck state` still shows it.
					await this.release(this.side).finally(() => {
						this.side = null;
					});
					if (this.host.focusedPane() === pane) await tmuxAsync(SESSIONS, "select-pane", "-t", this.main.pane);
					return;
				}
				if (!this.side) {
					const pane = await tmuxAsync(
						SESSIONS,
						"split-window",
						"-h",
						"-d",
						"-l",
						"50%",
						"-t",
						this.main.pane,
						"-P",
						"-F",
						"#{pane_id}",
						STAND_IN,
					);
					await tmuxAsync(SESSIONS, "set", "-p", "-t", pane, "@swb_slot", "side");
					this.side = { name: "side", pane, shows: null };
				}
				if (!(await this.place(this.side, want)) && this.asked.side === want) this.asked.side = undefined;
			} catch (error) {
				if (this.asked.side === want) this.asked.side = undefined;
				this.host.toast(`split: ${(error as Error).message}`, "error");
			}
		});
	}

	/**
	 * Creates, moves, or closes the shell's slot to match what is applied, against pi's. A shell that moves keeps the keyboard if it
	 * had it, out of pi's pane too; one that goes leaves it on pi.
	 */
	private syncShell(fromOver: boolean): void {
		this.queue(async () => {
			const want = this.applied.shell?.at === "replace" ? null : this.applied.shell;
			const parent: "main" | "side" = this.side ? "side" : "main";
			try {
				await this.read();
				const parentPane = this.side?.pane ?? this.main.pane;
				const refocus = fromOver && this.host.focusedPane() === parentPane;
				const shellPane = this.shellPane;
				if (shellPane && (want?.target !== shellPane.shows || want.at !== shellPane.at || parent !== shellPane.parent)) {
					const moving = want?.target === shellPane.shows;
					await this.dropShellPane();
					if (!moving) this.shellKeys = false;
				}
				if (want === null || this.shellPane) return;
				const created = await tmuxAsync(
					SESSIONS,
					...["split-window", want.at === "beside" ? "-h" : "-v", "-d", "-l", "50%", "-t", parentPane, "-P", "-F", "#{pane_id}", STAND_IN],
				);
				await tmuxAsync(SESSIONS, "set", "-p", "-t", created, "@swb_slot", "shell");
				const slot: Slot & { at: ShellAt; parent: "main" | "side" } = { name: "shell", pane: created, shows: null, at: want.at, parent };
				this.shellPane = slot;
				if (!(await this.place(slot, want.target))) {
					await this.dropShellPane();
					return;
				}
				if (refocus || this.shellKeys) await tmuxAsync(SESSIONS, "select-pane", "-t", slot.pane);
			} catch (error) {
				this.host.toast(`shell: ${(error as Error).message}`, "error");
			} finally {
				this.shellKeys = false;
			}
		});
	}

	private async dropShellPane(): Promise<void> {
		if (!this.shellPane) return;
		const { pane } = this.shellPane;
		this.shellKeys ||= this.host.focusedPane() === pane;
		const parent = this.shellPane.parent === "side" && this.side ? this.side.pane : this.main.pane;
		// The shell exiting already sent its pane home.
		await this.release(this.shellPane).catch(() => {});
		this.shellPane = null;
		if (this.host.focusedPane() === pane) await tmuxAsync(SESSIONS, "select-pane", "-t", parent).catch(() => {});
	}

	/** Names each of the Stage's panes after what it shows, once any pane split, swapped, or closed ahead of it is in place. */
	private syncLabels(harness: string): void {
		const a = this.applied;
		this.queue(async () => {
			const replaced = a.shell?.at === "replace";
			const want: [string, string][] = [[this.main.pane, replaced && a.side === null ? "shell" : a.view === "agent" ? harness : "editor"]];
			if (this.side) want.push([this.side.pane, replaced ? "shell" : harness]);
			if (this.shellPane) want.push([this.shellPane.pane, "shell"]);
			const key = JSON.stringify(want);
			if (key === this.labels) return;
			// A pane can close ahead of the apply that forgets it, which -q lets tmux skip without an error.
			const results = await Promise.allSettled(
				want.map(([pane, label]) => tmuxAsync(SESSIONS, "set", "-q", "-p", "-t", pane, "@swb_label", label)),
			);
			const failed = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
			// Only labels that took are remembered, so the next apply tries the rest again.
			this.labels = failed.length === 0 ? key : "";
			for (const error of failed) this.host.toast(`label: ${(error as Error).message}`, "error");
		});
	}
}
