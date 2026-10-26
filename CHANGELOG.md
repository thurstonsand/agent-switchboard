# Changelog

## Unreleased

Schema v7: update swb and the pi line together.

### Added

- `session_launch`, and `session_schedule`'s `launch`, take a `group`: a name starts the new session in that Group, in any Project, and `null` starts it in none. Left out, it starts in its parent's Group as before when both are in one Project. `swb launch` takes `--group` and `--no-group`, and `swb schedule` takes `--launch-group` and `--launch-no-group`.
- `session_search` and `session_ask`, in pi, Claude Code, and Codex. `session_search` searches every other session's conversation, open or archived, its subagents' included, with phrases, `OR`, `-word`, and filters for harness, project, file, and time. `session_ask` answers a question about another session's conversation with a reader in the asker's own harness. The reader starts from a map of that session, its turns, compactions, abandoned branches, and subagents, then searches and reads it by ref, and works until it answers or you press Esc. swb indexes transcripts as they change, in `recall.db` beside its db. A managed pi needs pi-sessions 0.22.0 or later, which leaves both tools to swb; an older one registers the same tool names, and pi refuses to start with both.
- `swb adopt --all` brings in every session pi, Claude Code, and Codex ran outside swb, archived as of its last turn and indexed, so `session_search` and `session_ask` reach your history from before swb. Sessions whose directory is gone come too. Run again, it adds only what's new.
- Codex's own subagents, from either multi-agent version, are their parent session's conversation the way Claude Code's are: `session_search` finds what they said under their parent, and `session_ask`'s reader lists them in its map and reads them. A subagent that starts with a copy of its parent's conversation is read from where its own work begins.

### Fixed

- A session in a directory that never answers, such as a cloud drive's folder, or `~/Downloads` behind a macOS permission prompt nobody is there to answer, no longer hangs its harness as it starts, nor the Deck: swb gives git five seconds to find its repository, then treats the directory as none.
- A Codex session you rewind to an earlier prompt keeps its card up to date. A rewind goes on in a new rollout file, and swb kept reading the old one. Its card, search, and `session_ask` now follow the rewind, and what it undid becomes an abandoned branch.

### Changed

- swb needs tmux 3.8: a Peek, and `n`'s launch card and its menu, are floating panes over the Stage instead of a popup, so more than one shows at a time.
- `n`'s picker says what a new session starts on, its harness as well as its model and effort, on a card on the Stage, with the preset's note. `Tab` drops the shortlist under it, a harness at a time and numbered: a number picks one, typing narrows it, and `Esc` keeps the one you had. With no room on the Stage, as on a narrow Deck, the roster draws the card.
- A message, launch goal, or scheduled message over 100,000 characters is refused when it's sent, in pi, Claude Code, and Codex, telling the agent to put the detail in a file and send its path. One Codex refused for its length used to stop every message queued behind it.
- A Group's name takes only letters, digits, spaces, and `-` `_` `.`: `m` in the roster won't type anything else, and the tools and CLI refuse it. Groups already named otherwise keep their names.

### Fixed

- A launch's parent and Group go to the first session its process records, in every harness. In pi, `/new` before the first prompt in a session `n` started inside a Group keeps the new session in that Group, and the roster no longer nests a `/new` after a launched session's first turn under its launcher.
- `Esc` goes back to the list for as long as a session on the Stage is starting, as its hint says. Once its harness's process was up, but not yet its screen, `Esc` went to the harness, which showed it as `^[`.
- A sessions server killed under a Deck always comes back. A check that ran as the server shut down could stop the Deck's background worker, after which `w` and `⏎` did nothing, and the error saying so went with the next key. A check that fails now says so and the next one tries again, and a stopped worker's error stays.
- A prefix key pressed just after moving to another pane acts on that pane: `M-a l` then `M-a v` could leave split for the Editor instead of the agent.
- `swb deck state` shows a split's or a shell's pane gone once tmux has closed it, not just before.
- Widening a narrow Deck, `M-a z` hides the roster as soon as `swb deck state` says the Deck is wide. It used to report the Deck wide while it was still laying itself out, when `M-a z` still acted as on a narrow Deck.
- A long message reaches a Codex session on macOS. swb wrote each request to Codex's app-server socket in one go, and what didn't fit in the socket's buffer, 8 KB on macOS, was lost, so a message much over that never arrived. The rest now waits until the socket takes it.
- Several swb processes opening a new database at once, as the first sessions after an install or the first indexing after this update do, no longer fail with `database is locked`.
- Waking a session in Inactive leaves its row there while it starts, instead of moving it to its Project and back.

## 0.7.0 — 2026-10-21

Schema v6: update swb and the pi line together.

### Added

- Schedules: an agent messages itself or another session later, once or on a cron, or launches a new session each time, with `session_schedule`, `session_schedules`, and `session_unschedule`, in pi, Claude Code, and Codex. A clock in swb's tmux server fires them with no Deck open, and after the machine sleeps, the missed ones fire once, saying when they were due. A session's Peek lists its schedules, and the last one that ran.
- Snooze: `s` in the roster, `M-a S` from anywhere, `swb snooze`, or `swb_update_session`'s `snooze` put a session in the new Snoozed section for an hour, a day, a week, a set time, or until its next message.
- `swb quit` stops every session, Deck, and the clock.
- The roster nests a session under the session that started it, on pi's tree guides, and sorts each family by its newest activity. `h` folds a family, and the folded row counts what it hides and what of that needs you. A session whose parent sits elsewhere is marked `↳`, or `⌁` when an Operator started it; its Peek says who, and `p` goes there.
- `a` on a session that started others still open asks whether they go too: `a` again archives it alone, `A` all of them.
- A session another starts begins in its parent's Group. Moving either one afterwards leaves the other where it is.
- A dormant session's card ends where its last turn did when it never replied: the tool calls it was making, then `cut off`, `stopped`, or `errored` beneath the provider's error, in pi, Claude Code, and Codex. A cut-off session's status says how: shut down, killed, or machine restarted.
- An errored session's row wears the cut-off session's `⚠` instead of looking finished, live or not, until its next turn starts; `swb ls --json` gains `errored`.
- Waking a cut-off session from the Deck continues its turn: pi and Claude Code are told `Continue where you left off.`, and Codex starts a turn with no prompt, going on from its own history. A stopped or errored session wakes idle, and so does any session woken to deliver a message.
- Settings: `,` in the roster, or `M-a ,` from anywhere, opens every setting by section, with search, edited by keyboard or mouse. Each saves to config.toml as you make it, keeping your comments; a value is dim while it's the default.
- The shortlist: presets of a harness with a model and effort, or a Claude Code agent, each with a note for agents. `n`'s picker opens on the ★ default and `Tab` steps through the rest, and agents choose from it in `session_launch`. Until you edit it, swb makes one from each harness's own list. `swb models` lists everything the harnesses offer.
- `harnesses` turns a harness off for new sessions.
- Your own instructions for Operators: Settings' Operators section is pi's editor on `operator.instructions`, saved a second after you stop typing and whenever you leave it. Every Operator's AGENTS.md carries them after swb's, rewritten as each save lands. At 16,000 characters the editor takes no more, and a paste goes in as far as fits.
- Claude Code's models and agents come from Claude Code itself, as this account sees them, with its own notes and the efforts each model takes, instead of a fixed list in swb. A preset can leave out its effort to start on the harness's own default.
- A Claude Code session keeps its effort: its line records the model and effort of each request, so what it launches carries the effort it runs on, live or dormant, and waking it restores the effort Claude Code's own resume drops.
- An edit to config.toml, by hand or from Settings, applies to every open Deck at once. A file swb can't read stops new swb commands at the line at fault; an open Deck keeps what it had, says so in red, and `O` opens the file there.
- `swb_show_session`: ask an agent to take you to a session, and the Deck you're talking to it in moves there, opening whatever section, Project, or family hid it, and starts it if it's dormant, in its agent, its editor, or a split when it asks for one. Other Decks stay where they are.
- `swb_update_session` groups and retitles a session, and archives a whole family with `family`, any of its changes in one call. A family member mid-turn, blocked, cut off, or errored refuses the whole call by name; `force` archives it anyway and cancels the turn. A title set through it becomes the harness's own name: pi and Codex take it at once, Claude Code with its next prompt.
- `session_reachable` names each session's Group.

### Changed

- The Stage's first view is the session's agent, whichever harness runs it: `swb deck state` reports it as `agent` instead of `pi`, and the Deck's help and notices name the session's harness or say "the agent".
- Claude Code's own scheduler (`CronCreate`, `/loop`) is off in sessions swb runs.
- A dormant session with a message waiting is started by the clock, retrying with backoff, instead of only by its sender.
- A family goes Inactive only once all of it has.
- An Operator can no longer start another Operator: `session_launch` from one must name a project's directory.
- A roster row's time shows nothing while its turn runs, and counts from when the turn finished, not from the prompt that started it. Its Peek says `active now`.
- Interrupted is now Cut off. `swb ls --json`'s `interrupted` boolean is `cutOff`: `"shutdown"`, `"killed"`, `"restart"`, or null. `session_reachable` lists such a session as `cut off`.
- `session_launch`, and `session_schedule`'s `launch`, take a preset's harness, model, effort, or agent; one that isn't a preset is refused. With none of them, the new session carries forward what its caller runs now: the preset with the caller's harness, model, and effort, else its harness and model, else its harness, else the default. `swb launch --harness` is optional, and `swb schedule` marks a launch with `--launch-title`.

### Fixed

- Archiving or stopping a session that no Deck started (the clock, a schedule, or `session_launch` did) took 5 seconds, waiting on a pane that stayed open after its harness quit. Every session's pane now closes with its harness once the session has registered.
- A pi session waiting on a dialog, the confirm, select, input, or editor any extension opens, read as working: only a Glimpse wait read as blocked. It reads blocked until you answer, and a dialog inside a Glimpse wait leaves it blocked until both end. A dialog opened while the session is idle still reads idle.
- On tmux 3.8, a pi on the Stage stayed tuned to your terminal's old theme after it switched between light and dark: a light screen with your messages in dark boxes. It follows the switch again, in copy mode too, and every session sees your terminal's foreground and palette along with its background. With several Decks open, the one you use last sets the colours.
- A Deck stopping an idle session sends it one SIGTERM, then SIGKILL if it's still running 10 seconds later, instead of a SIGTERM every 250 ms until it exits. A late one no longer draws `'kill -TERM <pid>' returned 1` over another session.
- A Codex session's app-server and the tools it's running end with its host, however the host ends, instead of finishing the turn alone with nothing left to show it. An app-server that dies ends its session as cut off, killed, instead of leaving its TUI reconnecting forever.
- A message Codex refused, such as one that arrived during `/compact`, waited for some unrelated write to the db before swb tried it again. It goes through once Codex takes it.
- A card no longer shows Claude Code's `[Request interrupted by user]` as something you typed, or its `API Error: …` as a reply.

### Removed

- `group_by = "worktree"`. A config that still sets `group_by` fails to load; delete the key.
- `harness`, the harness `n` started. The shortlist's default replaces it; a config that still sets `harness` fails to load.

## 0.6.4 — 2026-10-16

### Fixed

- On tmux 3.8, a row's Peek and the `?` help were dark grey boxes on a light terminal, their dim text hard to read, and copy mode highlighted search matches in its own colours instead of your terminal's. All of them wear your terminal's colours again, as on tmux 3.7.
- ctrl-hjkl move out of an nvim Editor again when your config is LazyVim, whose own window keys used to replace swb's.

## 0.6.3 — 2026-10-16

Requires Claude Code 2.1.300 or later, and pi 1.2.0 or later.

### Changed

- Copying text in pi now works when your terminal is on another machine.

### Fixed

- Claude Code: after an upgrade restarted a session, a prompt you'd already sent could reappear in the input box, and a restored draft could be lost at the next restart.

## 0.6.2 — 2026-10-15

### Added

- `swb adopt` takes Claude Code and Codex sessions too, by id or transcript path. Subagent threads are refused.

### Fixed

- In Claude Code, swb's tools could fail with `--from is required`, and the session go unrecorded, when the line missed Claude Code's `SessionStart` event. The line now asks Claude Code which session it is.
- The cursor flickered while a session worked: neither of swb's tmux servers sent the terminal synchronized frames, so it drew each redraw partway.
- A Claude Code session launched with a title keeps it, instead of Claude Code's generated one replacing it.
- Codex asked permission before every call to swb's tools. They now declare themselves read-only, or non-destructive and closed-world, which Codex's default policy runs without asking.
- A Codex session swb had just started could have an error printed over its screen: swb read its thread before Codex had written it. A read now has five seconds to succeed before swb says so.

## 0.6.1 — 2026-10-15

The first release of these changes: v0.6.0 stopped in CI, which lacked Claude Code and Codex, before it published anything.

Schema v5: update swb and the pi line together. With pi-sessions, needs pi-sessions 0.19.0 or later: an older one registers the same tool names, and pi refuses to start with both.

### Added

- **Claude Code and Codex** — on the roster beside pi, as their real TUIs. `n`'s picker cycles harnesses with `Tab`; `harness` sets the default; `swb new --harness`. The dormant card reads all three transcripts.
- **Messages between sessions** — every session, in any harness, gets `session_reachable`, `session_send_message`, `session_cancel`, `session_launch`, and `swb_update_session`. A message reaches a working session mid-turn, starts a turn in an idle one, and wakes a dormant one; it waits in the db until delivered.
- Codex's own `/archive` archives the session in swb, and `swb unarchive` unarchives it in Codex too. swb's Codex tools come from a plugin that only swb's sessions enable, so Codex titles its threads itself.
- Idle Codex sessions stop after `reap_after` and on upgrade like the others, but lose an unsent prompt: Codex gives swb no way to read it.
- `swb send`, `swb reachable`, and `swb launch --harness` for scripts.
- A session started by another records it as its parent, in `swb ls --json` as `parentId`, and for pi also in the transcript, where pi-sessions sees it.
- **Peek** — hovering a session, or landing on it with `j` and `k`, shows its full title, state, harness, age, directory and branch with uncommitted changes, Group, last turn, and its keys as buttons. A wide Deck shows it as a popup beside the roster; a narrow one draws it over the roster's edge.
- Every navigation has a mouse path: with the roster hidden, the status bar's `◂ M-a z show list` brings it back; the bar's tabs gain a shell toggle; the Group picker has a ✕; the filter's tag clears the filter.
- `swb ls --json` gains `createdAt`.

### Changed

- The recorder is now the pi line, in `packages/lines/pi`. It claims peer coordination from pi-sessions, which keeps only its subagent tools.
- `swb launch --session-id` is gone with the pi-sessions host API it served.
- An Operator's new sessions are `session_launch`es, in any harness.
- Operators run in pi, Claude Code, or Codex: `n` on the Operators section opens the picker on the Operator folder. A Claude Code Operator reads only the folder's AGENTS.md, through a CLAUDE.md swb writes there; a Codex one also reads `~/.codex/AGENTS.md`, which Codex can't skip. Neither can start subagents.
- `hover = "lazy" | "eager"` is now `wake_on_highlight = false | true`.
- The bar under a wide Deck's roster holds only the view tabs and the shell toggle; the state, path, and branch are the Peek's.
- A starting session is on the Stage, so a prompt it raises before it registers, such as a missing directory or project trust, can be answered. `esc` no longer backs out of a start; `M-a h` does.

### Fixed

- Waking a pi session whose directory is gone resumes it from the Project root, where pi asks what to do, instead of starting a fresh, empty session under its id.
- A pi whose first turn starts during another extension's startup shows as working for that turn, not idle.
- pi's links are clickable hyperlinks on the Stage.

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
