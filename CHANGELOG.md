# Changelog

## 0.2.1 — 2026-10-09

### Added

- **`M-a q`** closes the Deck from any pane, pi included. Sessions keep running.

### Fixed

- Managed pi and the editor start in your login shell from the passwd entry. Before, they ran under tmux's `/bin/sh`, skipping your shell setup and mise activation, so a project tool could resolve to the system one (e.g. a python too old for `tomllib`).
- swb's tmux servers no longer pick up the starting project's mise env through a mise `tmux` shim.

## 0.2.0 — 2026-10-09

### Added

- **`swb adopt`** — brings a pi session started outside swb under management, so it joins the roster and wakes in swb from then on. Subagents are refused.
- **pi-sessions host** — with pi-sessions 0.15.0 or later, a handoff launches its child as a managed swb session instead of a tmux split or Ghostty window. A message to a dormant swb session wakes it and delivers; pi-sessions 0.16.0 builds its index on its own, so this works on a fresh install.

### Fixed

- A session is tracked from its first turn, not its first user message. A pi-sessions handoff child, which starts with a custom message, used to never get a row. A provider retry after `swb_archive` no longer reopens the session.

## 0.1.0 — 2026-10-08

### Added

- **The Deck** — `swb` opens a roster of every open pi session, grouped by project, beside the selected session's real, interactive pi, its directory's editor, or a split of both.
- **Persistence** — sessions stay tracked from their first turn through quits, crashes, and reboots until archived. A session whose pi died mid-turn shows as Interrupted, and `w` or Enter wakes it where it left off.
- **Attention** — working, blocked, idle, and Unseen show live in the roster; sessions quiet for 72 hours fold into Inactive.
- **Moves** — pi-wt's `/mv` and `/wt` take the session with them, into the new directory's project, and it wakes there.
- **Scriptable surface** — `swb new`, `open`, `archive`, `unarchive`, `ls --json`, plus `swb drive` and `swb deck state` to drive a Deck exactly as a human does.
- **pi recorder** — `@thurstonsand/pi-agent-switchboard` records lifecycle, activity, and attention to the shared db, and says so in pi's footer when it can't.
- **`swb_archive`** — ask a managed pi to archive itself; it does, and quits once its final message lands.
