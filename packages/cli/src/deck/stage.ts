import type { View } from "@swb/shared";
import { quote, tmuxAsync, UI } from "../tmux.ts";
import type { Control } from "./control.ts";
import { deckEnv, NARROW_BELOW, stageScript } from "./deck.ts";
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
	/** The Stage's first pane. */
	target: string;
	/** The Stage's second pane, which only split has. */
	side: string | null;
	/** The directory's shell, and where it sits against pi's pane; replacing pi, the shell is that pane's target. */
	shell: { target: string; at: ShellAt } | null;
};

/** A nested client of the sessions server in one of the Stage's panes. */
type StageClient = { pane: string; tty: string; up: boolean };

/** What the UI server's keys read off the Stage's pane: an nvim Editor in it, and a harness starting there. */
export type StageTags = { editor: boolean; starting: boolean };

export type StageHost = {
	deck: string;
	rosterPane: string;
	stagePane: string;
	stageTty: string;
	ctl: Control;
	/** The pane the keyboard is on, as last read. */
	focusedPane: () => string;
	/** roster_width, as configured, in a window this wide. */
	configuredCols: (width: number) => number;
	settingsOpen: () => boolean;
	scheme: () => string | null;
	closeOverlays: () => Promise<void>;
	toast: (text: string, level: "info" | "error") => void;
	/** A switch-client took ms; keyAt is when the key that asked for it came in, or 0. */
	switched: (ms: number, keyAt: number) => void;
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
	readonly main: StageClient;
	side: (StageClient & { target: string }) | null = null;
	/** The shell's pane, against whichever pane holds pi. It closes with its shell, so it needs no client tracking. */
	shellPane: { pane: string; target: string; at: ShellAt; parent: string } | null = null;
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
	private tags: StageTags = { editor: false, starting: false };

	constructor(
		private readonly host: StageHost,
		applied: Applied,
	) {
		this.applied = applied;
		this.main = { pane: host.stagePane, tty: host.stageTty, up: false };
	}

	rosterWidth(): number {
		// A width dragged in a wider terminal, restored into this one, still leaves the Stage room.
		if (this.dragged !== null) return Math.max(20, Math.min(this.dragged, this.width - 21));
		return this.host.configuredCols(this.width);
	}

	/** Puts the Stage's panes in line with d; label names the harness its agent pane shows. */
	sync(d: Applied, label: string, tags: StageTags): void {
		const prev = this.applied;
		this.applied = d;
		// Split's pane is cut from the whole Stage, and leaving split gives its columns back to the Editor's pane, so a shell's pane
		// beside or below either goes first; syncShell puts it back where it now belongs.
		if ((d.side === null) !== (prev.side === null)) this.queue(() => this.dropShellPane());
		if (d.side !== prev.side || d.side !== (this.side?.target ?? null)) this.syncSide();
		const shellMoved = d.shell?.target !== prev.shell?.target || d.shell?.at !== prev.shell?.at;
		if (shellMoved || d.side !== prev.side) this.syncShell(prev.shell?.at === "replace" && d.shell?.target === prev.shell.target);
		if (tags.editor !== this.tags.editor) this.tag("@swb_editor", tags.editor);
		if (tags.starting !== this.tags.starting) this.tag("@swb_starting", tags.starting);
		this.tags = tags;
		this.syncLabels(label);
		if (d.target === prev.target) return;
		const keyAt = this.keyAt;
		this.keyAt = 0;
		this.switchTo(this.main, d.target, false, keyAt);
	}

	/** Runs op once every change queued before it is in place. */
	queue(op: () => Promise<void>): void {
		this.ops = this.ops.then(op);
	}

	/** In split, the keyboard goes to pi. */
	async focusStage(): Promise<void> {
		await this.ops;
		await tmuxAsync(UI, "select-pane", ...(this.narrow ? ["-Z"] : []), "-t", this.side?.pane ?? this.host.stagePane);
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
				const zoomed = (await tmuxAsync(UI, "display", "-p", "-t", rosterPane, "#{window_zoomed_flag}")) === "1";
				if (on && !zoomed) await this.host.closeOverlays();
				if (on !== zoomed) await tmuxAsync(UI, "resize-pane", "-Z", "-t", rosterPane);
				// Back beside the Stage, at whatever width Settings left it.
				if (!on) await tmuxAsync(UI, "resize-pane", "-t", rosterPane, "-x", String(this.rosterWidth()));
				// Bun's stdout keeps the size from before a zoom until a SIGWINCH reads it again; tmux's own one can land first.
				process.kill(process.pid, "SIGWINCH");
			}).catch((error: Error) => this.host.toast(`settings: ${error.message}`, "error")),
		);
	}

	/** The roster resized while the window didn't, and swb didn't do it: someone dragged its border. */
	async noteDrag(): Promise<void> {
		const before = this.sizings;
		if (this.sizing > 0 || this.narrow || this.rosterHidden) return;
		const sizes = await tmuxAsync(UI, "display", "-p", "-t", this.host.rosterPane, "#{window_width}\t#{pane_width}\t#{window_zoomed_flag}");
		const [window, pane, zoomed] = sizes.split("\t").map(Number) as [number, number, number];
		if (this.sizing > 0 || this.sizings !== before || window !== this.width || zoomed === 1 || pane === this.rosterWidth()) return;
		this.dragged = pane;
	}

	/** A Stage client on the placeholder unasked, as one that dropped and parked there is, goes back to what it shows. */
	parked(tty: string, placeholder: string): void {
		const { main, side } = this;
		if (tty === main.tty && main.up && this.applied.target !== placeholder) this.switchTo(main, this.applied.target, true, 0);
		if (side && tty === side.tty && side.up && side.target !== placeholder) this.switchTo(side, side.target, true, 0);
	}

	/** A Stage's nested client is up once it attaches to the sessions server, which the control client hears. */
	clientsUp(ttys: string[]): void {
		const { main, side } = this;
		if (!main.up && ttys.includes(main.tty)) {
			main.up = true;
			this.switchTo(main, this.applied.target, true, 0);
		}
		if (side && !side.up && ttys.includes(side.tty)) {
			side.up = true;
			this.switchTo(side, side.target, true, 0);
		}
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
		const { deck, rosterPane, stagePane } = this.host;
		return this.sizingRoster(async () => {
			const size = await tmuxAsync(
				UI,
				"display",
				"-p",
				"-t",
				stagePane,
				"#{window_width}\t#{window_height}\t#{client_cell_width}\t#{client_cell_height}",
			);
			const [width, height, cellWidth, cellHeight] = size.split("\t").map(Number) as [number, number, number, number];
			this.width = width;
			this.height = height;
			if (cellWidth > 0 && cellHeight > 0) this.cellRatio = Math.round(cellHeight / cellWidth);
			const wasNarrow = this.narrow;
			// The prefix keys read @swb_narrow, so it changes before `deck state` can say the Deck did.
			if (width < NARROW_BELOW !== wasNarrow) {
				if (wasNarrow) await tmuxAsync(UI, "set", "-u", "-t", deck, "@swb_narrow");
				else await tmuxAsync(UI, "set", "-t", deck, "@swb_narrow", "1");
			}
			this.narrow = width < NARROW_BELOW;
			this.host.resized();
			await this.ops;
			const [zoomFlag, active] = (await tmuxAsync(UI, "display", "-p", "-t", stagePane, "#{window_zoomed_flag}\t#{pane_active}")).split(
				"\t",
			);
			if (this.narrow) await this.syncRoster(false);
			if (this.narrow !== wasNarrow) {
				// What floats over the Stage goes before a zoom: the roster draws a narrow Deck's overlays itself.
				if (this.narrow) await this.host.closeOverlays();
				if (this.narrow && zoomFlag !== "1") await tmuxAsync(UI, "resize-pane", "-Z", "-t", active === "1" ? stagePane : rosterPane);
				if (!this.narrow && zoomFlag === "1") await tmuxAsync(UI, "resize-pane", "-Z", "-t", rosterPane);
			}
			// tmux scales every pane with the window; the roster keeps its configured or dragged width instead.
			const zoomed = (await tmuxAsync(UI, "display", "-p", "-t", stagePane, "#{window_zoomed_flag}")) === "1";
			if (!this.narrow && !this.rosterHidden && !zoomed) {
				if (this.host.settingsOpen()) await tmuxAsync(UI, "resize-pane", "-Z", "-t", rosterPane);
				else await tmuxAsync(UI, "resize-pane", "-t", rosterPane, "-x", String(this.rosterWidth()));
			}
			this.shownNarrow = this.narrow;
			this.host.rosterPlaced();
		});
	}

	/**
	 * Brings the roster in line with hideWanted, and @swb_hidden, which the bindings read, with it. Hiding breaks it out to
	 * a window of its own; showing joins the Stage's panes back into that window, because join-pane appends to the pane list
	 * and the bindings count on the roster being pane 0. A narrow Deck has no hidden roster.
	 */
	private syncRoster(toRoster: boolean): Promise<void> {
		const { deck, rosterPane, stagePane } = this.host;
		this.queue(() =>
			this.sizingRoster(async () => {
				if (this.narrow) this.hideWanted = false;
				const want = this.hideWanted;
				let failed = false;
				if (want === this.rosterHidden) {
					if (toRoster && !want) await tmuxAsync(UI, "select-pane", ...(this.narrow ? ["-Z"] : []), "-t", rosterPane);
					return;
				}
				const { side, shellPane } = this;
				try {
					if (want) {
						// Focus moves first: breaking the active roster away hands focus to the window's last pane, and that pane's
						// focus hook can land after pi's.
						const focusPi = this.host.focusedPane() === rosterPane ? ["select-pane", "-t", side?.pane ?? stagePane, ";"] : [];
						await tmuxAsync(UI, ...focusPi, "set", "-t", deck, "@swb_hidden", "1", ";", "break-pane", "-d", "-s", rosterPane);
					} else {
						const active = await tmuxAsync(UI, "list-panes", "-t", stagePane, "-f", "#{pane_active}", "-F", "#{pane_id}");
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
							const width = await tmuxAsync(UI, "display", "-p", "-t", side.pane, "#{pane_width}");
							join.push(";", "join-pane", "-h", "-d", "-l", width, "-s", side.pane, "-t", stagePane);
						}
						if (shellPane) {
							const beside = shellPane.at === "beside";
							const size = await tmuxAsync(UI, "display", "-p", "-t", shellPane.pane, beside ? "#{pane_width}" : "#{pane_height}");
							join.push(";", "join-pane", beside ? "-h" : "-v", "-d", "-l", size, "-s", shellPane.pane, "-t", shellPane.parent);
						}
						const scheme = this.host.scheme();
						if (scheme) join.push(";", "set", "-w", "-t", rosterPane, "@swb_scheme", scheme);
						// The roster's window began empty when it broke away, so it has no last pane: the Stage pane goes first, for
						// l and Tab to return to.
						const back = toRoster ? [";", "select-pane", "-t", rosterPane] : [];
						await tmuxAsync(
							UI,
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
						[rosterPane, stagePane].map((pane) => tmuxAsync(UI, "display", "-p", "-t", pane, "#{window_id}")),
					);
					this.rosterHidden = rosterWindow !== stageWindow;
					// What failed isn't still wanted; a toggle queued behind this one keeps its own.
					if (failed) this.hideWanted = this.rosterHidden;
					await tmuxAsync(UI, "set", ...(this.rosterHidden ? ["-t", deck, "@swb_hidden", "1"] : ["-u", "-t", deck, "@swb_hidden"]));
					this.host.rosterPlaced();
				}
			}),
		);
		return this.ops;
	}

	private switchTo(client: StageClient, target: string, force: boolean, keyAt: number): void {
		this.queue(async () => {
			if (!client.up && !force) return;
			const t0 = performance.now();
			try {
				await this.host.ctl.run(`switch-client -c ${quote(client.tty)} -t ${quote(`=${target}`)}`);
				this.host.switched(performance.now() - t0, keyAt);
			} catch {
				// A Stage client that drops parks on the placeholder, which parked() hears and puts right.
			}
		});
	}

	/** Creates, retargets, or kills the Stage's second pane to match what is applied. Leaving it keeps the keyboard on the Stage. */
	private syncSide(): void {
		const { stagePane } = this.host;
		this.queue(async () => {
			const want = this.applied.side;
			try {
				if (want === null) {
					if (!this.side) return;
					const { pane } = this.side;
					// Gone once tmux says so: until then, `deck state` still shows it.
					await tmuxAsync(UI, "kill-pane", "-t", pane).finally(() => {
						this.side = null;
					});
					if (this.host.focusedPane() === pane) await tmuxAsync(UI, "select-pane", "-t", stagePane);
					return;
				}
				if (this.side?.target === want) return;
				if (this.side) {
					this.side.target = want;
					if (this.side.up) await this.host.ctl.run(`switch-client -c ${quote(this.side.tty)} -t ${quote(`=${want}`)}`);
					return;
				}
				const created = await tmuxAsync(
					UI,
					...["split-window", "-h", "-d", "-l", "35%", "-t", stagePane, "-P", "-F", "#{pane_id}\t#{pane_tty}"],
					...deckEnv(),
					stageScript(want),
				);
				const [pane, tty] = created.split("\t") as [string, string];
				this.side = { pane, tty, up: false, target: want };
			} catch (error) {
				this.host.toast(`split: ${(error as Error).message}`, "error");
			}
		});
	}

	/**
	 * Creates, moves, or kills the shell's pane to match what is applied, against pi's pane. A shell that moves keeps the keyboard if it
	 * had it, out of pi's pane too; one that goes leaves it on pi.
	 */
	private syncShell(fromOver: boolean): void {
		const { stagePane } = this.host;
		this.queue(async () => {
			const want = this.applied.shell?.at === "replace" ? null : this.applied.shell;
			const parent = this.side?.pane ?? stagePane;
			const refocus = fromOver && this.host.focusedPane() === parent;
			try {
				const shellPane = this.shellPane;
				if (shellPane && (want?.target !== shellPane.target || want.at !== shellPane.at || parent !== shellPane.parent)) {
					const moving = want?.target === shellPane.target;
					await this.dropShellPane();
					if (!moving) this.shellKeys = false;
				}
				if (want === null || this.shellPane) return;
				const created = await tmuxAsync(
					UI,
					...["split-window", want.at === "beside" ? "-h" : "-v", "-d", "-l", "50%", "-t", parent, "-P", "-F", "#{pane_id}"],
					...deckEnv(),
					stageScript(want.target, true),
				);
				this.shellPane = { pane: created, target: want.target, at: want.at, parent };
				if (refocus || this.shellKeys) await tmuxAsync(UI, "select-pane", "-t", created);
			} catch (error) {
				this.host.toast(`shell: ${(error as Error).message}`, "error");
			} finally {
				this.shellKeys = false;
			}
		});
	}

	private async dropShellPane(): Promise<void> {
		if (!this.shellPane) return;
		const { pane, parent } = this.shellPane;
		this.shellKeys ||= this.host.focusedPane() === pane;
		// Ctrl-D in the shell already closed it.
		await tmuxAsync(UI, "kill-pane", "-t", pane).catch(() => {});
		this.shellPane = null;
		if (this.host.focusedPane() === pane) await tmuxAsync(UI, "select-pane", "-t", parent).catch(() => {});
	}

	/** Names each of the Stage's panes after what it shows, once any pane split or killed ahead of it is in place. */
	private syncLabels(harness: string): void {
		const a = this.applied;
		this.queue(async () => {
			const replaced = a.shell?.at === "replace";
			const want: [string, string][] = [
				[this.host.stagePane, replaced && a.side === null ? "shell" : a.view === "agent" ? harness : "editor"],
			];
			if (this.side) want.push([this.side.pane, replaced ? "shell" : harness]);
			if (this.shellPane) want.push([this.shellPane.pane, "shell"]);
			const key = JSON.stringify(want);
			if (key === this.labels) return;
			// One command per pane: a shell's pane closes with its shell, ahead of the apply that forgets it.
			const results = await Promise.allSettled(want.map(([pane, label]) => tmuxAsync(UI, "set", "-p", "-t", pane, "@swb_label", label)));
			const failed = results.flatMap((r) => (r.status === "rejected" && !String(r.reason).includes("can't find pane") ? [r.reason] : []));
			// Only labels that took are remembered, so the next apply tries the rest again.
			this.labels = failed.length === 0 ? key : "";
			for (const error of failed) this.host.toast(`label: ${(error as Error).message}`, "error");
		});
	}

	/**
	 * What the UI server's keys do on the Stage's pane: ctrl-hjkl reach an nvim Editor in it, which hands moves off its own edge
	 * back through `swb __nav`; Esc goes back to the list from a harness that's starting there, as it does from a card.
	 */
	private tag(option: "@swb_editor" | "@swb_starting", on: boolean): void {
		this.queue(() =>
			tmuxAsync(UI, "set", "-p", "-t", this.host.stagePane, ...(on ? [option, "1"] : ["-u", option])).then(
				() => {},
				(error: Error) => this.host.toast(`${option}: ${error.message}`, "error"),
			),
		);
	}
}
