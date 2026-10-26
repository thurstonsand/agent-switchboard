// What a scripted agent does with swb's tools, the same in every harness's fake model:
//   tell <pi|claude|codex> <message>   find that harness's session with session_reachable, then message it
//   flood <pi|claude|codex> <n>        tell it a message of <n> characters
//   launch <pi|claude|codex> <title>   start a session there with session_launch, whose goal is the title
//   show <title>                       find the session with that title with session_reachable, then swb_show_session it
//   update <title> <json>              find it the same way, then swb_update_session it with those arguments
//   ask <title> :: <question>          find it the same way, then session_ask it the question; answers "asked: <result>"
//   ask-id <id> :: <question>          session_ask that session directly, archived or not
//   search <query>                     session_search the query; answers "searched"
// session_ask's reader, whose prompt starts "Question about session <id>:", reads it with recall_read and answers
// "reader found: <every SWB- marker in it>", or "reader found nothing".
// Each call gets the prompt and the output of the tool it called last (null for a fresh turn), and answers the next
// tool call, or the final text, or null when the prompt isn't one of these.

const NAMES: Record<string, string> = { pi: "pi", claude: "Claude Code", codex: "Codex" };

/** A title for a session from its first prompt, the way a model would shorten it; a message's title is its body's. */
export function titleOf(prompt: string): string {
	const body = prompt.startsWith("Message from session") ? (prompt.split("\n\n")[1] ?? prompt) : prompt;
	const first = (body.split("\n")[0] ?? "").replace(/^(reply|hold|call|tell \S+|launch \S+)\s+/, "").trim() || "Session";
	const short = first.length > 40 ? `${first.slice(0, 40).trim()}…` : first;
	return short.charAt(0).toUpperCase() + short.slice(1);
}

export type Step = { tool: string; args: Record<string, unknown> } | { text: string } | null;

/** Whether a tool's output is session_reachable's. */
function isReachable(toolOutput: string): boolean {
	return /\{"sessions":/.test(toolOutput) || toolOutput.startsWith("Open sessions") || toolOutput.startsWith("No other open sessions");
}

/** The session titled `title` in session_reachable's output, structured or as text; undefined in any other tool's. */
function reachableId(toolOutput: string, title: string): string | undefined {
	const listed = /\{"sessions":.*\}/.exec(toolOutput)?.[0];
	if (listed)
		return (JSON.parse(listed) as { sessions: { id: string; title: string | null }[] }).sessions.find((session) => session.title === title)
			?.id;
	return /^- (\S+)/.exec(toolOutput.split("\n").find((line) => line.includes(` · "${title}" · `)) ?? "")?.[1];
}

export function agentStep(prompt: string, toolOutput: string | null): Step {
	const reading = /^Question about session (\S+):/.exec(prompt.trim());
	if (reading) {
		if (toolOutput === null) return { tool: "recall_read", args: { session: reading[1] } };
		const markers = [...new Set([...toolOutput.matchAll(/SWB-[A-Za-z0-9-]+/g)].map((m) => m[0]))];
		return { text: markers.length > 0 ? `reader found: ${markers.join(" ")}` : "reader found nothing" };
	}
	const searching = /^search (.+)$/s.exec(prompt.trim());
	if (searching) return toolOutput === null ? { tool: "session_search", args: { query: searching[1] } } : { text: "searched" };
	const asking = /^(ask|ask-id) (.+?) :: (.+)$/s.exec(prompt.trim());
	if (asking) {
		const [, verb, target, question] = asking as unknown as [string, string, string, string];
		if (verb === "ask-id" || (toolOutput !== null && !isReachable(toolOutput))) {
			if (toolOutput === null) return { tool: "session_ask", args: { session: target, question } };
			return { text: `asked: ${toolOutput}` };
		}
		if (toolOutput === null) return { tool: "session_reachable", args: {} };
		const id = reachableId(toolOutput, target);
		if (!id) return { text: toolOutput };
		return { tool: "session_ask", args: { session: id, question } };
	}
	const named = /^(show|update) (.+?)(?: (\{.*\}))?$/.exec(prompt.trim());
	if (named) {
		const [, verb, title, json] = named;
		if (toolOutput === null) return { tool: "session_reachable", args: {} };
		const id = reachableId(toolOutput, title as string);
		if (!id) return { text: toolOutput };
		if (verb === "show") return { tool: "swb_show_session", args: { session: id } };
		return { tool: "swb_update_session", args: { ...JSON.parse(json ?? "{}"), session: id } };
	}
	const [verb, harness, ...rest] = prompt.trim().split(" ");
	const name = NAMES[harness ?? ""];
	if (!name || (verb !== "tell" && verb !== "launch" && verb !== "flood")) return null;
	const words = verb === "flood" ? "x".repeat(Number(rest[0])) : rest.join(" ");
	if (verb === "launch") {
		if (toolOutput === null) return { tool: "session_launch", args: { harness, title: words, goal: words, requestResponse: false } };
		return { text: toolOutput };
	}
	if (toolOutput === null) return { tool: "session_reachable", args: {} };
	// Codex gives its model an MCP result's structured content; the other harnesses, its text.
	const listed = /\{"sessions":.*\}/.exec(toolOutput)?.[0];
	if (listed) {
		const sessions = (JSON.parse(listed) as { sessions: { id: string; harness: string }[] }).sessions;
		const id = sessions.find((session) => session.harness === harness)?.id;
		if (!id) return { text: `No ${name} session is open.` };
		return { tool: "session_send_message", args: { session: id, message: words, requestResponse: false } };
	}
	if (toolOutput.includes("Open sessions") || toolOutput.includes("No other open sessions")) {
		const id = new RegExp(`^- (\\S+) · ${name} · `, "m").exec(toolOutput)?.[1];
		if (!id) return { text: `No ${name} session is open.` };
		return { tool: "session_send_message", args: { session: id, message: words, requestResponse: false } };
	}
	return { text: toolOutput };
}
