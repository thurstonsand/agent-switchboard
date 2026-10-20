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
mise run install        # build swb from this checkout into ~/.local/bin
mise run dist:pi        # build the pi extension bundle exactly as the release publishes it
mise run release:check  # build every release artifact into a scratch dir and smoke-test this host's binary
mise run evidence       # render the VHS tapes in test/e2e/tapes to test/e2e/artifacts/phase6/videos
mise run perf           # time what a person waits for, on real harnesses; `-- --help` for options
mise run perf:compare   # two results files side by side
```

Some scenarios install pi-sessions and pi-wt from `node_modules`, at the versions bun.lock pins; point `SWB_E2E_PI_SESSIONS` or `SWB_E2E_PI_WT` at a checkout to test another. Scenarios for Claude Code and Codex run the host's npm-global installs against fake model servers in `test/e2e/fakes`, which log every request they answer.

## Performance

`mise run perf` runs the probes in `test/perf/suites`. Each one is something a person or an agent waits for: opening a Deck, a keystroke in the roster, starting or waking a session in each harness, a message reaching its recipient. Every probe types into a real terminal (a tmux pane at a shell prompt) and times the screen through a control-mode client, from the key going in to the last output before the screen went still. Each probe takes several samples, writes `test/perf/results/<date>-<sha>.json` with an HTML report beside it, and prints a table and the slowest probes.

- `--only deck,start.claude` narrows the run; `--list` shows every probe and what it measures
- `--against main` builds main in a scratch worktree and interleaves its samples with this checkout's, so a change's cost comes out of one run on one machine; `--baseline FILE` compares with an earlier run instead
- `SWB_TRACE=FILE` makes every swb process and line append marks and spans (`@swb/shared/trace`) to FILE. The runner sets it, and its reports show what filled each probe. Add a span where a probe's time goes unexplained

## Layout

- `packages/cli`: the `swb` CLI and TUI (pi-tui), compiled with `bun build --compile` to one binary per release target (linux-x64, darwin-arm64). May take any dependency.
- `packages/lines/pi`: the pi line, the pi extension that plugs a managed pi into swb. Use dependencies judiciously. Pi provides `@earendil-works/*` and `typebox` at runtime, so declare them as `"*"` peer dependencies and never bundle them.
- `packages/lines/claude/plugin`: the Claude Code line, a plugin with a mod. `swb` embeds it and writes it to `${state}/lines/claude` at every Claude launch, with the tool contracts as `hooks/tools.js`. `claude plugin validate` must pass on that directory: it only accepts `$` passed to top-level functions.
- `packages/cli/src/codex`: the Codex line, compiled into `swb`: `swb __codex` hosts a session on a private app-server, and `swb mcp` serves the tools through the MCP SDK. Codex loads it from a plugin swb writes into `$CODEX_HOME/plugins/cache/swb` and only its own app-servers enable.
- `packages/shared`: schema version, row types, db path, connection policy, anything that should be shared between packages.
- The `pi` branch is generated. The tag-driven release workflow overwrites it wholesale with the bundled extension. Never edit it by hand.

## Data locations

- Database: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/swb.db` (directory `0700`, file `0600`)
- Settings: `${XDG_CONFIG_HOME:-~/.config}/agent-switchboard/config.toml`; unknown keys are an error. Each setting is declared once, in `SETTINGS` in `packages/cli/src/config.ts`, which the Settings pane and README's block (`mise run readme`) both read
- Catalog: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/catalog.json`, what each harness can start and the models it offers; `catalog.lock` lets one swb at a time read the model lists
- Operator folder: `${XDG_CONFIG_HOME:-~/.config}/agent-switchboard/operator`. Every Deck rewrites its `AGENTS.md`, `CLAUDE.md`, `.pi/extensions/operator.js`, and `.pi/settings.json` from the copies swb ships; Claude Code and Codex Operators get the rest of their limits as launch flags
- Deck layout: the `deck_layouts` table, one row per Project root: the cursor, folds, and roster width the next Deck there starts from
- Drafts: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/drafts/<session_id>`, an unsent prompt saved when an upgrade stops its pi
- Deck sockets: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/decks/<deck>.sock`
- tmux servers: `tmux -L swb` (sessions) and `tmux -L swb-ui` (Decks), each suffixed `-<SWB_INSTANCE>` when that is set. Tests always set it. The sessions server's `swb-ctl` pane runs the clock, `swb __clock`, which any swb respawns if it's dead or another build

## Code style

- TypeScript on Bun; use `.ts` extensions for repo-local imports
- `swb` owns all DDL and migrations through `PRAGMA user_version`; a line only asserts the exact version
- Every line records through `@swb/shared/record` and reads messages through `@swb/shared/mailbox`; the tool contracts live once, in `@swb/shared/tools`
- Store facts, derive states: Live, Interrupted, Unseen, Inactive, Snoozed, and Archived are computed at read time, never persisted

## Testing

- **Never write unit tests.** Every test is an end-to-end test of a real workflow: real interactive pi, Claude Code, and Codex inside private tmux servers, the real lines, db, and `swb`. That includes real pi-sessions subagents and handoffs, which must never appear as Sessions
- Drive the Deck the way a human would, through `swb drive` (keys in, screen captured out) and `swb deck state --json`
- pi-ai's faux provider, registered by a scenario extension, scripts turns offline at zero token cost
- Every change ships with visual proof I can look at: a VHS recording (`mise run evidence`), or a PNG from a tape's `Screenshot` command. Don't render GIFs, whose ffmpeg pass runs out of memory. Text captures and `capture-pane` output are for assertions; I read them, but I'd much rather see an image
