import { ensureSessionsServer } from "../sessions.ts";
import { CLIENT_CWD, cleanEnv, SESSIONS, tmuxBin } from "../tmux.ts";

type Pending = { resolve: (out: string) => void; reject: (error: Error) => void };

/**
 * One control-mode client on the sessions server, attached to its swb-ctl session: a command costs about a
 * millisecond, against ~11 ms to spawn tmux. It respawns on the next command after the server dies.
 */
export class Control {
	private proc: Bun.Subprocess<"pipe", "pipe", "ignore"> | null = null;
	private pending: Pending[] = [];
	private block: { flags: number; lines: string[] } | null = null;

	private spawn(): Bun.Subprocess<"pipe", "pipe", "ignore"> {
		ensureSessionsServer();
		const proc = Bun.spawn([tmuxBin(), "-L", SESSIONS, "-C", "attach", "-f", "ignore-size,no-output", "-t", "=swb-ctl"], {
			cwd: CLIENT_CWD,
			env: cleanEnv(),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		});
		void this.read(proc);
		return proc;
	}

	private async read(proc: Bun.Subprocess<"pipe", "pipe", "ignore">): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of proc.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				this.line(buffer.slice(0, nl));
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
			}
		}
		if (this.proc !== proc) return;
		this.proc = null;
		this.block = null;
		for (const pending of this.pending.splice(0)) pending.reject(new Error("tmux control client exited"));
	}

	private line(line: string): void {
		if (this.block) {
			if (line.startsWith("%end ") || line.startsWith("%error ")) {
				const { flags, lines } = this.block;
				this.block = null;
				// Flag 1 marks a reply to one of our commands; the attach itself also gets a block.
				if ((flags & 1) === 0) return;
				const pending = this.pending.shift();
				if (!pending) return;
				if (line.startsWith("%end ")) pending.resolve(lines.join("\n"));
				else pending.reject(new Error(lines.join("\n")));
			} else this.block.lines.push(line);
			return;
		}
		if (line.startsWith("%begin ")) this.block = { flags: Number(line.split(" ")[3]), lines: [] };
	}

	run(command: string): Promise<string> {
		this.proc ??= this.spawn();
		const proc = this.proc;
		return new Promise((resolve, reject) => {
			this.pending.push({ resolve, reject });
			proc.stdin.write(`${command}\n`);
			proc.stdin.flush();
		});
	}

	close(): void {
		this.proc?.kill();
	}
}
