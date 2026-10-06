---
status: closed
type: research
blocked-by: []
---

# Cross-language SQLite on the work Mac

## Question

Can a Pi extension (TypeScript, loaded by pi's jiti under its Node runtime) and the Go `sessions` binary (`modernc.org/sqlite`) safely share one SQLite db?

- Which Node version runs pi on the work Mac and on pod042 (mise-managed? bundled?), and is `node:sqlite` available there without flags. Does it print an ExperimentalWarning into pi's TUI, and how would that be suppressed?
- Does WAL mode interoperate between the two drivers. Busy-timeout behavior, `BEGIN IMMEDIATE`, and what happens when pi is killed mid-transaction.
- Cheapest way for the Go TUI to notice changes made by other processes: `PRAGMA data_version` polling, fsnotify on the `-wal` file, or something else. Latency and CPU cost.
- Any jiti or pi-loader gotchas with importing `node:sqlite` from an extension. Do any existing pi extensions or packages do it (pi-sessions uses SQLite for its index: check how, and with which driver).
- Recommended db location (XDG state) and file permissions.

Primary sources only (Node docs, SQLite docs, modernc source, pi source). Verify on this machine where possible with a throwaway script in `/tmp`.

## Resolution

One WAL database is safe across the JavaScript and Go drivers, with per-connection busy timeouts, immediate write transactions, and `PRAGMA data_version` polling. The installed work-Mac Pi is a compiled Bun runtime and cannot load `node:sqlite`, so its recorder must use the same runtime adapter as pi-sessions (`bun:sqlite` here, `node:sqlite` under Node) unless Pi's installation changes. See [the findings](../research/cross-language-sqlite.md).
