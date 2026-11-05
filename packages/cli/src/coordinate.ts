import { existsSync, realpathSync } from "node:fs";
import { type Db, type Harness, operatorDir, projectRoot, type ReloadMode, type View } from "@swb/shared";
import { frame, harnessName, type MessageKind, ring } from "@swb/shared/mailbox";
import { isArchived, markArchived, recordTx, titleOf } from "@swb/shared/record";
import type { ToolArgs, ToolResult } from "@swb/shared/tools";
import { CodexClient } from "./codex/client.ts";
import { codexSocket } from "./codex/host.ts";
import { deckShowing, postCommand } from "./deck/deck.ts";
import { displayName, openDescendants, projectName, type SessionState, sessionState, states } from "./derive.ts";
import { checkBody, SwbError } from "./errors.ts";
import { requestedGroup } from "./groups.ts";
import { type Caller, launchFlags, presetLaunch } from "./harnesses.ts";
import { markSnoozed, snoozeChange } from "./schedules.ts";
import {
	archive,
	archiveWorktree,
	ensureSessionsServer,
	lastWords,
	launch,
	markUnarchived,
	restart,
	unarchiveInCodex,
	wake,
} from "./sessions.ts";
import { rename, setGroup, setReload } from "./store.ts";
import { SESSIONS, tmuxTry } from "./tmux.ts";
import { inUse } from "./transcripts/read.ts";

// The coordination every line's tools run. Each returns the text the model reads, so all three harnesses say the same
// thing, and the facts a line may render. The sender is always the line's own session, never a tool argument.

/** Working, blocked, idle, or a turn that ended badly; whether its process runs is swb's to handle. */
function stateOf(s: SessionState): string {
	return s.cutOff ? "cut off" : s.errored ? "errored" : s.activity;
}

function describe(s: SessionState): string {
	return `- ${s.id} · ${harnessName(s.harness)} · "${displayName(s)}" · ${stateOf(s)} · ${s.cwd}${s.group ? ` · Group "${s.group}"` : ""}`;
}

export function list(db: Db, from: string): ToolResult {
	const open = states(db)
		.filter((s) => s.open && s.id !== from)
		.sort((a, b) => b.activityAt - a.activityAt);
	const text =
		open.length === 0
			? "No other open sessions."
			: `Open sessions (id · harness · title · state · directory · Group):\n${open.map(describe).join("\n")}`;
	const sessions = open.map((s) => ({
		id: s.id,
		harness: s.harness,
		title: s.title,
		cwd: s.cwd,
		project: s.project,
		group: s.group,
		state: stateOf(s),
	}));
	return { text, details: { sessions }, ...(open.length > 0 ? { summary: open.map(displayName).join(", ") } : {}) };
}

export type Send = { from: string; to: string; body: string; reportBack: boolean; requestId: string | null; kind: MessageKind };

/** Accepts a message for a session, waking it if it's dormant, and waits a while for its line to deliver it. */
export async function send(db: Db, m: Send): Promise<ToolResult> {
	if (m.to === m.from) throw new SwbError("a session can't message itself");
	if (m.kind === "message") checkBody("message", m.body);
	const target = sessionState(db, m.to);
	if (m.kind === "cancel" && !(target.live && target.activity !== "idle")) {
		return {
			text: `"${displayName(target)}" has no running turn to cancel.`,
			details: { delivered: false, target: { id: target.id, title: target.title, harness: target.harness } },
		};
	}
	const id = recordTx(db, () => {
		// Checked with the write, so an archive can't land between them and leave this waiting on an archived session. An
		// archive with cancel_turns marks a session before it cancels the turn, so a cancel may reach one already archived.
		if (m.kind === "message" && isArchived(db, m.to)) throw new SwbError(`"${displayName(target)}" is archived; unarchive it first`);
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
			`INSERT INTO messages (id, kind, source_id, target_id, body, report_back, request_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			m.kind,
			m.from,
			m.to,
			m.body,
			m.reportBack ? 1 : 0,
			m.requestId,
			Date.now(),
		);
		return id;
	});
	ring(db, m.to);
	const woke = !target.live;
	if (woke) wake(db, m.to, "idle");
	const delivered = await deliveredWithin(db, id, woke ? 60_000 : 15_000);
	const name = `"${displayName(target)}"`;
	const text =
		m.kind === "cancel"
			? delivered
				? `Cancelled ${name}'s turn.`
				: `${name} hasn't taken the cancel yet.`
			: delivered
				? `Delivered to ${name}.${m.reportBack ? " Its reply will arrive as a message; end your turn rather than waiting." : ""}`
				: `Queued for ${name}.`;
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
	briefing: string;
	cwd: string | null;
	title: string | null;
	/** The Group it starts in, null for none; undefined keeps `from`'s Group when both are in one Project. */
	group: string | null | undefined;
	reportBack: boolean;
	model: string | null;
	/** The schedule that launches it, and when that was due, which its briefing's frame says. */
	scheduled: { id: string; at: number } | null;
};

/** Starts a new managed session whose first turn is the briefing, and waits until its harness has registered it. */
export async function launchSession(db: Db, l: Launch): Promise<ToolResult> {
	checkBody("briefing", l.briefing);
	const cwd = l.cwd ?? (l.from ? sessionState(db, l.from).cwd : null);
	if (!cwd) throw new SwbError("a directory is required");
	if (!existsSync(cwd)) throw new SwbError(`no directory ${cwd}`);
	const dir = realpathSync(cwd);
	// An Operator that names no directory would start another Operator in its own folder; starting one is the user's call.
	if (l.from && dir === operatorDir() && sessionState(db, l.from).operator)
		throw new SwbError("an Operator can't start another Operator; name a project's directory as cwd");
	const group = launchGroup(db, l, dir);
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
				body: l.briefing,
				reportBack: l.reportBack,
				createdAt: Date.now(),
				scheduleId: l.scheduled?.id ?? null,
				scheduledFor: l.scheduled?.at ?? null,
			})
		: l.briefing;
	ensureSessionsServer();
	const host = db.tx(() =>
		launch(db, {
			...launchFlags(target),
			cwd: dir,
			resume: null,
			...(sessionId ? { sessionId } : {}),
			prompt,
			...(l.title && harness === "claude" ? { title: l.title } : {}),
			...(l.from ? { parentId: l.from } : {}),
			group,
		}),
	);
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
	const text = `Launched a ${harnessName(harness)} session${what ? ` (${what})` : ""} (session: ${id}) in ${dir}${group === null ? "" : `, in Group "${group}"`}.${l.reportBack ? " It will report back as a message; end your turn rather than waiting." : ""}`;
	return { text, details: { id, harness, host, cwd: dir, group } };
}

function launchGroup(db: Db, l: Launch, dir: string): string | null {
	const group = requestedGroup(l.group, dir);
	if (group !== undefined) return group;
	if (!l.from) return null;
	const parent = sessionState(db, l.from);
	return parent.project === projectRoot(dir) ? parent.group : null;
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
		// A harness that dies first, as a Codex without swb's tools does, says why in what it left in its pane.
		if (tmuxTry(SESSIONS, "display", "-p", "-t", `=${host}:`, "#{pane_dead}").out.trim() === "1")
			throw new SwbError(`the new session (${host}) ended before it started:\n${lastWords(host).join("\n")}`);
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
		throw new SwbError(`no session ${id}; session_list lists them`);
	const host = db.get("SELECT tmux_session FROM runtimes WHERE session_id = ?", from)?.tmux_session as string | undefined;
	const showing = host === undefined ? null : deckShowing(host);
	if (!showing) throw new SwbError(`no Deck is showing this session, so there is none to switch; \`swb open ${id}\` opens one on it`);
	await postCommand(showing.deck, "show", [id, from, ...(view ? [view] : [])]);
	const name = displayName({ id, title: titleOf(db, id) });
	return {
		text: `Showing "${name}". The user isn't watching this session now, so end your turn with one short line.`,
		details: { id, deck: showing.deck },
	};
}

export type Update = Omit<ToolArgs<"swb_update_session">, "session">;

/**
 * Applies any combination of changes to a session: unarchiving first, cancelling after snoozing, reloading and then archiving last. Every change
 * is checked before any is made, and the unarchive, title, Group, and snooze are written together, so a refusal leaves everything as it was.
 */
export async function update(db: Db, from: string, id: string, change: Update): Promise<ToolResult> {
	const { archived, family, cancel_turns: cancelTurns, cancel, snooze: snoozing, group, title, reload: reloading } = change;
	if ([archived, cancel || undefined, snoozing, group, title, reloading].every((value) => value === undefined))
		throw new SwbError("nothing to change: give archived, cancel, snooze, group, title, or reload");
	if (change.delete_worktree && (archived !== true || id !== from))
		throw new SwbError("delete_worktree goes only with archived: true for this session");
	if ((family !== undefined || cancelTurns !== undefined) && archived !== true)
		throw new SwbError("family and cancel_turns go only with archived: true");
	if (cancel && id === from) throw new SwbError("cancel stops another session's turn; to stop this one, end your turn");
	if (cancel && (archived === true || reloading !== undefined))
		throw new SwbError("cancel goes without archived or reload, which settle a running turn themselves");
	if (archived === true && snoozing !== undefined)
		throw new SwbError("an archived session can't be snoozed; give one of archived or snooze");
	if (archived === true && reloading !== undefined)
		throw new SwbError("an archived session can't be reloaded; give one of archived or reload");
	const all = states(db);
	const target = all.find((s) => s.id === id);
	if (!target)
		throw new SwbError(
			db.get("SELECT 1 FROM runtimes WHERE session_id = ?", id) ? "nothing to change before the first prompt" : `no session ${id}`,
		);
	const name = `"${displayName(target)}"`;
	const trimmedTitle = title?.trim();
	if (trimmedTitle === "") throw new SwbError("a title can't be empty");
	const trimmedGroup = requestedGroup(group, target.cwd);
	const archiving = archived === true ? archivePlan(all, from, target, family ?? false, cancelTurns ?? false) : null;

	// Unarchiving comes first, so what follows it applies to an open session.
	const reopened = { ...target, open: target.open || archived === false };
	const snoozed = snoozing === undefined ? null : snoozeChange(reopened, from, snoozing, Date.now());
	if (reloading !== undefined && !reopened.open) throw new SwbError(`${name} is archived; unarchive it first`);

	const done: string[] = [];
	const deleted = change.delete_worktree && archiving ? await archiveRun(db, from, archiving, true, cancelTurns ?? false) : null;
	if (archived === false) unarchiveInCodex(db, id);
	recordTx(db, () => {
		if (archived === false) markUnarchived(db, id);
		else if (snoozed && isArchived(db, id)) throw new SwbError(`${name} is archived; unarchive it first`);
		if (trimmedTitle !== undefined) rename(db, id, trimmedTitle);
		if (trimmedGroup !== undefined) setGroup(db, [id], trimmedGroup);
		if (snoozed) markSnoozed(db, id, snoozed.at, snoozed.until);
	});
	if (archived === false) done.push(`Unarchived ${name}.`);
	if (trimmedTitle !== undefined) {
		ring(db, id);
		done.push(`Retitled ${name} as "${trimmedTitle}".`);
	}
	if (trimmedGroup !== undefined) {
		const existing = all.some((s) => s.open && s.id !== id && s.project === target.project && s.group === trimmedGroup);
		done.push(
			trimmedGroup === null
				? `Took ${name} out of its Group.`
				: `Moved ${name} into ${existing ? "" : "a new Group, "}"${trimmedGroup}", in ${projectName(target.project)}.`,
		);
	}
	if (snoozed) done.push(snoozed.result.text);
	// After the writes, which can still be refused: a cancel can't be taken back.
	if (cancel) done.push((await send(db, { from, to: id, body: "", reportBack: false, requestId: null, kind: "cancel" })).text);
	if (reloading !== undefined) done.push(reload(db, from, id, reloading));
	if (archiving) done.push(deleted ?? (await archiveRun(db, from, archiving)));
	return {
		text: done.join(" "),
		details: {
			id,
			archived,
			cancel,
			group: trimmedGroup,
			title: trimmedTitle,
			snooze: snoozing,
			reload: reloading,
			ids: archiving?.members.map((s) => s.id),
		},
	};
}

/**
 * Restarts a session's harness on its conversation, so it reads its configuration afresh. This session, or another
 * asked to wait, goes when its turn ends: its line quits, and the clock starts it again. Another told to continue goes
 * at once, a running turn and all, which it then picks back up. `from` is null for a person.
 */
export function reload(db: Db, from: string | null, id: string, mode: ReloadMode): string {
	const target = sessionState(db, id);
	const name = from === id ? "This session" : `"${displayName(target)}"`;
	if (!target.open) throw new SwbError(`${name} is archived; unarchive it first`);
	if (!target.live && mode === "idle") return `${name} reads its configuration afresh when its next turn starts.`;
	// Read with the write, so a turn settling meanwhile either sees the reload and quits for it, or is over and restarts now.
	const waits =
		target.live &&
		recordTx(db, () => {
			const phase = db.get("SELECT phase FROM sessions WHERE session_id = ?", id)?.phase;
			if (from !== id && (mode === "continue" || phase === "idle")) return false;
			// A reload waiting to carry on still does when asked again to come back idle.
			const pending = db.get("SELECT reload FROM marks WHERE session_id = ?", id)?.reload;
			if (pending !== "continue") setReload(db, id, mode);
			return true;
		});
	if (waits)
		return from === id
			? "This session restarts when this turn ends: end it now with a brief final message."
			: `${name} restarts when its turn ends.`;
	restart(db, id, mode);
	return `Restarted ${name}.`;
}

/** What keeps a session from going quietly: a turn still running or waiting on the user, or one that never finished. */
function unsettled(s: SessionState): string | null {
	if (s.live && s.activity !== "idle") return s.activity === "blocked" ? "blocked on the user" : "mid-turn";
	return s.cutOff ? "cut off mid-turn" : s.errored ? "errored" : null;
}

type ArchivePlan = { target: SessionState; members: SessionState[]; unsettled: SessionState[] };

/**
 * What archiving a session, and with `family` every open one it started, would take. The caller may archive itself
 * mid-turn: its line quits when the turn ends. Anyone else unsettled is refused, by name, unless cancel_turns cancels their turns.
 */
function archivePlan(all: SessionState[], from: string, target: SessionState, family: boolean, cancelTurns: boolean): ArchivePlan {
	const members = [...(target.open ? [target] : []), ...(family ? openDescendants(all, target.id) : [])];
	const refusals = members.flatMap((s) => {
		const why = s.id === from ? null : unsettled(s);
		return why ? [{ s, why }] : [];
	});
	if (refusals.length > 0 && !cancelTurns)
		throw new SwbError(
			`Nothing changed: ${refusals.map(({ s, why }) => `"${displayName(s)}" is ${why}`).join("; ")}. Archive anyway with cancel_turns.`,
		);
	return { target, members, unsettled: refusals.map(({ s }) => s) };
}

/** Archives what the plan names. With cancelTurns, an unsettled session is archived, then its turn cancelled, so its line quits as the turn ends. */
async function archiveRun(db: Db, from: string, plan: ArchivePlan, deleteWorktree = false, cancelTurns = false): Promise<string> {
	const { target, members } = plan;
	const name = from === target.id ? "this session" : `"${displayName(target)}"`;
	if (members.length === 0 && !deleteWorktree) return `${name} is already archived.`;
	const cancelling = plan.unsettled.filter((s) => s.live);
	const cancel = async (ids: string[]) => {
		await Promise.all(ids.map((to) => send(db, { from, to, body: "", reportBack: false, requestId: null, kind: "cancel" })));
	};
	let deleted: string | null = null;
	let closed = "";
	if (deleteWorktree) {
		deleted = await archiveWorktree(
			db,
			target.id,
			members.map((s) => s.id),
			from,
			cancelTurns ? cancel : null,
		);
	} else {
		if (members.some((s) => s.id === from)) recordTx(db, () => markArchived(db, from));
		for (const s of cancelling) recordTx(db, () => markArchived(db, s.id));
		const { refused, stopped } = archive(
			db,
			members.filter((s) => s.id !== from && !cancelling.includes(s)).map((s) => s.id),
		);
		// Archived either way: a harness swb had to close is news alongside that, not a failure of it.
		closed = await stopped.then(
			() => "",
			(error: Error) => `A harness ${error.message}.`,
		);
		if (refused) throw refused;
		await cancel(cancelling.map((s) => s.id));
	}
	const started = members.length - (target.open ? 1 : 0);
	const sessions = `${started} session${started === 1 ? "" : "s"} it started`;
	return [
		deleted ? `Deleted worktree ${deleted}; its branch is kept.` : "",
		target.open ? `Archived ${name}${started > 0 ? ` and ${sessions}` : ""}.` : `${name} was already archived; archived ${sessions}.`,
		cancelling.length > 0 ? `Cancelled the turns of ${cancelling.map((s) => `"${displayName(s)}"`).join(", ")}.` : "",
		members.some((s) => s.id === from) ? "This session quits when this turn ends: end it now with a brief final message." : "",
		closed,
	]
		.filter(Boolean)
		.join(" ");
}
