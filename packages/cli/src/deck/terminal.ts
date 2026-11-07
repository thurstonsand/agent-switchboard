import { ProcessTerminal, StdinBuffer } from "@earendil-works/pi-tui";
import { resolveEscapeTimeoutMs } from "@earendil-works/pi-tui/dist/terminal.js";

export class DeckTerminal extends ProcessTerminal {
	private fragments: StdinBuffer | null = null;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		const fragments = new StdinBuffer({ escapeTimeout: resolveEscapeTimeoutMs() });
		this.fragments = fragments;
		let recovering = false;
		const forward = (data: string) => {
			recovering = false;
			onInput(data);
		};
		fragments.on("data", forward);
		fragments.on("paste", (text) => forward(`\x1b[200~${text}\x1b[201~`));
		super.start((data) => {
			if (data.startsWith("\x1b") && fragments.getBuffer() === "\x1b") {
				for (const pending of fragments.flush()) forward(pending);
			}
			// tmux can fold Escape + a report's ESC into CSI-u Alt+Escape. pi-tui 1.5 also consumes ESC ESC
			// as a Meta key when the next chunk begins with [. Recover Escape and reassemble the report's tail.
			if (data === "\x1b\x1b" || data === "\x1b[27;3u") {
				onInput("\x1b");
				recovering = true;
				fragments.process("\x1b");
			} else if (recovering) fragments.process(data);
			else onInput(data);
		}, onResize);
	}

	override stop(): void {
		this.fragments?.destroy();
		this.fragments = null;
		super.stop();
	}
}
