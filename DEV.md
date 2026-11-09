# DEV.md

## Setup

```sh
mise trust && mise bootstrap
```

## Commands

Always prefer mise tasks over running tools directly.

```sh
mise run check          # full verification gate
mise run e2e            # real pi in a private tmux server, scripted by the faux provider
mise run e2e:soak       # e2e tests again and again with every CPU busy, counting failures; `-- --help` for options
mise run install        # build swb from this checkout into ~/.local/bin
mise run dist:pi        # build the pi extension bundle exactly as the release publishes it
mise run release:check  # build every release artifact into a scratch dir and smoke-test this host's binary
mise run release X.Y.Z  # release a green, pushed main: changelog, version, commit, tag, push
mise run evidence       # render the VHS tapes in test/e2e/tapes to test/e2e/artifacts/phase6/videos
mise run perf           # time what a person waits for, on real harnesses; `-- --help` for options
mise run perf:compare   # two results files side by side
mise run eval:search    # replay this machine's recorded session_search calls against this checkout's ranker
mise run eval:compare   # two eval runs, the latest two by default
```

`mise run e2e` parallelizes test files and runs latency tests separately. Use `SWB_E2E_JOBS` to override local concurrency. CI runs serial tests within parallel shards; reproduce one with `SWB_E2E_SHARD=2/6 mise run e2e`. Don't set `CI=1` for routine local testing: without a shard, it serializes the entire suite.

Some scenarios install pi-sessions and pi-wt from `node_modules`, at the versions bun.lock pins; point `SWB_E2E_PI_SESSIONS` or `SWB_E2E_PI_WT` at a checkout to test another. Every scenario runs pi, Claude Code, and Codex from `node_modules`, at the exact versions package.json pins, never the host's own installs, so every machine and CI test the same harnesses; `SWB_E2E_PI_CLI` points pi at a checkout instead. Claude Code and Codex run against fake model servers in `test/e2e/fakes`, which log every request they answer.

## Performance

`mise run perf` runs the probes in `test/perf/suites`. Each one is something a person or an agent waits for: opening a Deck, a keystroke in the roster, starting or waking a session in each harness, a message reaching its recipient. Every probe types into a real terminal (a tmux pane at a shell prompt) and times the screen through a control-mode client, from the key going in to the last output before the screen went still. Each probe takes several samples, writes `test/perf/results/<date>-<sha>.json` with an HTML report beside it, and prints a table and the slowest probes.

- `--only deck,start.claude` narrows the run; `--list` shows every probe and what it measures
- `--against main` builds main in a scratch worktree and interleaves its samples with this checkout's, so a change's cost comes out of one run on one machine; `--baseline FILE` compares with an earlier run instead
- `SWB_TRACE=FILE` makes every swb process and line append marks and spans (`@swb/shared/trace`) to FILE. The runner sets it, and its reports show what filled each probe. Add a span where a probe's time goes unexplained

## Layout

- `packages/cli`: the `swb` CLI and TUI (pi-tui), compiled with `bun build --compile` to one binary per release target (linux-x64, darwin-arm64). May take any dependency.
- `packages/lines/pi`: the pi line, the pi extension that plugs a managed pi into swb. Use dependencies judiciously. Pi provides `@earendil-works/*` and `typebox` at runtime, so declare them as `"*"` peer dependencies and never bundle them.
- `packages/lines/claude/plugin`: the Claude Code line, a plugin with a mod. `swb` embeds it and writes it to `${state}/lines/claude` at every Claude launch, with the tool contracts as `hooks/tools.js`. Its manifest runs `swb mcp --harness claude` to list the tools, so Claude runs read-only ones in parallel, and the mod answers every call. `claude plugin validate` must pass on that directory: it only accepts `$` passed to top-level functions.
- `packages/cli/src/codex`: the Codex line, compiled into `swb`: `swb __codex` hosts a session on a private app-server, and its tools run in `swb mcp` (`packages/cli/src/mcp.ts`), the MCP server Claude Code's line lists them from too. Codex loads it from a `[mcp_servers.swb]` that swb adds to Codex's `config.toml`, switched off, whenever it finds Codex and it isn't there; only swb's own app-servers switch it on, with `-c`.
- `packages/shared`: schema version, row types, db path, connection policy, anything that should be shared between packages.
- The `pi` branch is generated. The tag-driven release workflow overwrites it wholesale with the bundled extension. Never edit it by hand.

## Data locations

- Database: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/swb.db` (directory `0700`, file `0600`)
- Slow db calls: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/db-waits.jsonl`, one JSON line per call to swb.db or recall.db that took 200 ms or more or ran out `busy_timeout`, from any swb process or line: who waited, the op (`begin` is the wait for the write lock, `tx` how long it was then held), and the SQL's start. `jq` it before deciding the db needs anything
- Settings: `${XDG_CONFIG_HOME:-~/.config}/agent-switchboard/config.toml`; unknown keys are an error. Each setting is declared once, in `SETTINGS` in `packages/cli/src/config.ts`, which the Settings pane and README's block (`mise run readme`) both read
- Search index: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/recall.db`, every Session's transcripts and its subagents' in FTS5, rebuilt from them whenever its own version moves, so it never migrates. Each search catches up on what changed, and the clock keeps it warm
- Catalog: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/catalog.json`, what each harness can start and the models it offers; `locks/catalog.db` lets one swb at a time read the model lists
- Operator folder: `${XDG_CONFIG_HOME:-~/.config}/agent-switchboard/operator`. Every Deck rewrites its `AGENTS.md`, `CLAUDE.md`, `.pi/extensions/operator.js`, and `.pi/settings.json` from the copies swb ships, with `operator.instructions` after the shipped AGENTS.md, and again whenever that setting changes; Claude Code and Codex Operators get the rest of their limits as launch flags
- Deck layout: the `deck_layout` table, one row: the cursor, folds, and roster width the Deck starts from when its server does
- Drafts: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/drafts/<session_id>`, an unsent prompt saved when an upgrade stops its pi
- Deck socket: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/deck.sock`
- tmux server: `tmux -L swb`, suffixed `-<SWB_INSTANCE>` when that is set. Tests always set it. Each session has a tmux session of its own, and the Deck is the `deck` session: the Stage swaps a session's pane into one of its slots, tagged `@swb_slot`, leaving a stand-in in its place, so a pane is always found by its `@swb_home`, never by the session it sits in. The `swb-ctl` pane runs the clock, `swb __clock`, which any swb respawns if it's dead or another build, as it does the Deck's roster

## Code style

- TypeScript on Bun; use `.ts` extensions for repo-local imports
- Name tools and args for the call you want the model to make; the name outweighs its description. snake_case for both.
- `swb` owns all DDL and migrations through `PRAGMA user_version`; a line only asserts the exact version
- Every line records through `@swb/shared/record` and reads messages through `@swb/shared/mailbox`; the tool contracts live once, in `@swb/shared/tools`
- Store facts, derive states: Live, Interrupted, Unseen, Inactive, Snoozed, and Archived are computed at read time, never persisted. A state a SQL query asks about (archived, open, a pending message or schedule) is defined once in `@swb/shared/states`; queries use that, never their own copy
- The roster's thread never waits on the disk or a process: it uses `tmuxAsync`, its control client, async fs, or the worker. `packages/cli/src/deck/main-thread.grit` fails the lint on a `*Sync` call or a synchronous tmux, config, or directory helper there; each exception carries a `biome-ignore lint/plugin` saying why

## Testing

- **Never write unit tests.** Every test is an end-to-end test of a real workflow: real interactive pi, Claude Code, and Codex inside private tmux servers, the real lines, db, and `swb`. That includes real pi-sessions subagents and handoffs, which must never appear as Sessions
- Drive the Deck the way a human would, through `swb drive` (keys in, screen captured out) and `swb deck state --json`
- A new or changed test passes `mise run e2e:soak -- --runs 10 -- <file> -t <name>`, which runs it with every CPU busy, before it lands. Passing once on an idle machine proves little
- pi-ai's faux provider, registered by a scenario extension, scripts turns offline at zero token cost
- Every change ships with visual proof I can look at: a VHS recording (`mise run evidence`), or a PNG from a tape's `Screenshot` command. Don't render GIFs, whose ffmpeg pass runs out of memory. Text captures and `capture-pane` output are for assertions; I read them, but I'd much rather see an image
