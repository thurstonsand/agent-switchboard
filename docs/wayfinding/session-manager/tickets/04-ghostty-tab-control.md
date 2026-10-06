---
status: closed
type: research
blocked-by: []
---

# Ghostty scripting surface for tab create and focus

## Question

The Dispatcher needs two Ghostty operations GhosttyKit does not expose yet: **open a new tab** with a cwd and command, and **focus an existing terminal** (select its window and tab, focus its split) given the tty a tmux client is attached from. What does Ghostty's macOS scripting surface (the AppleScript dictionary the `ghosttykitd` daemon drives) support for each, and which Ghostty version is required?

- Read GhosttyKit at `~/code/personal/ghosttykit` (`daemon/ghosttykitd/Sources/ghosttykitd/GhosttyControl.swift`, `Requests.swift`, existing `split` and `terminalContext(forTTY:)`) to see how the daemon already maps tty → terminal/tab/window ids and creates splits.
- Check Ghostty's own scripting definitions and docs for new-tab-with-command, select-tab, and focus-terminal, plus the installed Ghostty version on this Mac.
- Does `ide`'s "fresh tab with exactly one terminal" precondition hold for a tab created this way, and is `--wait` tty reporting possible for a new tab as it is for splits.
- Sketch the minimal `gty` CLI surface (names, flags, outputs) that fits the existing command style.

Report only; do not modify GhosttyKit.

## Resolution

Ghostty 1.3.0+ can create a configured one-terminal tab and focus an exact terminal; GhosttyKit should expose `gty new-tab` and `gty focus-terminal`, reusing its tty mapping and spawn rendezvous. See [the findings](../research/ghostty-tab-control.md).
