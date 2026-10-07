import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Scripted turns for e2e scenarios. The user's prompt picks the script:
//   reply <text>      answer with <text>
//   tool <text>       run `echo <text>` through bash, then answer "tool done <text>"
//   hold <name>       signal <name>.entered, wait for <name>.release, answer "released <name>"
//   attention <name>  like hold, inside a glimpse attention span
//   subagent <name>   launch a real pi-sessions subagent whose task is `reply child <name>`; the child holds like
//                     `hold child.<name>` before answering
//   deferred <name>   prepare a deferred pi-sessions handoff whose task is `reply child <name>`
// pi-sessions' handoff extraction is answered with a fixed briefing.
// Raw terminal input is appended to input.log as JSON lines; `/e2e-bg` asks the terminal for its background (OSC 11).
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
		if (prompt.includes("<handoff-goal>")) {
			return fauxAssistantMessage(fauxToolCall("create_handoff_context", { summary: "e2e", relevantFiles: [] }), {
				stopReason: "toolUse",
			});
		}
		const child = /reply child (\S+)/.exec(prompt);
		if (child && !prompt.startsWith("reply ")) {
			signal(`child.${child[1]}.entered`);
			await released(`child.${child[1]}`, options?.signal);
			return fauxAssistantMessage(`child ${child[1]} done`);
		}
		const [verb, ...rest] = prompt.split(" ");
		const arg = rest.join(" ");
		switch (verb) {
			case "reply":
				signal(`replied.${arg}`);
				return fauxAssistantMessage(arg);
			case "tool":
				return fauxAssistantMessage(fauxToolCall("bash", { command: `echo ${arg}` }), { stopReason: "toolUse" });
			case "hold":
				signal(`${arg}.entered`);
				await released(arg, options?.signal);
				return fauxAssistantMessage(`released ${arg}`);
			case "subagent":
			case "deferred":
				return fauxAssistantMessage(
					fauxToolCall("session_handoff", {
						title: `child ${arg}`,
						goal: `reply child ${arg}`,
						launch: verb === "subagent" ? "subagent" : "deferred",
					}),
					{ stopReason: "toolUse" },
				);
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

	pi.on("session_start", (_event, ctx) => {
		mkdirSync(signals, { recursive: true });
		appendFileSync(join(signals, "session_start"), "started\n");
		ctx.ui.onTerminalInput((data) => {
			appendFileSync(join(signals, "input.log"), `${JSON.stringify(data)}\n`);
			return undefined;
		});
	});

	pi.registerCommand("e2e-bg", {
		description: "Query the terminal background",
		handler: async () => {
			process.stdout.write("\x1b]11;?\x1b\\");
		},
	});
}
