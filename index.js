// packages/lines/pi/src/index.ts
import { spawn } from "node:child_process";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, rmSync, writeFileSync } from "node:fs";
import { dirname as dirname3, join as join2 } from "node:path";
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
var SCHEMA_VERSION = 5;
var HARNESSES = ["pi", "claude", "codex"];
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
var HARNESS_NAMES = { pi: "pi", claude: "Claude Code", codex: "Codex" };
function harnessName(harness) {
  return HARNESS_NAMES[harness];
}
function pendingFor(db, targetId) {
  return db.all(`SELECT id, kind, source_id, target_id, body, request_response, created_at FROM messages
			 WHERE target_id = ? AND delivered_at IS NULL AND cancelled_at IS NULL ORDER BY created_at, rowid`, targetId).map((row) => ({
    id: row.id,
    kind: row.kind,
    sourceId: row.source_id,
    targetId: row.target_id,
    body: row.body,
    requestResponse: row.request_response === 1,
    createdAt: row.created_at
  }));
}
function markDelivered(db, id) {
  db.run("UPDATE messages SET delivered_at = coalesce(delivered_at, ?) WHERE id = ?", Date.now(), id);
}
function sender(db, sourceId) {
  const row = db.get("SELECT title, harness FROM sessions WHERE session_id = ?", sourceId);
  return { title: row?.title ?? sourceId, harness: row?.harness ?? null };
}
function frame(db, m) {
  const from = sender(db, m.sourceId);
  const harness = from.harness ? `, ${harnessName(from.harness)}` : "";
  const reply = m.requestResponse ? `

Response requested: reply with session_send_message to session ${m.sourceId}.` : "";
  return `Message from session "${from.title}" (session: ${m.sourceId}${harness}):

${m.body}${reply}`;
}

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
    db.run(`INSERT INTO sessions (session_id, harness, parent_id, cwd, project_root, transcript, title, branch, phase, created_at, last_prompt_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'working', ?, ?)
			 ON CONFLICT (session_id) DO UPDATE SET phase = 'working',
			   last_prompt_at = CASE WHEN sessions.phase = 'idle' THEN excluded.last_prompt_at ELSE sessions.last_prompt_at END`, t.sessionId, t.harness, t.parentId, t.cwd, projectRoot(t.cwd), t.transcript, t.title, branch(t.cwd), now, now);
  });
}
function setPhase(db, sessionId, phase) {
  recordTx(db, () => db.run("UPDATE sessions SET phase = ? WHERE session_id = ? AND phase != 'idle'", phase, sessionId));
}
function settle(db, s) {
  return recordTx(db, () => {
    db.run("UPDATE sessions SET phase = 'idle', last_settled_at = ?, cwd = ?, project_root = ?, branch = ?, title = coalesce(?, title) WHERE session_id = ?", Date.now(), s.cwd, projectRoot(s.cwd), branch(s.cwd), s.title, s.sessionId);
    db.run("UPDATE runtimes SET cwd = ?, project_root = ? WHERE tmux_session = ?", s.cwd, projectRoot(s.cwd), s.host);
    return { archived: isArchived(db, s.sessionId) };
  });
}
function setTitle(db, sessionId, title) {
  recordTx(db, () => db.run("UPDATE sessions SET title = ? WHERE session_id = ?", title, sessionId));
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
  db.run("INSERT INTO marks (session_id, archived_at) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET archived_at = excluded.archived_at", sessionId, now);
  db.run("UPDATE messages SET cancelled_at = ? WHERE target_id = ? AND delivered_at IS NULL AND cancelled_at IS NULL", now, sessionId);
  return true;
}

// packages/shared/src/tools.ts
import { Type } from "typebox";
import { Value } from "typebox/value";
var session = Type.String({ description: "The target session's id, from session_reachable." });
var TOOLS = {
  session_reachable: {
    description: "List every open session on the switchboard, in any harness (pi, Claude Code, Codex), except this one.",
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
      requestResponse: Type.Boolean({ description: "Whether the recipient should reply to this session." })
    }),
    readOnly: false
  },
  session_cancel: {
    description: "Interrupt another session's running turn. The session stays open.",
    guidelines: ["Only cancel another session's turn when the user asks for it."],
    parameters: Type.Object({ session }),
    readOnly: false
  },
  session_launch: {
    description: "Start a new session on the switchboard, in pi, Claude Code, or Codex, whose first turn is the goal you give it. It shows up on the user's roster.",
    guidelines: [
      "Write the goal as a complete briefing: objective, relevant context, constraints, and what done means. The new session sees nothing else.",
      "Launch a new session when the work is independent of this one, belongs to another directory, or the user asks for one."
    ],
    parameters: Type.Object({
      harness: Type.Union(HARNESSES.map((name) => Type.Literal(name)), { description: "Which harness runs it: pi, claude (Claude Code), or codex." }),
      goal: Type.String({ description: "The self-contained briefing, delivered as its first message." }),
      cwd: Type.Optional(Type.String({ description: "Its working directory; defaults to this session's." })),
      title: Type.String({ description: "A short title for the roster." }),
      requestResponse: Type.Boolean({ description: "Whether it should report back to this session when done." })
    }),
    readOnly: false
  },
  swb_update_session: {
    description: "Archive or unarchive a session. Omit session to update the current session.",
    guidelines: [
      "Archive only when the user asks, or when you started that session and have driven it to completion.",
      "Archiving the current session quits it when the turn ends: call it last, then end with a brief final message.",
      "Archiving another session fails while it is mid-turn. Unarchiving doesn't restart it; session_send_message wakes it."
    ],
    parameters: Type.Object({
      session: Type.Optional(Type.String({ description: "Session id; omit for the current session." })),
      archived: Type.Boolean()
    }),
    readOnly: false
  }
};

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
  const draftPath = (id) => join2(dirname3(proc.launch.db), "drafts", id);
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
    rmSync(draftPath(id));
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
    writeFor(ctx, (db, id) => {
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
    });
    if (proc.inbox)
      clearInterval(proc.inbox);
    proc.inbox = setInterval(deliver, 250);
    proc.inbox.unref();
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
  const attention = (open) => (data) => {
    const attentionId = data.attentionId;
    if (typeof attentionId !== "string" || !current)
      return;
    if (open)
      proc.attention.add(attentionId);
    else
      proc.attention.delete(attentionId);
    const phase = proc.attention.size > 0 ? "blocked" : "working";
    write(current, (db, id) => setPhase(db, id, phase));
  };
  pi.events.on("glimpseui:attention:request", attention(true));
  pi.events.on("glimpseui:attention:resolve", attention(false));
  pi.on("agent_settled", (_event, ctx) => {
    proc.attention.clear();
    writeFor(ctx, (db, id) => {
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
  const tool = (name, label, target, run) => pi.registerTool({
    name,
    label,
    description: TOOLS[name].description,
    promptSnippet: TOOLS[name].description,
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
  const titleOf = (id) => typeof id === "string" ? connect().get("SELECT title FROM sessions WHERE session_id = ?", id)?.title ?? id : "";
  tool("session_reachable", "Reachable sessions", () => "", (_args, ctx) => swb(proc.launch.bin, ["reachable", "--from", self(ctx)]));
  tool("session_send_message", "Message", (args) => titleOf(args.session), (args, ctx, toolCallId) => swb(proc.launch.bin, [
    "send",
    "--from",
    self(ctx),
    "--to",
    args.session,
    "--request-id",
    toolCallId,
    ...args.requestResponse ? ["--request-response"] : []
  ], args.message));
  tool("session_cancel", "Cancel", (args) => titleOf(args.session), (args, ctx) => swb(proc.launch.bin, ["send", "--from", self(ctx), "--to", args.session, "--cancel"]));
  tool("session_launch", "Launch", (args) => `${args.harness} · ${args.title}`, (args, ctx) => swb(proc.launch.bin, [
    "launch",
    "--harness",
    args.harness,
    "--from",
    self(ctx),
    "--cwd",
    args.cwd ?? ctx.cwd,
    "--title",
    args.title,
    ...args.requestResponse ? ["--request-response"] : []
  ], args.goal));
  tool("swb_update_session", "Update session", (args) => `${args.archived ? "archive" : "unarchive"} ${args.session ? titleOf(args.session) : "this session"}`, async (args, ctx) => {
    const id = self(ctx);
    if (!args.session || args.session === id) {
      if (!args.archived)
        throw new Error("this session is already open");
      if (!markArchived2(ctx))
        throw new Error(proc.failure ? `swb: not recording: ${proc.failure}` : "swb: no session recorded yet");
      ctx.shutdown();
      return { text: "Archived. pi quits when this turn ends.", details: { id, archived: true } };
    }
    return swb(proc.launch.bin, [args.archived ? "archive" : "unarchive", args.session, "--from", id]);
  });
  pi.on("session_shutdown", (event, ctx) => {
    if (proc.inbox)
      clearInterval(proc.inbox);
    proc.inbox = undefined;
    ctxNow = undefined;
    if (event.reason !== "quit")
      return;
    const draft = ctx.ui.getEditorText();
    if (draft.trim()) {
      const path = draftPath(ctx.sessionManager.getSessionId());
      mkdirSync2(dirname3(path), { recursive: true, mode: 448 });
      writeFileSync(path, draft, { mode: 384 });
    }
    writeFor(ctx, (db) => endHosting(db, proc.launch.tmuxSession));
  });
}
export {
  src_default as default
};
