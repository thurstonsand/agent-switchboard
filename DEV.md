# DEV.md

## Setup

```sh
mise trust && mise bootstrap
```

## Commands

Always prefer mise tasks over running tools directly.

```sh
mise run check      # full verification gate
mise run e2e        # real pi in a private tmux server, scripted by the faux provider
mise run install    # build swb from this checkout into ~/.local/bin
mise run dist:pi    # build the pi extension bundle exactly as the release publishes it
```

## Layout

- `packages/cli`: the `swb` CLI and TUI (pi-tui), compiled to one arm64 binary with `bun build --compile`. May take any dependency.
- `packages/pi`: the pi recorder extension. Use dependencies judiciously. Pi provides `@earendil-works/*` and `typebox` at runtime, so declare them as `"*"` peer dependencies and never bundle them.
- `packages/shared`: schema version, row types, db path, connection policy, anything that should be shared between packages.
- The `pi` branch is generated. The tag-driven release workflow overwrites it wholesale with the bundled extension. Never edit it by hand.

## Data locations

- Database: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/swb.db` (directory `0700`, file `0600`)
- Settings: `${XDG_CONFIG_HOME:-~/.config}/agent-switchboard/config.toml`; unknown keys are an error
- Deck sockets: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/decks/<deck>.sock`
- tmux servers: `tmux -L swb` (sessions) and `tmux -L swb-ui` (Decks), each suffixed `-<SWB_INSTANCE>` when that is set. Tests always set it

## Code style

- TypeScript on Bun; use `.ts` extensions for repo-local imports
- `swb` owns all DDL and migrations through `PRAGMA user_version`; the recorder only asserts the exact version
- Store facts, derive states: Live, Interrupted, Unseen, Inactive, and Archived are computed at read time, never persisted

## Testing

- **Never write unit tests.** Every test is an end-to-end test of a real workflow: real interactive pi inside private tmux servers, the real recorder, db, and `swb`. That includes real pi-sessions subagents and handoffs, which must never appear as Sessions
- Drive the Deck the way a human would, through `swb drive` (keys in, screen captured out) and `swb deck state --json`
- pi-ai's faux provider, registered by a scenario extension, scripts turns offline at zero token cost
- Every change ships with visual proof, as VHS recordings, screen captures, or `capture-pane` output, whichever shows it best
