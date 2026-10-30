// A fake Anthropic Messages API that scripts a real Claude Code TUI offline. The latest user text picks the script:
//   reply <text>         answer "<text>"
//   hold <name>          signal <name>.entered, wait for <name>.release through Bash, answer "released <name>"
//   call <tool> <json>   call the tool whose name is <tool> or ends in __<tool> with <json>, then answer "tool done"
//   run <command>        say so, run <command> through Bash, then answer "tool done"
//   fail <text>          fail the request with a 400, which isn't retried
//   ask-both <id> <id> :: <question>  session_ask both sessions the question in one response, then answer "asked both"
// A message from another session (its text contains 'Message from session "', which swb mcp's instructions only name)
// is answered "got <its last line>".
// Requests without tools (titles) get a short reply, auto mode's classifier allows every action, and prompt suggestions none. Every request is appended to $FAKE_LOG as one
// JSON line: the latest prompt, whether it carried a tool result, the tools offered, every swb message marker seen, and
// the conversation as sent, instructions included.
import { appendFileSync } from "node:fs";
import { agentStep, readerQuestion, titleOf } from "./agent.ts";

const port = Number(process.env.FAKE_PORT ?? 0);
const log = process.env.FAKE_LOG ?? "/dev/null";
const signals = process.env.FAKE_SIGNALS ?? "/tmp";
let n = 0;

type Block = { type: string; text?: string; content?: unknown; name?: string };
type Msg = { role: string; content: string | Block[] };

const blocks = (m: Msg): Block[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);

/** The text a person or plugin typed: user text that isn't a reminder Claude Code inserted. */
function typed(m: Msg): string | undefined {
	if (m.role !== "user") return undefined;
	const texts = blocks(m)
		.filter((b) => b.type === "text" && !(b.text ?? "").startsWith("<system-reminder>") && !(b.text ?? "").startsWith("<local-command"))
		.map((b) => b.text ?? "");
	return texts.length > 0 ? texts.join("\n") : undefined;
}

/** The session Claude Code asks a title for, between its <session> tags. */
function title(request: string): string {
	return titleOf(/<session>\n([\s\S]*?)\n<\/session>/.exec(request)?.[1] ?? "Session");
}

function lastLine(text: string, after: string): string {
	const from = text.slice(text.lastIndexOf(after));
	return (
		from
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("This is how") && !line.startsWith("Response requested"))
			.at(-1) ?? ""
	);
}

const server = Bun.serve({
	port,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 });
		if (req.method !== "POST" || !url.pathname.endsWith("/v1/messages")) return Response.json({ data: [] });
		const body = (await req.json()) as { messages: Msg[]; stream?: boolean; model: string; tools?: { name: string }[] };
		const requestN = ++n;
		const id = `msg_${requestN}`;
		const messages = body.messages ?? [];
		// Native subagents can append a system message after the tool result.
		const last = messages.findLast((m) => m.role !== "system");
		const tools = (body.tools ?? []).map((tool) => tool.name);
		const interrupted = typed(last ?? { role: "system", content: "" })?.startsWith("[Request interrupted by user for tool use]");
		const toolResult = last && !interrupted ? blocks(last).some((b) => b.type === "tool_result") : false;
		const lastTyped = (
			[...messages]
				.reverse()
				.map(typed)
				.find((text) => text !== undefined) ?? ""
		).replace(/^\[Request interrupted by user for tool use\]\s*/, "");
		const raw = JSON.stringify(messages);
		const markers = [...new Set([...raw.matchAll(/SWB-[A-Za-z0-9-]+/g)].map((m) => m[0]))];
		// Claude Code sends a hook's added context as a system message after the tool result, so read through to the end.
		const lastText = messages
			.slice(last ? messages.lastIndexOf(last) : messages.length)
			.flatMap((m) => blocks(m).flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])))
			.join("\n");
		// What the tools answered in this request's last message, as the model reads it.
		const toolOutput = last
			? blocks(last)
					.filter((b) => b.type === "tool_result")
					.map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content)))
					.join("\n")
			: "";
		appendFileSync(
			log,
			`${JSON.stringify({ n: requestN, at: Date.now(), model: body.model, prompt: lastTyped.slice(0, 400), toolResult, toolOutput: toolOutput.slice(0, 4000), lastText: lastText.slice(0, 400), tools, toolSpecs: body.tools, system: (body as { system?: unknown }).system, markers, context: raw.slice(0, 200_000) })}\n`,
		);
		// A slow model response keeps the native reader alive without giving it a write-capable holding tool.
		const hold = /^reader-hold (\d+)/.exec(readerQuestion(lastTyped) ?? "");
		if (hold && !toolResult) await Bun.sleep(Number(hold[1]));

		const [verb, ...rest] = lastTyped.trim().split(" ");
		// Claude Code joins a prompt that failed to the next one, so only the newest paragraph can fail again.
		if (tools.length > 0 && verb === "fail" && !lastTyped.includes("\n\n"))
			return Response.json(
				{ type: "error", error: { type: "invalid_request_error", message: `invalid request: ${rest.join(" ")}` } },
				{ status: 400 },
			);
		const answered = messages.findLastIndex((m) => m.role === "assistant") > messages.findLastIndex((m) => typed(m) !== undefined);
		let content: object[];
		const step = tools.length > 0 && (toolResult || !answered) ? agentStep(lastTyped, toolResult ? toolOutput : null) : null;
		const both = /^ask-both (\S+) (\S+) :: (.+)$/s.exec(lastTyped.trim());
		if (both && tools.length > 0 && !toolResult && !answered) {
			const name = tools.find((candidate) => candidate.endsWith("__session_ask")) ?? "session_ask";
			content = [both[1], both[2]].map((session, i) => ({
				type: "tool_use",
				id: `toolu_${requestN}_${i}`,
				name,
				input: { session, question: both[3] },
			}));
		} else if (both && toolResult) {
			content = [{ type: "text", text: "asked both" }];
		} else if (step && "tool" in step) {
			const name = tools.find((candidate) => candidate.endsWith(`__${step.tool}`)) ?? step.tool;
			content = [{ type: "tool_use", id: `toolu_${requestN}`, name, input: step.args }];
		} else if (step) {
			content = [{ type: "text", text: step.text }];
		} else if (tools.length > 0 && !toolResult && !answered && verb === "hold") {
			const name = rest.join(" ");
			const command = `echo entered > ${signals}/${name}.entered; until [ -e ${signals}/${name}.release ]; do sleep 0.1; done`;
			content = [{ type: "tool_use", id: `toolu_${requestN}`, name: "Bash", input: { command, description: "Hold", timeout: 600000 } }];
		} else if (tools.length > 0 && !toolResult && !answered && verb === "run") {
			const command = rest.join(" ");
			content = [
				{ type: "text", text: `Running ${command}.` },
				{ type: "tool_use", id: `toolu_${requestN}`, name: "Bash", input: { command, description: "Run", timeout: 600000 } },
			];
		} else if (tools.length > 0 && !toolResult && !answered && verb === "call") {
			const [tool, ...json] = rest;
			const name = tools.find((candidate) => candidate === tool || candidate.endsWith(`__${tool}`)) ?? (tool as string);
			content = [{ type: "tool_use", id: `toolu_${requestN}`, name, input: JSON.parse(json.join(" ") || "{}") }];
		} else {
			const header = 'Message from session "';
			const inbound = lastText.includes(header) ? lastText : lastTyped.includes(header) ? lastTyped : "";
			const text = inbound
				? `got ${lastLine(inbound, header)}`
				: lastTyped.startsWith("[SUGGESTION MODE")
					? ""
					: tools.length === 0 && lastTyped.startsWith("<session>")
						? JSON.stringify({ title: title(lastTyped) })
						: tools.length === 0 && lastTyped.startsWith("<transcript>")
							? "<severity>10</severity>"
							: tools.length === 0
								? "ok"
								: verb === "hold"
									? `released ${rest.join(" ")}`
									: verb === "reply"
										? rest.join(" ")
										: toolResult
											? "tool done"
											: `ack ${lastTyped.slice(0, 60)}`;
			content = [{ type: "text", text }];
		}
		const stop = content.some((c) => (c as { type: string }).type === "tool_use") ? "tool_use" : "end_turn";
		const message = {
			id,
			type: "message",
			role: "assistant",
			model: body.model,
			content,
			stop_reason: stop,
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 5 },
		};
		if (!body.stream) return Response.json(message);
		const events: object[] = [{ type: "message_start", message: { ...message, content: [], stop_reason: null } }];
		content.forEach((block, index) => {
			const b = block as { type: string; text?: string; id?: string; name?: string; input?: object };
			if (b.type === "text") {
				events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
				events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
			} else {
				events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
				events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
			}
			events.push({ type: "content_block_stop", index });
		});
		events.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
		events.push({ type: "message_stop" });
		return new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
			headers: { "content-type": "text/event-stream" },
		});
	},
});
// The harness reads the port the server bound.
console.log(server.port);
