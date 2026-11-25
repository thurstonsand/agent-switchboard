import { existsSync, realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { type Db, inGitRepo, linkedWorktree, type PendingMove } from "@swb/shared";
import { recordTx } from "@swb/shared/record";
import type { ToolArgs, ToolResult } from "@swb/shared/tools";
import { type SessionState, sessionState } from "./derive.ts";
import { SwbError } from "./errors.ts";
import { trustClaudeFolder } from "./lines.ts";
import { applyMoveNow, assertWorktreeSafeToModify, ensureSessionsServer, liveRuntimeOf } from "./sessions.ts";
import { setPendingMove } from "./store.ts";
import { SESSIONS, tmuxTry } from "./tmux.ts";
import {
	execWt,
	expandUserPath,
	gitWorktrees,
	injectFlag,
	isWtInstalled,
	listWorktrees,
	pathContains,
	runWt,
	shortenHome,
	tokenizeArgs,
} from "./wt.ts";

// Session mobility and git worktree operations, shared across agent tools (pi, Claude Code, Codex),
// human slash commands (/mv, /wt), CLI (`swb move`), and the Deck's `m` Move menu.

const WT_SLASH_SUBCOMMANDS = ["fork", "checkout", "co", "rm", "merge", "rebranch", "list", "ls"] as const;
type WtSlashSubcommand = (typeof WT_SLASH_SUBCOMMANDS)[number];

function firstPositional(args: string[], valueFlags: Set<string>): string | null {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--") return args[i + 1] ?? null;
		if (valueFlags.has(arg)) {
			i++;
			continue;
		}
		if (arg.startsWith("-")) continue;
		return arg;
	}
	return null;
}

function flagValue(args: string[], short: string, long: string): string | null {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--") return null;
		if (arg === short || arg === long) return args[i + 1] ?? null;
		if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1);
	}
	return null;
}

/** Validates a destination directory for a move; returns canonical realpath. */
function validateDestination(input: string, baseCwd: string, currentCwd: string): string {
	const expanded = expandUserPath(input, baseCwd);
	let stats: ReturnType<typeof statSync> | undefined;
	try {
		stats = statSync(expanded);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new SwbError(`Directory does not exist: ${expanded}.`);
		if (code === "ENOTDIR") throw new SwbError(`Not a directory: ${expanded}.`);
		throw error;
	}
	if (!stats.isDirectory()) throw new SwbError(`Not a directory: ${expanded}.`);
	const canonical = realpathSync(expanded);
	const currentCanonical = existsSync(currentCwd) ? realpathSync(currentCwd) : currentCwd;
	if (canonical === currentCanonical) throw new SwbError(`Already in ${shortenHome(canonical)}.`);
	return canonical;
}

function assertWorktreeCapable(session: SessionState): void {
	if (session.operator) throw new SwbError("Operator sessions cannot use worktree tools.");
	if (!inGitRepo(session.cwd)) throw new SwbError("Not in a git repository.");
	if (!isWtInstalled(session.cwd)) throw new SwbError("wt is not installed or not on PATH.");
}

/** Resolves a worktree name to its filesystem path via `wt path`, falling back to `git worktree list`. */
async function resolveWorktreePath(name: string, cwd: string): Promise<string | null> {
	const viaWt = await execWt(["path", name], cwd);
	if (viaWt.code === 0 && viaWt.stdout.trim()) return viaWt.stdout.trim();
	const found = gitWorktrees(cwd).find((w) => basename(w.path) === name || w.branch === name);
	return found?.path ?? null;
}

/** Schedules a mid-turn move so the harness quits when its turn settles and the clock wakes it in `dest`. */
async function scheduleAgentMove(
	db: Db,
	session: SessionState,
	dest: string,
	options: { prompt?: string; postOp?: { args: string[]; cwd: string } } = {},
): Promise<void> {
	const canonical = realpathSync(dest);
	if (session.harness === "claude") await trustClaudeFolder(canonical);
	const move: PendingMove = {
		cwd: canonical,
		prompt: options.prompt ?? `Session moved to ${canonical}.`,
		...(options.postOp ? { postOp: options.postOp } : {}),
	};
	recordTx(db, () => setPendingMove(db, session.id, move, "continue"));
	ensureSessionsServer();
}

/** Schedules an idle move for an in-harness slash command (/mv or /wt); optional `stopHost` SIGTERMs Claude cleanly. */
async function scheduleSlashMove(
	db: Db,
	session: SessionState,
	dest: string,
	options: { notice?: string; postOp?: { args: string[]; cwd: string }; stopHost?: boolean } = {},
): Promise<string> {
	const canonical = realpathSync(dest);
	if (session.harness === "claude") await trustClaudeFolder(canonical);
	const move: PendingMove = {
		cwd: canonical,
		notice: options.notice ?? `Switched session to ${canonical}.`,
		...(options.postOp ? { postOp: options.postOp } : {}),
	};
	recordTx(db, () => setPendingMove(db, session.id, move, "idle"));
	ensureSessionsServer();
	if (options.stopHost) {
		const runtime = liveRuntimeOf(db, session.id);
		if (runtime) tmuxTry(SESSIONS, "run-shell", "-b", `sleep 0.1; kill -TERM ${runtime.pid} 2>/dev/null || :`);
	}
	return canonical;
}

/** swb_move_session (agent tool): moves this session to a different directory. */
export async function moveSession(db: Db, from: string, target: string): Promise<ToolResult> {
	const session = sessionState(db, from);
	if (session.operator) throw new SwbError("Operator sessions cannot be moved.");
	const dest = validateDestination(target, session.cwd, session.cwd);
	await scheduleAgentMove(db, session, dest);
	return {
		text: `Moving this session to ${dest}. End your turn now, it will continue after the move.`,
		summary: "Restarting when turn ends",
		details: { cwd: dest },
	};
}

/** swb_worktree_list (agent tool): lists git worktrees with branch, parent, state, and path. */
export async function worktreeList(db: Db, from: string, args: ToolArgs<"swb_worktree_list">): Promise<ToolResult> {
	const session = sessionState(db, from);
	assertWorktreeCapable(session);
	const all = args.all ?? false;
	const { entries } = await listWorktrees(session.cwd, all);
	if (entries.length === 0) {
		return { text: "No worktrees found.", summary: "No worktrees", details: { worktrees: [] } };
	}
	const header = all ? "Worktrees (repo · name · branch · parent · state · path):" : "Worktrees (name · branch · parent · state · path):";
	const lines = entries.map((e) => {
		const tag = e.current ? `${e.name} *` : e.name;
		const cols = [...(all && e.repo ? [e.repo] : []), tag, e.branch, e.parent ?? "-", e.state, ...(e.path ? [e.path] : [])];
		return `- ${cols.join(" · ")}`;
	});
	const preview = entries
		.slice(0, 3)
		.map((e) => `${e.name}${e.current ? " *" : ""} (${e.branch}${e.state !== "clean" ? `, ${e.state}` : ""})`);
	const extra = entries.length > 3 ? ` … +${entries.length - 3} more` : "";
	return {
		text: `${header}\n${lines.join("\n")}`,
		summary: `${preview.join(" · ")}${extra}`,
		details: { worktrees: entries },
	};
}

/** swb_worktree_fork (agent tool): creates a new git worktree on a new branch. */
export async function worktreeFork(db: Db, from: string, args: ToolArgs<"swb_worktree_fork">): Promise<ToolResult> {
	const session = sessionState(db, from);
	assertWorktreeCapable(session);
	const wtArgs = [
		"fork",
		args.name,
		args.clean ? "--clean" : "--no-clean",
		...(args.base ? ["--base", args.base] : []),
		...(args.with ?? []).flatMap((pattern) => ["--with", pattern]),
	];
	const result = await runWt(wtArgs, session.cwd);
	if (!result.cd) throw new SwbError("wt fork did not report a destination");
	const dest = realpathSync(result.cd);
	if (args.move_session) {
		await scheduleAgentMove(db, session, dest);
		return {
			text: `Created worktree "${args.name}" at ${dest}. Moving this session there. End your turn now, it will continue after the move.`,
			summary: `Created ${shortenHome(dest)}`,
			details: { name: args.name, path: dest, moved: true },
		};
	}
	return {
		text: `Created worktree "${args.name}" at ${dest}.`,
		summary: `Created ${shortenHome(dest)}`,
		details: { name: args.name, path: dest, moved: false },
	};
}

/** swb_worktree_checkout (agent tool): checks out an existing branch into a new worktree. */
export async function worktreeCheckout(db: Db, from: string, args: ToolArgs<"swb_worktree_checkout">): Promise<ToolResult> {
	const session = sessionState(db, from);
	assertWorktreeCapable(session);
	const wtArgs = [
		"checkout",
		args.branch,
		...(args.parent ? ["--parent", args.parent] : []),
		...(args.with ?? []).flatMap((pattern) => ["--with", pattern]),
	];
	const result = await runWt(wtArgs, session.cwd);
	if (!result.cd) throw new SwbError("wt checkout did not report a destination");
	const dest = realpathSync(result.cd);
	if (args.move_session) {
		await scheduleAgentMove(db, session, dest);
		return {
			text: `Checked out "${args.branch}" at ${dest}. Moving this session there. End your turn now, it will continue after the move.`,
			summary: `Checked out ${shortenHome(dest)}`,
			details: { branch: args.branch, path: dest, moved: true },
		};
	}
	return {
		text: `Checked out "${args.branch}" at ${dest}.`,
		summary: `Checked out ${shortenHome(dest)}`,
		details: { branch: args.branch, path: dest, moved: false },
	};
}

/** swb_worktree_merge (agent tool): merges a worktree back into its parent branch and deletes it. */
export async function worktreeMerge(db: Db, from: string, args: ToolArgs<"swb_worktree_merge">): Promise<ToolResult> {
	const session = sessionState(db, from);
	assertWorktreeCapable(session);
	const prePath = await resolveWorktreePath(args.name, session.cwd);
	if (prePath) assertWorktreeSafeToModify(db, prePath, from);
	const wtArgs = [
		"merge",
		args.name,
		`--${args.mode}`,
		"--defer-removal",
		...(args.base ? ["--base", args.base] : []),
		...(args.force ? ["--force"] : []),
	];
	const result = await runWt(wtArgs, session.cwd);
	const sourcePath = result.stdout.trim();
	if (!sourcePath) throw new SwbError("wt merge did not report the source worktree");
	assertWorktreeSafeToModify(db, sourcePath, from);
	const inSource = pathContains(sourcePath, session.cwd);
	if (inSource) {
		if (!result.cd) throw new SwbError("wt merge did not report a landing worktree");
		const landing = realpathSync(result.cd);
		await scheduleAgentMove(db, session, landing, {
			prompt: `Session moved to ${landing}.`,
			postOp: { args: ["rm", "--force"], cwd: sourcePath },
		});
		return {
			text: `Merged "${args.name}" (${args.mode}) and queued worktree removal. Moving this session to ${landing}. End your turn now, it will continue after the move.`,
			summary: `Merged · moving to ${shortenHome(landing)}`,
			details: { name: args.name, mode: args.mode, landing, moved: true },
		};
	}
	await runWt(["rm", "--force"], sourcePath);
	return {
		text: `Merged "${args.name}" (${args.mode}) and removed its worktree.`,
		summary: "Merged",
		details: { name: args.name, mode: args.mode, moved: false },
	};
}

/** swb_worktree_remove (agent tool): removes a git worktree and its local branch. */
export async function worktreeRemove(db: Db, from: string, args: ToolArgs<"swb_worktree_remove">): Promise<ToolResult> {
	const session = sessionState(db, from);
	assertWorktreeCapable(session);
	const rmArgs = ["rm", args.name, ...(args.preserve_branch ? ["--preserve-branch"] : []), ...(args.force ? ["--force"] : [])];
	const validation = await runWt(injectFlag(rmArgs, "--validate-only"), session.cwd);
	const sourcePath = validation.stdout.trim();
	if (!sourcePath) throw new SwbError("wt rm did not report the source worktree");
	assertWorktreeSafeToModify(db, sourcePath, from);
	const inSource = pathContains(sourcePath, session.cwd);
	if (inSource) {
		if (!validation.cd) throw new SwbError("wt rm did not report a landing worktree");
		const landing = realpathSync(validation.cd);
		await scheduleAgentMove(db, session, landing, {
			prompt: `Session moved to ${landing}.`,
			postOp: { args: rmArgs, cwd: sourcePath },
		});
		return {
			text: `Validated removal of "${args.name}". Moving this session to ${landing} before removing it. End your turn now, it will continue after the move.`,
			summary: `Removed · moving to ${shortenHome(landing)}`,
			details: { name: args.name, landing, moved: true },
		};
	}
	await runWt(rmArgs, sourcePath);
	return {
		text: `Removed worktree "${args.name}"${args.preserve_branch ? " (kept local branch)" : ""}.`,
		summary: "Removed",
		details: { name: args.name, moved: false },
	};
}

/** swb_worktree_rebranch (agent tool): re-creates a worktree on a fresh baseline under a new branch. */
export async function worktreeRebranch(db: Db, from: string, args: ToolArgs<"swb_worktree_rebranch">): Promise<ToolResult> {
	const session = sessionState(db, from);
	assertWorktreeCapable(session);
	const prePath = await resolveWorktreePath(args.name, session.cwd);
	if (prePath) assertWorktreeSafeToModify(db, prePath, from);
	const inTarget = prePath !== null && pathContains(prePath, session.cwd);
	const wtArgs = ["rebranch", args.branch, "--move", ...(inTarget ? [] : ["-w", args.name]), ...(args.onto ? ["--onto", args.onto] : [])];
	const result = await execWt(wtArgs, session.cwd);
	if (!result.cd) throw new SwbError(result.stderr.trim() || `wt rebranch exited ${result.code}`);
	const newPath = realpathSync(result.cd);
	const conflict = result.code !== 0 ? result.stderr.trim() || `wt rebranch exited ${result.code}` : null;
	if (inTarget) {
		await scheduleAgentMove(db, session, newPath, {
			prompt: conflict ? `Session moved to ${newPath}. Note: ${conflict}` : `Session moved to ${newPath}.`,
		});
		return {
			text: `Rebranched "${args.name}" as "${args.branch}" at ${newPath}.${conflict ? ` Warning: ${conflict}` : ""} Moving this session there. End your turn now, it will continue after the move.`,
			summary: args.onto ? `Rebranched onto ${args.onto}` : `Rebranched · ${shortenHome(newPath)}`,
			details: { name: args.name, branch: args.branch, path: newPath, moved: true, ...(conflict ? { warning: conflict } : {}) },
		};
	}
	return {
		text: `Rebranched "${args.name}" as "${args.branch}" at ${newPath}.${conflict ? ` Warning: ${conflict}` : ""}`,
		summary: args.onto ? `Rebranched onto ${args.onto}` : `Rebranched · ${shortenHome(newPath)}`,
		details: { name: args.name, branch: args.branch, path: newPath, moved: false, ...(conflict ? { warning: conflict } : {}) },
	};
}

/** Human /mv slash command or CLI `swb move`: moves a session to `dir` with 0 LLM tokens. */
export async function humanMove(
	db: Db,
	id: string,
	dir: string,
	options: { defer?: boolean; stopHost?: boolean } = {},
): Promise<{ text: string; moved: boolean; cwd: string }> {
	const hasSession = db.get("SELECT 1 FROM sessions WHERE session_id = ?", id);
	if (!hasSession) throw new SwbError("nothing to move before the first prompt");
	const session = sessionState(db, id);
	if (session.operator) throw new SwbError("Operator sessions cannot be moved.");
	const dest = validateDestination(dir, session.cwd, session.cwd);
	const notice = `Switched session to ${dest}.`;
	if (options.defer) {
		await scheduleSlashMove(db, session, dest, { notice, stopHost: options.stopHost });
		return { text: `Moving session to ${shortenHome(dest)}…`, moved: true, cwd: dest };
	}
	await applyMoveNow(db, id, dest, { notice });
	return { text: `Moved session to ${shortenHome(dest)}.`, moved: true, cwd: dest };
}

/** Human /wt slash command: 1:1 mirror of `wt` CLI flags with session awareness and 0 LLM tokens. */
export async function humanWt(
	db: Db,
	id: string,
	rawInput: string,
	options: { defer?: boolean; stopHost?: boolean } = {},
): Promise<{ text: string; moved: boolean; cwd?: string }> {
	const tokens = tokenizeArgs(rawInput);
	const sub = tokens[0] as WtSlashSubcommand | undefined;
	if (!sub || !WT_SLASH_SUBCOMMANDS.includes(sub)) {
		const shown = sub ? ` ${sub}` : "";
		throw new SwbError(`Unsupported /wt command:${shown || " (missing)"}. Use: ${WT_SLASH_SUBCOMMANDS.join(", ")}`);
	}
	const args = tokens.slice(1);
	// Read-only `list`/`ls` works even before a session's first prompt.
	if (sub === "list" || sub === "ls") {
		const row = db.get("SELECT cwd FROM sessions WHERE session_id = ?", id) ?? db.get("SELECT cwd FROM runtimes WHERE session_id = ?", id);
		if (!row) throw new SwbError(`no session ${id}`);
		const cwd = row.cwd as string;
		if (!isWtInstalled(cwd)) throw new SwbError("wt is not installed or not on PATH.");
		const result = await runWt([sub, ...args], cwd);
		return { text: result.stdout.trim() || "No worktrees found.", moved: false };
	}

	const hasSession = db.get("SELECT 1 FROM sessions WHERE session_id = ?", id);
	if (!hasSession) throw new SwbError("nothing to move before the first prompt");
	const session = sessionState(db, id);
	assertWorktreeCapable(session);

	const moveTo = async (
		dest: string,
		moveOptions: { notice?: string; postOp?: { args: string[]; cwd: string } } = {},
	): Promise<{ text: string; moved: boolean; cwd: string }> => {
		const canonical = realpathSync(dest);
		if (options.defer) {
			await scheduleSlashMove(db, session, canonical, { ...moveOptions, stopHost: options.stopHost });
			return { text: `Moving session to ${shortenHome(canonical)}…`, moved: true, cwd: canonical };
		}
		await applyMoveNow(db, id, canonical, moveOptions);
		return { text: `Moved session to ${shortenHome(canonical)}.`, moved: true, cwd: canonical };
	};

	switch (sub) {
		case "fork":
		case "checkout":
		case "co": {
			const result = await runWt([sub, ...args], session.cwd);
			if (!result.cd) throw new SwbError(`wt ${sub} did not report a destination`);
			const canonical = realpathSync(result.cd);
			return moveTo(canonical, { notice: `Switched session to ${canonical}.` });
		}
		case "merge": {
			const targetName = firstPositional(args, new Set(["--base", "-b"]));
			const prePath = targetName ? await resolveWorktreePath(targetName, session.cwd) : (linkedWorktree(session.cwd)?.path ?? null);
			if (prePath) assertWorktreeSafeToModify(db, prePath, id);
			const result = await runWt(["merge", ...injectFlag(args, "--defer-removal")], session.cwd);
			const sourcePath = result.stdout.trim();
			if (!sourcePath) throw new SwbError("wt merge did not report the source worktree");
			assertWorktreeSafeToModify(db, sourcePath, id);
			if (pathContains(sourcePath, session.cwd)) {
				if (!result.cd) throw new SwbError("wt merge did not report a landing worktree");
				const landing = realpathSync(result.cd);
				return moveTo(landing, {
					notice: `Switched session to ${landing} (merged and removed ${shortenHome(sourcePath)}).`,
					postOp: { args: ["rm", "--force"], cwd: sourcePath },
				});
			}
			await runWt(["rm", "--force"], sourcePath);
			const msg = result.stderr.trim();
			return { text: msg || "Merged and removed worktree.", moved: false };
		}
		case "rm": {
			const validation = await runWt(["rm", ...injectFlag(args, "--validate-only")], session.cwd);
			const sourcePath = validation.stdout.trim();
			if (!sourcePath) throw new SwbError("wt rm did not report the source worktree");
			assertWorktreeSafeToModify(db, sourcePath, id);
			if (pathContains(sourcePath, session.cwd)) {
				if (!validation.cd) throw new SwbError("wt rm did not report a landing worktree");
				const landing = realpathSync(validation.cd);
				return moveTo(landing, {
					notice: `Switched session to ${landing} (removed ${shortenHome(sourcePath)}).`,
					postOp: { args: ["rm", ...args], cwd: sourcePath },
				});
			}
			const removed = await runWt(["rm", ...args], sourcePath);
			return { text: removed.stderr.trim() || "Removed worktree.", moved: false };
		}
		case "rebranch": {
			const forWt = flagValue(args, "-w", "--for-worktree");
			const prePath = forWt ? await resolveWorktreePath(forWt, session.cwd) : (linkedWorktree(session.cwd)?.path ?? null);
			if (prePath) assertWorktreeSafeToModify(db, prePath, id);
			const result = await execWt(["rebranch", ...injectFlag(args, "--move")], session.cwd);
			if (!result.cd) throw new SwbError(result.stderr.trim() || `wt rebranch exited ${result.code}`);
			const dest = realpathSync(result.cd);
			const warning = result.code !== 0 ? result.stderr.trim() || `wt rebranch exited ${result.code}` : undefined;
			const inTarget = prePath === null || pathContains(prePath, session.cwd);
			if (!inTarget) {
				return {
					text: warning ? `Rebranched at ${shortenHome(dest)}. Warning: ${warning}` : `Rebranched at ${shortenHome(dest)}.`,
					moved: false,
				};
			}
			const notice = warning ? `Switched session to ${dest}. Warning: ${warning}` : `Switched session to ${dest}.`;
			return moveTo(dest, { notice });
		}
	}
}

/** Deck worktree operations (work on both live idle and dormant sessions). */
export async function deckWorktreeFork(
	db: Db,
	id: string,
	options: { name: string; clean: boolean; moveSession: boolean },
): Promise<string> {
	const session = sessionState(db, id);
	assertWorktreeCapable(session);
	if (options.moveSession && session.live && session.activity !== "idle") throw new SwbError("turn running: wait for it to complete");
	const wtArgs = ["fork", options.name, options.clean ? "--clean" : "--no-clean"];
	const result = await runWt(wtArgs, session.cwd);
	if (!result.cd) throw new SwbError("wt fork did not report a destination");
	const dest = realpathSync(result.cd);
	if (options.moveSession) {
		await applyMoveNow(db, id, dest, { notice: `Switched session to ${dest}.` });
		return `Forked & moved to ${options.name}`;
	}
	return `Forked ${options.name} at ${shortenHome(dest)}`;
}

export async function deckWorktreeCheckout(db: Db, id: string, options: { branch: string; moveSession: boolean }): Promise<string> {
	const session = sessionState(db, id);
	assertWorktreeCapable(session);
	if (options.moveSession && session.live && session.activity !== "idle") throw new SwbError("turn running: wait for it to complete");
	const result = await runWt(["checkout", options.branch], session.cwd);
	if (!result.cd) throw new SwbError("wt checkout did not report a destination");
	const dest = realpathSync(result.cd);
	if (options.moveSession) {
		await applyMoveNow(db, id, dest, { notice: `Switched session to ${dest}.` });
		return `Checked out & moved to ${options.branch}`;
	}
	return `Checked out ${options.branch} at ${shortenHome(dest)}`;
}

export async function deckWorktreeMerge(
	db: Db,
	id: string,
	options: { mode: "rebase" | "squash" | "staged"; force?: boolean },
): Promise<string> {
	const session = sessionState(db, id);
	assertWorktreeCapable(session);
	if (session.live && session.activity !== "idle") throw new SwbError("turn running: wait for it to complete");
	const prePath = linkedWorktree(session.cwd)?.path;
	if (prePath) assertWorktreeSafeToModify(db, prePath, id);
	const result = await runWt(["merge", `--${options.mode}`, "--defer-removal", ...(options.force ? ["--force"] : [])], session.cwd);
	const sourcePath = result.stdout.trim();
	if (!sourcePath) throw new SwbError("wt merge did not report the source worktree");
	assertWorktreeSafeToModify(db, sourcePath, id);
	if (!result.cd) throw new SwbError("wt merge did not report a landing worktree");
	const landing = realpathSync(result.cd);
	await applyMoveNow(db, id, landing, {
		notice: `Switched session to ${landing} (merged and removed ${shortenHome(sourcePath)}).`,
		postOp: { args: ["rm", "--force"], cwd: sourcePath },
	});
	return `Merged (${options.mode}) → ${basename(landing)}`;
}

export async function deckWorktreeRemove(db: Db, id: string, options: { preserveBranch?: boolean; force?: boolean } = {}): Promise<string> {
	const session = sessionState(db, id);
	assertWorktreeCapable(session);
	if (session.live && session.activity !== "idle") throw new SwbError("turn running: wait for it to complete");
	const rmArgs = ["rm", ...(options.preserveBranch ? ["--preserve-branch"] : []), ...(options.force ? ["--force"] : [])];
	const validation = await runWt(injectFlag(rmArgs, "--validate-only"), session.cwd);
	const sourcePath = validation.stdout.trim();
	if (!sourcePath) throw new SwbError("wt rm did not report the source worktree");
	assertWorktreeSafeToModify(db, sourcePath, id);
	if (!validation.cd) throw new SwbError("wt rm did not report a landing worktree");
	const landing = realpathSync(validation.cd);
	await applyMoveNow(db, id, landing, {
		notice: `Switched session to ${landing} (removed ${shortenHome(sourcePath)}).`,
		postOp: { args: rmArgs, cwd: sourcePath },
	});
	return `Removed worktree → ${basename(landing)}`;
}

export async function deckWorktreeRebranch(db: Db, id: string, options: { branch: string; onto?: string }): Promise<string> {
	const session = sessionState(db, id);
	assertWorktreeCapable(session);
	if (session.live && session.activity !== "idle") throw new SwbError("turn running: wait for it to complete");
	assertWorktreeSafeToModify(db, session.cwd, id);
	const result = await execWt(["rebranch", options.branch, "--move", ...(options.onto ? ["--onto", options.onto] : [])], session.cwd);
	if (!result.cd) throw new SwbError(result.stderr.trim() || `wt rebranch exited ${result.code}`);
	const dest = realpathSync(result.cd);
	const warning = result.code !== 0 ? result.stderr.trim() || `wt rebranch exited ${result.code}` : undefined;
	await applyMoveNow(db, id, dest, {
		notice: warning ? `Switched session to ${dest}. Warning: ${warning}` : `Switched session to ${dest}.`,
	});
	return warning ? `Rebranched → ${options.branch} (conflicts)` : `Rebranched → ${options.branch}`;
}
