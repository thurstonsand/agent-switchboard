# Data locations

- Database: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/swb.db` (directory `0700`, file `0600`)
- Slow db calls: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/db-waits.jsonl`, one JSON line per call to swb.db or recall.db that took 200 ms or more or ran out `busy_timeout`, from any swb process or line: who waited, the op (`begin` is the wait for the write lock, `tx` how long it was then held), and the SQL's start. `jq` it before deciding the db needs anything
- Settings: `${XDG_CONFIG_HOME:-~/.config}/agent-switchboard/config.toml`; unknown keys are an error. Each setting is declared once, in `SETTINGS` in `packages/cli/src/config.ts`, which the Settings pane and README's block (`mise run readme`) both read
- Search index: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/recall.db`, every Session's transcripts and its subagents' in FTS5, rebuilt from them whenever its own version moves, so it never migrates. Each search catches up on what changed, and the clock keeps it warm
- Catalog: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/catalog.json`, what each harness can start and the models it offers; `locks/catalog.db` lets one swb at a time read the model lists
- Operator folder: `${XDG_CONFIG_HOME:-~/.config}/agent-switchboard/operator`. Every Deck rewrites its `AGENTS.md`, `CLAUDE.md`, `.pi/extensions/operator.js`, and `.pi/settings.json` from the copies swb ships, with `operator.instructions` after the shipped AGENTS.md, and again whenever that setting changes; Claude Code and Codex Operators get the rest of their limits as launch flags
- Deck layout: the `deck_layout` table, one row: the cursor, folds, and roster width the Deck starts from when its server does
- Drafts: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/drafts/<session_id>`, an unsent prompt saved when an upgrade stops its pi
- Deck socket: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/deck.sock`
