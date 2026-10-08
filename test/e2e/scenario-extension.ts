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
//   handoff <name>    hand off to the swb host, with the task `reply child <name>`
//   message <id> <n>  send session <id> a pi-sessions message, which it answers like `reply <n>`
//   archive <text>    call swb_archive, then answer "tool done <text>"
// A pi that starts while start.hold exists signals start.entered and blocks until start.release.
// pi-sessions' handoff extraction is answered with a fixed briefing.
// `archive flaky` fails its post-tool reply once with a retryable provider error.
// `/e2e-kick <prompt>` starts a turn with a custom message, the way a pi-sessions handoff child kicks off.
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
	if (existsSync(join(signals, "start.hold"))) {
		signal("start.entered");
		const sleeper = new Int32Array(new SharedArrayBuffer(4));
		while (!existsSync(join(signals, "start.release"))) Atomics.wait(sleeper, 0, 0, 50);
	}
	const faux = fauxProvider({ tokensPerSecond: 10_000 });

	const script = async (context: { messages: Message[] }, options: { signal?: AbortSignal } | undefined) => {
		const last = context.messages.at(-1);
		if (!last) throw new Error("scenario: empty context");
		if (last.role === "toolResult") {
			const prompt = text(context.messages.findLast((message) => message.role === "user") as Message);
			if (prompt === "archive flaky" && !existsSync(join(signals, "flaky.failed"))) {
				signal("flaky.failed");
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" });
			}
			return fauxAssistantMessage(`tool done ${prompt.split(" ").slice(1).join(" ")}`);
		}
		const prompt = text(last).trim();
		if (prompt.includes("<handoff-goal>")) {
			return fauxAssistantMessage(fauxToolCall("create_handoff_context", { summary: "e2e", relevantFiles: [] }), {
				stopReason: "toolUse",
			});
		}
		const relayed = /wake-reply (\S+)/.exec(prompt);
		if (relayed && !prompt.startsWith("message ")) {
			signal(`replied.${relayed[1]}`);
			return fauxAssistantMessage(relayed[1] as string);
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
			case "handoff":
				return fauxAssistantMessage(
					fauxToolCall("session_handoff", {
						title: `child ${arg}`,
						goal: `reply child ${arg}`,
						launch: verb === "handoff" ? "swb" : verb,
					}),
					{ stopReason: "toolUse" },
				);
			case "message":
				return fauxAssistantMessage(
					fauxToolCall("session_send_message", { session: rest[0] as string, message: `wake-reply ${rest[1]}` }),
					{
						stopReason: "toolUse",
					},
				);
			case "archive":
				return fauxAssistantMessage(fauxToolCall("swb_archive", {}), { stopReason: "toolUse" });
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

	pi.registerCommand("e2e-kick", {
		description: "Start a turn with a custom message",
		handler: async (args) => {
			pi.sendMessage({ customType: "e2e-kick", content: args, display: true }, { triggerTurn: true });
		},
	});

	pi.registerCommand("e2e-bg", {
		description: "Query the terminal background",
		handler: async () => {
			process.stdout.write("\x1b]11;?\x1b\\");
		},
	});
}
