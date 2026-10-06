---
status: closed
type: research
blocked-by: []
---

# Driving a real pi deterministically for e2e tests

## Question

Thurston's testing standard: no unit tests. Only useful end-to-end tests that exercise real features: a real pi in the `tmux -L sessions` server, the real recorder, the real db, and the real `sessions` CLI and TUI. How can such tests run deterministically, offline, and without spending model tokens?

- Does pi (v0.99.2 source at `~/.cache/pi-source/v0.99.2`) or pi-ai ship a fake or scripted provider ("faux" or similar) usable from the CLI, or can a tiny custom provider extension script turns: plain reply, a tool call, a long-running turn that a test can kill midway, an attention-raising tool?
- How do pi-sessions' smoke tests (`~/code/personal/pi-sessions`, `SMOKE.md`, `vitest.smoke.config.ts`, `test/`) drive real pi sessions in tmux? What can be reused?
- How to drive and assert on a TUI in tmux: `send-keys`, `capture-pane`, waiting for a state. How to simulate reboot (kill the tmux server and pi processes, with the db left intact) honestly.
- How these e2e runs could double as the visual proof Thurston wants (VHS tapes, see [the evidence research](../research/evidence-recording.md)).

## Resolution

Use Pi AI's faux provider through a tiny scenario extension, launch the real interactive Pi and recorder in an isolated tmux server, synchronize on sentinels and durable DB state, and reserve pane captures for visual assertions. Reuse pi-sessions' disposable environment, deadline polling, artifact retention, and cleanup; label server/Pi destruction as simulated process loss, and drive the same harness from versioned VHS tapes. The approach and a successful offline real-Pi proof of concept are in [the findings](../research/deterministic-pi-e2e.md).
