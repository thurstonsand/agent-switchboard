---
status: closed
type: grilling
blocked-by:
  - 7
  - 11
---

# Retiring the recovery tree

## Question

This work happens in ansiblonomicon. Agent Switchboard replaces ansiblonomicon's `sessions` CLI (`bootstrap/capabilities/software/sources/sessions/`) and its recovery tree at `~/.local/state/session-recovery/`. Decide what happens to the existing pieces, including how ansiblonomicon starts installing `swb` (mise `github:thurstonsand/agent-switchboard`) and the pi extension (`git:…@pi`) per [Repo and language for sessions v2](11-repo-and-language.md). This includes the shared `@thurstons/session-recovery` package (rename? fold into the recorder?), the Pi consumer and its `viaSignal` hack, the Claude Code recorder hooks (keep writing the old tree, or remove them while Claude is deferred?), the `session-recovery/config.json` ignored-directories config, `sessions shell` completion, and design 15's status (superseded by the new design). Decide `ide`'s fate too: keep it for work outside `swb`, or retire it in favor of the Deck's editor swap. Include the native `state = "absent"` retirements each removal needs on every affected host.

## Resolution

Resolved with Thurston on 2026-10-06.

- **Retire now.** Don't wait for `swb` to ship. Thurston never used the recovery tree: it was cumbersome, and too many sessions that shouldn't have been recorded ended up in it. The work is delegated to an ansiblonomicon subagent (session `01a11231`).
- **Delete all of it, on every host, including the data**, each piece with a native `state = "absent"` retirement:
  - the Go `sessions` source, its `~/.local/bin/sessions` binary, and pod042's build task
  - `sessions shell` completion
  - the shared `@thurstons/session-recovery` package
  - the Pi consumer extension and its `viaSignal` hack
  - the Claude Code recorder hooks
  - `~/.config/session-recovery/config.json`
  - `~/.local/state/session-recovery/`

  Claude Code support returns later as `packages/claude` in agent-switchboard, writing the new schema.
- **pod042 and other non-Mac hosts** lose session tracking until `swb` ships linux builds, if it ever does.
- **`ide` stays**, for nvim plus shell work outside `swb`; revisit once the Deck's split layout ships. The dead `ide-<name>-<hex>` tmux-name parsing in `tmux.conf`, both gruvbox confs, and nvim's `tmux-status.lua` is removed.
- **Design 15** is marked `Superseded`, with a pointer to agent-switchboard.
- **Installing `swb` later** is the execution plan's final unit, in ansiblonomicon:
  - mise `"github:thurstonsand/agent-switchboard" = "latest"` on both Macs; verify the download isn't quarantined.
  - Work Mac: pi package `git:github.com/thurstonsand/agent-switchboard@pi` in `WORK_PACKAGES`.
  - Personal hosts: an entry in `PERSONAL_PACKAGES`, like Thurston's other pi extensions. That means the local checkout (`agent-switchboard/packages/pi`) on the Mac and the npm package elsewhere; see the npm-release amendment in ticket 11.
- **Testing addition**: the e2e suite must run real sessions, including pi-sessions subagents and handoffs, and prove that the TUI shows them correctly. Subagents must never appear as Sessions.
