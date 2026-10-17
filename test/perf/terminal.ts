import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_CONF, themeCommands } from "../../packages/cli/src/commands/drive-terminal.ts";
import type { DeckState } from "../../packages/cli/src/deck/protocol.ts";
import { quote } from "../../packages/cli/src/tmux.ts";
import { now } from "../../packages/shared/src/trace.ts";
import { type Scenario, until } from "../e2e/harness/index.ts";

/**
 * The person's terminal: a tmux server whose one pane sits at a shell prompt, themed as `swb drive` themes its own, so
 * swb is typed and run there as a person runs it. A control-mode client watches the pane: every byte the program
 * writes toward the screen arrives as an %output line, and its arrival time is when the screen changed. Keys go in
 * through the same client, so a key's timestamp is when tmux got it, not when a child process started.
 */
export class Terminal {
	readonly server: string;
	/** When each burst of the pane's output arrived, epoch ms. */
	private outputs: number[] = [];
	private control: Bun.Subprocess<"pipe", "pipe", "ignore">;
	private pending: { resolve: (out: string) => void; reject: (error: Error) => void }[] = [];

	constructor(
		private s: Scenario,
		size = "140x40",
	) {
		this.server = `perf-term-${s.instance}`;
		const conf = join(s.root, `${this.server}.conf`);
		const theme = themeCommands("light").map(([set, flag, option, value]) => `${set} ${flag} ${option} ${quote(value)}`);
		writeFileSync(conf, [...HARNESS_CONF, ...theme, ""].join("\n"));
		const [x, y] = size.split("x") as [string, string];
		s.tmux(this.server, "-f", conf, "new-session", "-d", "-s", "t", "-c", s.project, "-x", x, "-y", y, "exec /bin/sh");
		this.control = Bun.spawn([join(s.bin, "tmux"), "-L", this.server, "-C", "attach", "-f", "ignore-size", "-t", "=t"], {
			env: s.env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		});
		void this.read();
	}

	private async read(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		let block: string[] | null = null;
		let mine = false;
		for await (const chunk of this.control.stdout) {
			const at = now();
			buffer += decoder.decode(chunk, { stream: true });
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
				if (block) {
					if (line.startsWith("%end ") || line.startsWith("%error ")) {
						const lines = block;
						block = null;
						if (!mine) continue;
						const pending = this.pending.shift();
						if (line.startsWith("%end ")) pending?.resolve(lines.join("\n"));
						else pending?.reject(new Error(lines.join("\n")));
					} else block.push(line);
				} else if (line.startsWith("%begin ")) {
					block = [];
					// Flag 1 marks a reply to one of this client's commands; the attach gets a block of its own.
					mine = (Number(line.split(" ")[3]) & 1) === 1;
				} else if (line.startsWith("%output ")) this.outputs.push(at);
			}
		}
	}

	/** A tmux command through the control client. */
	run(command: string): Promise<string> {
		return new Promise((resolve, reject) => {
			this.pending.push({ resolve, reject });
			this.control.stdin.write(`${command}\n`);
			this.control.stdin.flush();
		});
	}

	/** Presses tmux keys, in order; returns when the first went in. */
	async press(...keys: string[]): Promise<number> {
		const at = now();
		for (const key of keys) await this.run(`send-keys -t =t: ${quote(key)}`);
		return at;
	}

	/** Types literal text; returns when it went in. */
	async type(text: string): Promise<number> {
		const at = now();
		await this.run(`send-keys -t =t: -l ${quote(text)}`);
		return at;
	}

	/**
	 * Waits until `done` holds and the screen has then been still for `quietMs`. `first` is the first output after
	 * `from`, `last` the last one before the stillness: when the screen finished changing.
	 */
	async settle(
		from: number,
		done: () => boolean | Promise<boolean>,
		options: { quietMs?: number; timeoutMs?: number; what: string },
	): Promise<{ first: number; last: number; doneAt: number }> {
		const quietMs = options.quietMs ?? 150;
		const deadline = Date.now() + (options.timeoutMs ?? 30_000);
		let doneAt = 0;
		for (;;) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.what}\n${this.screen()}`);
			if (!doneAt && (await done())) doneAt = now();
			const after = this.outputs.filter((t) => t >= from);
			const last = after.at(-1) ?? from;
			if (doneAt && now() - Math.max(last, doneAt) >= quietMs) return { first: after[0] ?? last, last, doneAt };
			await Bun.sleep(10);
		}
	}

	screen(): string {
		return this.s.tmux(this.server, "capture-pane", "-p", "-t", "=t:");
	}

	/** The Deck this terminal is attached to, if any. */
	deck(): string | null {
		const tty = this.s.tmux(this.server, "display", "-p", "-t", "=t:", "#{pane_tty}");
		try {
			const line = this.s
				.tmux(this.s.servers.ui, "list-clients", "-F", "#{client_tty}\t#{session_name}")
				.split("\n")
				.find((l) => l.split("\t")[0] === tty);
			return line ? (line.split("\t")[1] as string) : null;
		} catch {
			return null;
		}
	}

	/** The attached Deck's state, straight from its socket; null while there is none. */
	async state(): Promise<DeckState | null> {
		const deck = this.deck();
		if (!deck) return null;
		const sock = join(this.s.env.XDG_STATE_HOME as string, "agent-switchboard/decks", `${deck}.sock`);
		try {
			return (await (await fetch("http://deck/state", { unix: sock })).json()) as DeckState;
		} catch {
			return null;
		}
	}

	async waitState(what: string, probe: (st: DeckState) => boolean, timeoutMs = 30_000): Promise<DeckState> {
		return until(
			async () => {
				const st = await this.state();
				return st !== null && probe(st) && st;
			},
			timeoutMs,
			what,
		);
	}

	/** Runs `swb ARGS` at the prompt and waits for its Deck to be ready. */
	async open(...args: string[]): Promise<number> {
		await this.atPrompt();
		await this.type(["swb", ...args].join(" "));
		await Bun.sleep(30);
		const at = await this.press("Enter");
		await this.waitState("a ready Deck", (st) => st.ready);
		return at;
	}

	/** Quits the Deck with M-a q, from whichever pane has the keyboard, and waits for the shell's prompt. */
	async quit(): Promise<void> {
		await this.press("M-a", "q");
		await this.atPrompt();
	}

	async atPrompt(): Promise<void> {
		await until(() => this.deck() === null && /\$ ?$/m.test(this.screen().trimEnd()), 15_000, "the shell's prompt");
	}

	close(): void {
		this.control.kill();
		try {
			this.s.tmux(this.server, "kill-server");
		} catch {}
	}
}
