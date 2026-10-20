import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pidAlive } from "@swb/shared";
import { frame, listen, markDelivered, markOffered, pendingFor, sender } from "@swb/shared/mailbox";
import { endHosting, recordTx, setPhase, settle, startHosting, startTurn } from "@swb/shared/record";
import { claudeTitle } from "../deck/transcript.ts";
import { UsageError } from "../errors.ts";
import { openStore } from "../store.ts";
import { SESSIONS, tmux, tmuxTry } from "../tmux.ts";

// The Claude line's half in swb. A mod can't open a database, so its hooks run these.

/** Claude Code writes its transcript with the first message, so a turn may start before there is one. */
function title(transcript: string): string | null {
	return existsSync(transcript) ? claudeTitle(transcript) : null;
}

/**
 * Where Claude Code keeps a session's transcript, for a line that wasn't told: classic.SessionStart names it, and
 * another mod can keep that event from the line. Claude names a project's folder after its path, every other
 * character a dash; a session moved since keeps its file where it started, so an existing one wins.
 */
function claudeTranscript(id: string, cwd: string): string {
	const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
	const [found] = new Bun.Glob(`*/${id}.jsonl`).scanSync({ cwd: projects, absolute: true });
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
			transcript: { type: "string" },
			parent: { type: "string" },
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
	const transcript = (): string => values.transcript || claudeTranscript(need("session"), need("cwd"));
	const db = openStore();
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
				parentId: values.parent ?? null,
			});
			return;
		}
		case "phase": {
			const phase = positionals[0];
			if (phase !== "blocked" && phase !== "working") throw new UsageError("__record phase: blocked or working");
			setPhase(db, need("session"), phase);
			return;
		}
		case "settled": {
			const { archived } = settle(db, { host, sessionId: need("session"), cwd: need("cwd"), title: title(transcript()) });
			// Archived during its turn: stop it now the turn is over, in the background, since Claude Code waits on this.
			// Quiet, since a failed run-shell draws its status over some other session's harness.
			if (archived) tmuxTry(SESSIONS, "run-shell", "-b", `kill -TERM ${panePid(host)} 2>/dev/null || :`);
			console.log(JSON.stringify({ archived }));
			return;
		}
		case "end":
			endHosting(db, host);
			return;
		default:
			throw new UsageError(`__record: unknown event ${event}`);
	}
}

/**
 * Streams a host's incoming messages as JSON lines, for its line to deliver, until its parent process is gone.
 * Whatever was offered but never acknowledged is offered again when this starts, so a crash loses nothing.
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
				recordTx(db, () => markOffered(db, m.id));
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

export function ack(ids: string[]): void {
	if (ids.length === 0) throw new UsageError("__ack: a message id is required");
	const db = openStore();
	recordTx(db, () => {
		for (const id of ids) markDelivered(db, id);
	});
}
