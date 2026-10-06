---
status: closed
type: prototype
blocked-by:
  - 11
  - 8
---

# Roster TUI prototype

## Question

Does the roster *feel* right in a real terminal? Build a throwaway prototype on fake in-memory data, using the TUI stack chosen in [Repo and language for sessions v2](11-repo-and-language.md). It should cover mock A (compact) switching to mock C (roster + preview) at a width breakpoint, the three sections (Projects, Inactive by project, Archived flat by recency), glyphs and colors, a cursor that tracks session id across reorders, archive with timed undo, unarchive, `y`/`Y` copy, `/` filter, and a fake "activity tick" that reorders rows live.

Starting point: [the round 2 mocks](../prototypes/round-2-mocks.md). Settle the key map, glyph set, breakpoint, and any layout changes from Thurston's reactions. Keep the prototype on a branch or under `prototypes/`, per the prototype reference.

## Verdicts so far

- 2026-10-06: **Project order is stable, alphabetical by project name.** Sessions within a project sort by most recent activity. This replaces strict newest-activity-first project order, which made whole projects leapfrog on every update.
- 2026-10-06: The preview must show real conversation history, enough to decide whether to dive in. This feeds the Deck discussion in [Launch, hosting, and reopen contract](08-launch-hosting-reopen-contract.md).

## Round 1 (roster-only prototype, 2026-10-06)

A pi-tui 1.0.0 prototype with fake data lives in [prototypes/roster-tui/](../prototypes/roster-tui/README.md). It covers every item in the original question, with A/C/D layout variants and 32 tmux captures.

## Scope expansion (2026-10-06)

[The launch contract](08-launch-hosting-reopen-contract.md) turned the TUI into the **Deck**, so the mocks continue as refinement rounds on the full Deck experience, not just the roster:
- a roster beside a live Stage: a nested tmux client of a scratch sessions server running fake programs or a faux-provider pi
- hover start, with its loading marker and instant navigation away
- `M-a` prefix keys: focus toggle, editor swap, zoom, help
- Stage states: live, loading, not running, archived
- titles instead of ids
- the editor swap

Build it on the agent-drivable harness (`drive start/keys/capture`, `deck state`), so the mocks also prove that mechanism. Thurston reviews each round, and his verdicts accumulate here until the Deck feels right, before the design doc is written.

## Round 2 (Deck mock, 2026-10-06)

The mock is in [prototypes/deck/](../prototypes/deck/README.md) (`bun run deck`, `bun run reset`). It has a real nested Stage, hover start, a placeholder per Deck, the editor swap, and an agent driver (`drive start/keys/capture/state/wait/…`). It produced 38 captures. Measured: 38 ms key-to-Stage repaint through three tmux layers, 0.9 ms roster render, 4.7 ms hover start, and `switch-client` in 0.86 ms over a control-mode client.

Thurston is exploring the mock and will give feedback on his own time. Close this ticket once it's in, or after a round 3 if he asks for one.

## Round 2 feedback (Thurston, 2026-10-06, from playing with it)

- **Highlight to copy** must work in the session pane, as it does with pi directly in Ghostty. It doesn't today; being investigated in round 3.
- **pi is a black box.** Drop the "previous turn was interrupted" notice; `swb` never alters pi's own screen, apart from the extension's footer status.
- **The word "stage"** reads badly. Its intended meaning, the right-hand pane showing the selected session live, is under discussion. Interim: the UI never shows it, and the Enter hint says `⏎ focus`.
- **Lazy wake is the default** (explicit `w`). Eager stays as a setting.
- **Clicking a header** expands or collapses it.
- **Archived is an inline accordion**, not its own view.
- **`h`/`l` move focus.** `M-a h` goes from the session to the roster, and `l` in the roster focuses the session; Tab still works.
- **`a` toggles** archive and unarchive. `U` goes away.
- **The blocked glyph flashes** in the glimpse companion's attention purple, `#c084fc`.
- **Theme**: the pi pane rendered dark on a light-theme Mac and ignored his terminal colors. Being investigated in round 3 (tmux's handling of OSC 10/11/4 queries in the nested topology).

Round 3 runs as subagent `01a1127b`.

## Round 3 (Deck mock, 2026-10-06)

Round 3 rebuilt [prototypes/deck/](../prototypes/deck/README.md) with every round-2 verdict and ran two investigations. Its 57 captures cover the new behavior.

- **Copy by highlighting**: the UI server's default `set-clipboard external` dropped the inner server's OSC 52. `set -s set-clipboard on` there fixes it. In pi's fullscreen mode the drag reaches pi, which copies natively; in regular mode the sessions server's copy mode copies. Both put the right text on the clipboard.
- **Theme**: round 2's fake pi hard-coded dark colors. Underneath, the user's gruvbox `window-style` on the sessions server answered pi's background query with a color frozen at server start, and blocked live light/dark switching. tmux 3.7c relays the real terminal's colors through both layers once nothing paints pane backgrounds, Stage clients attach after the outer client, and the roster re-queries on every 997.

## Round 3 feedback (Thurston, 2026-10-06)

- **"Stage" is internal only.** The UI never names the right-hand side; "on view" goes too.
- **tmux is an execution engine.** People shouldn't interact with it directly. So the sessions server loads only an embedded config, with no prefix and no key bindings beyond the `M-Enter` correction. That reverses ticket 08's inherited user config. Removing his own tmux theme's `window-style` lines was tried and reverted: they're what answers color queries from detached panes, such as pi-sessions subagents, which went dark without them. The same gap shaped the design: the roster mirrors the terminal background into the sessions server and refreshes it on every 997.
- **`h`/`l`**: `h` on an expanded header collapses it, and does nothing on a collapsed header or a session row. `l` on a session row is Enter.
- **No `u`.** `a` toggles both ways.
- **The dormant card shows the whole conversation**: every prompt and every text reply, newest at the bottom, cropped from the top. Tool-call summaries may come later.
- **Reap** idle live pis that nobody is viewing after a configurable `reap_after`, 30 minutes by default.
- **Enter on a dormant session takes the keyboard** onto the loading card, and pi gets it once ready. `esc` backs out to the roster without stopping the wake, as if `w` had been pressed. `w` never takes the keyboard, and `esc` is never bound once pi has it.
- **Views**: the 65/35 editor-and-pi split comes in now, beside the pi and editor swap. Each session remembers the view it was left on.

## Resolution

The Deck feels right. Every verdict above is folded into [the design doc](../../../designs/01-agent-switchboard.md), which the implementing agent treats with the round-3 mock as the visual reference. Two checks still need Thurston's real Ghostty and are owed before release, not before implementation: a real drag and shift+drag in both pi modes, and a macOS light/dark flip in a live Deck.
