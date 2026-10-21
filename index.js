// packages/lines/pi/src/index.ts
import { spawn } from "node:child_process";
import { mkdirSync as mkdirSync3, readFileSync as readFileSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname4, join as join3 } from "node:path";
import { Text } from "@earendil-works/pi-tui";

// packages/shared/src/index.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync2, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname as dirname2, join } from "node:path";

// packages/shared/src/db.ts
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
var require2 = createRequire(import.meta.url);
function connect(path) {
  if (process.versions.bun) {
    const { Database } = require2("bun:sqlite");
    return new Database(path, { strict: false });
  }
  const { DatabaseSync } = require2("node:sqlite");
  return new DatabaseSync(path);
}

class Db {
  path;
  #driver;
  constructor(path, { create }) {
    this.path = path;
    if (create) {
      mkdirSync(dirname(path), { recursive: true, mode: 448 });
      closeSync(openSync(path, "a", 384));
    } else if (!existsSync(path)) {
      throw new Error(`no db at ${path}`);
    }
    this.#driver = connect(path);
    this.#driver.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
  }
  get(sql, ...params) {
    return this.#driver.prepare(sql).get(...params) ?? undefined;
  }
  all(sql, ...params) {
    return this.#driver.prepare(sql).all(...params);
  }
  run(sql, ...params) {
    this.#driver.prepare(sql).run(...params);
  }
  exec(sql) {
    this.#driver.exec(sql);
  }
  userVersion() {
    return Number(this.get("PRAGMA user_version")?.user_version);
  }
  dataVersion() {
    return Number(this.get("PRAGMA data_version")?.data_version);
  }
  tx(body) {
    this.#driver.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.#driver.exec("COMMIT");
      return result;
    } catch (error) {
      this.#driver.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.#driver.close();
  }
}

// packages/shared/src/index.ts
var SCHEMA_VERSION = 6;
var VIEWS = ["agent", "editor", "split"];
var HARNESSES = ["pi", "claude", "codex"];
var SNOOZE_PRESETS = ["one_hour", "one_day", "monday", "next_message"];
function stateDir() {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "agent-switchboard");
}
function configDir() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-switchboard");
}
function operatorDir() {
  if (physicalOperatorDir)
    return physicalOperatorDir;
  const dir = join(configDir(), "operator");
  if (!existsSync2(dir))
    return dir;
  physicalOperatorDir = realpathSync(dir);
  return physicalOperatorDir;
}
var physicalOperatorDir;
function shortlistPath() {
  return join(stateDir(), "shortlist.txt");
}
function launchGuide() {
  try {
    return readFileSync(shortlistPath(), "utf8");
  } catch (error) {
    if (error.code === "ENOENT")
      return "";
    throw error;
  }
}
function describeTool(name, description, guide) {
  return name === "session_launch" && guide !== "" ? `${description}

${guide}` : description;
}
function bootId() {
  if (process.platform === "darwin")
    return execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" }).trim();
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function git(cwd, ...args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
function projectRoot(cwd) {
  const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common ? dirname2(common) : cwd;
}
function branch(cwd) {
  const name = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  return name === "HEAD" ? git(cwd, "rev-parse", "--short", "HEAD") : name;
}

// packages/shared/src/mailbox.ts
import { mkdirSync as mkdirSync2, rmSync, watch, writeFileSync } from "node:fs";
import { dirname as dirname3, join as join2 } from "node:path";

// packages/shared/src/record.ts
function recordTx(db, body) {
  return db.tx(() => {
    const version = db.userVersion();
    if (version !== SCHEMA_VERSION)
      throw new Error(`db schema is v${version}, this line writes v${SCHEMA_VERSION}`);
    return body();
  });
}
function liveHost(row) {
  if (row && row.boot_id === bootId() && pidAlive(row.pid))
    return row.tmux_session;
  return;
}
function hostOfSession(db, sessionId, exceptHost) {
  return liveHost(db.get("SELECT tmux_session, boot_id, pid FROM runtimes WHERE session_id = ? AND tmux_session != ?", sessionId, exceptHost));
}
function hostOfTranscript(db, transcript, exceptHost) {
  return liveHost(db.get("SELECT r.tmux_session, r.boot_id, r.pid FROM runtimes r JOIN sessions s USING (session_id) WHERE s.transcript = ? AND r.tmux_session != ?", transcript, exceptHost));
}
function startHosting(db, h) {
  recordTx(db, () => {
    const other = hostOfSession(db, h.sessionId, h.host);
    if (other)
      throw new Error(`session ${h.sessionId} is already open in another process (${other})`);
    db.run("DELETE FROM runtimes WHERE session_id = ? AND tmux_session != ?", h.sessionId, h.host);
    db.run(`INSERT INTO runtimes (tmux_session, session_id, harness, cwd, project_root, boot_id, pid, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (tmux_session) DO UPDATE SET session_id = excluded.session_id, harness = excluded.harness, cwd = excluded.cwd,
			   project_root = excluded.project_root, boot_id = excluded.boot_id, pid = excluded.pid`, h.host, h.sessionId, h.harness, h.cwd, projectRoot(h.cwd), bootId(), h.pid, Date.now());
    db.run("UPDATE sessions SET phase = CASE WHEN ? THEN 'idle' ELSE phase END, cwd = ?, project_root = ?, branch = ?, transcript = ? WHERE session_id = ?", h.idle ? 1 : 0, h.cwd, projectRoot(h.cwd), branch(h.cwd), h.transcript, h.sessionId);
  });
}
function startTurn(db, t) {
  recordTx(db, () => {
    const now = Date.now();
    const first = !db.get("SELECT 1 FROM sessions WHERE session_id = ?", t.sessionId);
    db.run(`INSERT INTO sessions (session_id, harness, parent_id, cwd, project_root, transcript, title, branch, phase, created_at, last_prompt_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'working', ?, ?)
			 ON CONFLICT (session_id) DO UPDATE SET phase = 'working',
			   last_prompt_at = CASE WHEN sessions.phase = 'idle' THEN excluded.last_prompt_at ELSE sessions.last_prompt_at END`, t.sessionId, t.harness, t.parentId, t.cwd, projectRoot(t.cwd), t.transcript, t.title, branch(t.cwd), now, now);
    if (first && t.parentId)
      db.run(`INSERT INTO marks (session_id, group_name)
				 SELECT ?, m.group_name FROM sessions p JOIN marks m USING (session_id)
				 WHERE p.session_id = ? AND p.project_root = ? AND m.group_name IS NOT NULL`, t.sessionId, t.parentId, projectRoot(t.cwd));
  });
}
function setPhase(db, sessionId, phase) {
  recordTx(db, () => db.run("UPDATE sessions SET phase = ? WHERE session_id = ? AND phase != 'idle'", phase, sessionId));
}
function settle(db, s) {
  return recordTx(db, () => {
    harnessTitled(db, s.sessionId, s.title);
    db.run("UPDATE sessions SET phase = 'idle', last_settled_at = ?, cwd = ?, project_root = ?, branch = ?, title = coalesce(?, title) WHERE session_id = ?", Date.now(), s.cwd, projectRoot(s.cwd), branch(s.cwd), s.title, s.sessionId);
    db.run("UPDATE runtimes SET cwd = ?, project_root = ? WHERE tmux_session = ?", s.cwd, projectRoot(s.cwd), s.host);
    return { archived: isArchived(db, s.sessionId) };
  });
}
function turnErrored(db, sessionId) {
  recordTx(db, () => db.run("UPDATE sessions SET errored_at = ? WHERE session_id = ?", Date.now(), sessionId));
}
function setTitle(db, sessionId, title) {
  recordTx(db, () => {
    harnessTitled(db, sessionId, title);
    db.run("UPDATE sessions SET title = ? WHERE session_id = ?", title, sessionId);
  });
}
function harnessTitled(db, sessionId, title) {
  if (title === null)
    return;
  db.run("UPDATE marks SET title = NULL WHERE session_id = ? AND ? IS NOT (SELECT title FROM sessions WHERE session_id = ?)", sessionId, title, sessionId);
}
function pendingTitle(db, sessionId) {
  const row = db.get("SELECT m.title FROM marks m JOIN sessions s USING (session_id) WHERE m.session_id = ? AND m.title IS NOT NULL AND m.title IS NOT s.title", sessionId);
  return row?.title ?? null;
}
function titleOf(db, sessionId) {
  const row = db.get("SELECT coalesce(m.title, s.title) AS title FROM sessions s LEFT JOIN marks m USING (session_id) WHERE s.session_id = ?", sessionId);
  return row?.title ?? null;
}
function endHosting(db, host) {
  recordTx(db, () => db.run("DELETE FROM runtimes WHERE tmux_session = ?", host));
}
function isArchived(db, sessionId) {
  return Boolean(db.get("SELECT 1 FROM sessions s JOIN marks m USING (session_id) WHERE s.session_id = ? AND m.archived_at >= s.last_prompt_at", sessionId));
}
function markArchived(db, sessionId) {
  if (!db.get("SELECT 1 FROM sessions WHERE session_id = ?", sessionId))
    return false;
  const now = Date.now();
  db.run(`INSERT INTO marks (session_id, archived_at) VALUES (?, ?)
		 ON CONFLICT (session_id) DO UPDATE SET archived_at = excluded.archived_at, snoozed_at = NULL, snoozed_until = NULL`, sessionId, now);
  db.run("UPDATE messages SET cancelled_at = ? WHERE target_id = ? AND delivered_at IS NULL AND cancelled_at IS NULL", now, sessionId);
  db.run("UPDATE schedules SET cancelled_at = ? WHERE target_id = ? AND next_at IS NOT NULL AND cancelled_at IS NULL", now, sessionId);
  return true;
}

// packages/shared/src/mailbox.ts
function doorbells(db) {
  const dir = join2(dirname3(db.path), "doorbells");
  mkdirSync2(dir, { recursive: true, mode: 448 });
  return dir;
}
function listen(db, heard) {
  const watcher = watch(doorbells(db), (_event, name) => {
    if (name)
      heard(name.toString());
  });
  watcher.unref();
  return watcher;
}
var HARNESS_NAMES = { pi: "pi", claude: "Claude Code", codex: "Codex" };
function harnessName(harness) {
  return HARNESS_NAMES[harness];
}
function pendingFor(db, targetId) {
  return db.all(`SELECT id, kind, source_id, target_id, body, request_response, created_at, schedule_id, scheduled_for FROM messages
			 WHERE target_id = ? AND delivered_at IS NULL AND cancelled_at IS NULL ORDER BY created_at, rowid`, targetId).map((row) => ({
    id: row.id,
    kind: row.kind,
    sourceId: row.source_id,
    targetId: row.target_id,
    body: row.body,
    requestResponse: row.request_response === 1,
    createdAt: row.created_at,
    scheduleId: row.schedule_id,
    scheduledFor: row.scheduled_for
  }));
}
function markDelivered(db, id) {
  db.run("UPDATE messages SET delivered_at = coalesce(delivered_at, ?) WHERE id = ?", Date.now(), id);
}
function sender(db, sourceId) {
  const row = db.get("SELECT harness FROM sessions WHERE session_id = ?", sourceId);
  return { title: titleOf(db, sourceId) ?? sourceId, harness: row?.harness ?? null };
}
function clockTime(ms) {
  const d = new Date(ms);
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
  return `${day}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
var LATE_MS = 60000;
function frame(db, m, now = Date.now()) {
  const from = sender(db, m.sourceId);
  const who = m.sourceId === m.targetId ? ", this session" : from.harness ? `, ${harnessName(from.harness)}` : "";
  let when = "";
  if (m.scheduledFor !== null) {
    when = `, scheduled for ${clockTime(m.scheduledFor)}`;
    if (now - m.scheduledFor > LATE_MS)
      when += `, delivered ${clockTime(now)}`;
    if (m.scheduleId)
      when += ` (schedule: ${m.scheduleId})`;
  }
  const reply = m.requestResponse ? `

Response requested: reply with session_send_message to session ${m.sourceId}.` : "";
  return `Message from session "${from.title}" (session: ${m.sourceId}${who})${when}:

${m.body}${reply}`;
}

// packages/shared/src/tools.ts
import { Type } from "typebox";
import { Value } from "typebox/value";
var session = Type.String({ description: "The target session's id, from session_reachable." });
var requestResponse = Type.Boolean({ description: "Whether the recipient should reply to this session." });
var cwd = Type.Optional(Type.String({ description: "Its working directory; defaults to this session's." }));
var title = Type.String({ description: "A short title for the roster." });
var preset = {
  harness: Type.Optional(Type.Union(HARNESSES.map((name) => Type.Literal(name)), { description: "pi, claude (Claude Code), or codex." })),
  model: Type.Optional(Type.String({ description: "As listed." })),
  effort: Type.Optional(Type.String({ description: "As listed; needed only between presets of one model." })),
  agent: Type.Optional(Type.String({ description: "A Claude Code agent, as listed, in place of model and effort." }))
};
var TOOLS = {
  session_reachable: {
    description: "List every open session on the switchboard except this one.",
    guidelines: [
      "Use session_reachable to find another session before messaging, cancelling, or archiving it.",
      "Sessions in other projects and other harnesses are all reachable; a dormant one wakes when messaged."
    ],
    parameters: Type.Object({}),
    readOnly: true
  },
  session_send_message: {
    description: "Send a message to another session on the switchboard. It arrives in that session's conversation, mid-turn when it is working; a dormant session is woken first.",
    guidelines: [
      "Messages are for coordinating with the session that owns the work; don't send what you can do yourself.",
      "Set requestResponse when you need an answer; the reply arrives later as a message to you, so end your turn instead of polling."
    ],
    parameters: Type.Object({
      session,
      message: Type.String({ description: "The message, self-contained: the recipient doesn't see this conversation." }),
      requestResponse
    }),
    readOnly: false
  },
  session_cancel: {
    description: "Stop another session's running turn. The session stays open.",
    guidelines: ["Only cancel another session's turn when the user asks for it."],
    parameters: Type.Object({ session }),
    readOnly: false
  },
  session_launch: {
    description: "Start a new session on the switchboard, on one of the presets below.",
    guidelines: [
      "Write the goal as a complete briefing: objective, relevant context, constraints, and what done means.",
      "Launch a new session when the work is independent of this one, belongs to another directory, or the user asks for one.",
      "Omit the preset fields to carry forward what this session runs now. To switch, pass the fields of the preset whose note fits the work; anything not listed is refused."
    ],
    parameters: Type.Object({
      ...preset,
      goal: Type.String({ description: "The self-contained briefing, delivered as its first message." }),
      cwd,
      title,
      requestResponse: Type.Boolean({ description: "Whether it should report back to this session when done." })
    }),
    readOnly: false
  },
  session_schedule: {
    description: "Schedule a message for later, once or on a recurring cron schedule: to this session, another session, or a new session launched when it fires.",
    guidelines: [
      "Schedule only when the user asks to remind, follow up, check back, or repeat something. To wait on another session, set requestResponse on your message instead of scheduling checks.",
      "For something expected within a few minutes, keep working in this turn instead.",
      "Write the message as instructions for when it fires: what to check, and what to do with each outcome. A recurring message should say when to unschedule itself.",
      "To message this session, omit both session and launch.",
      "Set snooze only when the user asks for it."
    ],
    parameters: Type.Object({
      message: Type.String({ description: "What to deliver, self-contained when it goes to another session." }),
      at: Type.Optional(Type.String({
        description: 'When, once: an ISO 8601 time, local unless it has an offset ("2026-10-23T15:00"), or a duration from now ("PT2H", "P1D").'
      })),
      cron: Type.Optional(Type.String({
        description: 'Recurring instead: standard 5-field cron in local time, "M H DoM Mon DoW" (e.g. "57 8 * * 1-5" = weekdays at 8:57am).'
      })),
      label: Type.String({ description: 'When it runs, in plain words, such as "Weekdays, 8:57 AM".' }),
      session: Type.Optional(session),
      launch: Type.Optional(Type.Object({
        ...preset,
        cwd,
        title
      }, {
        description: "Instead of an existing session, launch a new one each time it fires, on a preset as session_launch takes it, with the message as its goal."
      })),
      requestResponse: Type.Optional(requestResponse),
      snooze: Type.Optional(Type.Boolean({ description: "Snooze the recipient until this fires." }))
    }),
    readOnly: false
  },
  session_schedules: {
    description: "List this session's schedules, the ones it set and the ones that deliver to it: pending ones with their next run, finished ones with their last.",
    guidelines: [],
    parameters: Type.Object({}),
    readOnly: true
  },
  session_unschedule: {
    description: "Cancel a pending schedule.",
    guidelines: ["Unschedule only when the user asks, or when the schedule's stated completion condition is met."],
    parameters: Type.Object({ id: Type.String({ description: "The schedule's id, from session_schedules." }) }),
    readOnly: false
  },
  swb_update_session: {
    description: "Update one session on the switchboard: this one, unless you name another.",
    guidelines: [
      "Archive only when the user asks, or when you started that session and have driven it to completion.",
      "Archiving this session quits it when the turn ends: call it last, then end with a brief final message.",
      "Archiving refuses any session other than this one that is mid-turn, blocked, cut off, or errored, and names them. If they should go anyway, call again with force, which cancels their turns.",
      "Unarchiving doesn't restart a session; session_send_message wakes it.",
      "Snooze or unsnooze only when the user asks.",
      "Group sessions when the user asks, or to keep sessions you started for one piece of work together. Reuse a Group session_reachable lists in that Project rather than inventing a near-duplicate.",
      "Retitle a session when the user asks, or when its title no longer says what it is working on."
    ],
    parameters: Type.Object({
      session: Type.Optional(session),
      archived: Type.Optional(Type.Boolean({ description: "True to archive, false to unarchive." })),
      family: Type.Optional(Type.Boolean({ description: "With archived true: archive every open session it started too, and the ones they started." })),
      force: Type.Optional(Type.Boolean({
        description: "With archived true: archive sessions mid-turn, blocked, cut off, or errored anyway, cancelling their turns."
      })),
      group: Type.Optional(Type.Union([Type.String(), Type.Null()], {
        description: "The Group to move it into, within its Project; null takes it out of its Group."
      })),
      title: Type.Optional(Type.String({ description: "A new, short title." })),
      snooze: Type.Optional(Type.Union([...[...SNOOZE_PRESETS, "off"].map((preset) => Type.Literal(preset)), Type.Object({ until: Type.String() })], {
        description: 'How long to snooze it, off to unsnooze, or {"until":"2026-11-05T09:00:00-08:00"} for a set time.'
      }))
    }),
    readOnly: false
  },
  swb_show_session: {
    description: "Show the user a specific session by switching focus to it.",
    guidelines: ["Call it last in your turn, and end with one short line; the user won't be watching this session afterward."],
    parameters: Type.Object({
      session,
      view: Type.Optional(Type.Union(VIEWS.map((view) => Type.Literal(view)), { description: "agent, its directory's editor, or a split of both; omit unless the user asks for one." }))
    }),
    readOnly: false
  }
};

// packages/shared/src/trace.ts
import { appendFileSync } from "node:fs";
var file = process.env.SWB_TRACE;
function now() {
  return performance.timeOrigin + performance.now();
}
function write(event) {
  if (file)
    appendFileSync(file, `${JSON.stringify({ ...event, pid: process.pid })}
`);
}
function mark(name) {
  if (file)
    write({ name, at: now() });
}
function span(name, run) {
  if (!file)
    return run();
  const at = now();
  const result = run();
  if (result instanceof Promise)
    return result.finally(() => write({ name, at, ms: now() - at }));
  write({ name, at, ms: now() - at });
  return result;
}

// packages/lines/pi/src/index.ts
var KEY = Symbol.for("agent-switchboard.recorder");
var store = globalThis;
var MESSAGE = "swb.message";
var LINEAGE = "pi-sessions.lineage";
function claim() {
  const env = process.env;
  if (env.SWB_MANAGED === "1" && env.SWB_DB && env.SWB_TMUX_SESSION) {
    store[KEY] = {
      launch: Object.freeze({ db: env.SWB_DB, tmuxSession: env.SWB_TMUX_SESSION, bin: env.SWB_BIN ?? "" }),
      attention: new Set,
      ...env.SWB_PARENT ? { parent: env.SWB_PARENT } : {},
      ...env.SWB_BIN ? {} : { failure: "started by an swb older than this line; upgrade swb" }
    };
  }
  delete env.SWB_MANAGED;
  delete env.SWB_DB;
  delete env.SWB_TMUX_SESSION;
  delete env.SWB_BIN;
  delete env.SWB_PARENT;
  return store[KEY];
}
function swb(bin, args, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0)
        resolve(JSON.parse(out));
      else
        reject(new Error(err.trim().replace(/^swb: /, "") || `swb ${args[0]} exited ${code}`));
    });
    child.stdin.end(stdin);
  });
}
function src_default(pi) {
  mark("pi-line.load");
  pi.on("project_trust", (event) => ({ trusted: event.cwd === operatorDir() ? "yes" : "undecided" }));
  const claimed = claim();
  if (!claimed)
    return;
  const proc = claimed;
  let ui;
  let ctxNow;
  pi.events.on("pi-sessions:hosts", (request) => request.register({ name: "swb", peers: true }));
  const showFailure = () => ui?.setStatus("swb", ui.theme.fg("error", `swb: not recording: ${proc.failure}`));
  const connect = () => {
    proc.db ??= new Db(proc.launch.db, { create: false });
    return proc.db;
  };
  const fail = (error) => {
    proc.failure = error instanceof Error ? error.message : String(error);
    showFailure();
    ui?.notify(`swb: not recording: ${proc.failure}`, "error");
  };
  const write = (sessionId, body) => {
    if (proc.failure) {
      showFailure();
      return;
    }
    try {
      body(connect(), sessionId);
    } catch (error) {
      fail(error);
    }
  };
  const writeFor = (ctx, body) => {
    ui = ctx.ui;
    write(ctx.sessionManager.getSessionId(), body);
  };
  let current;
  let launchedBy;
  pi.on("session_before_switch", (event, ctx) => {
    if (event.reason !== "resume" || !event.targetSessionFile || proc.failure)
      return;
    ui = ctx.ui;
    let host;
    try {
      host = hostOfTranscript(connect(), event.targetSessionFile, proc.launch.tmuxSession);
    } catch (error) {
      fail(error);
      return;
    }
    if (!host)
      return;
    ctx.ui.notify(`swb: that session is already open in another pi (${host})`, "error");
    return { cancel: true };
  });
  const draftPath = (id) => join3(dirname4(proc.launch.db), "drafts", id);
  const restoreDraft = (ctx, id) => {
    let draft;
    try {
      draft = readFileSync2(draftPath(id), "utf8");
    } catch (error) {
      if (error.code === "ENOENT")
        return;
      throw error;
    }
    if (!ctx.ui.getEditorText())
      ctx.ui.setEditorText(draft);
    rmSync2(draftPath(id));
  };
  let seenVersion = -1;
  const deliver = () => {
    const ctx = ctxNow;
    if (!ctx || !current || proc.failure)
      return;
    try {
      const db = connect();
      const version = db.dataVersion();
      if (version === seenVersion)
        return;
      seenVersion = version;
      for (const m of pendingFor(db, current)) {
        if (m.kind === "cancel") {
          if (!ctx.isIdle())
            ctx.abort();
        } else {
          const details = { from: m.sourceId, title: sender(db, m.sourceId).title, body: m.body };
          pi.sendMessage({ customType: MESSAGE, content: frame(db, m), display: true, details }, ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" });
        }
        markDelivered(db, m.id);
      }
      const title = pendingTitle(db, current);
      if (title !== null && title !== ctx.sessionManager.getSessionName())
        pi.setSessionName(title);
    } catch (error) {
      fail(error);
    }
  };
  pi.registerMessageRenderer(MESSAGE, (message, _options, theme) => {
    const details = message.details;
    return new Text(`${theme.fg("accent", `↘ ${details.title}`)}
${details.body}`, 0, 0);
  });
  pi.on("session_start", (event, ctx) => {
    current = ctx.sessionManager.getSessionId();
    ctxNow = ctx;
    seenVersion = -1;
    if (event.reason !== "reload")
      restoreDraft(ctx, current);
    proc.attention.clear();
    if (proc.parent) {
      launchedBy = { sessionId: current, parent: proc.parent };
      if (!ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === LINEAGE))
        pi.appendEntry(LINEAGE, { parentSessionId: proc.parent });
      delete proc.parent;
    }
    span("pi-line.start-hosting", () => writeFor(ctx, (db, id) => {
      const transcript = ctx.sessionManager.getSessionFile();
      if (!transcript)
        throw new Error("pi is running without a session file");
      startHosting(db, {
        host: proc.launch.tmuxSession,
        harness: "pi",
        sessionId: id,
        cwd: ctx.cwd,
        transcript,
        pid: process.pid,
        idle: ctx.isIdle()
      });
    }));
    if (proc.inbox)
      clearInterval(proc.inbox);
    proc.inbox = setInterval(deliver, 250);
    proc.inbox.unref();
    proc.doorbell?.close();
    write(current, (db) => {
      proc.doorbell = listen(db, (id) => {
        if (id === current)
          deliver();
      });
    });
  });
  pi.on("agent_start", (_event, ctx) => {
    writeFor(ctx, (db, id) => {
      const transcript = ctx.sessionManager.getSessionFile();
      if (!transcript)
        throw new Error("pi is running without a session file");
      const title = ctx.sessionManager.getSessionName() ?? null;
      const parentId = launchedBy?.sessionId === id ? launchedBy.parent : null;
      startTurn(db, { harness: "pi", sessionId: id, cwd: ctx.cwd, transcript, title, parentId });
    });
  });
  const waiting = (key, open) => {
    if (!current)
      return;
    if (open)
      proc.attention.add(key);
    else
      proc.attention.delete(key);
    const phase = proc.attention.size > 0 ? "blocked" : "working";
    write(current, (db, id) => setPhase(db, id, phase));
  };
  const attention = (open) => (data) => {
    const attentionId = data.attentionId;
    if (typeof attentionId === "string")
      waiting(`glimpse:${attentionId}`, open);
  };
  pi.events.on("glimpseui:attention:request", attention(true));
  pi.events.on("glimpseui:attention:resolve", attention(false));
  pi.on("ui_prompt_start", () => waiting("ui-prompt", true));
  pi.on("ui_prompt_end", () => waiting("ui-prompt", false));
  let stopReason;
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant")
      stopReason = event.message.stopReason;
  });
  pi.on("agent_settled", (event, ctx) => {
    proc.attention.clear();
    writeFor(ctx, (db, id) => {
      if (stopReason === "error" && !event.aborted)
        turnErrored(db, id);
      const { archived } = settle(db, {
        host: proc.launch.tmuxSession,
        sessionId: id,
        cwd: ctx.cwd,
        title: ctx.sessionManager.getSessionName() ?? null
      });
      if (archived)
        ctx.shutdown();
    });
  });
  pi.on("session_info_changed", (event, ctx) => {
    writeFor(ctx, (db, id) => setTitle(db, id, event.name ?? null));
  });
  const markArchived2 = (ctx) => {
    let archived = false;
    writeFor(ctx, (db, id) => {
      archived = recordTx(db, () => markArchived(db, id));
    });
    return archived;
  };
  pi.registerCommand("archive", {
    description: "Archive this session in swb and quit",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("swb: turn running: wait for it to complete", "error");
        return;
      }
      if (markArchived2(ctx))
        ctx.shutdown();
      else if (!proc.failure)
        ctx.ui.notify("swb: nothing to archive before the first prompt", "error");
    }
  });
  const guide = launchGuide();
  const tool = (name, label, target, run) => pi.registerTool({
    name,
    label,
    description: describeTool(name, TOOLS[name].description, guide),
    promptSnippet: describeTool(name, TOOLS[name].description, guide),
    promptGuidelines: TOOLS[name].guidelines,
    parameters: TOOLS[name].parameters,
    renderCall(args, theme) {
      const what = target(args);
      return new Text(`${theme.fg("toolTitle", theme.bold(label))}${what ? ` · ${theme.fg("accent", what)}` : ""}`, 0, 0);
    },
    renderResult(result, _options, theme, context) {
      const output = result.content.find((item) => item.type === "text")?.text ?? "";
      return new Text(context.isError ? theme.fg("error", output) : theme.fg("dim", output), 0, 0);
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (proc.failure)
        throw new Error(`swb: not recording: ${proc.failure}`);
      const result = await run(params, ctx, toolCallId);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    }
  });
  const self = (ctx) => ctx.sessionManager.getSessionId();
  const titleOf2 = (id) => typeof id === "string" ? titleOf(connect(), id) ?? id : "";
  tool("session_reachable", "Reachable sessions", () => "", (_args, ctx) => swb(proc.launch.bin, ["reachable", "--from", self(ctx)]));
  tool("session_send_message", "Message", (args) => titleOf2(args.session), (args, ctx, toolCallId) => swb(proc.launch.bin, [
    "send",
    "--from",
    self(ctx),
    "--to",
    args.session,
    "--request-id",
    toolCallId,
    ...args.requestResponse ? ["--request-response"] : []
  ], args.message));
  tool("session_cancel", "Cancel", (args) => titleOf2(args.session), (args, ctx) => swb(proc.launch.bin, ["send", "--from", self(ctx), "--to", args.session, "--cancel"]));
  tool("session_launch", "Launch", (args) => `${[args.harness, args.agent, args.model].filter(Boolean).join(" ") || "default"} · ${args.title}`, (args, ctx) => swb(proc.launch.bin, [
    "launch",
    ...["harness", "model", "effort", "agent"].flatMap((k) => args[k] ? [`--${k}`, args[k]] : []),
    "--from",
    self(ctx),
    "--cwd",
    args.cwd ?? ctx.cwd,
    "--title",
    args.title,
    ...args.requestResponse ? ["--request-response"] : []
  ], args.goal));
  tool("session_schedule", "Schedule", (args) => `${args.launch ? `new ${args.launch.title}` : args.session ? titleOf2(args.session) : "this session"} · ${args.label}${args.snooze ? " · snooze" : ""}`, (args, ctx, toolCallId) => swb(proc.launch.bin, [
    "schedule",
    "--from",
    self(ctx),
    "--label",
    args.label,
    "--request-id",
    toolCallId,
    ...args.at !== undefined ? ["--at", args.at] : [],
    ...args.cron !== undefined ? ["--cron", args.cron] : [],
    ...args.session !== undefined ? ["--to", args.session] : [],
    ...args.launch ? [
      ...["harness", "model", "effort", "agent"].flatMap((k) => args.launch?.[k] ? [`--launch-${k}`, args.launch[k]] : []),
      "--launch-title",
      args.launch.title,
      "--launch-cwd",
      args.launch.cwd ?? ctx.cwd
    ] : [],
    ...args.requestResponse ? ["--request-response"] : [],
    ...args.snooze ? ["--snooze"] : []
  ], args.message));
  tool("session_schedules", "Schedules", () => "", (_args, ctx) => swb(proc.launch.bin, ["schedules", "--from", self(ctx)]));
  tool("session_unschedule", "Unschedule", (args) => String(args.id), (args, ctx) => swb(proc.launch.bin, ["unschedule", args.id, "--from", self(ctx)]));
  tool("swb_show_session", "Show", (args) => `${titleOf2(args.session)}${args.view ? ` · ${args.view}` : ""}`, (args, ctx) => swb(proc.launch.bin, ["show", args.session, "--from", self(ctx), ...args.view ? ["--view", args.view] : []]));
  const snoozeText = (snooze) => typeof snooze === "string" ? snooze : snooze.until;
  tool("swb_update_session", "Update session", (args) => {
    const parts = [
      args.archived === true ? `archive${args.family ? " family" : ""}${args.force ? " · force" : ""}` : "",
      args.archived === false ? "unarchive" : "",
      args.snooze !== undefined ? `snooze ${snoozeText(args.snooze)}` : "",
      args.group === null ? "ungroup" : args.group !== undefined ? `group ${args.group}` : "",
      args.title !== undefined ? `retitle as "${args.title}"` : ""
    ].filter(Boolean);
    if (args.title !== undefined)
      return parts.join(" · ");
    return `${parts.join(" · ")} ${args.session ? titleOf2(args.session) : "this session"}`;
  }, (args, ctx) => swb(proc.launch.bin, ["update", "--from", self(ctx)], JSON.stringify(args)));
  pi.on("session_shutdown", (event, ctx) => {
    if (proc.inbox)
      clearInterval(proc.inbox);
    proc.inbox = undefined;
    proc.doorbell?.close();
    proc.doorbell = undefined;
    ctxNow = undefined;
    if (event.reason !== "quit")
      return;
    const draft = ctx.ui.getEditorText();
    if (draft.trim()) {
      const path = draftPath(ctx.sessionManager.getSessionId());
      mkdirSync3(dirname4(path), { recursive: true, mode: 448 });
      writeFileSync2(path, draft, { mode: 384 });
    }
    writeFor(ctx, (db) => endHosting(db, proc.launch.tmuxSession));
  });
}
export {
  src_default as default
};
