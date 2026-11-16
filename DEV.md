# DEV.md

## Setup

```sh
mise trust && mise bootstrap
```

## Commands

Always prefer mise tasks over running tools directly; `mise tasks` lists and describes every one. `mise run check` is the full verification gate.

## Layout

- `packages/cli`: the `swb` CLI and TUI (pi-tui). May take any dependency, pending approval from the user.
- `packages/lines/pi`: the pi extension that plugs a managed pi into swb. Use dependencies judiciously. Pi provides `@earendil-works/*` and `typebox` at runtime, so they are peer dependencies, never bundled.
- `packages/lines/claude/plugin`: the Claude Code plugin with a mod, which `swb` embeds. `claude plugin validate` must pass on it.
- `packages/cli/src/codex`: the Codex line, compiled into `swb`.
- `packages/shared`: anything that should be shared between packages.
- tmux server: `tmux -L swb`, suffixed `-<SWB_INSTANCE>` when that is set, as tests always do.

## Elsewhere

- The e2e suite's workers, shards, pinned harnesses, and faux provider: `test/e2e/README.md`
- Timing what a person or agent waits for (`mise run perf`, `SWB_TRACE`): `test/perf/README.md`
- Where swb keeps its state on disk, the slow db call log among it: `docs/data-locations.md`

## Code style

- Name tools and args for the call you want the model to make; the name outweighs its description. snake_case for both.
- `swb` owns the schema and its migrations; a line only asserts the exact version it expects
- Every line shares one way to record, read messages, and describe its tools, in `@swb/shared`; none keeps its own copy
- Store facts, derive states: Live, Cut off, Unseen, Inactive, Snoozed, and Archived are computed at read time, never persisted. A state a SQL query asks about is defined once, in `@swb/shared/states`; queries use that, never their own copy
- The roster's thread never waits on the disk or a process

## Testing

- **Never write unit tests.** Every test is an end-to-end test of a real workflow: real interactive pi, Claude Code, and Codex inside private tmux servers, the real lines, db, and `swb`. That includes real pi-sessions subagents and handoffs.
- Drive the Deck the way a human would, through `swb drive` (keys in, screen captured out) and `swb deck state --json`
- Every change ships with visual proof I can look at: a VHS recording (`mise run evidence`), or a PNG from a tape's `Screenshot` command.
