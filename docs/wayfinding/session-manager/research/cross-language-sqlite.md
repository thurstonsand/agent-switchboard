# Cross-language SQLite

## Answers

- **One database is safe, but the standing driver choice is not executable as written on the work Mac.** The installed Pi 0.99.2 is a compiled Bun 1.3.14 executable that reports Node compatibility version `v24.3.0`; its extension runtime cannot resolve `node:sqlite`. It can and already does use `bun:sqlite`. Use a tiny runtime adapter—`bun:sqlite` when `process.versions.bun` exists, otherwise `node:sqlite`—against the same database as `modernc.org/sqlite`, or deliberately replace the work-Mac Pi executable with a Node-hosted installation. Do not specify `node:sqlite` unconditionally.
- **WAL interoperability is sound.** Node 24.21.0 `node:sqlite`, Pi's Bun `bun:sqlite`, and `modernc.org/sqlite` v1.60.1 exchanged writes on this Mac. The standalone Node and modernc drivers both report SQLite 3.53.4. WAL has a defined cross-platform format and permits concurrent readers, but still only one writer. Configure every connection with a busy timeout and use immediate transactions for read-modify-write operations.
- **Use `PRAGMA data_version` polling, not filesystem notifications.** Keep one Go connection alive and compare values from that same connection every 250 ms while the TUI is active. This gives at most roughly 250 ms external-update latency, is explicitly the SQLite mechanism for interactive displays, and avoids following a `-wal` file that SQLite recycles and deletes. Update the model directly after the Go process's own writes because `data_version` deliberately does not change for commits on the same connection.
- **Location:** `${XDG_STATE_HOME:-$HOME/.local/state}/sessions/sessions.db`. Create `sessions/` as `0700`; create the database as `0600`. The directory is the durable security boundary for SQLite's transient `-wal` and `-shm` siblings.
- **pod042 remains unverified and does not affect the work-Mac decision.** Its declaration installs Node `lts` and the npm Pi package, rather than the compiled Pi artifact used here (`bootstrap/targets/pod042/operator/mise.toml:1-2`, `bootstrap/targets/pod042/operator/node-packages.toml:1-7`). `ssh pod042` from the work Mac failed DNS resolution, so no live runtime claim is possible.

## Runtime and loader evidence

On 2026-10-05, a throwaway extension loaded by the actual work-Mac `pi` executable recorded:

```json
{
  "node": "v24.3.0",
  "execPath": "/Users/tsandberg/.local/share/mise/installs/github-earendil-works-pi/0.99.2/pi/pi",
  "bun": "1.3.14"
}
```

The running process's executable was the same 77 MB Mach-O binary. A static `import { DatabaseSync } from "node:sqlite"` and a `createRequire(...)("node:sqlite")` both failed during extension loading with `ResolveMessage: No such built-in module: node:sqlite`. Selecting `bun:sqlite` through `createRequire` opened a database and returned a row without stderr. Pi's loader creates Jiti with embedded virtual modules and `tryNative: false`, then imports the extension through it (`~/.cache/pi-source/v0.99.2/packages/coding-agent/src/core/extensions/loader.ts:560-574`); loader errors become extension diagnostics (`loader.ts:627-648`). Static `node:sqlite` therefore fails before extension initialization in this distribution.

The machine's shell Node is mise-managed 24.21.0 at `~/.local/share/mise/installs/node/24.21.0/bin/node`. A direct `require("node:sqlite")` worked without a flag and emitted no warning. Node removed the feature flag in 22.13.0 and marks the module release-candidate as of 24.15.0; Node's built-in timeout option defaults to zero ([Node SQLite documentation](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlite), [constructor options](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#new-databasesyncpath-options)). Thus a Node-hosted Pi on current Node 24 needs neither a flag nor warning suppression. On an older Node release that still emits the experimental warning, `NODE_OPTIONS=--disable-warning=ExperimentalWarning` is the narrowest supported switch, though it suppresses every warning of that type, not only SQLite ([Node CLI documentation](https://nodejs.org/docs/latest-v24.x/api/cli.html#--disable-warningcode-or-type)); `--no-warnings` is unnecessarily broad.

pi-sessions is useful deployed precedent rather than merely similar code:

- it detects Bun through `process.versions.bun`, uses `createRequire`, selects `bun:sqlite` under Bun and `node:sqlite` otherwise (`~/code/personal/pi-sessions/extensions/shared/session-index/sqlite.ts:1-5`, `:38-46`);
- it sets a 5 s busy timeout, enables foreign keys, selects WAL, and currently uses `synchronous=NORMAL` (`sqlite.ts:48-80`);
- its transaction wrapper issues `BEGIN IMMEDIATE` (`sqlite.ts:101-125`);
- its package requires Node 24 and Pi loads its TypeScript entry directly (`~/code/personal/pi-sessions/package.json:18-29`).

This adapter shape is the loader-safe choice for the new recorder. There is no external SQLite dependency to resolve from Jiti.

## WAL, locking, and failure behavior

SQLite owns the on-disk contract, not either binding. In WAL mode readers and a writer can proceed concurrently, all processes must be on the same host, and there can be only one writer because there is one WAL ([SQLite WAL overview](https://sqlite.org/wal.html#overview), [concurrency](https://sqlite.org/wal.html#concurrency)). The WAL format is precisely defined and cross-platform; the WAL is persistent database state after an unclean exit ([WAL persistence](https://sqlite.org/wal.html#persistence_of_wal_mode)). `modernc.org/sqlite` is a CGo-free `database/sql` port, and v1.60.1 supports Darwin arm64 with SQLite 3.53.4 ([modernc package documentation](https://pkg.go.dev/modernc.org/sqlite@v1.60.1#hdr-Overview), [supported platforms](https://pkg.go.dev/modernc.org/sqlite@v1.60.1#hdr-Supported_platforms_and_architectures)). The work proxy returned v1.60.1 metadata and its module zip with HTTP 200 from `https://go-proxy.crwd.dev`.

Recommended connection policy:

1. During schema initialization, execute `PRAGMA journal_mode=WAL` and assert the returned mode is `wal`. WAL mode persists across later connections ([SQLite `journal_mode`](https://sqlite.org/pragma.html#pragma_journal_mode)).
2. Set a 5 s busy timeout on **every** connection. Node 24 can use `new DatabaseSync(path, { timeout: 5000 })`; the runtime adapter can instead issue `PRAGMA busy_timeout=5000` for both Node and Bun. For modernc, put `_busy_timeout=5000` in the fixed URI DSN so `database/sql` applies it to every pooled connection; `_pragma` and `_txlock` are also supported connection parameters ([modernc `Driver.Open`](https://pkg.go.dev/modernc.org/sqlite@v1.60.1#Driver.Open)). A one-time `db.Exec("PRAGMA …")` is insufficient if Go later opens another pooled connection.
3. Use `BEGIN IMMEDIATE` for recorder and command mutations that read before writing. A deferred transaction can start as a read and then fail its write upgrade with `SQLITE_BUSY`; immediate acquires the write transaction at the start ([SQLite transaction modes](https://sqlite.org/lang_transaction.html#deferred_immediate_and_exclusive_transactions)). On Go, `_txlock=immediate` makes `database/sql` transactions begin this way. Keep transactions short and perform no tmux, process, or network work inside them.
4. Prefer `synchronous=FULL` for this low-write-rate lifecycle database. FULL is durable in WAL mode across OS crash/power loss; NORMAL remains consistent but can lose a committed transaction after OS crash or power failure. Both preserve transactions across an application-only crash ([SQLite `synchronous`](https://sqlite.org/pragma.html#pragma_synchronous)). The experiment below validates process death, not power removal.
5. Enable `foreign_keys=ON` on every connection. Bound the Go pool; the modernc maintainers specifically warn that `database/sql` is unlimited by default and periodic queries can accumulate, recommending `SetMaxOpenConns` and at most one outstanding periodic query ([modernc performance notes](https://pkg.go.dev/modernc.org/sqlite@v1.60.1#hdr-Performance)). One connection is sufficient for this TUI's workload.

A `/tmp` Go module using `modernc.org/sqlite@v1.60.1` and a Node 24.21 script exercised one shared WAL database:

- Node committed a row, modernc read it and committed another, and Node read both; `PRAGMA integrity_check` returned `ok`.
- Node held `BEGIN IMMEDIATE`; a modernc writer waited rather than returning busy. Killing Node with `SIGKILL` after about 700 ms caused its uncommitted row to disappear, modernc completed after 744 ms, and integrity remained `ok`.
- The reverse test killed modernc while it held an uncommitted write. Node completed after 671 ms, the Go row disappeared, and integrity remained `ok`.
- A Pi-loaded `bun:sqlite` extension committed a row to a second WAL database; modernc appended a row; the same Pi extension read both. Pi emitted no stderr.

This matches SQLite's commit design: a transaction commits only when its commit record reaches the WAL, and the first opener after a crashed last connection performs recovery under an exclusive lock ([WAL operation](https://sqlite.org/wal.html#how_wal_works), [sometimes queries return `SQLITE_BUSY`](https://sqlite.org/wal.html#sometimes_queries_return_sqlite_busy)). A busy timeout is needed during that recovery window too.

## Change detection

`PRAGMA data_version` is designed for interactive programs deciding whether to refresh displayed state. Two reads on the same connection differ after another connection—including one in another process—commits; values from different connections must not be compared, and same-connection commits do not change its value ([SQLite `data_version`](https://sqlite.org/pragma.html#pragma_data_version)). Therefore:

- reserve or retain one Go connection for polling;
- read and store its initial `data_version`;
- every 250 ms, issue one new read only after the prior read has returned;
- on change, reload the roster in one query and replace the model while retaining selection by session id;
- after a Go-owned mutation, update/reload immediately rather than waiting for `data_version`.

In the scratch test a modernc poller with a 100 ms interval noticed a Node commit after 101.27 ms. Ten thousand serial `PRAGMA data_version` reads took 41.7 ms, or 4.17 µs each. At 250 ms, four reads consume about 17 µs of query CPU per second on this machine; timer wakeups dominate but remain negligible. These are measurements, not latency guarantees under machine load.

Watching `sessions.db-wal` is more machinery and less faithful. SQLite normally recycles the WAL near 1000 pages, deletes `-wal` and `-shm` when the last connection closes, and may retain the WAL after an unclean exit ([SQLite WAL file lifecycle](https://sqlite.org/wal.html#avoiding_excessively_large_wal_files)). A correct watcher must therefore watch the parent directory, filter several file events, survive deletion/recreation, debounce commits, and still query the database. fsnotify itself advises watching the parent directory because replacement loses a file watcher ([fsnotify FAQ](https://github.com/fsnotify/fsnotify#watching-a-file-doesnt-work-well)). Polling the database's own change indicator is both cheaper to implement and semantically exact.

## State path and permissions

The XDG specification assigns restart-persistent, machine-local application state to `$XDG_STATE_HOME`, defaulting to `$HOME/.local/state`, and directs applications to create missing destination directories with mode `0700` ([XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/#basics), [defaults and state semantics](https://specifications.freedesktop.org/basedir-spec/latest/#variables), [directory creation](https://specifications.freedesktop.org/basedir-spec/latest/#referencing)). Use:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/sessions/sessions.db
```

Create the application directory before opening SQLite and fail if that cannot be done. Use `0700` for the directory and `0600` for the database. A scratch database created under the ordinary work-Mac umask appeared as `0644`, so the implementation must not assume SQLite chooses private file permissions. The private directory protects `sessions.db`, `sessions.db-wal`, and `sessions.db-shm` together; never copy or move the database separately from a retained WAL because committed transactions can live there ([SQLite WAL persistence](https://sqlite.org/wal.html#persistence_of_wal_mode)).

## Uncertainties

- pod042's live Node and Pi runtime could not be reached. Its checked-in declarations imply a Node-hosted npm Pi, but the installed versions, `node:sqlite` warning behavior, and drift from declaration remain unknown.
- The experiments covered bidirectional writes, lock waiting, and application `SIGKILL`, not sustained contention, disk-full behavior, kernel panic, or physical power loss. Those are implementation-test concerns; they do not change SQLite's documented transaction contract.
- The work-Mac finding contradicts the map's literal `node:sqlite` wording. The database architecture survives; the recorder driver must be runtime-native (`bun:sqlite` here) unless Pi's installation method changes.
