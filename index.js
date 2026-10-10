// packages/pi/src/index.ts
import { execFile } from "node:child_process";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, rmSync, writeFileSync } from "node:fs";
import { dirname as dirname3, join as join2 } from "node:path";
import { promisify } from "node:util";
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
    this.#driver.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
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
var SCHEMA_VERSION = 3;
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

// packages/pi/src/index.ts
import { Type } from "typebox";
var KEY = Symbol.for("agent-switchboard.recorder");
var store = globalThis;
function claim() {
  const env = process.env;
  if (env.SWB_MANAGED === "1" && env.SWB_DB && env.SWB_TMUX_SESSION) {
    store[KEY] = {
      launch: Object.freeze({ db: env.SWB_DB, tmuxSession: env.SWB_TMUX_SESSION, bin: env.SWB_BIN ?? "" }),
      attention: new Set,
      ...env.SWB_BIN ? {} : { failure: "started by an swb older than this recorder; upgrade swb" }
    };
  }
  delete env.SWB_MANAGED;
  delete env.SWB_DB;
  delete env.SWB_TMUX_SESSION;
  delete env.SWB_BIN;
  return store[KEY];
}
var run = promisify(execFile);
function host(bin) {
  const swb = async (...args) => {
    try {
      return (await run(bin, args, { timeout: 15000 })).stdout;
    } catch (error) {
      const { stderr, message } = error;
      throw new Error(stderr?.trim() || message);
    }
  };
  return {
    name: "swb",
    async launch(input) {
      await swb("launch", "--cwd", input.cwd, "--session-id", input.sessionId, "--model", input.model);
      return { success: true };
    },
    async listSessions() {
      const sessions = JSON.parse(await swb("ls", "--json"));
      return sessions.filter((s) => s.open).map((s) => ({ sessionId: s.id, cwd: s.cwd, title: s.title ?? s.id }));
    },
    async wake(sessionId) {
      await swb("wake", sessionId);
    }
  };
}
function liveHost(row) {
  if (row && row.boot_id === bootId() && pidAlive(row.pid))
    return row.tmux_session;
  return;
}
function hostOfSession(db, proc, sessionId) {
  return liveHost(db.get("SELECT tmux_session, boot_id, pid FROM runtimes WHERE session_id = ? AND tmux_session != ?", sessionId, proc.launch.tmuxSession));
}
function hostOfTranscript(db, proc, transcript) {
  return liveHost(db.get("SELECT r.tmux_session, r.boot_id, r.pid FROM runtimes r JOIN sessions s USING (session_id) WHERE s.transcript = ? AND r.tmux_session != ?", transcript, proc.launch.tmuxSession));
}
function src_default(pi) {
  pi.on("project_trust", (event) => ({ trusted: event.cwd === operatorDir() ? "yes" : "undecided" }));
  const claimed = claim();
  if (!claimed)
    return;
  const proc = claimed;
  let ui;
  if (proc.launch.bin)
    pi.events.on("pi-sessions:hosts:v1", (request) => request.register(host(proc.launch.bin)));
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
      const db = connect();
      db.tx(() => {
        const version = db.userVersion();
        if (version !== SCHEMA_VERSION)
          throw new Error(`db schema is v${version}, this recorder writes v${SCHEMA_VERSION}`);
        body(db, sessionId);
      });
    } catch (error) {
      fail(error);
    }
  };
  const writeFor = (ctx, body) => {
    ui = ctx.ui;
    write(ctx.sessionManager.getSessionId(), body);
  };
  let current;
  pi.on("session_before_switch", (event, ctx) => {
    if (event.reason !== "resume" || !event.targetSessionFile || proc.failure)
      return;
    ui = ctx.ui;
    let host;
    try {
      host = hostOfTranscript(connect(), proc, event.targetSessionFile);
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
  pi.on("session_start", (event, ctx) => {
    current = ctx.sessionManager.getSessionId();
    if (event.reason !== "reload")
      restoreDraft(ctx, current);
    proc.attention.clear();
    writeFor(ctx, (db, id) => {
      const host = hostOfSession(db, proc, id);
      if (host)
        throw new Error(`session ${id} is already open in another pi (${host})`);
      db.run("DELETE FROM runtimes WHERE session_id = ? AND tmux_session != ?", id, proc.launch.tmuxSession);
      db.run(`INSERT INTO runtimes (tmux_session, session_id, cwd, project_root, boot_id, pid, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (tmux_session) DO UPDATE SET session_id = excluded.session_id, cwd = excluded.cwd,
				   project_root = excluded.project_root, boot_id = excluded.boot_id, pid = excluded.pid`, proc.launch.tmuxSession, id, ctx.cwd, projectRoot(ctx.cwd), bootId(), process.pid, Date.now());
      const transcript = ctx.sessionManager.getSessionFile();
      if (!transcript)
        throw new Error("pi is running without a session file");
      db.run("UPDATE sessions SET phase = 'idle', cwd = ?, project_root = ?, branch = ?, transcript = ? WHERE session_id = ?", ctx.cwd, projectRoot(ctx.cwd), branch(ctx.cwd), transcript, id);
    });
  });
  pi.on("agent_start", (_event, ctx) => {
    writeFor(ctx, (db, id) => {
      const transcript = ctx.sessionManager.getSessionFile();
      if (!transcript)
        throw new Error("pi is running without a session file");
      const now = Date.now();
      db.run(`INSERT INTO sessions (session_id, tool, cwd, project_root, transcript, title, branch, phase, created_at, last_prompt_at)
				 VALUES (?, 'pi', ?, ?, ?, ?, ?, 'working', ?, ?)
				 ON CONFLICT (session_id) DO UPDATE SET phase = 'working',
				   last_prompt_at = CASE WHEN sessions.phase = 'idle' THEN excluded.last_prompt_at ELSE sessions.last_prompt_at END`, id, ctx.cwd, projectRoot(ctx.cwd), transcript, ctx.sessionManager.getSessionName() ?? null, branch(ctx.cwd), now, now);
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
    write(current, (db, id) => db.run("UPDATE sessions SET phase = ? WHERE session_id = ? AND phase != 'idle'", phase, id));
  };
  pi.events.on("glimpseui:attention:request", attention(true));
  pi.events.on("glimpseui:attention:resolve", attention(false));
  pi.on("agent_settled", (_event, ctx) => {
    proc.attention.clear();
    writeFor(ctx, (db, id) => {
      db.run("UPDATE sessions SET phase = 'idle', last_settled_at = ?, cwd = ?, project_root = ?, branch = ?, title = ? WHERE session_id = ?", Date.now(), ctx.cwd, projectRoot(ctx.cwd), branch(ctx.cwd), ctx.sessionManager.getSessionName() ?? null, id);
      db.run("UPDATE runtimes SET cwd = ?, project_root = ? WHERE tmux_session = ?", ctx.cwd, projectRoot(ctx.cwd), proc.launch.tmuxSession);
    });
  });
  pi.on("session_info_changed", (event, ctx) => {
    writeFor(ctx, (db, id) => db.run("UPDATE sessions SET title = ? WHERE session_id = ?", event.name ?? null, id));
  });
  const markArchived = (ctx) => {
    let archived = false;
    writeFor(ctx, (db, id) => {
      if (!db.get("SELECT 1 FROM sessions WHERE session_id = ?", id))
        return;
      db.run("INSERT INTO marks (session_id, archived_at) VALUES (?, ?) ON CONFLICT (session_id) DO UPDATE SET archived_at = excluded.archived_at", id, Date.now());
      archived = true;
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
      if (markArchived(ctx))
        ctx.shutdown();
      else if (!proc.failure)
        ctx.ui.notify("swb: nothing to archive before the first prompt", "error");
    }
  });
  pi.registerTool({
    name: "swb_update_session",
    label: "Update session",
    description: "Archive or unarchive a session. Omit session to update the current session.",
    promptSnippet: "Archive or unarchive a session",
    promptGuidelines: [
      "Archive only when the user asks, or when you started that session and have driven it to completion.",
      "Archiving the current session will quit it when the turn ends: call it last, then end with a brief final message.",
      "Archiving another session fails while it is mid-turn. Unarchiving doesn't restart it; session_send_message wakes it."
    ],
    parameters: Type.Object({
      session: Type.Optional(Type.String({ description: "Session id; omit for the current session" })),
      archived: Type.Boolean()
    }),
    renderCall(args, theme) {
      const target = !args.session || args.session === current ? "This session" : connect().get("SELECT title FROM sessions WHERE session_id = ?", args.session)?.title ?? args.session;
      return new Text(`${theme.fg("toolTitle", theme.bold(args.archived ? "Archive" : "Unarchive"))} · ${theme.fg("accent", target)}`, 0, 0);
    },
    renderResult(result, _options, theme, context) {
      const output = result.content.find((item) => item.type === "text")?.text ?? "";
      return new Text(context.isError ? theme.fg("error", output) : "", 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const self = ctx.sessionManager.getSessionId();
      if (!params.session || params.session === self) {
        if (!params.archived)
          throw new Error("this session is already open");
        if (!markArchived(ctx)) {
          throw new Error(proc.failure ? `swb: not recording: ${proc.failure}` : "swb: no session recorded yet");
        }
        ctx.shutdown();
        return { content: [{ type: "text", text: "Archived. pi quits when this turn ends." }], details: undefined };
      }
      try {
        await run(proc.launch.bin, [params.archived ? "archive" : "unarchive", params.session], { timeout: 15000 });
      } catch (error) {
        const { stderr, message } = error;
        throw new Error(stderr?.trim() || message);
      }
      return {
        content: [{ type: "text", text: params.archived ? "Archived." : "Unarchived. It stays dormant until messaged." }],
        details: undefined
      };
    }
  });
  pi.on("session_shutdown", (event, ctx) => {
    if (event.reason !== "quit")
      return;
    const draft = ctx.ui.getEditorText();
    if (draft.trim()) {
      const path = draftPath(ctx.sessionManager.getSessionId());
      mkdirSync2(dirname3(path), { recursive: true, mode: 448 });
      writeFileSync(path, draft, { mode: 384 });
    }
    writeFor(ctx, (db) => db.run("DELETE FROM runtimes WHERE tmux_session = ?", proc.launch.tmuxSession));
  });
}
export {
  src_default as default
};
