# Three harnesses on one switchboard

## Status

Ready

## Decision Summary

`swb` hosts Claude Code and Codex CLI beside pi, as the same real interactive TUIs in its tmux server, on one roster. Each harness plugs into the board through a **line**: a small, harness-native integration that records the session's lifecycle into `swb.db`, gives its agent the same coordination tools, and delivers messages from other sessions into it. Coordination itself (who is reachable, sending, waking, launching, archiving) belongs to `swb`, and every line calls the same `swb` commands. Messages travel through a mailbox table in `swb.db`, which each live line polls, so a message outlives its sender and waits for a dormant target to wake. There is still no daemon.

Session search and ask across harnesses are a separate piece of work.

## Problem Statement / Background

I run Claude Code and Codex sessions alongside pi, and lose track of them the same way. Worse, sessions in different harnesses can't talk to each other: pi-sessions connects pi to pi only.

Research ([thread](https://ampcode.com/threads/T-01a13611-7076-75bb-b88f-f1d6a013beab)) and two spikes against the real binaries settled what each harness offers:
- **Claude Code ≥ 2.1.287** has mods: in-process plugin hooks that can register tools, read session identity, run processes, and inject text into the conversation. A message appended as `context` to a tool result is read by the model within the same turn; `$.prompt.submit` starts a turn when idle.
- **Codex CLI ≥ 0.149** runs its TUI against an app-server (`codex --remote unix://…`). Another client of the same server sees every thread's status notifications without subscribing, and `turn/start` starts an idle thread's turn or steers a running one. The TUI writes the id of the thread it displays into the terminal title when told to (`-c tui.terminal_title=["session-id","status"]`), which tmux exposes as `#{pane_title}`. MCP tool calls carry the calling thread in `_meta.threadId`.
- T3 Code, which runs every harness headless, showed what to steal: one coordination service behind thin per-harness transports, caller identity the model can't forge, and send modes that steer rather than interrupt.

## Goals

- Parity of the roster across harnesses: lifecycle (working, blocked, idle, interrupted), launch, wake, archive, visits, the dormant card.
- Parity of coordination: every session, in any harness, can list every open session and message, cancel, launch, or archive it. A message to a dormant session wakes it.
- Real TUIs only. `swb` never runs a harness headless and never modifies a harness.
- Messages arrive mid-turn wherever the harness allows it.

## Non-Goals

- Session search and ask across harnesses.
- Cross-harness handoffs that translate one transcript into another. A launch carries a brief, not history.
- Patching Claude Code or Codex, or depending on Claude's private inbox socket protocol.

## Exposed Shape

### Vocabulary

[CONTEXT.md](../../CONTEXT.md) gains:
- **Harness**: the agent program a Session runs in: pi, Claude Code, or Codex.
- **Line**: a harness's integration with swb, which records its sessions and carries messages in and out.
- **Message**: text one Session sends another, delivered through swb's mailbox.

### Lines

| | pi | Claude Code | Codex |
| --- | --- | --- | --- |
| Lives in | `packages/lines/pi`, the pi package `@thurstonsand/pi-agent-switchboard` (was `packages/pi`) | `packages/lines/claude`, a plugin with a mod, written by `swb` into `${state}/lines/claude` at launch and loaded with `--plugin-dir` | `packages/lines/codex`, compiled into `swb`: a host process per session plus `swb mcp` |
| Managed by | the consumed `SWB_*` env token | being launched with `--plugin-dir`, plus the `SWB_*` env | being launched by `swb __codex` |
| Records through | `@swb/shared`'s recorder, in process | `swb __record`, from mod hooks | the host process, from app-server notifications and the pane title |
| Tools reach `swb` by | running `swb` | `$.process.run` of `swb` | MCP, served by `swb mcp` |
| Incoming messages | the line polls the mailbox | `swb __inbox`, spawned by the mod, streams them | the host process polls the mailbox |
| Mid-turn delivery | steer | at the next tool result | `turn/start` steers |
| Draft kept on stop | yes | yes, the last `prompt.edit` | no: Codex sessions stop like the others and lose an unsent prompt |

### Tools

Every line registers the same five tools, from one contract in `@swb/shared`. Claude's names carry its prefix (`mcp__swb__session_send_message`), Codex's its namespace.

- `session_reachable {}`: every open Session except the caller: id, title, harness, cwd, project, live, activity.
- `session_send_message { session, message, requestResponse? }`: delivers now if the target is live, otherwise wakes it and delivers when it starts. Refuses archived targets.
- `session_cancel { session }`: interrupts the target's running turn.
- `session_launch { harness, cwd?, title?, goal, requestResponse? }`: starts a new managed Session in that harness, whose first turn is the goal, framed as a message from the caller. Returns its id.
- `swb_update_session { session?, archived }`: archives or unarchives; the current session by default, which then quits when its turn ends.

The sender is never a tool argument: each line passes its own session id, so a model can't send as another session.

### Command line

New or changed, for lines and scripts:

```text
swb send --from ID --to ID [--request-response] [--request-id KEY] [--cancel]   body on stdin; prints the receipt as JSON
swb launch --harness pi|claude|codex --cwd DIR [--from ID] [--title T] [--model M]   goal on stdin; prints the new session as JSON
swb archive ID [--from ID]        from the session itself, it may run mid-turn and quits when the turn ends
swb mcp                           the MCP server Codex's app-server runs for the Codex line
swb __record EVENT …              the Claude line's recorder
swb __inbox --host NAME           streams a host's incoming messages as JSON lines
swb __ack ID                      marks a message delivered
swb __codex --host NAME [--resume ID]   a Codex session's host process
```

`swb launch --session-id` (the pi-sessions host v1 entry) is gone.

### Settings

```toml
harness = "pi"   # what n starts by default; Tab in the directory picker cycles it
```

### Database (schema v5)

```sql
-- sessions: `tool` becomes `harness`, and a launched session remembers its parent
harness   TEXT NOT NULL CHECK (harness IN ('pi','claude','codex')),
parent_id TEXT,
-- runtimes: a provisional row needs its harness before the session has a row
harness   TEXT NOT NULL CHECK (harness IN ('pi','claude','codex')),
-- the mailbox
CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('message','cancel')),
  source_id        TEXT NOT NULL,
  target_id        TEXT NOT NULL,
  body             TEXT NOT NULL,
  request_response INTEGER NOT NULL,
  request_id       TEXT,              -- the caller's retry key, unique per source
  created_at       INTEGER NOT NULL,
  offered_at       INTEGER,           -- handed to the target's line
  delivered_at     INTEGER,           -- the line put it in front of the model
  cancelled_at     INTEGER,           -- the target was archived first
  UNIQUE (source_id, request_id)
);
```

A runtime row is still one tmux session's process, and its pid is the pane's. For Codex that process is `swb __codex`, which owns the session's app-server, so the server lives and dies with the pane.

## Call Stacks and Data Flow

### Sending

```text
tool session_send_message (any line)
  swb send --from A --to B          body on stdin, --request-id = the tool call id
    B archived → refuse
    db.tx: INSERT messages, or return the existing row for (A, request id)
    B dormant → wake(B)             the same wake the Deck uses
    wait ≤ 15 s (≤ 60 s if woken) for delivered_at, then print { text, details: { id, delivered, woke, target } }
B's line, every 250 ms while live, when data_version moved:
  pending = messages for B's current session, undelivered, uncancelled
  pi      idle → sendMessage(triggerTurn); busy → sendMessage(steer); mark delivered
  claude  swb __inbox prints it, marks offered; the mod injects it, then swb __ack marks delivered
            busy → context on the next main-loop tool result; idle → $.prompt.submit
  codex   turn/start (it steers a running turn); mark delivered
  cancel  pi ctx.abort(); claude $.turn.abort; codex turn/interrupt
```

A message is framed for the model as `Message from session "<title>" (session: <id>, <harness>):` then the body, then `Response requested: reply with session_send_message to <id>.` when asked. A dormant session's undelivered messages arrive when it next starts, which is always an explicit wake.

### Launching

```text
swb launch --harness H --cwd D --from A    goal on stdin
  pi, claude: a fresh uuid, passed as --session-id
  the goal, framed as a message from A, is the harness's initial prompt argument
  SWB_PARENT=A in the launch env; the line writes sessions.parent_id
    and the pi line also appends { customType: "pi-sessions.lineage", data: { parentSessionId: A } }
  wait for the runtime row (Codex: until its pane title binds), print { id, harness, host }
```

### The Codex host process

```text
swb __codex --host NAME [--resume ID]      the pane's process
  spawn codex app-server --listen unix://${state}/codex/NAME.sock   in its own process group
    -c features.plugins=true -c plugins.swb@swb.enabled=true
      swb writes the swb@swb plugin, whose manifest declares `swb mcp`, into $CODEX_HOME/plugins/cache/swb/swb/local.
      Not -c mcp_servers.swb: Codex's title generator replaces the whole mcp_servers table, which strips a -c server's command
      and fails the title thread; it turns plugins off instead.
  connect as an observer
  spawn codex --remote unix://… [resume ID] -c tui.terminal_title=["session-id","status"] [prompt]   on the tty
  every 300 ms: pane title → thread id prefix → resolve on this server → bind (runtime row)
  thread/status/changed for the bound thread: active → working; waitingOnApproval|waitingOnUserInput → blocked; idle → settled
  thread/name/updated → title
  thread/archived for the bound thread → mark archived, stop the TUI    native /archive
  TUI exits → delete the runtime row, stop the server, exit with its code
swb mcp (spawned by the server per thread)
  tools/call _meta.threadId → the caller's session id
```

### The Claude line

```text
session.start          register tools; spawn swb __inbox --host $SWB_TMUX_SESSION
classic.SessionStart   swb __record start   (session id, transcript, cwd)   also after /clear and /resume
turn.start (main)      swb __record turn
classic.PermissionRequest → blocked; turn.step → working again
turn.complete (main)   swb __record settled   archived meanwhile → swb stops the pane
prompt.edit            remember the draft; session.end writes it to drafts/<id>
```

## Design Decisions

### 1. swb owns coordination; pi-sessions steps aside

pi-sessions' host contract shrinks to a claim, `pi-sessions:hosts` `{ name, peers: true }`. The pi line registers it, and pi-sessions then registers none of its peer tools, keeping its subagent tools (`subagent_list`, `subagent_send`, `subagent_cancel`, `subagent_launch`, `submit_task_report`). Outside swb nothing claims, and pi-sessions is whole. pi-sessions knows nothing about swb.

### 2. A mailbox in the db, not a daemon

Every line polls `data_version` on its own connection, which costs microseconds. That gives durable acceptance, wake-then-deliver, and delivery after the sender exits with no long-lived owner: the reason a broker looked necessary. The oracle recommended a broker; the spikes showed no responsibility left for it.

### 3. Codex runs on a private app-server per session

Not the user's daemon, which swb must not stop, and not one shared server, whose environment and failures would be shared. One server per pane keeps a runtime row meaning exactly what it means for pi.

### 4. Claude's public mod API, not its inbox socket

Tool-result context and `$.prompt.submit` are documented. The socket's frame format is private and has no receipts. The cost: a message waits for the next tool call or the end of the turn.

### 5. Messages are user-visible

pi renders them as custom messages, Claude logs a transcript row (the injected context itself is invisible), and Codex shows them as the user turn they are.

## Edge Cases & Failure Modes

- **A send to a session whose line is broken** waits the full timeout and reports `delivered: false`; the message stays queued.
- **Archive with messages pending**: archiving cancels them, and a later send refuses.
- **Native Codex `/archive`** moves the TUI to another thread; the host stops it first, so a pane never rebinds to a conversation swb doesn't track.
- **Codex `/new` before any prompt** shows a title with no id for a moment; the binding keeps the previous thread until a real id appears.
- **A Codex thread archived in Codex** can't be resumed; `swb unarchive` unarchives it in Codex too.
- **Claude permission prompts**: `PermissionRequest` marks blocked; the next model step marks working.
- **Two harnesses with the same id format**: ids are UUIDs everywhere; the harness column disambiguates resume.

## Implementation Plan

The validation predicate for the whole plan: `mise run check` and `mise run e2e` pass in both repositories, with e2e scenarios that run real pi, Claude Code, and Codex against faux and fake model servers, and VHS recordings show sessions in different harnesses messaging each other.

- [x] Phase 1: pi-sessions steps aside
  - Host contract v2, the directory split into peer and subagent tools from one factory, the `pi-sessions.lineage` entry.
  - Validation: pi-sessions `mise run check` and `mise run smoke`, which covers a claiming host.
- [x] Phase 2: Prefactor
  - `packages/pi` → `packages/lines/pi`; schema v5; the recorder's SQL moved into `@swb/shared`; launch and wake take a harness.
  - Validation: the existing e2e suite passes unchanged.
- [x] Phase 3: Mailbox and the pi line's tools
  - `swb send`, `swb launch`, `swb archive --from`, the pi line's tools and inbox, the v2 claim.
  - Validation: e2e: pi messages pi mid-turn and idle, wakes a dormant pi, launches one, and pi-sessions' peer tools are absent.
- [x] Phase 4: The Claude line
  - Validation: e2e: lifecycle rows, blocked on a permission prompt, mid-turn and idle delivery, launch, self-archive, draft restore.
- [x] Phase 5: The Codex line
  - Validation: e2e: lifecycle rows, binding across `/new`, MCP tools with the right caller, steer and idle delivery, native `/archive`.
- [x] Phase 6: Deck and evidence
  - Harness in the bar, the picker's harness choice, dormant cards for every harness, a cross-harness message matrix, VHS tapes.
