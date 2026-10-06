---
status: closed
type: research
blocked-by: []
---

# Pi lifecycle signals for session state

## Question

What exact Pi (v0.99.2, source at `~/.cache/pi-source/v0.99.2/packages/coding-agent/src`) and pi-sessions signals can a recorder extension use to derive every state axis, and with what race and failure behavior?

- **Activity**: working / blocked / idle. Map `agent_start`, `agent_end`, and `agent_settled` (and whether queued continuations make `agent_end` misleading), plus the `glimpseui:attention:request|resolve` events on `pi.events` emitted by the permission gate and interview tool (see the glimpse-companion extension and design 16 in this repo).
- **Interrupted vs dormant**: what the recorder must persist so that, after the process dies (signal, crash, power loss), a reader can tell "died mid-turn" from "died idle". Which writes must be synchronous.
- **Location**: how a recorder inside pi learns it runs in the `tmux -L sessions` server (`$TMUX`, `tmux display -p`), and its pane/session names.
- **Session identity changes**: `session_start` and `session_shutdown` reasons (`new`, `resume`, `fork`, `reload`, `quit`), `/new` inside a managed pane, and how id replacement should be recorded.
- **Subagent exclusion**: how to recognize a pi-sessions subagent from inside its own process (bootstrap identity, env, tmux socket).
- **Excerpt**: where to get the last user prompt and the last assistant reply cheaply, for the preview pane.
- **Unarchive on turn**: which event marks "a new turn" (user input vs. agent start).
- Whether `ctx.hasUI` and `getSessionFile()` guards from design 15 still hold.

Cite source file:line for each claim.

## Resolution

Use `agent_start`/attention spans/`agent_settled` for Working/Blocked/Idle, persist the in-turn boundary synchronously for Interrupted versus Dormant, identify managed panes by the `tmux -L sessions` socket and subagents by pi-sessions' durable child bootstrap, and unarchive on a user `message_start`. Full evidence, races, identity replacement behavior, excerpt strategy, and guard decisions are in [the findings](../research/pi-lifecycle-signals.md).
