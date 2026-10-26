import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	getCurrentTools,
	Type,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentStep, readerQuestion } from "./fakes/agent.ts";

// Scripted turns for e2e scenarios. The user's prompt picks the script:
//   reply <text>      answer with <text>
//   tool <text>       run `echo <text>` through bash, then answer "tool done <text>"
//   run <command>     say so, run <command> through bash, then answer "tool done <command>"
//   fail <text>       end the turn on a provider error that isn't retried
//   hold <name>       signal <name>.entered, wait for <name>.release, answer "released <name>"
//   attention <name>  like hold, inside a glimpse attention span
//   confirm <name>    ask in pi's own confirm dialog, signalling <name>.entered, then answer "tool done <name>"
//   both <name>       inside a glimpse attention span, ask like confirm, signal <name>.answered, then hold the span
//                     until <name>.release
//   subagent <name>   launch a real pi-sessions subagent whose task is `reply child <name>`; the child holds like
//                     `hold child.<name>` before answering, signalling its active tools as `child.<name>.tools`
//   handoff <name>    launch a new pi session through swb's session_launch, with the goal `reply child <name>`
//   message <id> <n>  send session <id> a message with swb's session_send_message, which it answers like `reply <n>`
//   reach <n>         find the first dormant session through session_reachable and message it like `message`
//   call <tool> <json>  call any tool with those arguments, then answer "tool done call"
//   tools [name]      signal the active tool names as `tools` or `tools.<name>`, and answer "tools listed"
//   tell <harness> <m>, launch <harness> <title>, show <title>, update <title> <json>   use swb's tools as fakes/agent.ts scripts them
// A message from another session (it starts "Message from session") whose body is `reply <n>` is answered like it.
//   archive <text>    call swb_update_session to archive itself, then answer "tool done <text>"
// "Continue where you left off.", which waking a cut-off session sends, is answered "continued".
// A pi that starts while start.hold exists signals start.entered and blocks until start.release.
// A turn that starts while turn.hold exists signals turn.entered and waits for turn.release before agent_start.
// A pi that shuts down while shutdown.hold exists signals shutdown.entered and waits for shutdown.release.
// Every SIGTERM a pi receives appends its pid to sigterm.
// pi-sessions' handoff extraction is answered with a fixed briefing.
// `archive flaky` fails its post-tool reply once with a retryable provider error.
// `/e2e-kick <prompt>` starts a turn with a custom message, the way a pi-sessions handoff child kicks off.
// Raw terminal input is appended to input.log as JSON lines; `/e2e-bg` asks the terminal for its background (OSC 11) and palette color 9 (OSC 4).
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
	if (process.env.SWB_E2E_LOGIN_SHELL) signal("login-shell");
	if (existsSync(join(signals, "start.hold"))) {
		signal("start.entered");
		const sleeper = new Int32Array(new SharedArrayBuffer(4));
		while (!existsSync(join(signals, "start.release"))) Atomics.wait(sleeper, 0, 0, 50);
	}
	const faux = fauxProvider({
		tokensPerSecond: 10_000,
		...(existsSync(join(signals, "recall.reasoning")) ? { models: [{ id: "faux-1", reasoning: true }] } : {}),
	});

	const script: FauxResponseFactory = async (context, options, _state, model) => {
		const last = context.messages.at(-1);
		if (!last) throw new Error("scenario: empty context");
		const typed = context.messages.findLast((message) => message.role === "user");
		const promptText = typed ? text(typed).trim() : "";
		if (/^(Question about session |ask(?:-id)? |search )/.test(promptText)) {
			mkdirSync(signals, { recursive: true });
			appendFileSync(
				join(signals, "recall.jsonl"),
				`${JSON.stringify({ at: Date.now(), pid: process.pid, prompt: promptText, role: last.role, tools: getCurrentTools(context.messages).map((tool) => tool.name), model: `${model.provider}/${model.id}`, thinking: options?.reasoning, text: text(last) })}\n`,
			);
			if (readerQuestion(promptText) === "hold-reader" && last.role === "user") {
				signal("reader.entered");
				try {
					await released("reader", options?.signal);
				} catch (error) {
					if (options?.signal?.aborted) signal("reader.aborted");
					throw error;
				} finally {
					signal("reader.exited");
				}
			}
		}
		const step = typed ? agentStep(text(typed).trim(), last.role === "toolResult" ? text(last) : null) : null;
		if (step && "tool" in step) return fauxAssistantMessage(fauxToolCall(step.tool, step.args as never), { stopReason: "toolUse" });
		if (step) return fauxAssistantMessage(step.text);
		if (last.role === "toolResult") {
			const prompt = text(context.messages.findLast((message) => message.role === "user") as Message);
			if ((last as { toolName?: string }).toolName === "session_reachable") {
				const dormant = /^- (\S+) · .* · dormant · /m.exec(text(last))?.[1];
				if (!dormant) throw new Error(`scenario: nothing dormant to reach in ${text(last)}`);
				return fauxAssistantMessage(
					fauxToolCall("session_send_message", {
						session: dormant,
						message: `wake-reply ${prompt.split(" ")[1]}`,
						requestResponse: false,
					}),
					{ stopReason: "toolUse" },
				);
			}
			if (prompt === "archive flaky" && !existsSync(join(signals, "flaky.failed"))) {
				signal("flaky.failed");
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" });
			}
			return fauxAssistantMessage(`tool done ${prompt.split(" ").slice(1).join(" ")}`);
		}
		const prompt = text(last).trim();
		if (prompt === "Continue where you left off.") return fauxAssistantMessage("continued");
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
			writeFileSync(join(signals, `child.${child[1]}.tools`), JSON.stringify(pi.getActiveTools()));
			signal(`child.${child[1]}.entered`);
			await released(`child.${child[1]}`, options?.signal);
			return fauxAssistantMessage(`child ${child[1]} done`);
		}
		if (prompt.startsWith("Message from session")) {
			const body = prompt.split("\n\n")[1] ?? "";
			const replied = /^reply (\S+)/.exec(body);
			if (replied) {
				signal(`replied.${replied[1]}`);
				return fauxAssistantMessage(`got ${replied[1]}`);
			}
			return fauxAssistantMessage(`got ${body}`);
		}
		const [verb, ...rest] = prompt.split(" ");
		const arg = rest.join(" ");
		switch (verb) {
			case "reply":
				signal(`replied.${arg}`);
				return fauxAssistantMessage(arg);
			case "tool":
				return fauxAssistantMessage(fauxToolCall("bash", { command: `echo ${arg}` }), { stopReason: "toolUse" });
			case "run":
				return fauxAssistantMessage([fauxText(`Running ${arg}.`), fauxToolCall("bash", { command: arg })], { stopReason: "toolUse" });
			case "fail":
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: `400 invalid request: ${arg}` });
			case "hold":
				signal(`${arg}.entered`);
				await released(arg, options?.signal);
				return fauxAssistantMessage(`released ${arg}`);
			case "subagent":
				return fauxAssistantMessage(
					fauxToolCall("subagent_launch", { title: `child ${arg}`, goal: `reply child ${arg}`, requestResponse: true }),
					{
						stopReason: "toolUse",
					},
				);
			case "handoff":
				return fauxAssistantMessage(
					fauxToolCall("session_launch", { harness: "pi", title: `child ${arg}`, goal: `reply child ${arg}`, requestResponse: false }),
					{
						stopReason: "toolUse",
					},
				);
			case "call":
				return fauxAssistantMessage(fauxToolCall(rest[0] as string, JSON.parse(rest.slice(1).join(" ") || "{}")), {
					stopReason: "toolUse",
				});
			case "tools":
				writeFileSync(join(signals, arg ? `tools.${arg}` : "tools"), JSON.stringify(pi.getActiveTools()));
				return fauxAssistantMessage("tools listed");
			case "message":
				return fauxAssistantMessage(
					fauxToolCall("session_send_message", { session: rest[0] as string, message: `wake-reply ${rest[1]}`, requestResponse: false }),
					{
						stopReason: "toolUse",
					},
				);
			case "reach":
				return fauxAssistantMessage(fauxToolCall("session_reachable", {}), { stopReason: "toolUse" });
			case "archive":
				return fauxAssistantMessage(fauxToolCall("swb_update_session", { archived: true }), { stopReason: "toolUse" });
			case "attention":
				return fauxAssistantMessage(fauxToolCall("e2e_attention", { name: arg }), { stopReason: "toolUse" });
			case "confirm":
				return fauxAssistantMessage(fauxToolCall("e2e_confirm", { name: arg }), { stopReason: "toolUse" });
			case "both":
				return fauxAssistantMessage(fauxToolCall("e2e_both", { name: arg }), { stopReason: "toolUse" });
			default:
				throw new Error(`scenario: unknown prompt ${JSON.stringify(prompt)}`);
		}
	};
	faux.setResponses(Array.from({ length: 1000 }, () => script as never));
	pi.registerProvider(faux.provider);

	const askTiming = (data: { type: string; toolName: string; toolCallId: string }) => {
		if (data.toolName !== "session_ask") return;
		appendFileSync(join(signals, "ask-timing.jsonl"), `${JSON.stringify({ event: data.type, at: Date.now(), id: data.toolCallId })}\n`);
	};
	pi.on("tool_execution_start", askTiming);
	pi.on("tool_execution_end", askTiming);

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

	pi.on("before_agent_start", async () => {
		if (!existsSync(join(signals, "turn.hold"))) return;
		signal("turn.entered");
		await released("turn", undefined);
	});

	process.on("SIGTERM", () => appendFileSync(join(signals, "sigterm"), `${process.pid}\n`));

	pi.on("session_shutdown", async () => {
		if (!existsSync(join(signals, "shutdown.hold"))) return;
		signal("shutdown.entered");
		await released("shutdown", undefined);
	});

	pi.registerTool({
		name: "e2e_confirm",
		label: "E2E confirm",
		description: "Asks the person to confirm, in pi's own dialog",
		parameters: Type.Object({ name: Type.String() }),
		async execute(_id, params, _abort, _update, ctx) {
			signal(`${params.name}.entered`);
			const yes = await ctx.ui.confirm(`Confirm ${params.name}?`, "The e2e scenario asks.");
			return { content: [{ type: "text", text: yes ? "confirmed" : "declined" }], details: undefined };
		},
	});

	pi.registerTool({
		name: "e2e_both",
		label: "E2E both",
		description: "Asks in pi's own dialog inside a glimpse attention span, which outlasts it",
		parameters: Type.Object({ name: Type.String() }),
		async execute(_id, params, abort, _update, ctx) {
			const attentionId = `e2e-${params.name}`;
			pi.events.emit("glimpseui:attention:request", { attentionId });
			try {
				signal(`${params.name}.entered`);
				await ctx.ui.confirm(`Confirm ${params.name}?`, "The e2e scenario asks.");
				signal(`${params.name}.answered`);
				await released(params.name, abort);
			} finally {
				pi.events.emit("glimpseui:attention:resolve", { attentionId });
			}
			return { content: [{ type: "text", text: "both done" }], details: undefined };
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
		description: "Query the terminal background and palette color 9",
		handler: async () => {
			process.stdout.write("\x1b]11;?\x1b\\\x1b]4;9;?\x1b\\");
		},
	});
}
