// A fake OpenAI Responses API that scripts a real Codex TUI offline. The latest user text picks the script:
//   reply <text>         answer "<text>"
//   hold <name>          signal <name>.entered, wait for <name>.release through the shell, answer "released <name>"
//   call <tool> <json>   call the tool whose name ends in <tool> with <json>, then answer "tool done"
// A message from another session (it starts "Message from session") is answered "got <its last line>".
// Every request is appended to $FAKE_LOG as one JSON line: the user texts it saw, the tools it was offered, and its
// whole input, instructions included.
import { appendFileSync } from "node:fs";
import { agentStep, titleOf } from "./agent.ts";

const port = Number(process.env.FAKE_PORT ?? 0);
const log = process.env.FAKE_LOG ?? "/dev/null";
const signals = process.env.FAKE_SIGNALS ?? "/tmp";
let n = 0;

type Part = { type: string; text?: string };
type Item = { type: string; role?: string; content?: Part[]; name?: string; output?: unknown };

/** A tool call's output as the model reads it. */
function outputText(item: Item | undefined): string {
	const output = item?.output;
	if (typeof output === "string") return output;
	if (Array.isArray(output)) return (output as Part[]).map((part) => part.text ?? "").join("\n");
	return JSON.stringify(output ?? "");
}
type Tool = { type: string; name?: string; tools?: Tool[] };

function userTexts(input: Item[]): string[] {
	return input
		.filter((item) => item.type === "message" && item.role === "user")
		.map((item) => (item.content ?? []).map((part) => part.text ?? "").join(""))
		.filter((text) => !text.startsWith("<environment_context>") && !text.startsWith("# AGENTS.md"));
}

/** Tool names, with the namespace Codex nests each MCP server's tools under. */
function toolNames(tools: Tool[], namespace?: string): { name: string; namespace?: string }[] {
	return tools.flatMap((tool) =>
		tool.type === "namespace"
			? toolNames(tool.tools ?? [], tool.name)
			: tool.name
				? [{ name: tool.name, ...(namespace ? { namespace } : {}) }]
				: [],
	);
}

function shell(names: string[], command: string): { name: string; args: object } {
	if (names.includes("exec_command")) return { name: "exec_command", args: { cmd: command, yield_time_ms: 600_000 } };
	if (names.includes("shell_command")) return { name: "shell_command", args: { command, timeout_ms: 600_000 } };
	return { name: "shell", args: { command: ["bash", "-lc", command], timeout_ms: 600_000 } };
}

const server = Bun.serve({
	port,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method !== "POST" || !url.pathname.endsWith("/responses")) return Response.json({ data: [], models: [] });
		const body = (await req.json()) as { input?: Item[]; tools?: Tool[] };
		const input = body.input ?? [];
		const texts = userTexts(input);
		const last = input.at(-1);
		const tools = toolNames(body.tools ?? []);
		const names = tools.map((tool) => tool.name);
		const id = `resp_${++n}`;
		appendFileSync(
			log,
			`${JSON.stringify({ n, texts, last: last?.type, tools: names, toolOutput: last?.type === "function_call_output" ? outputText(last).slice(0, 4000) : null, context: JSON.stringify(input).slice(0, 200_000) })}\n`,
		);
		const prompt = (texts.at(-1) ?? "").trim();
		const answering = last?.type === "message";
		let output: object;
		const [verb, ...rest] = prompt.split(" ");
		const step = answering || last?.type === "function_call_output" ? agentStep(prompt, answering ? null : outputText(last)) : null;
		if (step && "tool" in step) {
			const found = tools.find((candidate) => candidate.name === step.tool) ?? { name: step.tool };
			output = { type: "function_call", call_id: `call_${n}`, ...found, arguments: JSON.stringify(step.args) };
		} else if (step) {
			output = { type: "message", role: "assistant", id: `msg_${n}`, content: [{ type: "output_text", text: step.text }] };
		} else if (answering && verb === "hold") {
			const name = rest.join(" ");
			const call = shell(names, `echo entered > ${signals}/${name}.entered; until [ -e ${signals}/${name}.release ]; do sleep 0.1; done`);
			output = { type: "function_call", call_id: `call_${n}`, name: call.name, arguments: JSON.stringify(call.args) };
		} else if (answering && verb === "call") {
			const [tool, ...json] = rest;
			const found = tools.find((candidate) => candidate.name === tool) ?? { name: tool as string };
			output = { type: "function_call", call_id: `call_${n}`, ...found, arguments: json.join(" ") || "{}" };
		} else {
			const titled = /^Generate a concise, single-line task title[\s\S]*?User prompt:\n([\s\S]+)/.exec(prompt)?.[1];
			const text = titled
				? JSON.stringify({ title: titleOf(titled) })
				: prompt.startsWith("Message from session")
					? `got ${prompt.split("\n").filter(Boolean).at(-1)}`
					: verb === "hold"
						? `released ${rest.join(" ")}`
						: verb === "reply"
							? rest.join(" ")
							: verb === "call"
								? "tool done"
								: `ack ${prompt.slice(0, 60)}`;
			output = { type: "message", role: "assistant", id: `msg_${n}`, content: [{ type: "output_text", text }] };
		}
		const usage = { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 };
		const events = [
			{ type: "response.created", response: { id } },
			{ type: "response.output_item.done", item: output },
			{ type: "response.completed", response: { id, usage } },
		];
		return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "content-type": "text/event-stream" },
		});
	},
});
// The harness reads the port the server bound.
console.log(server.port);
