import { existsSync, realpathSync } from "node:fs";
import { type Db, type Harness, operatorDir, type View } from "@swb/shared";
import { frame, harnessName, type MessageKind, ring } from "@swb/shared/mailbox";
import { markArchived, recordTx, titleOf } from "@swb/shared/record";
import type { ToolArgs, ToolResult } from "@swb/shared/tools";
import { CodexClient } from "./codex/client.ts";
import { codexSocket } from "./codex/host.ts";
import { deckShowing, postCommand } from "./deck/deck.ts";
import { inUse } from "./deck/transcript.ts";
import { displayName, openDescendants, projectName, type SessionState, sessionState, states } from "./derive.ts";
import { checkBody, SwbError } from "./errors.ts";
import { type Caller, launchFlags, presetLaunch } from "./harnesses.ts";
import { snooze } from "./schedules.ts";
import { archive, ensureSessionsServer, launch, unarchive, wake } from "./sessions.ts";
import { rename, setGroup } from "./store.ts";

// The coordination every line's tools run. Each returns the text the model reads, so all three harnesses say the same
// thing, and the facts a line may render. The sender is always the line's own session, never a tool argument.

function describe(s: SessionState): string {
	const state = s.cutOff ? "cut off" : s.errored ? `errored${s.live ? "" : ", dormant"}` : s.live ? s.activity : "dormant";
	return `- ${s.id} · ${harnessName(s.harness)} · "${displayName(s)}" · ${state} · ${s.cwd}${s.group ? ` · Group "${s.group}"` : ""}`;
}

export function reachable(db: Db, from: string): ToolResult {
	const open = states(db)
		.filter((s) => s.open && s.id !== from)
		.sort((a, b) => b.activityAt - a.activityAt);
	const text =
		open.length === 0
			? "No other open sessions."
			: `Open sessions (id · harness · title · state · directory · Group, if it's in one); a dormant one wakes when messaged:\n${open.map(describe).join("\n")}`;
	const sessions = open.map((s) => ({
		id: s.id,
		harness: s.harness,
		title: s.title,
		cwd: s.cwd,
		project: s.project,
		group: s.group,
		live: s.live,
		activity: s.activity,
	}));
	return { text, details: { sessions } };
}

export type Send = { from: string; to: string; body: string; requestResponse: boolean; requestId: string | null; kind: MessageKind };

/** Accepts a message for a session, waking it if it's dormant, and waits a while for its line to deliver it. */
export async function send(db: Db, m: Send): Promise<ToolResult> {
	if (m.to === m.from) throw new SwbError("a session can't message itself");
	if (m.kind === "message") checkBody("message", m.body);
	const target = sessionState(db, m.to);
	// A forced archive marks a session before it cancels the turn, so a cancel may reach one already archived.
	if (!target.open && m.kind === "message") throw new SwbError(`"${displayName(target)}" is archived; unarchive it first`);
	if (m.kind === "cancel" && !(target.live && target.activity !== "idle")) {
		return { text: `"${displayName(target)}" has no running turn to cancel.`, details: { delivered: false, target: m.to } };
	}
	const id = recordTx(db, () => {
		if (m.requestId) {
			const existing = db.get("SELECT id, target_id, body FROM messages WHERE source_id = ? AND request_id = ?", m.from, m.requestId);
			if (existing) {
				if (existing.target_id !== m.to || existing.body !== m.body)
					throw new SwbError(`request ${m.requestId} was already used for another message`);
				return existing.id as string;
			}
		}
		const id = crypto.randomUUID();
		db.run(
			`INSERT INTO messages (id, kind, source_id, target_id, body, request_response, request_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			m.kind,
			m.from,
			m.to,
			m.body,
			m.requestResponse ? 1 : 0,
			m.requestId,
			Date.now(),
		);
		return id;
	});
	ring(db, m.to);
	const woke = !target.live;
	if (woke) wake(db, m.to, false);
	const delivered = await deliveredWithin(db, id, woke ? 60_000 : 15_000);
	const name = `"${displayName(target)}"`;
	const text =
		m.kind === "cancel"
			? delivered
				? `Cancelled ${name}'s turn.`
				: `${name} hasn't taken the cancel yet.`
			: delivered
				? `Delivered to ${name}${woke ? ", which was woken for it" : ""}.${m.requestResponse ? " Its reply will arrive as a message; end your turn rather than waiting." : ""}`
				: `Queued for ${name}${woke ? ", which is starting" : ""}; it arrives when its session takes it.`;
	return { text, details: { id, delivered, woke, target: { id: target.id, title: target.title, harness: target.harness } } };
}

/** A live line delivers within milliseconds of the ring, which the sending agent waits for; a lookup costs microseconds. */
async function deliveredWithin(db: Db, id: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const row = db.get("SELECT delivered_at FROM messages WHERE id = ?", id);
		if (row?.delivered_at !== null && row?.delivered_at !== undefined) return true;
		if (Date.now() > deadline) return false;
		await Bun.sleep(10);
	}
}

export type Launch = {
	from: string | null;
	/** The preset to start on, by its fields; none for the one nearest what `from` runs now, else the default. */
	harness: Harness | null;
	effort: string | null;
	agent: string | null;
	goal: string;
	cwd: string | null;
	title: string | null;
	requestResponse: boolean;
	model: string | null;
	/** The schedule that launches it, and when that was due, which its goal's frame says. */
	scheduled: { id: string; at: number } | null;
};

/** Starts a new managed session whose first turn is the goal, and waits until its harness has registered it. */
export async function launchSession(db: Db, l: Launch): Promise<ToolResult> {
	checkBody("goal", l.goal);
	const cwd = l.cwd ?? (l.from ? sessionState(db, l.from).cwd : null);
	if (!cwd) throw new SwbError("a directory is required");
	if (!existsSync(cwd)) throw new SwbError(`no directory ${cwd}`);
	const dir = realpathSync(cwd);
	// An Operator that names no directory would start another Operator in its own folder; starting one is the user's call.
	if (l.from && dir === operatorDir() && sessionState(db, l.from).operator)
		throw new SwbError("an Operator can't start another Operator; name a project's directory as cwd");
	const asked = l.harness !== null || l.model !== null || l.effort !== null || l.agent !== null;
	const caller = !asked && l.from ? callerOf(db, l.from) : null;
	const target = await presetLaunch({ harness: l.harness, model: l.model, effort: l.effort, agent: l.agent }, caller);
	const harness = target.harness;
	// pi and Claude Code take an id up front; Codex mints its own, which its host reports once it binds.
	const sessionId = harness === "codex" ? undefined : crypto.randomUUID();
	const prompt = l.from
		? frame(db, {
				id: "",
				kind: "message",
				sourceId: l.from,
				targetId: "",
				body: l.goal,
				requestResponse: l.requestResponse,
				createdAt: Date.now(),
				scheduleId: l.scheduled?.id ?? null,
				scheduledFor: l.scheduled?.at ?? null,
			})
		: l.goal;
	ensureSessionsServer();
	const host = launch({
		...launchFlags(target),
		cwd: dir,
		resume: null,
		...(sessionId ? { sessionId } : {}),
		prompt,
		...(l.title && harness === "claude" ? { title: l.title } : {}),
		...(l.from ? { parentId: l.from } : {}),
	});
	const id = await registered(db, host, 60_000);
	if (l.title && harness === "codex") await nameThread(host, id, l.title);
	else if (l.title && harness === "pi") await titled(db, id, l.title);
	const what = [
		target.provider && target.model ? `${target.provider}/${target.model}` : target.model,
		target.effort && `${target.effort} effort`,
		target.agent && `agent ${target.agent}`,
	]
		.filter(Boolean)
		.join(", ");
	const text = `Launched a ${harnessName(harness)} session${what ? ` (${what})` : ""} (session: ${id}) in ${dir}.${l.requestResponse ? " It will report back as a message; end your turn rather than waiting." : ""}`;
	return { text, details: { id, harness, host, cwd: dir } };
}

/** What a session runs on now: Claude Code's as its line recorded its last request, pi's and Codex's from their transcripts. */
function callerOf(db: Db, id: string): Caller {
	const row = db.get("SELECT harness, transcript, model, effort FROM sessions WHERE session_id = ?", id);
	if (!row) throw new SwbError(`no session ${id}`);
	const harness = row.harness as Harness;
	if (harness === "claude") return { harness, model: row.model as string | null, effort: row.effort as string | null };
	return { harness, ...inUse(row.transcript as string, harness) };
}

async function registered(db: Db, host: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const row = db.get("SELECT session_id FROM runtimes WHERE tmux_session = ?", host);
		if (row) return row.session_id as string;
		if (Date.now() > deadline) throw new SwbError(`the new session (${host}) didn't start within ${timeoutMs / 1000} s`);
		await Bun.sleep(100);
	}
}

/** Codex keeps the name itself, where its resume picker shows it too; the session's host records it from there. */
async function nameThread(host: string, id: string, title: string): Promise<void> {
	const client = await CodexClient.connect(codexSocket(host), "swb");
	try {
		await client.request("thread/name/set", { threadId: id, name: title });
	} finally {
		client.close();
	}
}

/** A requested title for pi to take, once the first turn has made the session's row and only while pi hasn't named it. */
async function titled(db: Db, id: string, title: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const row = db.get("SELECT title FROM sessions WHERE session_id = ?", id);
		if (row) {
			if (row.title === null) {
				recordTx(db, () => rename(db, id, title));
				ring(db, id);
			}
			return;
		}
		await Bun.sleep(100);
	}
	throw new SwbError(`launched ${id}, but its first turn didn't start within 15 s, so it isn't titled "${title}"`);
}

/** Moves the Deck the user is looking at the caller in onto another session, as picking its row would. */
export async function show(db: Db, from: string, id: string, view: View | null): Promise<ToolResult> {
	const recorded = db.get("SELECT 1 FROM sessions WHERE session_id = ?", id);
	// One launched a moment ago has its runtime before its first prompt makes its row, and the Deck lists it already.
	if (!recorded && !db.get("SELECT 1 FROM runtimes WHERE session_id = ?", id))
		throw new SwbError(`no session ${id}; session_reachable lists them`);
	const host = db.get("SELECT tmux_session FROM runtimes WHERE session_id = ?", from)?.tmux_session as string | undefined;
	const showing = host === undefined ? null : deckShowing(host);
	if (!showing) throw new SwbError(`no Deck is showing this session, so there is none to switch; \`swb open ${id}\` opens one on it`);
	await postCommand(showing.deck, "show", [id, from, ...(view ? [view] : [])]);
	const name = displayName({ id, title: titleOf(db, id) });
	return { text: `Showing "${name}".`, details: { id, deck: showing.deck } };
}

export type Update = Omit<ToolArgs<"swb_update_session">, "session">;

/**
 * Applies any combination of changes to a session: unarchiving first, archiving last. Every change is checked before any
 * is made, so a refused archive leaves the rest undone too.
 */
export async function update(db: Db, from: string, id: string, change: Update): Promise<ToolResult> {
	const { archived, family, force, snooze: snoozing, group, title } = change;
	if ([archived, snoozing, group, title].every((value) => value === undefined))
		throw new SwbError("nothing to change: give archived, snooze, group, or title");
	if ((family !== undefined || force !== undefined) && archived !== true)
		throw new SwbError("family and force go only with archived: true");
	if (archived === true && snoozing !== undefined)
		throw new SwbError("an archived session can't be snoozed; give one of archived or snooze");
	const all = states(db);
	const target = all.find((s) => s.id === id);
	if (!target)
		throw new SwbError(
			db.get("SELECT 1 FROM runtimes WHERE session_id = ?", id) ? "nothing to change before the first prompt" : `no session ${id}`,
		);
	const name = `"${displayName(target)}"`;
	const trimmedTitle = title?.trim();
	if (trimmedTitle === "") throw new SwbError("a title can't be empty");
	const trimmedGroup = group === undefined ? undefined : (group?.trim() ?? null);
	if (trimmedGroup === "") throw new SwbError("a Group needs a name; null takes the session out of its Group");
	if (trimmedGroup !== undefined && target.operator)
		throw new SwbError(`${name} is an Operator, which belongs to no Project, so it takes no Group`);
	const archiving = archived === true ? archivePlan(all, from, target, family ?? false, force ?? false) : null;

	const done: string[] = [];
	if (archived === false) {
		unarchive(db, id);
		done.push(`Unarchived ${name}. It stays dormant until messaged.`);
	}
	if (trimmedTitle !== undefined) {
		recordTx(db, () => rename(db, id, trimmedTitle));
		ring(db, id);
		done.push(`Retitled ${name} as "${trimmedTitle}".`);
	}
	if (trimmedGroup !== undefined) {
		const existing = all.some((s) => s.open && s.id !== id && s.project === target.project && s.group === trimmedGroup);
		setGroup(db, [id], trimmedGroup);
		done.push(
			trimmedGroup === null
				? `Took ${name} out of its Group.`
				: `Moved ${name} into ${existing ? "" : "a new Group, "}"${trimmedGroup}", in ${projectName(target.project)}.`,
		);
	}
	if (snoozing !== undefined) done.push(snooze(db, from, id, snoozing).text);
	if (archiving) done.push(await archiveRun(db, from, archiving));
	return {
		text: done.join(" "),
		details: { id, archived, group: trimmedGroup, title: trimmedTitle, snooze: snoozing, ids: archiving?.members.map((s) => s.id) },
	};
}

/** What keeps a session from going quietly: a turn still running or waiting on the user, or one that never finished. */
function unsettled(s: SessionState): string | null {
	if (s.live && s.activity !== "idle") return s.activity === "blocked" ? "blocked on the user" : "mid-turn";
	return s.cutOff ? "cut off mid-turn" : s.errored ? "errored" : null;
}

type ArchivePlan = { target: SessionState; members: SessionState[]; unsettled: SessionState[] };

/**
 * What archiving a session, and with `family` every open one it started, would take. The caller may archive itself
 * mid-turn: its line quits when the turn ends. Anyone else unsettled is refused, by name, unless forced.
 */
function archivePlan(all: SessionState[], from: string, target: SessionState, family: boolean, force: boolean): ArchivePlan {
	const members = [...(target.open ? [target] : []), ...(family ? openDescendants(all, target.id) : [])];
	const refusals = members.flatMap((s) => {
		const why = s.id === from ? null : unsettled(s);
		return why ? [{ s, why }] : [];
	});
	if (refusals.length > 0 && !force)
		throw new SwbError(
			`Nothing changed: ${refusals.map(({ s, why }) => `"${displayName(s)}" is ${why}`).join("; ")}. Archive anyway with force, which cancels their turns.`,
		);
	return { target, members, unsettled: refusals.map(({ s }) => s) };
}

/** Archives what the plan names. A forced session is archived, then its turn cancelled, so its line quits as the turn ends. */
async function archiveRun(db: Db, from: string, plan: ArchivePlan): Promise<string> {
	const { target, members } = plan;
	const name = from === target.id ? "this session" : `"${displayName(target)}"`;
	if (members.length === 0) return `${name} is already archived.`;
	if (members.some((s) => s.id === from)) recordTx(db, () => markArchived(db, from));
	const cancelling = plan.unsettled.filter((s) => s.live);
	for (const s of cancelling) recordTx(db, () => markArchived(db, s.id));
	archive(
		db,
		members.filter((s) => s.id !== from && !cancelling.includes(s)).map((s) => s.id),
	);
	await Promise.all(cancelling.map((s) => send(db, { from, to: s.id, body: "", requestResponse: false, requestId: null, kind: "cancel" })));
	const started = members.length - (target.open ? 1 : 0);
	const sessions = `${started} session${started === 1 ? "" : "s"} it started`;
	return [
		target.open ? `Archived ${name}${started > 0 ? ` and ${sessions}` : ""}.` : `${name} was already archived; archived ${sessions}.`,
		cancelling.length > 0
			? `Cancelled the turns of ${cancelling.map((s) => `"${displayName(s)}"`).join(", ")}; each quits as its turn ends.`
			: "",
		members.some((s) => s.id === from) ? "This session quits when this turn ends." : "",
	]
		.filter(Boolean)
		.join(" ");
}
