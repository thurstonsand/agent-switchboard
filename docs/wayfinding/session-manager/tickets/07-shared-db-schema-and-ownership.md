---
status: closed
type: grilling
blocked-by:
  - 1
  - 2
  - 3
---

# Shared session db: schema and ownership

## Question

Design the single SQLite db that the Pi recorder (`node:sqlite`) and `sessions` (Go) both write.

- Tables and columns: session identity, tool, cwd, project root, transcript, pid, boot id, tmux location, activity, last-turn timestamps, excerpt, archived-at, visited-at. Which writer owns each column, and whether ownership is enforced by table split.
- How much of T3's model to copy (see [T3 Code thread-state model](03-t3-thread-state-model.md)): plain state tables, or an append-only event log with derived state.
- Schema ownership across two languages: who creates and migrates, how versions are checked, and how a mismatched writer fails fast.
- Derivations: Live (pid + boot id + tmux), Interrupted, Unseen (watermark), Inactive (72h), unarchive-on-turn ("open iff last turn > archived-at"), and project identity (git common dir, non-git dirs, deleted worktrees).
- Undo for archive. Ignored directories (`sessions ignore`) in the new store.
- The seam where behavior gets tested: shared fixture dbs exercised by both the Go and TS test suites?

## Inputs

- From [the Pi lifecycle research](../research/pi-lifecycle-signals.md): Pi swallows errors thrown by extension handlers. A failed recorder write therefore can't crash anything, so fail-fast needs a deliberate surface: a visible notify, a health column, or `sessions` flagging stale writers.
- There is no event after the transcript (JSONL) write, so a power loss can leave the db ahead of the transcript. Decide whether readers tolerate a db row that points one turn past the transcript.

## Resolution

Resolved with Thurston on 2026-10-05. The implementation language is still open (see [Repo and language for sessions v2](11-repo-and-language.md)), so "the CLI" below means the `sessions` executable, whatever it's written in.

**Tables.** Approved as sketched. Recorder-owned tables are written only by the session's own pi process.

```sql
-- recorder-owned
CREATE TABLE sessions (
  session_id       TEXT PRIMARY KEY,
  tool             TEXT NOT NULL CHECK (tool IN ('pi')),
  cwd              TEXT NOT NULL,
  project_root     TEXT NOT NULL,    -- parent of git common dir, else cwd; set once
  transcript       TEXT NOT NULL,
  title            TEXT,             -- null until auto-title lands
  branch           TEXT,             -- null outside git
  phase            TEXT NOT NULL CHECK (phase IN ('idle','working','blocked')),
  created_at       INTEGER NOT NULL, -- epoch ms, first user message
  last_prompt_at   INTEGER NOT NULL, -- latest user message_start
  last_settled_at  INTEGER,          -- latest agent_settled
  last_prompt_text TEXT NOT NULL,    -- truncated
  last_reply_text  TEXT              -- truncated
);
-- recorder-owned; the current process lease, deleted on clean shutdown
CREATE TABLE runtimes (
  session_id   TEXT PRIMARY KEY REFERENCES sessions,
  boot_id      TEXT NOT NULL,
  pid          INTEGER NOT NULL,
  tmux_session TEXT NOT NULL,
  tmux_pane    TEXT NOT NULL,
  started_at   INTEGER NOT NULL
);
-- user intent; written by any user-facing surface (CLI, TUI, pi's /archive)
CREATE TABLE marks (
  session_id  TEXT PRIMARY KEY REFERENCES sessions,
  archived_at INTEGER,
  visited_at  INTEGER
);
```

**Derivations.**

- **Archived**: `archived_at >= last_prompt_at`. A newer prompt unarchives without anyone writing `marks`.
- **Live**: a runtime row with the current `boot_id`, a `pid` that passes `kill(pid, 0)`, and a `tmux_pane` that appears in one `tmux -L sessions list-panes -a` call per refresh.
- **Activity** (live only): `phase`.
- **Interrupted**: not live and `phase != 'idle'`. **Dormant**: not live and `phase = 'idle'`. The recorder never clears `phase` on shutdown.
- **Unseen**: open, `last_settled_at > coalesce(visited_at, 0)`, and the session's viewer is not focused right now (live from `tmux list-clients`). A session with no Visit is unseen once it settles.
- `activity_at` = `max(last_prompt_at, last_settled_at)`; Visits never bump it. **Inactive**: open, `activity_at` older than 72h, and neither blocked nor unseen.
- **Archived list order**: `max(activity_at, archived_at)` descending, so a fresh accidental archive sits on top.

**Writers and rules.**

- `/archive` in pi writes `marks.archived_at` directly, then quits. `marks` is user intent rather than single-writer: this overrides the one-writer-per-table principle for that table only.
- A **Visit** is written on tmux `client-focus-in` and `client-focus-out` (both hooks run `sessions visit --pane …`) and when a session is opened from the TUI.
- The recorder computes `project_root` once, at row creation. It checks the branch at each `agent_settled` by reading HEAD (no spawn needed) and writes `branch` only when it changed, which is rare (worktree `/mv`, `/wt fork`).
- **Schema ownership**: the CLI owns all DDL and migrations through `PRAGMA user_version`. It migrates on every invocation and from its install task. The recorder never creates tables: it asserts the exact `user_version` at startup and fails loudly on a mismatch or a missing db.
- **Failure surfacing**: on any recorder failure, pi gets a persistent red footer status (`sessions: not recording: <reason>`) and an error notify. The session keeps working, and the recorder stays failed for the rest of that process.
- Connection policy is from [the cross-language SQLite research](../research/cross-language-sqlite.md): WAL, `synchronous=FULL`, 5 s busy timeout, `BEGIN IMMEDIATE`, `foreign_keys=ON`, and `data_version` polling.
- **Power-loss window**: accepted. The db can run one message ahead of the transcript, and nothing treats the db as the transcript.
- **`sessions ignore`** and the ignored-directories config are deleted. Only managed sessions are recorded, so nothing stray gets in.

**Testing.** No unit tests. Only useful end-to-end tests that drive a real feature of the tool (see [Driving a real pi deterministically for e2e tests](13-deterministic-pi-e2e.md)). Every change also ships with visual proof in whatever form shows it best.

## Amendment (2026-10-06, adversarial review)

`runtimes` is keyed by `tmux_session`, the process that hosts a session, rather than by `session_id`. A fresh session has no `sessions` row until its first prompt, so a runtime foreign-keyed to it could not exist, and the Deck had no signal that a new pi was ready. The row is written from the first `session_start`, rewritten in place on `/new`, `/resume`, `/fork`, and `/reload`, and deleted only on quit. It carries `cwd` and `project_root` for the provisional roster row. `tmux_pane` is gone: one pi runs per tmux session. `last_prompt_text` and `last_reply_text` are gone too, because the dormant card reads the transcript. See [the design doc](../../../designs/01-agent-switchboard.md)'s Database section.
