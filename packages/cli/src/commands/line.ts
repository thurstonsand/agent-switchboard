import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pidAlive } from "@swb/shared";
import { frame, listen, markDelivered, pendingFor, sender, unmarkDelivered } from "@swb/shared/mailbox";
import { endHosting, pendingTitle, recordTx, sawRequest, setPhase, settle, startHosting, startTurn, turnErrored } from "@swb/shared/record";
import { UsageError } from "../errors.ts";
import { openStore } from "../store.ts";
import { SESSIONS, tmux, tmuxTry } from "../tmux.ts";
import { claudePermissionMode, claudeTitle } from "../transcripts/claude.ts";

// The Claude line's half in swb. A mod can't open a database, so its hooks run these.

/** Claude Code writes its transcript with the first message, so a turn may start before there is one. */
function title(transcript: string): string | null {
	return existsSync(transcript) ? claudeTitle(transcript) : null;
}

/**
 * Where Claude Code keeps a session's transcript, which no mod event names. Claude names a project's folder after its
 * path, every other character a dash; a session moved since keeps its file where it started, so an existing one wins.
 * A fresh Claude home has no projects folder until its first transcript.
 */
function claudeTranscript(id: string, cwd: string): string {
	const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
	const [found] = existsSync(projects) ? new Bun.Glob(`*/${id}.jsonl`).scanSync({ cwd: projects, absolute: true }) : [];
	return found ?? join(projects, cwd.replaceAll(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
}

/** The process in a host's pane: the harness itself, since its login shell execs it. */
function panePid(host: string): number {
	return Number(tmux(SESSIONS, "display", "-p", "-t", `=${host}:`, "#{pane_pid}"));
}

export function record(args: string[]): void {
	const [event, ...rest] = args;
	const { values, positionals } = parseArgs({
		args: rest,
		options: {
			host: { type: "string" },
			session: { type: "string" },
			cwd: { type: "string" },
			model: { type: "string" },
			effort: { type: "string" },
			"asks-person": { type: "boolean" },
		},
		allowPositionals: true,
	});
	const host = values.host;
	if (!host) throw new UsageError("__record: --host is required");
	const need = (name: "session" | "cwd"): string => {
		const value = values[name];
		if (!value) throw new UsageError(`__record ${event}: --${name} is required`);
		return value;
	};
	const db = openStore();
	// Claude keeps a session's file where it started, so its row's path holds once that file exists.
	const transcript = (): string => {
		const stored = db.get("SELECT transcript FROM sessions WHERE session_id = ?", need("session"))?.transcript as string | undefined;
		return stored && existsSync(stored) ? stored : claudeTranscript(need("session"), need("cwd"));
	};
	switch (event) {
		case "start":
			startHosting(db, {
				host,
				harness: "claude",
				sessionId: need("session"),
				cwd: need("cwd"),
				transcript: transcript(),
				pid: panePid(host),
				idle: true,
			});
			return;
		case "turn": {
			const path = transcript();
			startTurn(db, {
				harness: "claude",
				sessionId: need("session"),
				cwd: need("cwd"),
				transcript: path,
				title: title(path),
				host,
			});
			return;
		}
		case "phase": {
			const phase = positionals[0];
			if (phase !== "blocked" && phase !== "working") throw new UsageError("__record phase: blocked or working");
			// In auto mode the classifier answers an ask, not the person, and a missed prompt costs less than a false one.
			if (phase === "blocked" && !values["asks-person"] && claudePermissionMode(transcript()) === "auto") return;
			setPhase(db, need("session"), phase);
			return;
		}
		case "settled": {
			const { quit } = settle(db, { host, sessionId: need("session"), cwd: need("cwd"), title: title(transcript()) });
			// Archived or reloading during its turn: stop it now the turn is over, in the background, since Claude Code
			// waits on this. Quiet, since a failed run-shell draws its status over some other session's harness.
			if (quit) tmuxTry(SESSIONS, "run-shell", "-b", `kill -TERM ${panePid(host)} 2>/dev/null || :`);
			console.log(JSON.stringify({ quit }));
			return;
		}
		case "request": {
			if (!values.model) throw new UsageError("__record request: --model is required");
			sawRequest(db, need("session"), values.model, values.effort ?? null);
			return;
		}
		case "errored":
			turnErrored(db, need("session"));
			return;
		case "end":
			endHosting(db, host);
			return;
		default:
			throw new UsageError(`__record: unknown event ${event}`);
	}
}

/**
 * The line's command hooks, by name: the kind an organization's cc-plugin-sec-default runs, where it sends a mod's
 * classic hooks on past the line.
 */
export async function claudeHook(args: string[]): Promise<void> {
	switch (args[0]) {
		case "title":
			return promptTitle();
		case "recovery":
			return recoveryNotice();
		default:
			throw new UsageError(`__claude_hook: title or recovery, not ${args[0]}`);
	}
}

/** On each prompt: hands Claude Code a title set through swb, which it takes as its own. Only a prompt hook can. */
async function promptTitle(): Promise<void> {
	if (!process.env.SWB_TMUX_SESSION) return;
	const { session_id } = (await Bun.stdin.json()) as { session_id: string };
	const title = pendingTitle(openStore(), session_id);
	if (title === null) return;
	console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: title } }));
}

/** On a resume: tells the person and the model that swb resumed this conversation somewhere else, since its directory is gone. */
function recoveryNotice(): void {
	const notice = process.env.SWB_RECOVERY_NOTICE;
	if (!notice) return;
	const additional = { hookEventName: "SessionStart", additionalContext: notice };
	console.log(JSON.stringify({ systemMessage: notice.replace(/^swb: /, ""), hookSpecificOutput: additional }));
}

/**
 * Streams a host's incoming messages as JSON lines, for its line to deliver, until its parent process is gone. It only
 * reads, so a busy db can't stop it. Whatever was offered but never acknowledged is offered again when this starts, and
 * the line drops what it already holds. The line acknowledges a message just before handing it over, so a crash
 * between the two loses that one message rather than delivering it twice.
 */
export async function inbox(args: string[]): Promise<void> {
	const { values } = parseArgs({ args, options: { host: { type: "string" } } });
	const host = values.host;
	if (!host) throw new UsageError("__inbox: --host is required");
	const db = openStore();
	const parent = process.ppid;
	let offered = new Set<string>();
	let serving: string | undefined;
	let version = -1;
	let rang = () => {};
	listen(db, (id) => {
		if (id === serving) rang();
	});
	while (process.ppid === parent && pidAlive(parent)) {
		const now = db.dataVersion();
		if (now !== version) {
			version = now;
			const session = db.get("SELECT session_id FROM runtimes WHERE tmux_session = ?", host)?.session_id as string | undefined;
			// The line drops what it held for a session it moved away from, so moving back offers it again.
			if (session !== serving) {
				serving = session;
				offered = new Set();
			}
			for (const m of session ? pendingFor(db, session) : []) {
				if (offered.has(m.id)) continue;
				offered.add(m.id);
				const line = { id: m.id, kind: m.kind, target: m.targetId, title: sender(db, m.sourceId).title, body: m.body, text: frame(db, m) };
				process.stdout.write(`${JSON.stringify(line)}\n`);
			}
		}
		await new Promise<void>((resolve) => {
			rang = resolve;
			setTimeout(resolve, 250);
		});
	}
}

/** Marks messages delivered, which the line does just before it hands them to Claude Code. */
export function ack(ids: string[]): void {
	if (ids.length === 0) throw new UsageError("__ack: a message id is required");
	const db = openStore();
	recordTx(db, () => {
		for (const id of ids) markDelivered(db, id);
	});
}

/** Claude Code refused messages the line had marked delivered: they wait for its next try. */
export function unack(ids: string[]): void {
	if (ids.length === 0) throw new UsageError("__unack: a message id is required");
	const db = openStore();
	recordTx(db, () => {
		for (const id of ids) unmarkDelivered(db, id);
	});
}
