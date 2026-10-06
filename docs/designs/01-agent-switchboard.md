# Agent Switchboard

## Status

Ready

## Decision Summary

Agent Switchboard (`swb`) keeps every managed Pi session tracked from its first turn until I archive it, across quits, crashes, and reboots. It shows them in a **Deck**: a roster beside a live, interactive **Stage** of the selected session. Everything runs on two dedicated tmux servers, both configured entirely by `swb`, so the product works in any terminal and owes nothing to Ghostty. tmux is an execution engine here: people never interact with it directly. The core tradeoff is nesting: the Stage is a tmux client inside a tmux pane. That costs one layer of key and graphics translation, and in return we get the real session, with its real scrollback, instead of a snapshot or a hand-built terminal emulator.

## Problem Statement / Background

I run many Pi sessions in parallel, mostly on a corporate Mac. When the machine reboots, a tab closes, or a process dies, I lose track of which sessions were mid-flight, which finished while I wasn't looking, and which I'd already finished with.

T3 Code gets the workflow right: threads grouped by project, live status, and an explicit "I'm done with this". But it's a GUI app that does far more than I need. Herdr isn't available on the work Mac, and agent-deck is unreliable with Pi.

The previous attempt was ansiblonomicon's design 15: a recovery recorder writing a JSON tree, plus a Go `sessions` CLI. It failed in practice for three reasons:
- **Quitting ended tracking**, so "I closed it" and "I'm done" were the same act.
- **Too many sessions got in**: subagents, RPC sessions, and stray `pi` runs.
- **Getting back in was cumbersome**: find the id, cd, resume, rebuild the layout.

It has since been retired outright.

Scenarios this design must handle:
- **Reboot.** Two sessions were idle and one was mid-turn. After the reboot, the roster shows all three exactly where they were. The mid-turn one carries ⚠ Interrupted. Selecting one shows its whole conversation at once; `w` or Enter brings its real pi back within a second or two, and nothing auto-continues.
- **Away from the keyboard.** An agent finishes while I'm in another session. Its row turns unseen (●). It clears once I've been looking at it for a second.
- **Done.** I finish a task and archive it. It leaves the roster, its pi exits, and if no other open session shares its directory, so does that directory's editor. A week later, a new prompt in it from Archived brings it back.
- **Mid-turn.** Archiving a session in the middle of a turn refuses with "turn running: wait for it to complete".
- **Agent at the controls.** An agent drives a Deck end to end, keys in and screen out, with exactly the same capabilities I have.

## Goals

- Persistence first: a managed session stays tracked through every exit, crash, and reboot until I archive it.
- Four separate facts, never merged into one status: the process died, the agent finished, I saw it, and I'm done.
- The Stage is the real session: live, interactive, scrollable, with no snapshot lag.
- A snappy TUI: input is never blocked on a subprocess, a database write, or a Pi startup.
- Full agent drivability, with parity to a human: every action, plus a text capture of the screen.
- Terminal-agnostic: identical in Ghostty, over SSH, or inside another tmux.

## Non-Goals

- **Claude Code support**: deferred. The schema must not preclude it, but there's no recorder here.
- **Cross-host rosters.** Each host stands alone.
- **Linux builds**: macOS arm64 only. pod042 has no session tracking.
- **Tracking unmanaged Pi**: bare `pi` is invisible to `swb`.
- **PR badges**: later, but in scope for the product.
- **A daemon**: nothing needs one long-lived owner yet.
- **Unit tests**: never. Only end-to-end tests of real workflows.

## Exposed Shape

### Vocabulary

[CONTEXT.md](../../CONTEXT.md) is authoritative. The key terms:
- **Session**: one conversation, shown by its title, or its id when it has no title.
- **Open** / **Archived**.
- **Live** / **Dormant**: internal runtime facts. The roster shows Dormant as Idle.
- **Interrupted**: a dormant session that died mid-turn.
- **Activity**: working, blocked, or idle.
- **Visit** and **Unseen**.
- **Managed**.
- **Viewer**, **Deck**, **Stage**, **Editor**, **Project**, **Roster**.

**Stage** is an internal term, for code and docs only. The UI never names the right-hand side: it shows what's selected, and hints say `⏎ focus`.

### Command line

```text
swb                          open a Deck (in the current terminal)
swb new [--cwd DIR]          open a Deck with a new session selected
swb open <id>                open a Deck with that session selected
swb ls [--json]              list sessions with derived state
swb archive <id>             refuses while a turn is running; kills an idle live pi
swb unarchive <id>
swb deck state [--deck ID] [--json]       a Deck's view state
swb drive start [--size COLSxROWS] [-- swb-args]   run a Deck in a hidden harness terminal
swb drive keys <tmux key names…>          type into it (`-l TEXT` for literal text)
swb drive capture [--ansi]                the composited screen, as text
swb drive state                           = deck state of the driven Deck
swb drive stop
swb migrate                  create or upgrade the db (also implicit on every invocation)
```

These are called only by tmux hooks or by `swb` itself, never by a person: `swb visit`, `swb detached`, `swb gc`, `swb __roster`, `swb __placeholder`, `swb __deck <deck> <command>` (posts to a Deck socket), `swb __help`. Hidden subcommands carry a `__` prefix.

Exit codes: 0 means success. 1 means a failed action, with the reason on stderr; that includes "turn running: wait for it to complete" from `archive`. 2 means usage. JSON output uses stable field names, documented in `swb ls --help`.

### The Deck

```text
┌ roster pane (pi-tui app) ───────┬ Stage pane (tmux client of the sessions server) ┐
│ swb            6 open · 2 arch  │ <the real pi TUI of the selected session>        │
│ ▾ agent-switchboard             │                                                  │
│   ◐ Deck mock round 2      now  │                                                  │
│   ● Recorder footer        2h   │                                                  │
│ ▾ ansiblonomicon                │                                                  │
│   ◆ Retire recovery tree   2m   │                                                  │
│   ⚠ Fix fnox routing       3h   │                                                  │
│ › Inactive (3)                  │                                                  │
│ › Archived (41)                 │                                                  │
└─────────────────────────────────┴──────────────────────────────────────────────────┘
```

The Stage shows one of three **views** of the selected session, and each session remembers the one it was left on (`marks.view`):
- **pi**: the session alone.
- **editor**: its directory's Editor alone.
- **split**: the Editor on the left at 65% and pi on the right at 35%, as `ide` laid them out. In split view the Stage is two panes, each its own nested client of the sessions server.

**Layout rules**, which the Deck state reports as `layout`:
- The roster is 42 columns. A Deck narrower than 100 columns shows the roster alone, and Enter zooms the Stage to full width; `M-a z` or `M-a h` returns.
- Split needs a Deck at least 160 columns wide. Narrower, a split session shows pi view, and `marks.view` keeps `split` so widening restores it.
- Split applies only to a live session. Every card (dormant, loading, pi exited, empty) fills a single Stage pane, and a session that comes up in split gains its editor pane then.
- The second Stage pane exists only while split is showing: it's created on entering split and killed on leaving it.
- Any view change unzooms first.

The final visual spec comes from the Deck mock rounds (see [ticket 09](../wayfinding/session-manager/tickets/09-roster-tui-prototype.md) and `prototypes/deck/`). The implementing agent treats the last accepted mock as the visual reference. This document fixes behavior.

**Roster** (bare keys):
- `j`/`k`/arrows move; `g`/`G` jump to the ends.
- `Enter` focuses the Stage. On a dormant session it wakes pi and moves the keyboard to the loading card at once; pi gets the keyboard the moment it's ready. `esc` on the loading card hands the keyboard back to the roster without stopping the wake, exactly as if I had pressed `w`. `esc` is never bound once pi has the keyboard, because it means something to pi.
- `a` toggles: it archives an open session and unarchives an archived one. There is no separate undo key. After `a` the cursor stays in place, on the row that followed, instead of chasing the session into its new section.
- `n` starts a new session: in the selected session's cwd on a session row, or in the project root on a header.
- `w` wakes a dormant session in the background and never takes the keyboard.
- `/` filters; `y` copies `swb open <id>`; `Y` copies `@session:<uuid>`.
- `l` on a session row is Enter, and on a collapsed header it expands. `h` on an expanded header collapses it; on a collapsed header or a session row it does nothing. Clicking, Enter, or space on a header toggles it. `q` quits the Deck.

**Prefix** (`M-a`, rebindable), handled by the UI server:
- `Tab` toggles focus between the roster and the Stage. `h` and `l` move focus one pane left or right: roster, then editor and pi in split view.
- `e` swaps the view between pi and the Editor. In split it does nothing.
- `v` toggles split view. Entering split keeps the keyboard on the pane matching the previous view; leaving it shows the pane that had the keyboard, full width.
- `z` zooms the focused Stage pane (focus mode).
- `?` shows help.
- `M-a` sends a literal `M-a` to pi. The sessions server has no prefix, so nothing in between catches it.

Clicking a pane focuses it. The bindings target panes by index rather than `{left}`/`{right}`, which stop resolving while a pane is zoomed.

**Roster order**:
- Open sessions are grouped by Project. Projects sort alphabetically and stay put; sessions within a project sort by `activity_at`, newest first.
- Then **Inactive**, collapsed: open, no activity for 72h, never blocked or unseen. Grouped by project.
- Then **Archived**: an inline section, collapsed by default like Inactive, flat, ordered by `max(activity_at, archived_at)` descending.
- The cursor follows the session id across reorders.

**Glyphs**: ◆ blocked (flashing at about 1 Hz in `#c084fc`, the glimpse companion's attention purple; animated by the TUI, not SGR blink, and re-rendering only the affected rows) · ◐ working · ● unseen · ○ idle (including dormant) · ⚠ interrupted · ⟳ loading (wake in progress). Final glyphs are per the mocks.

**Stage states**: live (the real session), dormant (a card, below), loading (pi is starting), not running (pi quit while selected), empty (nothing selected). Archived rows show the dormant card and never start on their own.

**The dormant card** shows the whole conversation: every prompt of mine and every text reply from pi, newest at the bottom, cropped from the top to fit, then `w wake · ⏎ focus` (plus `a unarchive` on archived rows). It skips tool calls and thinking for now; tool-call summaries may come later. It is read from the session's transcript by a small read-only adapter in `packages/cli` for pi's v3 session format: JSONL entries linked by `parentId`, walked back from the last entry so only the active branch shows, keeping `message` entries with role `user` or `assistant` and their text parts. The adapter lives in the roster's worker, cached by the file's mtime, so the card appears at once and fills in when the parse lands. Importing pi's `SessionManager` instead would compile pi's whole coding-agent graph into `swb`, and pin it to whatever pi version `swb` happened to bundle.

**Copying** works by dragging, through both tmux layers. In pi's fullscreen mode the drag reaches pi, which copies natively. In regular mode the sessions server's copy mode takes the drag and emits OSC 52, which the UI server passes on (`set-clipboard on`). Ghostty's shift+drag selects across panes as a fallback.

### Settings

`${XDG_CONFIG_HOME:-~/.config}/agent-switchboard/config.toml`. Every key is optional; the defaults are shown.

```toml
hover = "lazy"             # "lazy": only `w` or Enter starts pi; "eager": resting 500 ms on a dormant open row starts it
editor = "$EDITOR"         # falls back to "nvim"
inactive_after = "72h"     # open sessions idle this long move to Inactive
reap_after = "30m"         # an idle live pi that nobody is viewing is stopped after this long
clipboard = "pbcopy"       # command that receives copied text on stdin

[keys]
prefix = "M-a"
```

Durations are an integer and a unit, `s`, `m`, `h`, or `d` (`"90s"`, `"30m"`). `editor` runs as `$SHELL -lic 'exec <editor>'` in the directory. `clipboard` runs under `/bin/sh -c`, with the text on stdin.

Unknown keys or bad values are a startup error that names the key. Nothing is silently ignored.

### Database

Path: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/swb.db`. Directory mode 0700, file mode 0600.

Connection policy on every connection: WAL, `synchronous=FULL`, `busy_timeout=5000`, `foreign_keys=ON`. Read-then-write transactions use `BEGIN IMMEDIATE`. The driver is `bun:sqlite` everywhere, because the work Mac's pi is a compiled Bun binary and `swb` is too. `node:sqlite` is used only if the recorder runs under Node.

`bun:sqlite` is synchronous, and a write can wait out the 5 s busy timeout. So in the Deck, every db access and every transcript parse runs in one Bun Worker, and the TUI thread only exchanges messages with it. Short-lived commands (`swb archive`, `swb ls`, hooks) use the db directly.

Schema v1 is ticket 07's, with a `cwd` that may change and runtimes keyed by the process that hosts them:

```sql
-- recorder-owned: written only by the session's own managed pi process
CREATE TABLE sessions (
  session_id       TEXT PRIMARY KEY,
  tool             TEXT NOT NULL CHECK (tool IN ('pi')),
  cwd              TEXT NOT NULL,    -- current; rewritten when it changes (/wt, /mv)
  project_root     TEXT NOT NULL,    -- parent of git common dir, else cwd; set once
  transcript       TEXT NOT NULL,    -- the dormant card reads the conversation from here
  title            TEXT,             -- pi session name; null until titled
  branch           TEXT,             -- null outside git
  phase            TEXT NOT NULL CHECK (phase IN ('idle','working','blocked')),
  created_at       INTEGER NOT NULL, -- epoch ms, first user message
  last_prompt_at   INTEGER NOT NULL,
  last_settled_at  INTEGER
);
-- recorder-owned: one row per managed pi process, written from its first session_start;
-- deleted only when the process quits
CREATE TABLE runtimes (
  tmux_session TEXT PRIMARY KEY,     -- given to the recorder by swb at launch
  session_id   TEXT NOT NULL UNIQUE, -- the session it hosts now; no row in sessions until the first prompt
  cwd          TEXT NOT NULL,        -- for a not-yet-prompted session's provisional roster row
  project_root TEXT NOT NULL,
  boot_id      TEXT NOT NULL,        -- kern.bootsessionuuid
  pid          INTEGER NOT NULL,
  started_at   INTEGER NOT NULL
);
-- user intent: written by swb (CLI and TUI) and by pi's /archive
CREATE TABLE marks (
  session_id  TEXT PRIMARY KEY REFERENCES sessions,
  archived_at INTEGER,
  visited_at  INTEGER,
  view        TEXT NOT NULL DEFAULT 'pi' CHECK (view IN ('pi','editor','split'))
);
```

Derived, never stored:
- **Archived**: `archived_at >= last_prompt_at`.
- **Live**: a runtime row for the session with the current `boot_id`, `kill(pid, 0)` succeeds, and its `tmux_session` exists on the sessions server.
- **Provisional**: a live runtime whose `session_id` has no `sessions` row yet: a new session before its first prompt. The roster shows it as a "new session" row in its project, so the Deck can select and show it; it is never persisted as a Session.
- **Interrupted**: not live and `phase != 'idle'`.
- **Unseen**: open, `last_settled_at > coalesce(visited_at, 0)`, and not on the Stage of a focused Deck right now.
- **Reapable**: live, `phase = 'idle'`, no client attached to its tmux session, and `max(coalesce(last_settled_at, 0), coalesce(visited_at, 0))` older than `reap_after`.
- **`activity_at`**: `max(last_prompt_at, coalesce(last_settled_at, 0))`. Archived rows order by `max(activity_at, archived_at)`. SQLite's scalar `max` returns NULL if any argument is NULL, so every nullable column is coalesced.
- **Inactive**: open, `activity_at` older than 72h, and neither blocked nor unseen.

`swb` owns all DDL through `PRAGMA user_version`. It migrates on every invocation. The recorder reads `user_version` inside every write transaction, so a recorder that predates a migration goes red at its next write instead of writing an old shape.

### tmux topology

Every tmux name below takes a suffix of `-<SWB_INSTANCE>` when that variable is set. Tests always set it.

- **Sessions server**, `tmux -L swb`.
  - It is started by `swb` from a scrubbed environment (`mise -C / hook-env` and `direnv exec /`, as ansiblonomicon's zshenv `tmux()` wrapper does). That keeps project credentials out of the server.
  - It loads **only an embedded `swb` config**, never the user's tmux config. tmux reads `-f` only when a server first starts, and this server outlives `swb` upgrades, so every `ensureSessionsServer` compares the server's `@swb_conf_version` with the binary's and, if they differ, re-sources the config. Hooks are set at a fixed index (`set-hook -g client-detached[0] …`), so re-sourcing replaces them and they always call the current `swb` path. The UI server does the same. The user's config binds keys in the root table (`M-z`, `M-0`…`M-9`, vim-tmux-navigator's `C-h/j/k/l`) that tmux would take before pi saw them, paints pane backgrounds, and adds hooks that bring the status bar back. The embedded config:
    - terminal: `default-terminal tmux-256color`, `terminal-features` with RGB, hyperlinks, and `extkeys`, `extended-keys always`, `extended-keys-format csi-u`, `escape-time 0`, `focus-events on`;
    - behavior: `mouse on` with tmux's stock mouse bindings, `mode-keys vi`, `history-limit 50000`, `set -s set-clipboard on`;
    - no prefix (`prefix None`, `prefix2 None`) and no other key bindings, so every key reaches pi;
    - hooks: `client-focus-in`/`client-focus-out` run `swb visit`, `client-detached` runs `swb detached`, and `session-closed` runs `swb gc`;
    - lifecycle: `remain-on-exit off`, `destroy-unattached off`, `exit-unattached off`, `exit-empty off`, `detach-on-destroy on` (otherwise a Stage whose session dies lands on some other session);
    - chrome off: `status off`, `pane-border-status off`, `set-titles off`;
    - colors: no foreground and no `pane-colours`, so those queries fall through to the real terminal; the background is mirrored in by the roster (see Theme below);
    - one key correction, because nested tmux turns Alt+Enter into legacy `ESC CR`, which pi reads as Enter. It must live on this inner server; an outer-only binding doesn't help:
      `bind-key -n M-Enter if-shell -F '#{m:*Ext*,#{pane_key_mode}}' 'send-keys -H 1b 5b 31 33 3b 33 75' 'send-keys M-Enter'`
    - managed pi gets `PI_IMAGE_PROTOCOL=none`, which makes pi's existing text fallback for images explicit.
  - Hooks call the absolute path of the running `swb` executable.
  - It holds three kinds of tmux session, tagged with user options:
    - **pi sessions**: `@swb_kind=pi`, plus `@swb_launch_id=<id>` on a resume launch. Named `<project>-<4 hex>`, never renamed. Which session one hosts comes from `runtimes`, never from tmux.
    - **Editor sessions**: `@swb_kind=editor`, `@swb_dir=<dir>`. Named `<dirname>-edit-<4 hex>`.
    - **Placeholder sessions**, one per Deck: `@swb_kind=placeholder`, `@swb_deck=<deck>`. They render the Stage's cards.
    - **The control session**, `swb-ctl` (`@swb_kind=control`). Each Deck's control-mode client attaches here. A `tmux -C` client is an attached client like any other, so attached to a pi session it would make that session look viewed and never reapable.
- **UI server**, `tmux -L swb-ui`.
  - Owned entirely by `swb` through an embedded config: `default-terminal tmux-256color`, `extended-keys always` with `csi-u`, `terminal-features` with `extkeys`, RGB and hyperlinks, `allow-passthrough all`, `focus-events on`, `escape-time 0`, `status off`, `mouse on`, `set -s set-clipboard on` (its default, `external`, drops the inner server's OSC 52), no color styles, and the prefix table. `destroy-unattached` is set **per Deck session** from a `client-attached` hook, because setting it globally kills a new Deck before its client attaches.
  - It has its own `swb-ctl` control session, for the same reason: a control client attached to a Deck would keep `destroy-unattached` from ever destroying it.
  - Prefix bindings and focus hooks talk to the roster through `run-shell -b 'swb __deck <deck> <command>'`, which posts to the roster's Deck socket. Its output is redirected, because a failed `run-shell -b` paints its error over the active pane.
  - The Stage's `tmux attach` has its stdout sent to `/dev/null` (drawing goes to the tty), so tmux's `[detached (from session <name>)]` line never leaks internal names.
  - Each Deck is one disposable tmux session, `deck-<6 hex>`, with the roster pane (`swb __roster --deck <id>`) and one Stage pane per visible view pane (`env -u TMUX tmux -L swb attach -t <target>`): one for pi or editor view, two for split.
  - Stage panes are created only after the Deck's outer client has attached, from the Deck's `client-attached` hook. A nested client that attaches first finds no terminal colors to inherit; in the theme probe that left pi without colors in 2 of 3 runs.
- `swb` always unsets `$TMUX` for clients it starts, so it behaves the same inside or outside another tmux.

### Theme

tmux 3.7c relays the real terminal's colors through both layers by itself, so `swb` copies no color values anywhere:
- each tmux answers a pane's OSC 10/11 (foreground and background) from the colors its own client reported at attach;
- OSC 4 palette queries are forwarded live to the outermost terminal;
- a light/dark change (mode 2031, report 997) flows down: Ghostty tells the UI server, which re-queries and tells its panes and the Stage clients, and the sessions server does the same for pi, which re-queries.

What `swb` must do is not get in the way: no color styles on either server, Stage panes created after the outer client attaches, and the roster re-querying colors on every 997, as pi does.

The relay has one gap: a pane with no client attached. tmux has no terminal to ask, so it answers no color query at all, and pi falls back to its default dark theme. That's every pi woken with `w`, by eager hover, or after reaping, until someone views it, and glimpse-companion mirrors pi's theme, so its pill goes black too. Thurston's own tmux hit exactly this with pi-sessions subagents, which run detached. So the roster mirrors the terminal's **background only** into the sessions server: `set -g window-style bg=<color>` and `window-active-style` likewise, at Deck start and again after every 997. tmux answers OSC 11 from that style for every pane, viewed or not, and a `window-style` change makes tmux send each pane whose theme changed a 997, so unviewed pis re-theme live as well. The mirrored color equals the terminal's, so painting it changes nothing visible. Foreground and palette stay relayed. With no Deck open nothing updates the mirror, and the next Deck refreshes it at start. `COLORFGBG` is not set: the mirrored background makes it redundant. Verified in a probe with a fake Ghostty, including a live light→dark flip reaching both the roster and real pi; a real Ghostty run is still pending.

### Pi ↔ swb contract (the recorder)

The recorder is the pi package `@thurstonsand/pi-agent-switchboard`, built from `packages/pi`.

`swb` launches every managed pi as:

```sh
tmux -L swb new-session -d -s <name> -c <cwd> \
  -e SWB_MANAGED=1 -e SWB_DB=<db path> -e SWB_TMUX_SESSION=<name> -e PI_IMAGE_PROTOCOL=none \
  "env -u TMUX -u TMUX_PANE $SHELL -lic 'exec pi [--session-id <id>]'"
```

A resume launch also sets `@swb_launch_id=<id>` on the tmux session. It only marks a launch in flight: once that session's runtime row exists, the db is the truth, even after `/new` moves the process to another id.

Resume uses `--session-id <id>` after the cd to `sessions.cwd`. Accepted risk: a missed lookup creates an empty session under that id.

At load, the recorder reads `SWB_MANAGED`, `SWB_DB`, and `SWB_TMUX_SESSION` into a frozen launch descriptor on a `globalThis` symbol, then **deletes all three from `process.env`**, so no child process inherits them. pi's `/reload` re-imports extensions with a fresh module cache, so the reloaded recorder finds the descriptor there instead of in the environment; a recorder that fails also records that on the descriptor, so the failure outlives reloads too. With neither environment nor descriptor, the recorder is inert and silent. Every session the process hosts is managed, through `/new`, `/resume`, `/fork`, `/wt`, and `/reload`.

Events and the writes they make. Each write is synchronous and one transaction.

| Event | Write |
| --- | --- |
| `session_start` (any reason) | upsert `runtimes` by `tmux_session` with the current `session_id`, `cwd`, `project_root`, and pid; if a `sessions` row exists, reconcile `phase='idle'`. No `sessions` row is created: rows begin at the first prompt |
| user `message_start` | create the row if missing (with `project_root`, `created_at`, and `phase='working'`, because pi emits `agent_start` before the first user message), and set `last_prompt_at` |
| `agent_start` | `phase='working'` on an existing row |
| `glimpseui:attention:request` / `:resolve` | an id set: non-empty means `blocked`, empty means back to `working` |
| `agent_settled` | `phase='idle'`, `last_settled_at`, plus `cwd`, `branch` (read HEAD), and `title` when changed |
| `session_info_changed` | `title`, at once, so a rename while idle shows up |
| `session_shutdown`, reason `quit` | delete the runtime row; never touch `phase` |
| `session_shutdown`, any other reason | nothing: the `session_start` that follows rewrites the same runtime row, so a Deck never sees the process vanish |

Failure: the recorder shows a persistent red footer status (`swb: not recording: <reason>`) and an error notify, then stays failed for the rest of that process. A `user_version` mismatch is a failure.

`/archive`:
- If a turn is running, it refuses with "turn running: wait for it to complete".
- Otherwise it writes `marks.archived_at` and calls `ctx.shutdown()`.
- The tmux `session-closed` hook then runs `swb gc`, which reaps the editor.

### Drive contract

- `swb drive start [--theme light|dark]` creates a harness tmux server, `swb-drive[-<instance>]`, whose single pane runs `swb [args]` at the given size (default 140x40). It waits until the Deck reports ready in its state.
- A detached tmux pane answers no color queries, so the harness stands in for a terminal: it sets `window-style` and `pane-colours` to a Gruvbox palette on its own server only, which tmux reports to the Deck as terminal colors. `drive theme light|dark` swaps them, and tmux sends the 997 that a real terminal would. The harness also sets `set-clipboard on` and captures OSC 52 into its buffer, which `drive clipboard` prints.
- `drive keys` sends tmux key names to that pane, exactly as a terminal would deliver them.
- `drive capture` is `capture-pane -p [-e]` of that pane: the composited Deck as a human sees it.
- Each roster serves a **Deck socket** at `${XDG_STATE_HOME}/agent-switchboard/decks/<deck>.sock`, speaking HTTP over a unix socket. `GET /state` returns the view state, which is always current. `POST /cmd` takes the prefix and hook commands. `swb deck state` and `drive state` read `GET /state`. The state holds: `deck`, `cursor` (session id), `staged` (session id, Stage state, and `view`), `focus` (`roster`, `stage`, or `editor`), `zoomed`, `mode` (`roster`, `filter`, `help`), `filter`, `toasts`, `waking` (pending or loading ids, and whether the keyboard is waiting on one), `rows` (the visible rows in order: kind, id, title, glyph, and expanded for headers), `colors` (the terminal background the roster last read), `terminalFocused`, and `ready`.
- A socket whose Deck session no longer exists on the UI server is reported as gone and removed.
- `drive wait <path>=<value> [--timeout]` polls `GET /state` until it matches. It proved the most useful verb in the mock (e.g. `drive wait staged.kind=live`).

The Deck state, which `swb deck state --json` prints. Field names and types are the contract; values are illustrative:

```json
{
  "deck": "deck-3fa9c1", "ready": true, "terminalFocused": true,
  "cursor": "01a1127b-…", "mode": "roster", "filter": "",
  "focus": "stage",
  "staged": { "id": "01a1127b-…", "host": "agent-switchboard-7f3a", "kind": "live", "view": "split", "savedView": "split" },
  "layout": { "width": 180, "rosterOnly": false, "split": true, "zoomed": false },
  "waking": [{ "id": "01a10cd1-…", "keyboardWaiting": true }],
  "rows": [
    { "kind": "header", "project": "agent-switchboard", "expanded": true },
    { "kind": "session", "id": "01a1127b-…", "title": "Deck mock round 3", "glyph": "◐", "provisional": false }
  ],
  "colors": { "background": "#f9f5d7", "scheme": "light" },
  "toasts": [{ "text": "turn running: wait for it to complete", "level": "error" }]
}
```

`staged.kind` is one of `live`, `dormant`, `loading`, `exited`, `empty`; `focus` is `roster`, `stage`, or `editor`.

`swb ls --json` prints an array, one object per Session, with these fields and the derived states:

```json
[{ "id": "01a1127b-…", "title": "Deck mock round 3", "project": "/Users/me/code/agent-switchboard",
   "cwd": "/Users/me/code/agent-switchboard", "branch": "main",
   "open": true, "live": true, "activity": "working", "unseen": false, "interrupted": false, "inactive": false,
   "activityAt": 1791313272416, "archivedAt": null }]
```

## Call Stacks and Data Flow

### Opening a Deck

```text
swb [new|open <id>]
  config.load()                          fails loudly on a bad key
  db.open(); db.migrate()                user_version
  tmux.ensureSessionsServer()            scrubbed env, embedded conf
  tmux.ensureUiServer()                  embedded conf
  deck = tmux.createDeck(size)           deck-<hex>: roster pane only
    placeholder = tmux.createPlaceholder(deck)   `swb __placeholder --deck`
  [new]  pi = sessions.launch(cwd, resume=null)  then stage(pi)
  [open] stage(id)
  exec env -u TMUX tmux -L swb-ui attach -t deck  this terminal becomes the Deck
    client-attached hook → Stage pane(s): env -u TMUX tmux -L swb attach -t <placeholder or session>
```

### Roster loop (packages/cli/src/deck/roster.ts)

```text
start: render from db snapshot, write state (ready=true)
one tmux control-mode client (`tmux -C`) per server, attached to that server's swb-ctl session:
  commands go over it (switch-client ~0.9 ms, versus ~11 ms to spawn a tmux process)
  its notifications (%sessions-changed, %session-window-changed, pane exits) drive liveness
one Bun Worker owns the db connection and the transcript cache; the TUI thread only messages it
every 250 ms (in the worker):
  db.dataVersion() changed?  → post fresh rows to the TUI thread
  derive states → TUI thread diffs → render if changed
  reapable sessions → re-read phase, then
    tmux if-shell -F -t =<s> '#{==:#{session_attached},0}' 'kill-session -t =<s>'
    the attached check runs inside tmux, so a Deck that attached since the poll keeps it
on key:
  update view model synchronously → render → schedule effects (never awaited by the input handler)
on cursor change:
  stage(cursor) immediately, in that session's remembered view
  dormant → card from the transcript cache; on a miss the worker parses and posts it
  if eager and dormant-open: hoverTimer(500 ms) → sessions.launch(resume=id)
at start, and on terminal 997 (light/dark change):
  re-query colors and re-render
  mirror the background: tmux -L swb set -g window-style bg=<bg> ; set -g window-active-style bg=<bg>
```

With no Deck open, nothing reaps. That's fine: a reaped session only matters for memory, and the next Deck catches up within one poll.

### Staging a session (never blocks)

```text
stage(id)
  live?          → switchClient each Stage client to its view's target (pi session, editor session)   ~50 ms
  starting?      → placeholder shows "loading"; switch to placeholder
  dormant / not running / archived / empty → placeholder shows that card; switch to placeholder
sessions.launch(cwd, resume)
  tmux new-session -d … (as in the recorder contract)    returns in ~10 ms; pi starts in the pane
  set @swb_launch_id                                     resume only
  row.loading = true                                     cleared when the runtime row for that tmux session appears
when that runtime appears and the cursor is still on it → switchClient to the pi session
  the keyboard was on the loading card (Enter, no esc since) → it stays on the Stage, now pi
a staged host's runtime changes session_id (/new, /resume, /fork inside pi)
  → the selection follows the host: cursor and staged.id move to the new id, provisional or not,
    and the Stage client is left where it is
```

A new session from `swb new` or `n` is ready, and selectable, as soon as its `session_start` writes the runtime row; it doesn't wait for a first prompt.

The placeholder is `swb`'s own process, so it can bind `esc` on the loading card without touching pi. Stage clients are the Stage panes' nested clients, found by tty from `list-clients` when each pane is created.

### Visit

```text
roster loop: selected session S shown live, terminalFocused = true, for ≥ 1 s
  db.tx: marks.visited_at = now                once per 1 s dwell, and again on leaving if the dwell completed
the dwell timer carries the selection it started for, so a stale timer never visits a later selection
tmux client-focus-in / client-focus-out on the sessions server (plain attach viewers):
  swb visit --client <tty> --in|--out  → resolve client → session → visited_at = now
```

### Archive

```text
TUI `a` / swb archive <id> / pi /archive
  phase ∈ {working, blocked} and live → refuse: "turn running: wait for it to complete"
  db.tx (BEGIN IMMEDIATE): re-check phase, then marks.archived_at = now
  live → tmux kill-session <runtime.tmux_session>     SIGHUP → pi clean shutdown → runtime row deleted
  gc()                                                also triggered by the session-closed hook
TUI `a` on an archived row / swb unarchive <id> → db.tx: marks.archived_at = null   nothing restarts; `w` or Enter resumes
gc()
  for each editor session E (@swb_dir = D):
    no open session has cwd = D → kill E
```

### Detach and never-prompted cleanup

```text
client-detached hook → swb detached --session <name>
  @swb_kind = pi, its runtime is provisional (never prompted), and no clients left → kill-session
```

### Views: editor swap and split

```text
M-a e | M-a v (UI server bindings) → run-shell -b "swb __deck <deck> view-swap|view-split" → POST /cmd
  selected session S, dir D = S.cwd
  editor for D exists? else tmux new-session -d -c D (@swb_kind=editor, @swb_dir=D) "$SHELL -lic 'exec <editor>'"
  db.tx: marks.view = pi | editor | split
  pi | editor: one Stage pane, switchClient to that target
  split:       a second Stage pane at 35% on the right; editor client on the left (65%), pi client on the right
               only when live and the Deck is ≥ 160 columns; otherwise pi view, with marks.view unchanged
  state.staged.savedView = marks.view; state.staged.view = what is showing
```

Moving the cursor restores each session's own view, so a session left in split comes back in split.

### Process loss and reboot

```text
next swb invocation: runtime rows with a stale boot_id or dead pid → not live
  phase = idle → shown as idle (dormant); phase ≠ idle → ⚠ interrupted
  stale runtime rows are left alone: the row is replaced the next time that session starts
```

## Design Decisions

### 1. The Deck: a nested tmux client, not a dispatcher or an emulator

The Stage is `tmux attach` running inside a Deck pane, and the roster drives it with `switch-client`.
- The spike measured a 52 ms switch with a clean screen.
- Truecolor, Shift+Enter, resize, copy mode, mouse, focus hooks, and OSC 8 links all survive both layers.

The first design opened Ghostty tabs through GhosttyKit. That made the product depend on one terminal and a helper daemon, broke over SSH, and showed no live preview. Rendering `capture-pane` snapshots gives a read-only preview with lag. An emulator inside pi-tui gives the most control, but it's a large build with real fidelity risk. The escape hatch, if tmux ever proves inadequate, is libghostty embedding, to be avoided if at all possible.

### 2. Two tmux servers, both owned by `swb`

tmux is an execution engine here, not something people interact with. Both servers load only configs that `swb` embeds. Ticket 08 first had the sessions server inherit the user's config, so copy mode and root bindings would feel familiar. Round 3 of the mock showed what that costs. The user's root bindings take keys before pi does: `M-z` collides with pi's own `alt+z`. Its `window-style` freezes pane colors and blocks live light/dark switching. Its hooks bring the status bar back. The overlay that fought all that is gone. The embedded config copies only the settings fidelity needs, and the nested-tmux research validated those. Two servers stay separate because Decks are disposable UI and sessions are durable.

### 3. No daemon; the db and the tmux servers are the truth

Several Decks stay in sync because each one polls `data_version`, at about 4 µs per poll, alongside two tmux list calls. Every cross-Deck effect is idempotent and written to the db or to tmux, so no single process needs to own anything. That's simpler to drive, to test, and to crash. Add a daemon the day a feature needs one long-lived actor; PR polling is the likely first.

### 4. A consumed environment token marks managed pi

`SWB_MANAGED` and `SWB_DB` are deleted at load, so subagents, handoffs, and any child pi are unmanaged by construction, and the recorder always writes the db that its launcher chose. The socket-based rule (ticket 01) leaked to children through `$TMUX`, and it couldn't follow `/new`. Hiding `$TMUX` from pi also keeps pi-sessions' tmux features off the sessions server. The cost: directional handoffs are unavailable in managed sessions until pi-sessions gains an `swb` backend.

### 5. Waking pi happens in the background, and the TUI never waits

Starting pi takes seconds, and the TUI must never wait on it. Launching returns in about 10 ms, readiness arrives through the db (a runtime row appears), and the placeholder covers the gap. **Lazy is the default:** using the Deck mock, Thurston preferred waking sessions explicitly with `w`. A dormant row shows its whole conversation from the transcript instead, so deciding whether to dive in needs no pi at all. `hover = "eager"` starts pi after 500 ms on a row, for anyone who wants it ready by the time they look.

Enter is an explicit "I want to talk to it", so it takes the keyboard straight to the loading card; `esc` backs out to the roster and lets the wake finish in the background. `w` never takes the keyboard: being pulled out of the roster mid-navigation would be jarring. Live pis that sit idle and unviewed for `reap_after` (30 minutes by default) are stopped, so browsing the roster doesn't leave most of it running. A reaped session is dormant, and nothing is lost.

### 6. Editors are per directory, and each session remembers its view

Sessions sharing a directory share files, so they share one editor. Worktrees get their own, because they're different directories. An editor is a separate tmux session, so swapping is one `switch-client`, and the editor survives pi quitting. Split view puts editor and pi side by side as two nested clients, which keeps the editor a single shared session instead of a pane that one pi session would have to own. The view lives in `marks.view` because it's my intent for that session: every Deck agrees on it, and it survives restarts. `gc` reaps it once no open session uses its directory. nvim keeps swap files on SIGHUP, so a reaped editor's unsaved edits stay recoverable.

### 7. Archive never force-stops a turn

On every surface, archiving refuses while a turn is running. Archiving an idle session kills it immediately, because nothing is lost: the transcript is complete, and `w` or Enter resumes it. Reversing it is just unarchiving, with `a` again on its row in Archived, so there's no undo key, no deferred kill, and no timer that has to outlive the TUI.

### 8. Revive is gone

Whether a process is running is plumbing. A process starts only by `w`, Enter, or eager hover, and it stops by quitting, archiving, or reaping. The roster shows Dormant as Idle. Only ⚠ Interrupted surfaces process death, because a dead turn is the one runtime fact worth acting on.

### 9. Visit means "it was live on a focused Deck's Stage"

The Stage shows the real screen, so being shown there is seeing it, wherever the keyboard focus is. The 1 s dwell keeps a fast scroll through the roster from clearing everything it passes.

### 10. pi mints ids, and tmux names are internal

Once `/new` exists, a tmux session can't keep a session's id as its name, so names are readable plumbing (`ansiblonomicon-7f3a`), mapped through `runtimes.tmux_session`. Users only ever see titles.

### 11. Agent drivability is a product feature

`swb drive` puts a real Deck in a hidden terminal: keys go in through the same path a human's do, and the composited screen comes out. `deck state` exposes what's on screen as JSON for assertions. The e2e suite and evidence recordings are built on it. That's what lets a single implementation agent build and verify the whole product without a human at the keyboard.

### 12. Distribution: one tag, three artifacts

A `vX.Y.Z` tag runs `.github/workflows/release.yml`:
- it builds the arm64 `swb` binary as a GitHub release asset;
- it bundles `packages/pi` (with `shared` inlined and pi's host packages left external) into a generated `pi` branch;
- it publishes the same bundle to npm as `@thurstonsand/pi-agent-switchboard`, through Trusted Publishing.

CI sets versions from the tag; nothing is bumped locally. Following pi-sessions' `npm-release` skill:
- the work Mac installs `swb` with mise `github:` at `latest`, plus pi `git:…@pi`, because its npm mirror lags;
- personal hosts list the package in ansiblonomicon's `PERSONAL_PACKAGES`: the local checkout on the Mac, npm elsewhere.

### 13. Stack

- TypeScript on Bun, with `@earendil-works/pi-tui` tracking latest (1.0.0 at time of writing).
- Bun workspaces: `packages/cli`, `packages/pi`, `packages/shared`.
- The CLI may take any dependency. The recorder takes as few as possible: pi's packages and `typebox` are `"*"` peer dependencies, and `bun:sqlite` is built in.

## Edge Cases & Failure Modes

- **Two Decks wake the same dormant session at once.** `sessions.launch` takes a tmux mutex (`wait-for -L swb-launch-<id>`). It starts nothing if the session has a live runtime, or if a tmux session with `@swb_launch_id=<id>` has no runtime row yet (a launch in flight). Otherwise it creates the session, then releases the mutex (`wait-for -U`). Only one pi ever starts per session.
- **A prompt lands in the instant an archive kills pi.** Archive re-checks `phase` inside its transaction, but a prompt typed into another viewer can still arrive between that commit and `kill-session`. Accepted, and arguably not a race at all: the prompt's `message_start` lands after `archived_at`, so the session reopens as ⚠ Interrupted with its transcript intact, which is exactly what happened to it. A handshake through the recorder would close the window at the cost of a request protocol the product doesn't otherwise need. Reaping has the same window, with the same outcome.
- **pi quits while selected.** The Stage shows "pi exited", and does not restart pi until `w` or Enter.
- **pi never becomes ready** (crash on start). The placeholder shows "failed to start" with the pane's last lines, captured before it disappears. Set `remain-on-exit` per pane for the launch window, then turn it off. The toast names the cause.
- **The transcript is missing on resume.** That's the accepted `--session-id` risk: pi creates an empty session. The roster keeps showing the row. The dormant card shows "transcript not found" with the path.
- **The transcript fails to parse** (a pi format change). The card shows the parse error and the path, and everything else keeps working. The adapter checks the header's `version` and names it when it isn't 3.
- **Two Decks on terminals with different themes.** The background mirror is server-wide, so the last Deck to see a 997 sets every pi's background. Accepted: one person, one appearance setting.
- **The user's own tmux** still paints whatever it likes. Nothing in it reaches `swb`'s servers.
- **The db is missing, or newer than the binary.** `swb` refuses with the version numbers. The recorder goes red in the footer.
- **Running pi processes during an upgrade** keep the old recorder. They go red at their next write after a migration, until restarted. Old tmux servers pick up the new embedded config at the next `swb` invocation.
- **The sessions server dies** (`kill-server`, or a crash). Every session derives dormant or interrupted, and the next `w` or Enter restarts it. Decks show the placeholder and recover once the server is back, because `ensureSessionsServer` runs on every effect.
- **`swb` inside another tmux.** Identical behavior: `$TMUX` is unset for every client `swb` starts. The outer tmux grabs its own prefix first; if that's also `M-a`, rebind `swb`'s prefix in config. Its color styles, if any, become the Deck's outer terminal colors.
- **Terminal too narrow.** The mocks set the breakpoint. Below it, the Deck shows the roster alone, and `Enter` zooms the Stage. Split view falls back to pi view below its own breakpoint, without changing `marks.view`.
- **Alt+Enter through two layers** used to arrive as `ESC CR`. The sessions-server `M-Enter` binding re-emits CSI-u `13;3u`; real pi 0.99.2 passed with Shift+Enter, Enter, Escape, and Ctrl+C unchanged ([research](../wayfinding/session-manager/research/nested-tmux-alt-enter-and-images.md)). An e2e scenario guards it.
- **Images in the Stage**: pi disables images under `TERM=tmux-256color` and renders a text fallback (path, MIME type, dimensions, an OSC 8 link). Kitty graphics can't cross two tmux layers by configuration alone, because tmux 3.7c has no Kitty graphics feature and pi doesn't double-wrap. That's accepted degradation, and `PI_IMAGE_PROTOCOL=none` makes it explicit.
- **The power-loss window.** The db can run one message ahead of the transcript. Accepted: the db is never treated as the transcript.
- **Subagents and handoffs** from a managed session have no `SWB_MANAGED`, so they're never Sessions. The e2e suite proves it with real pi-sessions subagents.

## Alternatives

### Ghostty-tab Dispatcher (GhosttyKit `new-tab` / `focus-terminal`)

- **Status:** Rejected
- **Decision:** It depended on a single terminal and a helper daemon, it broke over SSH, and it showed no live preview.
- **Discussion:** It was the plan through ticket 11. Ticket 06 (the GhosttyKit commands) was dropped.

### Snapshot preview (`capture-pane -e` rendered in the TUI)

- **Status:** Rejected
- **Decision:** Read-only and laggy. The Deck shows the real, interactive session at the same cost.

### Terminal emulator inside pi-tui, or libghostty

- **Status:** Open, as an escape hatch only
- **Open Issue:** None, unless nested tmux proves inadequate.
- **Discussion:** Most control, highest cost, and fidelity risk with keyboard protocols, images, and mouse.
- **Next step:** Revisit only if the nested-tmux defects can't be resolved.

### Pre-minted session ids

- **Status:** Rejected
- **Decision:** `/new` re-homes a process anyway. pi mints the id, and `runtimes.tmux_session` maps it.

### `--session <transcript path>` for resume

- **Status:** Rejected, with the risk accepted
- **Decision:** Thurston prefers `--session-id` after a cd, accepting that a missed lookup silently creates an empty session.

### Per-session or per-project editors

- **Status:** Rejected
- **Decision:** Sessions in one directory share its files, and worktrees are separate directories. So editors are per directory.

### Inheriting the user's tmux config on the sessions server

- **Status:** Rejected (ticket 08 chose it; the round-3 mock reversed it)
- **Decision:** Its root bindings steal pi's keys, its pane styles break the theme relay, and its hooks re-enable chrome. tmux is an execution engine here, so `swb` embeds the whole config.

### Copying all terminal colors into tmux styles at launch

- **Status:** Rejected; the background alone is mirrored and kept live
- **Decision:** Copying once at launch freezes values. Copying foreground and palette too adds nothing, because tmux relays those to any pane with a viewer. The background is the exception, because a pane nobody views gets no answer at all and pi goes dark. So the roster mirrors the background and refreshes it on every 997.

### Importing pi's `SessionManager` for the dormant card

- **Status:** Rejected
- **Decision:** It's exported only from `@earendil-works/pi-coding-agent`'s root barrel. A compile probe pulled in pi's providers, UI, MCP, and model data, and failed without their assets. A 40-line adapter for the active branch's text is smaller and fails loudly on a version change.

### An archive handshake through the recorder

- **Status:** Rejected for now
- **Decision:** It closes a millisecond race between the idle check and the kill, but it needs a request channel from `swb` into pi. The race's worst outcome is an open, Interrupted session with nothing lost.

### Last prompt and reply stored in the db

- **Status:** Rejected
- **Decision:** The dormant card shows the whole conversation, so it reads the transcript. Two truncated copies in the db would be dead weight.

### A background daemon owning state

- **Status:** Deferred
- **Decision:** The db and tmux are enough today. Add one when a feature needs a long-lived actor.

## Implementation Gotchas

Traps found during the spikes and mocks that the sections above don't already spell out:
- `PRAGMA data_version` changes only for commits made by other connections. Compare it on one long-lived connection, and expect it not to move for that connection's own writes.
- `agent_end` is not idle: a queued follow-up can start another turn. Only `agent_settled` means the turn finished with nothing queued.
- pi swallows extension errors. A recorder that throws just stops recording, so every recorder failure has to surface itself, through the red footer.
- The faux provider is not in pi's built-in registry; register it from the scenario extension. A disposable `HOME` breaks the mise `pi` shim, so resolve the real executable before changing `HOME`.
- tmux's `default-shell` is the user's zsh, which expands `=target` in `attach -t =target` as a command lookup. Run tmux command strings that use `=` targets under `/bin/sh`.
- In a synthetic harness, an `Escape` sent just before another key can arrive as an Alt chord, even with `escape-time 0`. Space keys out in tests instead of adding `escape-time`, which would slow real input.

## Implementation Plan

One autonomous agent runs Phases 0–7 in order; Phase 8 happens after Thurston reviews and tags a release. Every phase leaves `main` green, under `mise run check` (lint, typecheck, build) and `mise run e2e`, and ends with a commit. There are **no unit tests**: every validation is an end-to-end scenario against the real built `swb`, real pi 0.99.2 with the faux provider, the real recorder, an isolated db, and private tmux servers (`SWB_INSTANCE=e2e-<rand>`, disposable `HOME`/`XDG_*`/`PI_CODING_AGENT_DIR`). Every phase also saves visual evidence (`swb drive capture` text, plus `--ansi`) under `test/e2e/artifacts/<phase>/`, which is gitignored and attached to the PR. Read [CONTEXT.md](../../CONTEXT.md), AGENTS.md, DEV.md, this doc, and the [e2e research](../wayfinding/session-manager/research/deterministic-pi-e2e.md) first.

Two settings exist so tests needn't mock anything. Both are real user-facing keys, not test hooks:
- `inactive_after = "72h"`, so a test can set `"2s"`.
- `clipboard = "pbcopy"`, so a test can point it at a file.

- [ ] Phase 0: Scaffold and e2e harness
  - Goal: the repo builds a compiled `swb`, and the e2e harness drives a real scripted pi in a private tmux server.
  - Files: root `package.json` (Bun workspaces), `packages/{cli,pi,shared}/package.json`, `tsconfig*.json`, `biome.json`, `mise.toml` (tools: bun, tmux checks, vhs, `conda:ttyd`, ffmpeg; tasks `check`, `lint`, `fix`, `typecheck`, `build`, `install`, `e2e`, `dist:pi`), `.github/workflows/ci.yml`, `renovate.json` (`security:minimumReleaseAgeNpm`, as in wt), `test/e2e/harness/` (disposable env, deadline polling, artifact retention, server cleanup, PID-death checks), and `test/e2e/scenario-extension.ts` (faux provider: plain reply, tool call, held turn, attention span; borrowed from pi-sessions' smoke extension).
  - Work: pin and check `pi --version` against 0.99.2 before any scenario. Resolve the real pi executable, not the mise shim. The work Mac's npm mirror trails upstream: if a dependency won't resolve there, pin the newest version it has and note it, rather than stopping.
  - Validation: `mise run check`. Run `mise run e2e` with one harness scenario: pi starts, a scripted reply renders, the capture is saved, and the server and PIDs are gone afterwards.

- [ ] Phase 1: Store, recorder, and the sessions server
  - Goal: a managed pi records its lifecycle into the db, and `swb ls --json` derives its state.
  - Files: `packages/shared/` (schema v1, paths, connection policy, derivations), `packages/pi/` (the recorder), and in `packages/cli/src/`: `db/`, `tmux.ts` (the one module for every tmux call), `sessions.ts` (launch with the env token, scrubbed server env, the embedded sessions-server config including `prefix None` and the `M-Enter` correction), and `commands/{ls,migrate,new,visit,detached,gc}.ts`.
  - Work: `swb new` temporarily attaches the current terminal straight to the new pi session; Phase 2 replaces that with the Deck. Add `swb drive start/keys/capture/stop` over arbitrary `swb` args; `drive state` waits for Phase 2.
  - Validation, as e2e scenarios:
    - `session_start` writes a provisional runtime before any prompt; the first prompt creates the row as working
    - working, then idle on `agent_settled` only
    - `/name` while idle updates the title at once
    - `/reload` keeps recording, and a failed recorder stays failed across it
    - blocked during an attention span
    - `/new` rewrites the same runtime row to the new id and leaves the old session dormant, with no gap in between
    - a migration under a running recorder turns its footer red at the next write
    - re-running `swb` against a server started with an older embedded config re-sources it, and the hooks call the new path
    - `kill-server` turns the idle session dormant and the held one interrupted
    - a never-prompted session is killed on last detach
    - a `user_version` mismatch shows the red footer
    - bare pi (no token) writes nothing
    - Alt+Enter arrives as CSI-u and Shift+Enter still works
    - with a user `tmux.conf` that binds `-n M-z` and sets `window-style`, pi still receives `alt+z`, and its OSC 11 reply is the harness terminal's background

- [ ] Phase 2: The Deck
  - Goal: `swb` opens a Deck with a live roster and a Stage that switches between sessions and wakes dormant ones, without blocking.
  - Files: `packages/cli/src/deck/` (roster app, the db-and-transcript worker, control-mode clients on the `swb-ctl` sessions, placeholder renderer with the dormant card, the transcript adapter, stage control, Deck socket, UI-server config and prefix bindings), `commands/{deck,open}.ts`, and the rewrite of `commands/new.ts`.
  - Work:
    - The roster per this doc and the last accepted mock: sections, header clicks, `h`/`l`, glyphs, alphabetical projects, cursor tracking.
    - Polling for `data_version`, live panes, Deck focus, and reaping.
    - Lazy wake (`w`, Enter with `esc` back-out), eager hover behind the setting, the placeholder states, and `M-a Tab`/`h`/`l`/`z`/`?`.
    - Stage panes created from the `client-attached` hook; the roster's 997 re-query.
    - `deck state` and `drive state`.
  - Validation, as e2e scenarios:
    - `w` → loading → live, with the keyboard still in the roster
    - Enter on a dormant row → keyboard on the loading card → pi has it once ready; Enter then `esc` → back in the roster, and pi still comes up
    - a dormant card shows the whole conversation, cropped from the top, from a real transcript
    - an idle, unviewed pi is reaped with `reap_after = "2s"`, and a viewed one is not
    - closing the Deck's terminal destroys the Deck session, its roster, and its socket
    - `n` and `swb new` show the new pi before any prompt, as a provisional row; `/new` inside a staged pi moves the selection to the new provisional row
    - with the db writer lock held by another process and a 50 MB transcript being parsed, the cursor still moves within 100 ms
    - the roster and a live pi report the harness terminal's background, and both follow `drive theme dark`
    - a pi woken with `w` and never viewed reports the terminal's background, not pi's dark fallback, and re-themes on `drive theme dark` while still unviewed
    - the cursor keeps moving within 100 ms while a pi is loading (measured from state-file timestamps)
    - switching between two live sessions takes ≤ 150 ms
    - Enter, then typing a prompt in the Stage, shows working then idle in the roster
    - two Decks waking one session start exactly one pi
    - the sessions server killed under an open Deck recovers on the next `w` or Enter
    - a drag in regular-mode pi reaches `drive clipboard` through both layers; a drag in fullscreen pi puts the text on the macOS clipboard (saved and restored around the test)

- [ ] Phase 3: Attention and lifecycle surfaces
  - Goal: Visits, Unseen, Inactive, Archived, and every archive surface.
  - Files: `deck/` (`a` toggle, the inline Archived section, filter, copy, Inactive section), `commands/{archive,unarchive}.ts`, and the recorder's `/archive`.
  - Validation, as e2e scenarios:
    - unseen after a turn finishes, cleared after 1 s on a focused Stage but not when the Deck terminal is unfocused
    - archive refused mid-turn on all three surfaces, with the exact message
    - archiving an idle live session kills its pi; `a` on its Archived row leaves it dormant and open; the cursor stays in place both times
    - `/archive` archives and quits
    - a new prompt in an archived session unarchives it
    - Inactive with `inactive_after = "2s"`, never for blocked or unseen sessions
    - `y`/`Y` copy

- [ ] Phase 4: Editors and settings
  - Goal: per-directory editors, the three views, and every setting.
  - Files: the `view-swap` and `view-split` Deck commands, `gc` rules, and `config.ts` (strict TOML parse and validation).
  - Validation, as e2e scenarios:
    - `M-a e` opens nvim in the session's cwd, and swaps back
    - `M-a v` shows the editor at 65% beside pi at 35%; `M-a h`/`l` move between all three panes; moving to another session and back restores split
    - split below 160 columns shows pi and comes back on widening; a dormant split session shows one card pane, then splits once live; below 100 columns the roster stands alone
    - the view survives closing and reopening the Deck
    - two sessions in one directory share one editor
    - a worktree gets its own
    - archiving the last open session in a directory reaps its editor, but not while another open session remains
    - eager hover starts pi after 500 ms; lazy (the default) starts nothing until `w` or Enter
    - a rebound prefix works, and `M-a M-a` delivers a literal `M-a` to pi
    - a bad config key fails loudly, naming the key

- [ ] Phase 5: Real-world hardening
  - Goal: prove the product against real pi-sessions behavior and its operating limits.
  - Work: install real pi-sessions into the disposable `PI_CODING_AGENT_DIR`. Then cover:
    - a managed session launching a subagent and a deferred handoff. Neither ever appears as a Session; the subagent's tmux session lands on the default-server equivalent, never on `swb`'s.
    - `swb` launched inside another tmux behaves identically
    - a narrow terminal (below the mock's breakpoint)
    - three concurrent Decks staying in sync
    - a shared viewer (`tmux attach` while the session is selected in a Deck)
    - a sessions-server restart
    - pi failing to start, shown as "failed to start"
  - Validation: all of the above as e2e scenarios, plus a performance scenario asserting keypress-to-frame under 16 ms (median, from the TUI's own frame timing exposed in `GET /state`; the mock measured a 0.9 ms render and 38 ms key-to-Stage-repaint through three tmux layers) across 200 cursor moves.

- [ ] Phase 6: Evidence recordings
  - Goal: one reviewable recording per scenario.
  - Work: versioned VHS tapes under `test/e2e/tapes/`, driven by the same harness, for:
    - first turn to idle
    - tool turn
    - blocked and release
    - wake with `w`, and Enter with `esc` back-out
    - the dormant card
    - Stage switching
    - editor swap and split view
    - archive refused, then archive and unarchive with `a`
    - a live light/dark flip
    - unarchive on a new turn
    - unseen and Visit
    - Inactive
    - labeled simulated process loss: idle versus interrupted
    - subagent exclusion
    - three Decks in sync

    Real-Ghostty capture, if wanted, uses `screencapture -v -R` once Screen Recording access is approved.
  - VHS, ttyd, and ffmpeg are repo-local dev tools in agent-switchboard's `mise.toml`, so `mise install` sets them up:
    ```toml
    vhs = "latest"           # aqua:charmbracelet/vhs
    "conda:ttyd" = "latest"  # aqua's ttyd has no darwin/arm64 build
    ffmpeg = "latest"        # conda:ffmpeg
    ```
    Proven on the work Mac on 2026-10-06: a tape rendered a GIF and a PNG. Videos are the primary evidence; `drive capture` text and ANSI artifacts back them up.
  - Validation: `mise run evidence` renders every tape and exits non-zero if any harness assertion fails.

- [ ] Phase 7: Release pipeline
  - Goal: one `vX.Y.Z` tag produces the binary, the `pi` branch, and the npm package.
  - Files: `.github/workflows/release.yml`, `.agents/skills/npm-release/SKILL.md` (adapted from pi-sessions' skill, extended for the binary and the `pi` branch), `CHANGELOG.md`, `README.md`, and `LICENSE` (MIT).
  - Work:
    - `dist:pi` builds the bundle, keeping pi's host packages and `typebox` external.
    - The release job builds `swb` for arm64, uploads it as a release asset, force-replaces the `pi` branch with the bundle, and publishes the same bundle to npm.
    - CI sets versions from the tag.
  - Prerequisite (Thurston): npm Trusted Publishing configured for `@thurstonsand/pi-agent-switchboard`.
  - Validation: `mise run release-check` builds everything into a scratch dir. One e2e scenario installs the `dist:pi` output as a pi package and passes Phase 1's first-turn scenario through it.

- [ ] Phase 8: Install from ansiblonomicon (in that repo, after the run)
  - Not part of the autonomous run. Preconditions: Thurston has reviewed the work, npm Trusted Publishing is configured, and a `vX.Y.Z` tag has produced the GitHub release, the `pi` branch, and the npm package.
  - Goal: both Macs run released `swb`.
  - Work:
    - mise `"github:thurstonsand/agent-switchboard" = "latest"`; verify the binary is not quarantined.
    - `git:github.com/thurstonsand/agent-switchboard@pi` in `WORK_PACKAGES`.
    - `("@thurstonsand/pi-agent-switchboard", "agent-switchboard/packages/pi")` in `PERSONAL_PACKAGES`.
  - Validation: ansiblonomicon's check tasks and `mise reconcile --check`; the real reconcile is Thurston's call. On the work Mac, `swb` opens a Deck and a managed session records.
