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
```

Some scenarios install the host's own pi-sessions and pi-wt, found through its pi settings; point `SWB_E2E_PI_SESSIONS` or `SWB_E2E_PI_WT` at a checkout when the settings don't name one.

## Layout

- `packages/cli`: the `swb` CLI and TUI (pi-tui), compiled with `bun build --compile` to one binary per release target (linux-x64, darwin-arm64). May take any dependency.
- `packages/pi`: the pi recorder extension. Use dependencies judiciously. Pi provides `@earendil-works/*` and `typebox` at runtime, so declare them as `"*"` peer dependencies and never bundle them.
- `packages/shared`: schema version, row types, db path, connection policy, anything that should be shared between packages.
- The `pi` branch is generated. The tag-driven release workflow overwrites it wholesale with the bundled extension. Never edit it by hand.

## Data locations

- Database: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/swb.db` (directory `0700`, file `0600`)
- Settings: `${XDG_CONFIG_HOME:-~/.config}/agent-switchboard/config.toml`; unknown keys are an error
- Drafts: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/drafts/<session_id>`, an unsent prompt saved when an upgrade stops its pi
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
- Every change ships with visual proof I can look at: a VHS recording (`mise run evidence`), or a PNG from a tape's `Screenshot` command. Text captures and `capture-pane` output are for assertions; I read them, but I'd much rather see an image
