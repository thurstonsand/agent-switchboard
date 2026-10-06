---
status: closed
type: research
blocked-by: []
---

# TS TUI and single-binary options on the work Mac

## Question

If `sessions` were rewritten in TypeScript to share code with the Pi recorder, what would it be built on, and how would it ship?

- **TUI libraries**: `@earendil-works/pi-tui` (Pi's own TUI library: is it usable standalone?), OpenTUI, Ink, and any others worth naming. Compare maturity, full-screen and alt-screen support, mouse support, resize handling, width-responsive layout, and how each runs under Bun.
- **Single executable**: `bun build --compile` (the installed Pi is itself a compiled Bun binary). Startup latency for a CLI invoked from tmux hooks (`sessions visit` runs on every focus change), binary size, `bun:sqlite` inside a compiled binary, and macOS signing or quarantine issues.
- **Work Mac availability**: whether these packages and Bun resolve through the work npm mirror or Artifactory. Check the agent-harness npm-mirror shim in this repo for how Pi packages get installed there.
- **Go baseline**: `sessions visit` startup latency for the existing Go binary, for comparison.

Measure startup latency on this machine with throwaway builds under `/tmp`.

## Resolution

TypeScript is viable. If ticket 11 selects it, use `@earendil-works/pi-tui` standalone and ship an arm64 `bun build --compile` executable; compiled `bun:sqlite` works, startup is close to Go, and local ansiblonomicon installation avoids Gatekeeper distribution concerns. Current pi-tui 0.99.2 is not yet on the work mirror, so TypeScript remains conditional on mirroring that release rather than pinning the stale 0.87.1 available there. OpenTUI is a capable pre-1.0 alternative but is absent from Artifactory; Ink lacks mouse support.

See [the research](../research/ts-tui-and-binary-options.md).
