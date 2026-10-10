# Changelog

## 0.5.0 — 2026-10-10

Needs pi-sessions 0.17.0 or later for Operators.

### Added

- **Shell** — `M-a s` opens the directory's login shell beneath pi, sharing its column evenly; beside a split editor it sits bottom-right. `M-a s` hides it; `ctrl-d` ends it.
- **ctrl-hjkl** move between the Deck's panes by position. An nvim Editor walks its own windows first, netrw included, then steps off its edge into the Deck. `M-a h` and `M-a l` follow the same geometry.
- **Group picker** — `m` lists the Project's Groups, plus "(no Group)" and a "+ new" row for a typed name.
- **`x`** stops an idle session's pi; the session stays open, and Enter wakes it again.

### Changed

- swb owns the Operator's AGENTS.md and rewrites it whenever it differs from the shipped copy. The Operator talks like a colleague instead of filing reports, and keeps no STATE.md.
- An Operator can't start subagents or deferred handoffs: its folder's `.pi/settings.json` turns them off in pi-sessions, so `session_handoff` offers only `launch: "swb"`.
- A dragged row stays in place, hollowed, and the hint names where it will drop.

### Fixed

- The help popup fits its keys instead of wrapping and scrolling.

## 0.4.0 — 2026-10-10

Schema v3: update swb and the recorder together; an older one refuses the db.

### Added

- **Operators** — sessions in `~/.config/agent-switchboard/operator`, in their own section atop the roster, outside every Project and never Inactive. They read only that folder's AGENTS.md, written once as CAPCOM. `n` on the section starts one.
- **Layout restore** — a new Deck picks up the last Deck's cursor, folds, and dragged width for this Project, else lands on the most recently visited session. The keyboard stays in the roster.
- **`swb -c`** — opens a Deck in pi on this Project's most recent session, or a new one.
- **Groups** — `m` names a session's Group, or renames one from its header; dragging a session lights the Group it would land in. Groups sit beside worktree buckets under `group_by = "worktree"` and vanish with their last open session. `n` joins the cursor's Group.
- **`N`** starts a session where swb was run; `n` keeps using the highlighted row's directory.
- **`roster_width`** setting, in columns or `N%`, capped at half the Deck.
- **`swb_update_session`** replaces `swb_archive`: archive or unarchive this session or another, refusing one mid-turn. It renders as "Archive · title".
- **Upgrades take over** — a newer swb stops idle pis and restarts or re-sources its older tmux servers. Working and blocked pis keep running. An older Deck says "reopen the Deck".
- Unsent drafts survive upgrades and restarts.

### Changed

- A Visit is a focused second on pi. Passing the cursor or `w` no longer clears Unseen.
- One click on a session focuses it, waking it if dormant.
- The bar under the roster is one status word, path and branch, and view tabs. The legend lists only what the current row does.
- Project headers carry counts; the top-right "open · arch" is gone.
- The preview fills the Stage and no longer flickers.
- Focusing a sleeping session, or choosing pi or split for it, wakes it.

### Fixed

- A pi started with no viewer gets the terminal's palette hues, not pi's built-in ones.
- Archive and reap stop pi with SIGTERM, so its shutdown hooks run.

## 0.3.0 — 2026-10-09

### Added

- **`M-a z`** hides the list in a wide Deck, leaving pi, the editor, or the split full width; `M-a h` or `Tab` brings it back. A narrow Deck keeps zooming.
- **Prefix roster keys** — `M-a` followed by `n a w y Y / j k` does what the list's own key does, from any pane. `M-a j`/`k` restage without taking the keyboard off pi.
- **Clickable tabs and legend** — the selected session's `pi`, `editor`, and `split` tabs switch its view, and the legend's hints run their keys.

### Changed

- `M-a e` and the other view keys put the keyboard on the pane they bring up. A split refused for want of columns puts it on pi.

## 0.2.2 — 2026-10-09

### Fixed

- A project's own tools win in managed pi again. When `tmux` resolved to a mise shim, it prepended the starting project's mise PATH to each new pane, and the shell's mise activation then pushed the project's `.venv/bin` far down PATH, so `python3` resolved to mise's python instead of the venv's.

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
