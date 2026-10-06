---
status: closed
type: grilling
blocked-by:
  - 1
  - 4
---

# Launch, hosting, and reopen contract

## Question

Pin down every path a managed session takes through `ide`, the `tmux -L swb` server, and Ghostty.

- **New session**: the `swb new --cwd …` contract that `ide` calls, tmux session naming, whether ids are pre-minted (`pi --session-id <uuid>` creates a session under a given id), and a TUI "new session in project" action.
- **Open**: dormant → `pi --session <id>` inside a new tmux session, plus a viewer. Live without a viewer → new viewer. Live with a viewer → focus it ([GhosttyKit tab and focus commands](06-ghosttykit-tab-and-focus-commands.md)). Multiple viewers of one session.
- **Revive** (`R`): start dormant sessions detached, per session or per project. No auto-continue.
- **Archive a live session**: kill its tmux session, ask first if it's working, the `/archive` path.
- **Unmanaged** sessions (bare `pi`): hide them, or show "open outside Agent Switchboard"? Does the recorder still record them?
- **Viewer lifecycle**: what the `ide` right pane does when pi exits, and when the tab closes (tmux detach). tmux config for the dedicated server (status bar off, keys passthrough, `client-focus-in` hook for Visits).
- Failure behavior when Ghostty, gty, or the daemon is unavailable: fail loudly, or fall back to a plain `tmux attach` in the current terminal?

## Settled so far

Round 1 (2026-10-06):
- **Managed identity**: `swb` starts pi with a one-time `SWB_MANAGED=1`. The recorder deletes it from `process.env` at load, so spawned children never inherit it. Every session the process hosts is managed, including after `/new`, `/resume`, `/fork`, and `/wt` migration, and the runtime row moves to whichever session is current. This replaces ticket 01's "on the swb socket" rule and the need for pi-sessions bootstrap detection.
- **$TMUX**: `swb` unsets `TMUX`/`TMUX_PANE` for pi, so pi-sessions subagents go to the default tmux server as they do today. Directional handoffs are unavailable inside managed sessions until pi-sessions gains an `swb` launch backend (a follow-up, tracked in the map).
- **Environment**: the tmux server starts with a scrubbed environment (`mise -C / hook-env` plus `direnv exec /`, mirroring the zshenv `tmux()` wrapper). Each pane runs `$SHELL -lic 'exec pi …'` in the session's cwd. The caller's environment is never forwarded.
- **Never-prompted sessions**: when the last client detaches from a tmux session that has no db row, `swb` kills it.
- **`/archive` during a turn**: refuses. Archive never force-stops a turn.
- **Backends**: tmux only for now, but expect to swap or add backends later.
- Reopened for round 2: id minting, resume lookup, revive, viewers and Ghostty, and tmux config ownership.

Round 2 (2026-10-06):
- **Multiple viewers**: shared by default. tmux supports several clients on one session natively, so nothing blocks it.
- **Resume lookup**: cd to `sessions.cwd`, then `pi --session-id <id>`. Accepted risk: if the cwd lookup misses, pi creates an empty session under that id.
- **Revive**: deleted, along with `R`, `swb revive`, and the term. A process starts only when you go into a session. In the roster, Dormant displays as Idle; ⚠ Interrupted stays.
- **Archive**: refuses on every surface (TUI, CLI, `/archive`) while a turn is running, with "turn running: wait for it to complete". Archiving an idle live session kills it immediately (SIGHUP, clean shutdown), and undo only clears the mark.
- **Backends**: every tmux call lives in one module of domain-level operations, with no abstraction yet. Schema columns keep their tmux names.
- **Inside or outside tmux**: `swb` must behave identically whether or not it's launched inside another tmux.
- Reopened: Thurston wants the session itself visible, live and interactive, inside the TUI, plus a focus mode and an editor keybind. That moves the Deck into scope and reopens tmux config ownership, naming, and where you land on detach.

Round 3 (2026-10-06):
- **Architecture: the Deck.** `swb` opens a Deck on its own UI server, with a roster pane and a Stage pane. The Stage is a real tmux client of the sessions server, switched with `switch-client`. It's interactive, with its own scrollback. Each invocation gets its own Deck, and every Deck reads the same db. There's no daemon. The escape hatch, if tmux proves inadequate, is libghostty-based embedding, to be avoided if at all possible. Snapshot previews and an in-TUI terminal emulator were rejected.
- **Scope**: the Deck is this effort's destination, delivered in stages.
- **Hover**: hovering a dormant session starts its pi in the background. The TUI never blocks on it: it shows a loading marker, and moving away is instant. Returning after startup snaps straight to the running session. Started processes stay running for now; watch performance. A snappy TUI is paramount.
- **tmux config**: the UI server is owned by `swb`. The sessions server inherits the user's config plus the minimal overlay.
- **Ghostty**: ticket 06 is dropped from the effort. `ide`'s fate moves to ticket 10.
- **Editor**: a key swaps the Stage between pi and an editor in the session's cwd. It must not collide with pi or nvim keys, probably behind a prefix. An `ide`-like split layout (65/35) comes later.
- Evidence: [Nested tmux Pi fidelity](../research/nested-tmux-pi-fidelity.md).

Round 4 (2026-10-06):
- **Deck prefix**: `M-a`, the same prefix Thurston uses in tmux. It's rebindable in config, for anyone running `swb` inside a tmux that already uses `M-a`.
- **Hover**: approved, with a 500 ms debounce. A setting chooses between `eager` (hover starts pi) and `lazy` (only `w` wakes a session, or Enter).
- **Editor**: one per **directory**, shared by every session whose cwd is that directory. Worktrees therefore get their own editor. Archiving kills the session's pi. If no other open session shares that directory, it also kills the editor.
- **Visit**: a session is seen while it's on the Stage of a focused Deck for at least 1 s, wherever the keyboard focus is.
- **Chrome**: `swb` owns tmux's visible UI elements on both servers. Behavior is still inherited on the sessions server.
- **Names**: ids and tmux names are internal. The user sees the session's title, or its session id when it has no title.
- **Alt+Enter**: fix it through tmux configuration only. Never patch tmux source. Fallback: rebind pi's follow-up key.
- **Process**: Thurston plans to have this built in one autonomous implementation run. Design is front-loaded; mock rounds refine the TUI; then one agent implements the whole design. So every action must be drivable by an agent, and the TUI must be capturable as text.

## Resolution

Resolved with Thurston on 2026-10-06 over four rounds. The Dispatcher, which sent sessions into Ghostty tabs, became the **Deck**. Decisions marked *(assumed)* were made by the charting agent under Thurston's direction to run autonomously; object to any of them by editing this ticket.

### Topology

- **Sessions server** (`tmux -L swb`): hosts managed sessions and editors headless.
  - It starts from a scrubbed environment (`mise -C / hook-env` plus `direnv exec /`, mirroring ansiblonomicon's zshenv `tmux()` wrapper).
  - It loads the user's tmux config for behavior: terminal features, mouse, copy mode, history, root bindings.
  - `swb` then applies its overlay: `set-hook -ga` for `client-focus-in`, `client-focus-out`, and `client-detached`; `focus-events on`; `remain-on-exit off`; `destroy-unattached off`; `exit-unattached off`; `extended-keys always` with the `csi-u` format. It also owns all visible chrome: `status off`, `pane-border-status off`, and titles.
- **UI server** (`tmux -L swb-ui`, *(assumed name)*): owned entirely by `swb` through an embedded config. It holds one disposable **Deck** session per `swb` invocation, with `destroy-unattached on`. Its terminal features follow [the nested-tmux research](../research/nested-tmux-pi-fidelity.md): `tmux-256color`, `extended-keys always` with `csi-u`, `extkeys`/RGB/hyperlinks, `allow-passthrough all`, `focus-events on`, and `escape-time 0`. There's no status bar.
- **No daemon.** The two tmux servers plus the db are the persistent truth. Every Deck renders from the db (`PRAGMA data_version` polling) and from tmux state.
- **Backends**: every tmux call lives in one module of domain-level operations, with no abstraction yet. Expect other backends someday. The escape hatch, if tmux proves inadequate, is libghostty embedding, to be avoided if at all possible.
- `swb` behaves identically inside or outside another tmux. It unsets `$TMUX` for its own clients.

### Deck

- A Deck is a **roster pane** (the pi-tui app) beside a **Stage pane**. The Stage runs a nested client of the sessions server, `env -u TMUX tmux -L swb attach`, and the roster drives it with `switch-client`.
- **Keys**:
  - The roster takes bare keys. Enter moves focus into the Stage, starting pi if needed.
  - The prefix is `M-a`, rebindable. `M-a Tab` toggles focus between roster and Stage, `M-a e` swaps the Stage between pi and the editor, `M-a z` zooms the Stage (focus mode), and `M-a ?` shows help.
  - `M-a M-a` sends a literal `M-a` through to the Stage *(assumed)*. Clicking a pane focuses it.
- **Hover** (setting `hover = "eager" | "lazy"`, default `eager` *(assumed default)*):
  - In eager mode, resting on a dormant **open** row for 500 ms starts its pi in the background. In lazy mode, only `w` or Enter does.
  - The TUI never waits. The Stage shows a loading marker, moving away is instant, and returning after startup snaps to the running session.
  - Archived rows never hover-start. Enter starts them, but only a prompt unarchives.
  - If pi quits while staged, the Stage shows "not running" and does not restart pi until the cursor leaves and returns, or Enter is pressed.
  - Started processes stay running for now; watch performance.
- **Editor**: one per directory. It's its own tmux session on the sessions server, running `$EDITOR` (falling back to `nvim`) in that cwd, and it starts lazily on the first `M-a e`. Swapping switches the Stage client between the pi session and its directory's editor. An `ide`-like split layout (about 65/35) comes later.
- **Visit**: while a session sits on the Stage of a focused Deck, the TUI writes a Visit after 1 s and again when the session leaves the Stage. Deck focus comes from UI-server focus hooks. A session on a focused Stage right now is never unseen. Sessions-server focus hooks still record Visits for plain `tmux attach` viewers.
- **Multiple viewers**: shared by default. tmux supports several clients on one session natively.

### Sessions

- **Managed identity**: `swb` starts pi with a one-time `SWB_MANAGED=1`. The recorder deletes it from `process.env` at load, so spawned children never inherit it. Every session that process hosts is managed, including after `/new`, `/resume`, `/fork`, and `/wt` migration, and the runtime row moves to whichever session is current.
- `swb` unsets `TMUX`/`TMUX_PANE` for pi, so pi-sessions subagents go to the default tmux server as they do today. Directional handoffs are unavailable inside managed sessions until pi-sessions gains an `swb` launch backend (a follow-up).
- **Ids and names**: pi mints session ids. The tmux session for a pi is named `<project>-<4 hex>`, is never renamed, and is mapped through `runtimes.tmux_session`. Editor sessions are named `<dirname>-edit-<4 hex>` *(assumed)*. All of these are internal. The user sees the session's title, or its session id when it has none.
- **Pane process**: `$SHELL -lic 'exec pi …'` in the session's cwd. New sessions run plain `pi`. Resuming runs `pi --session-id <id>` after a cd to `sessions.cwd`. Accepted risk: a missed lookup silently creates an empty session.
- **Never-prompted sessions**: when the last client detaches from a pi's tmux session that has no db row, `swb detached` kills it.
- **Revive**: deleted. A process starts only by hover, `w`, or Enter. The roster shows Dormant as Idle and keeps ⚠ Interrupted.
- **Archive**: from the TUI (with a short undo), `swb archive <id>`, or `/archive`. All three refuse while a turn is running ("turn running: wait for it to complete"). Archiving an idle live session kills its pi immediately (SIGHUP, clean shutdown). If no other open session shares the directory, it also kills that directory's editor. Undo only clears the mark; the next hover or Enter resumes the session.

### Command surface

```text
swb                         open a Deck
swb new [--cwd DIR]         open a Deck with a new session on stage   (also `n` in the roster)
swb open <id>               open a Deck with that session on stage    (what `y` copies)
swb ls [--json]
swb archive|unarchive <id>
swb visit …, swb detached … internal, called by tmux hooks
```

### Agent drivability (requirement)

Every action a human can take must be drivable by an agent with full parity, and the Deck's screen must be capturable as text. *(Assumed mechanism; the design doc pins the exact verbs.)*
- **Driving**: `swb drive start` runs a Deck inside a hidden harness terminal (a private tmux server). `swb drive keys …` types into it through the same path as a human, and `swb drive capture [--ansi]` returns the composited screen of roster plus Stage, the way `capture-pane` does. `swb drive stop` tears it down.
- **State**: every Deck exposes its view state as JSON (cursor, staged session, focus, mode, toasts) through `swb deck state [--json]`.
- **Actions**: all non-UI actions (`new`, `archive`, `unarchive`, `ls`) are CLI verbs.
- The e2e suite from [ticket 13](13-deterministic-pi-e2e.md) is built on the same driver.

### Settings

`${XDG_CONFIG_HOME:-~/.config}/agent-switchboard/config.toml` *(assumed path)*: `hover`, the key bindings (including the prefix), and the editor command.

### Open items carried forward

- **Alt+Enter** arrives as legacy `ESC CR` through two tmux layers. Fix it through tmux configuration only, never by patching tmux; the fallback is rebinding pi's follow-up key.
- **Kitty images** need one passthrough wrap per tmux layer.
- **Deck split layouts.**
- **The pi-sessions `swb` launch backend.**

## Amendment (2026-10-06, Deck mock round 3)

The sessions server no longer inherits the user's tmux config. Its root bindings took keys before pi did, its `window-style` froze pane colors and blocked light/dark switching, and its hooks re-enabled the status bar. `swb` now embeds the whole config: the settings fidelity needs, `prefix None`, and the `M-Enter` correction. So `M-a M-a` delivers a literal `M-a` to pi, as this ticket intended. See [the design doc](../../../designs/01-agent-switchboard.md)'s tmux topology and Theme sections.
