import type { Harness } from "@swb/shared";
import { readClaude } from "./claude.ts";
import { codexInUse, locateRollout, readCodex } from "./codex.ts";
import type { Conversation } from "./conversation.ts";
import { piInUse, readPi } from "./pi.ts";

/** Where a session's transcript is now; only Codex moves one. */
export function locateTranscript(path: string, harness: Harness): string {
	return harness === "codex" ? locateRollout(path) : path;
}

/**
 * A session's conversation, or one of its subagents', read from its harness's own transcript. Each reader fails loudly
 * on a format it doesn't know.
 */
export function readConversation(path: string, harness: Harness, subagent = false): Conversation {
	switch (harness) {
		case "pi":
			return readPi(path);
		case "claude":
			return readClaude(path, subagent);
		case "codex":
			return readCodex(path, subagent);
	}
}

/** The model and effort a session runs on now, as its transcript last records them; null where it records none. */
export type InUse = { model: string | null; effort: string | null };

/** Claude Code's transcript has no effort, so its line records both instead. */
export function inUse(path: string, harness: "pi" | "codex"): InUse {
	return harness === "pi" ? piInUse(path) : codexInUse(path);
}
