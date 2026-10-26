// A fake OpenAI Responses API that scripts a real Codex TUI offline. The latest user text picks the script:
//   reply <text>         answer "<text>"
//   hold <name>          signal <name>.entered, wait for <name>.release through the shell, answer "released <name>"
//   call <tool> <json>   call the tool whose name ends in <tool> with <json>, then answer "tool done"; after a multi-agent
//                        v2 spawn_agent, wait for the subagent first, as a model does, so `codex exec` doesn't end it
//   run <command>        run <command> through the shell, then answer "ran <command>"
//   fail <text>          fail the request with a 400, which isn't retried
//   hold-compact <name>  the next /compact signals <name>.entered and waits for <name>.release before it summarizes
// A message from another session (it starts "Message from session") is answered "got <its last line>", a multi-agent
// v2 subagent's task is its prompt, and session_ask's reader follows readerStep.
// Every request is appended to $FAKE_LOG as one JSON line: the user texts it saw, the tools it was offered, and its
// whole input, instructions included.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { agentStep, readerQuestion, titleOf } from "./agent.ts";

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
		.flatMap((item) => {
			if (item.type === "message" && item.role === "user") return [(item.content ?? []).map((part) => part.text ?? "").join("")];
			// A multi-agent v2 subagent's task. OpenAI's model writes it as a token only OpenAI reads; this one's is
			// "gAAAAA" and the prompt in base64url, which only the fake reads.
			const task = (item.content ?? []).find((part) => part.type === "encrypted_content") as { encrypted_content?: string } | undefined;
			const token = task?.encrypted_content ?? "";
			const text = token.startsWith("gAAAAA") ? Buffer.from(token.slice(6), "base64url").toString() : token;
			return item.type === "agent_message" && text ? [text] : [];
		})
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

/**
 * session_ask's reader, whose prompt is "Question about session <id>:" and one of:
 *   reader-hold         signal reader-hold.entered, then run `true` through the shell once a second until reader-hold.release exists
 *   reader-shell <file> read <file> through the shell, then answer with what it printed
 *   reader-exec <path>  write <path> through the shell and through apply_patch, then answer with what each returned
 */
async function readerStep(
	probe: string,
	arg: string,
	names: string[],
	outputs: string[],
	aborted: AbortSignal,
): Promise<{ tool: string; args: object } | { text: string }> {
	if (probe === "hold") {
		if (existsSync(`${signals}/reader-hold.release`)) return { text: `reader hold: released after ${outputs.length} calls` };
		writeFileSync(`${signals}/reader-hold.entered`, "entered\n");
		for (let waited = 0; waited < 1000 && !aborted.aborted; waited += 50) await Bun.sleep(50);
		const call = shell(names, "true");
		return { tool: call.name, args: call.args };
	}
	const script =
		probe === "shell"
			? [shell(names, `grep -n SWB-file ${arg}`)]
			: [
					shell(names, `echo reader-wrote > ${arg}`),
					{ name: "apply_patch", args: { input: `*** Begin Patch\n*** Add File: ${arg}\n+reader-patched\n*** End Patch\n` } },
				];
	const next = script[outputs.length];
	return next ? { tool: next.name, args: next.args } : { text: `reader ${probe}: ${outputs.join(" | ")}` };
}

const server = Bun.serve({
	port,
	hostname: "127.0.0.1",
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method !== "POST" || !url.pathname.endsWith("/responses")) return Response.json({ data: [], models: [] });
		const body = (await req.json()) as { input?: Item[]; tools?: Tool[]; model?: string };
		const input = body.input ?? [];
		const texts = userTexts(input);
		const last = input.at(-1);
		const tools = toolNames(body.tools ?? []);
		const names = tools.map((tool) => tool.name);
		const id = `resp_${++n}`;
		appendFileSync(
			log,
			`${JSON.stringify({ n, at: Date.now(), model: body.model, texts, last: last?.type, tools: names, toolOutput: last?.type === "function_call_output" ? outputText(last).slice(0, 4000) : null, context: JSON.stringify(input).slice(0, 200_000) })}\n`,
		);
		const prompt = (texts.at(-1) ?? "").trim();
		const answering = last?.type === "message";
		let output: object;
		const [verb, ...rest] = prompt.split(" ");
		const compactHold = prompt.startsWith("You are performing a CONTEXT CHECKPOINT COMPACTION")
			? texts.map((text) => /^hold-compact (\S+)/.exec(text)?.[1]).find(Boolean)
			: undefined;
		if (compactHold) {
			writeFileSync(`${signals}/${compactHold}.entered`, "entered\n");
			while (!existsSync(`${signals}/${compactHold}.release`)) await Bun.sleep(100);
		}
		if (verb === "fail")
			return Response.json(
				{ error: { type: "invalid_request_error", code: null, param: null, message: `invalid request: ${rest.join(" ")}` } },
				{ status: 400 },
			);
		const readerProbe = /^reader-(hold|shell|exec)(?: (.+))?$/.exec(readerQuestion(prompt) ?? "");
		let toolOutput = answering ? null : outputText(last);
		// Codex presents an MCP result's structured content under its timing wrapper; the shared script wants the answer text.
		if (toolOutput && /^ask(?:-id)? /.test(prompt)) {
			const answer = /\{"answer":("(?:[^"\\]|\\.)*")\}/.exec(toolOutput)?.[1];
			if (answer) toolOutput = JSON.parse(answer) as string;
		}
		const step = answering || last?.type === "function_call_output" ? agentStep(prompt, toolOutput) : null;
		if (readerProbe) {
			const [, probe, arg = ""] = readerProbe as unknown as [string, string, string?];
			const outputs = input.filter((item) => item.type === "function_call_output").map(outputText);
			const move = await readerStep(probe, arg, names, outputs, req.signal);
			output =
				"tool" in move
					? { type: "function_call", call_id: `call_${n}`, name: move.tool, arguments: JSON.stringify(move.args) }
					: { type: "message", role: "assistant", id: `msg_${n}`, content: [{ type: "output_text", text: move.text }] };
		} else if (step && "tool" in step) {
			const found = tools.find((candidate) => candidate.name === step.tool) ?? { name: step.tool };
			output = { type: "function_call", call_id: `call_${n}`, ...found, arguments: JSON.stringify(step.args) };
		} else if (step) {
			output = { type: "message", role: "assistant", id: `msg_${n}`, content: [{ type: "output_text", text: step.text }] };
		} else if (answering && verb === "hold") {
			const name = rest.join(" ");
			const call = shell(names, `echo entered > ${signals}/${name}.entered; until [ -e ${signals}/${name}.release ]; do sleep 0.1; done`);
			output = { type: "function_call", call_id: `call_${n}`, name: call.name, arguments: JSON.stringify(call.args) };
		} else if (answering && verb === "run") {
			const call = shell(names, rest.join(" "));
			output = { type: "function_call", call_id: `call_${n}`, name: call.name, arguments: JSON.stringify(call.args) };
		} else if (answering && verb === "call") {
			const [tool, ...json] = rest;
			const found = tools.find((candidate) => candidate.name === tool) ?? { name: tool as string };
			output = { type: "function_call", call_id: `call_${n}`, ...found, arguments: json.join(" ") || "{}" };
		} else if (
			verb === "call" &&
			rest[0] === "spawn_agent" &&
			last?.type === "function_call_output" &&
			names.includes("wait_agent") &&
			!input.some((item) => item.name === "wait_agent")
		) {
			const found = tools.find((candidate) => candidate.name === "wait_agent") ?? { name: "wait_agent" };
			output = { type: "function_call", call_id: `call_${n}`, ...found, arguments: JSON.stringify({ timeout_ms: 30_000 }) };
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
								: verb === "run"
									? `ran ${rest.join(" ")}`
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
