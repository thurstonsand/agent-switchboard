import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Scripted turns for e2e scenarios. The user's prompt picks the script:
//   reply <text>      answer with <text>
//   tool <text>       run `echo <text>` through bash, then answer "tool done <text>"
//   hold <name>       signal <name>.entered, wait for <name>.release, answer "released <name>"
//   attention <name>  like hold, inside a glimpse attention span
// Signals live in $HOME/e2e-signals because HOME survives the sessions server's scrubbed environment.

const signals = join(process.env.HOME ?? "", "e2e-signals");

function signal(name: string): void {
	mkdirSync(signals, { recursive: true });
	writeFileSync(join(signals, name), String(Date.now()));
}

async function released(name: string, abort: AbortSignal | undefined): Promise<void> {
	while (!existsSync(join(signals, `${name}.release`))) {
		if (abort?.aborted) throw new Error(`hold ${name} aborted`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

type Message = { role: string; content: unknown };

function text(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return (message.content as { type: string; text?: string }[])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

export default function (pi: ExtensionAPI) {
	const faux = fauxProvider({ tokensPerSecond: 10_000 });

	const script = async (context: { messages: Message[] }, options: { signal?: AbortSignal } | undefined) => {
		const last = context.messages.at(-1);
		if (!last) throw new Error("scenario: empty context");
		if (last.role === "toolResult") {
			const prompt = text(context.messages.findLast((message) => message.role === "user") as Message);
			return fauxAssistantMessage(`tool done ${prompt.split(" ").slice(1).join(" ")}`);
		}
		const prompt = text(last).trim();
		const [verb, ...rest] = prompt.split(" ");
		const arg = rest.join(" ");
		switch (verb) {
			case "reply":
				return fauxAssistantMessage(arg);
			case "tool":
				return fauxAssistantMessage(fauxToolCall("bash", { command: `echo ${arg}` }), { stopReason: "toolUse" });
			case "hold":
				signal(`${arg}.entered`);
				await released(arg, options?.signal);
				return fauxAssistantMessage(`released ${arg}`);
			case "attention":
				return fauxAssistantMessage(fauxToolCall("e2e_attention", { name: arg }), { stopReason: "toolUse" });
			default:
				throw new Error(`scenario: unknown prompt ${JSON.stringify(prompt)}`);
		}
	};
	faux.setResponses(Array.from({ length: 1000 }, () => script as never));
	pi.registerProvider(faux.provider);

	pi.registerTool({
		name: "e2e_attention",
		label: "E2E attention",
		description: "Waits for the e2e harness inside a glimpse attention span",
		parameters: Type.Object({ name: Type.String() }),
		async execute(_id, params, abort) {
			const attentionId = `e2e-${params.name}`;
			pi.events.emit("glimpseui:attention:request", { attentionId });
			signal(`${params.name}.entered`);
			try {
				await released(params.name, abort);
			} finally {
				pi.events.emit("glimpseui:attention:resolve", { attentionId });
			}
			return { content: [{ type: "text", text: `attention ${params.name} released` }], details: undefined };
		},
	});
}
