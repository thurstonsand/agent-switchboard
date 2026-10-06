---
status: closed
type: task
blocked-by:
  - 4
---

# GhosttyKit tab and focus commands

## Question

Thurston adds the two GhosttyKit commands the Dispatcher needs, using the surface sketched in [Ghostty scripting surface for tab create and focus](04-ghostty-tab-control.md): open a new tab with cwd and command, and focus the terminal attached to a given tty. This is HITL: Thurston implements in `~/code/personal/ghosttykit`. This ticket tracks it and records the released version and final CLI shape that later tickets depend on.

## Inputs

- Proposed surface, from [the Ghostty research](../research/ghostty-tab-control.md): `gty new-tab --cwd … --command … [--tty …] [--wait]` (with `--wait`, it reuses the spawn-claim rendezvous and prints the new tty) and `gty focus-terminal --tty … [--wait]`. Requires Ghostty 1.3.0+.
- Harden the shared rendezvous while you're in there. The research found that `split`'s existing tty rendezvous may race, because escrow happens after creation returns, and `new-tab --wait` would inherit that race.

## Resolution

Dropped from this effort on 2026-10-06. The Deck runs entirely on tmux, so `swb` needs nothing from Ghostty or GhosttyKit (see [Launch, hosting, and reopen contract](08-launch-hosting-reopen-contract.md)). Thurston may still build these commands for other reasons, outside this effort.
