/** A failed action: exit 1 with the message on stderr. */
export class SwbError extends Error {}

/** Bad invocation: exit 2. */
export class UsageError extends Error {}

/** In characters: room for any briefing, and far under every harness's input limit (Codex refuses a turn over 1,048,576). */
const BODY_MAX_LENGTH = 100_000;

/** A message, goal, or scheduled message, checked where it comes in, so no harness is ever handed one it refuses. */
export function checkBody(what: string, text: string): void {
	if (!text.trim()) throw new SwbError(`the ${what} is empty`);
	if (text.length > BODY_MAX_LENGTH)
		throw new SwbError(
			`the ${what} is ${text.length.toLocaleString("en-US")} characters, over the ${BODY_MAX_LENGTH.toLocaleString("en-US")} limit; put the detail in a file and send its path`,
		);
}
