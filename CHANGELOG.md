# Changelog

## [Unreleased]

### Fixed

- A Peek's buttons stay clickable when the Deck redraws while tmux is creating its floating pane.
- Settings keeps config.toml's comments where they were: resetting a section's last setting no longer deletes the comment above the next section, and a new top-level setting goes above the comment that introduces the first section instead of between it and its header.

## [0.14.2] - 2026-11-09

### Changed

- The footer's `⏎` stays put while a Peek shows, so moving with `j`/`k` no longer flickers it. The Peek drops its own `⏎` button; its title, which is its row, focuses on a click as the row does.

### Fixed

- The pointer on its way from a row into its Peek keeps the Peek, as a submenu's safe triangle does: crossing a header, a section, or the empty roster no longer closes it, and crossing other rows no longer moves it unless the pointer rests there. Moving down the list, the Peek follows each row sooner.

## [0.14.1] - 2026-11-08

### Changed

- The Peek's row is one of its edges. A title the roster cuts runs on across the divider along the Peek's edge, with its age at the Peek's far side and the row's tint across it, ending in `…` only when even that can't hold it. The Peek opens upward when it can't fit below its row, and its title is never written twice. Its actions sit in aligned Session and Organize columns, wrapping whole rather than cutting a label short, and an errored session's provider error shows in both widths.
- Archive, Snooze, and Group open directly under their row, at any width, and the row wraps its whole title while they're open. Snooze and Group take number keys for their choices.
- Every box, the Peek, the launch card, and the row menus among them, closes from a clickable `esc` in its top border. The `✕` buttons and the `⏎ choose  esc cancel` rows are gone. Esc puts a Peek away before it clears a filter.
- Archive on a worktree with uncommitted changes leaves out its delete choices and says `Uncommitted changes`, so it no longer offers a deletion that can only fail.
- The keys under the roster sit in one column grid, each over the one below it. The Deck's prefix is named once: on the rule when the Stage has the keyboard, and before the views when the roster does, where only they need it. `s shell` stays whenever it fits, narrow too.
- Help fills the terminal's height, sits beside the roster when the Stage has room for it, leads with moving, focusing, and leaving, and closes on any key.
- The roster's `▌` marks only the session on the Stage; the cursor is its tint alone, on Project and Group headers too. The `↳` and `⎇` badges follow their title instead of sitting by the age.
- The new-session picker counts the presets its menu hides above and below, and a narrow launch card keeps the model's name and price when there's room. A split Stage gives the editor and the agent half each.
- Settings marks a changed setting with `•` beside its label, keeps its explanation while it's edited, and searches every section at once.

### Fixed

- Resizing a Deck with a session's details expanded down to a very narrow width no longer kills the roster, which left a one-column pane and `swb deck state` failing with ECONNREFUSED.
- Esc followed by mouse movement no longer types the mouse's raw bytes into the filter.
- Narrow Help wraps its descriptions instead of cutting them off. Expanded details keep their frame while they scroll, and its border counts what's hidden above and below; nothing else claims PgUp/PgDn, so a Snooze menu over the details no longer advertises them.
- A blocked session's Peek gives the age its roster row shows instead of `active now`. One that's snoozed but showing for attention names when its snooze ends and offers Unsnooze.
- pi's `swb: not recording` footer puts `roster: R reload` first, so a narrow pane cuts the diagnostic instead of the way out.
- The editor view's `e editor` lights up while the editor is on, as `v split` does.

## [0.14.0] - 2026-11-08

Never published: its release stopped on a test that read the Deck's screen while a Peek covered what it waited for. 0.14.1 carries its changes.

## [0.13.0] - 2026-11-07

Schema v12: update swb and the pi line together, and run `swb quit` with the swb you have before installing this one: this swb finds the sessions it runs by a mark an older one didn't leave, so it can't see, stop, or quit those.

### Added

- `db-waits.jsonl`, beside swb's database, logs every database call from swb or a line that takes 200 ms or more, or gives up on a busy database: which process waited, for how long, and on what. It's there to tell whether a hitch in pi is swb's database before anything changes for it.

### Changed

- There is one Deck, and every `swb` opens it: each terminal shows the same cursor, keyboard, and session. `q` leaves it as it is for the next `swb`, and `swb -c`, `swb new`, and `swb open` move it. The session on its Stage keeps running while it's there, even with no terminal on the Deck. A roster that died or belongs to an older swb restarts in place the next time `swb` runs. `swb deck state` no longer takes `--deck`. Each `swb` used to open a Deck of its own, which kept a cursor, folds, and roster width for its Project.
- swb runs one tmux server, not two. A session on the Deck's Stage is its own pane, moved into the Deck while it's on view, rather than a tmux client nested in the Deck showing it, so nothing stands between the terminal and the harness, and the Deck's layout stays put when the harness on view quits. Attaching to a session with `tmux attach` is no longer supported: while the Stage shows a session, its pane isn't in its own tmux session. A session that was never prompted is no longer stopped as its last viewer leaves; it stops after `reap_after`, like any other idle session off the Stage.
- Archiving a session cancels every schedule it set, the messages to other sessions and the launches included, as well as those aimed at it. A cron launch no longer keeps starting children of an archived session. The Deck's `a` names them first and asks again, after asking whether its family goes too; `swb archive` asks at a terminal, and refuses without one unless given `--yes`. Deleting a worktree with its archive no longer refuses a scheduled launch into it that an archived session set.
- The roster says what each session needs at a glance: blocked `◆`, cut off `!`, and errored `×` are bold and distinct, dormant is `–`, and `?` explains every mark in plain words. Project names are bold, Groups regular, counts dim, and an Operator's or worktree's mark sits beside the age, clear of the cursor.
- The Peek leads with the action its state calls for (Focus to respond, Resume unfinished turn, Wake & focus, Inspect and retry), owns its keys while it shows, underlines the row it describes when the pointer opened it, and leaves out what the roster already says. Navigating away or focusing the Stage puts it away, and it closes itself after 30 idle seconds.
- A narrow Deck has no floating Peek: `i`, or a click on `details`, expands the selected session's particulars and actions below the roster, scrollable on a short terminal, and an errored session's shows its provider's error. Hidden rows above and below are counted with their attention marks.
- Archive and Snooze open beside their row, and Group inserts beneath it. The filter underlines what matched, mutes the rows shown only for context, and counts its matches, with Esc to clear. The footer keeps `n new`, `? keys`, and `, settings` in place, and the view strip names its keys.
- The new-session card says which preset it starts and where, narrow too, with its keys inside it. Settings shows the selected setting's explanation in full, bold only in the pane without the keyboard, and lines up its sections.
- A Message from another session, a launch briefing included, draws in pi as `↘ from <sender>` with its body beneath, and swb's tool calls in pi draw as one line each, such as `Sessions · 14 found · ctrl+o details`.

### Fixed

- A message reaches its session once while swb's database is busy for longer than five seconds. Claude Code could take it twice, Codex was steered with it again every few seconds until the database freed up, and pi stopped recording altogether: its session read as working for good, and took the message a second time once it restarted. Every line now marks a message delivered before handing it over, and holds its records until the database takes them, saying so meanwhile.
- `session_recall` works in a Claude Code Operator. It failed with `no tool named "Agent" in this session`: the Operator's settings took the Agent tool away to keep its model from starting subagents, and the reader starts through it. The line now offers an Operator's model no agent types instead, so its own subagents are still refused.
- A session an agent or `swb launch` starts in a folder Claude Code hasn't trusted starts, instead of waiting on Claude Code's trust dialog until swb gave up after 60 seconds. Claude Code has no flag that skips the dialog, so swb marks the folder's Project root trusted in `~/.claude.json`, as answering the dialog would, under the same lock Claude Code takes; it stays trusted for every later Claude Code session there. Codex, started the same way, trusts the folder for that session, so it reads the folder's own `.codex` config.
- A message reaches a dormant session an agent started, or one whose directory is gone, instead of waking it onto a trust prompt and reporting it queued. pi's `--approve` and Codex's trust covered only a session's first run, so pi stopped at its prompt on a folder with `.pi` settings, and Codex at its own once a deleted worktree moved the session to its Project root. A session you started yourself, woken in place, keeps what you answered.
- `swb_update_session` that refuses one change makes none. Retitling and snoozing an archived session in one call used to keep the new title while refusing the snooze.
- Renaming a Codex session whose app-server went away just then fails instead of waiting forever.
- A harness whose model listing fails keeps the list it found last, beside the error. The shortlist lost which efforts each model takes, and the add search offered none of its models.
- A lock left by a swb that died before a reboot no longer holds up the next swb for three minutes, and two swbs can no longer both take over a lock whose holder died.
- The Deck, and every session it hosts, follows a switch between two light themes, or two dark ones, in a terminal that reports every theme change, as Ghostty does. They kept the old theme's colors until the terminal next flipped between light and dark.
- An invalid config.toml no longer stops swb's clock. It exited the first time a dormant session had a message waiting, and no schedule fired again; it now says why in its pane and wakes the session once the file is fixed.

## [0.12.0] - 2026-11-05

Schema v10: update swb and the pi line together.

### Changed

- swb's tools and their arguments take names that say what the agent is choosing, all in snake_case: `session_reachable` is `session_list`, `session_ask` is `session_recall`, and `session_schedules` splits into `session_list_schedules` and `session_unschedule`. `session_launch`'s `goal` is `briefing`; `requestResponse` is `report_back`; a schedule's `label` is `schedule_label`; `swb_update_session`'s `force` is `cancel_turns` and `deleteWorktree` is `delete_worktree`; and the reader's `recall_read` takes `tool_output: trimmed | whole` in place of `body: preview | full`.
- The CLI follows: `swb reachable` is `swb list`, `swb schedules` is `swb list-schedules`, `--request-response` is `--report-back`, and `--label` is `--schedule-label`.
- swb's e2e runs pi-sessions 0.23.0, which takes the same names for its own tools.

### Fixed

- A Claude Code session that snoozes itself until its next message, or archives itself, mid-turn stays that way. Its tool call could land before swb recorded the turn's start, and that record then counted as the next prompt, ending the snooze or undoing the archive.
- A working session no longer moves to Inactive when its turn outlasts `inactive_after`. Resolving a long-held attention prompt could hide the session and switch the Stage away before its reply landed, leaving that reply Unseen.
- Codex errors no longer go unmarked when its transcript writes lag behind its live status. swb records the error when Codex reports it, before settling the turn, instead of checking a history entry that may not yet contain it.
- Claude Code on a machine with managed settings takes a title set through swb with its next prompt, as everywhere else, and a conversation swb resumed in its Project root says so, to you and to the model. Its built-in `cc-plugin-sec-default` mod skipped the line's last two classic hooks, which carried both, and posted a notice for each; the line now hands them over through command hooks, which that mod leaves alone.
- In Claude Code, `session_recall` returns as soon as its reader starts, and the reader's answer arrives as a message once it's done, as a subagent's does. A Claude Code session in auto mode no longer gets the answer twice: Claude Code made the reader report through SubagentHandback, which posted the answer beside the tool's result.

## [0.11.0] - 2026-11-03

Schema v9: update swb and the pi line together.

### Added

- `u` in the roster, and `M-a u` from the agent, marks a session Unseen: its `●` shows at once, and holds for as long as the session stays on the Stage, through any turns it takes, and after you move on. Only coming back to it from another session, for the second a Visit takes, clears it; `u` again takes the mark off. Snoozed and archived sessions can't be marked.
- `[` and `]` in the roster step back and forward through the sessions you visited, as a browser's back and forward do, and `‹ ›` at the end of the legend does the same with a click. From the agent, `M-a [` and `M-a ]` focus the session there, waking it. A Visit counts as it does for Unseen, a second with the agent focused, so moving the cursor over a session doesn't. A new Deck reaches back through every earlier Visit. Archived sessions are passed over; snoozed ones aren't.

### Changed

- An idle session nobody is viewing now stops after an hour by default, not 30 minutes, matching Claude Code's hour-long prompt cache. `reap_after` still sets it.
- The Deck lists its sessions sooner. It used to ask git, one directory at a time, about every directory any session ever ran in, archived ones included, before showing any; it now asks only about open sessions below their Project's root, all at once, and asks the harnesses what they offer after the list is up. A Deck opened when swb's tmux servers were down also no longer leaves its Stage blank for an extra 0.2 s.

### Fixed

- `?` shows every key again. Its popup had a fixed size the list outgrew, so its first keys scrolled off the top, and on a Deck under 37 rows it didn't open at all. It now fits the list, short of the Deck's own size, and when the Deck is too short it scrolls by `j`/`k`, `↑`/`↓`, `space` and PgUp/PgDn, or the wheel, saying how much lies above and below.

## [0.10.0] - 2026-11-02

### Added

- Archiving a session in a linked worktree can delete the worktree too: `d` in the Deck's archive prompt, or `D` with the sessions it started, and `deleteWorktree` on `swb_update_session`. The branch and the conversations stay. It refuses a worktree with modified or untracked files, a locked one, one a schedule launches into, and one other open sessions still use; ignored files go with it. A conversation whose directory is gone resumes in its Project root, with the same history and a notice that its files may differ, in all three harnesses.
- pi shows what changed in swb's pi line after an update, under Extension Updates: the npm package now ships this changelog.
- The Deck dims the panes the keyboard isn't in, by 35% on a dark terminal and 15% on a light one, so a cursor drawn in another pane no longer looks like where you're typing.

### Changed

- swb needs pi 1.5.0 or newer. Its pi line draws key hints, such as ctrl+o to expand a tool's result, with the keys pi injects, so they follow your keybindings.
- Archive in the Deck returns at once. The row, its card, and the keyboard stay where they were for a last look, and j or k moves on. The harness quits in the background; one still running after 10 s is closed and named, in a toast, by `swb archive`, and in the tool's result.
- swb's tools cost about 40% less context in Claude Code and Codex, and nearly half in pi, which no longer repeats each description, the shortlist included, in its system prompt. Rules an agent needs at one moment, like ending its turn after archiving or reloading itself, now come in that tool's result. Three tools merge into others: `session_cancel` is `swb_update_session`'s `cancel`, `session_unschedule` is `session_schedules`' `unschedule`, and a scheduled launch is `session_launch` with `at` or `cron` and a `label` instead of `session_schedule`'s `launch`. A Claude Code permission rule naming `session_cancel` or `session_unschedule` needs the new names. `swb launch` takes `--at`, `--cron`, `--label`, and `--request-id`, and `swb schedule` drops its `--launch-*` flags.
- Codex gets swb's tools from a `[mcp_servers.swb]` that swb adds to `~/.codex/config.toml`, switched off, when it finds Codex and it isn't declared there, instead of from a plugin. Only swb's own Codex sessions switch it on. A Codex for Work policy that only allows its own plugin marketplace dropped the plugin silently; this server still loads. If you declared `[mcp_servers.swb]` yourself as a workaround, set `enabled = false` so plain `codex` stops offering swb's tools; swb supplies the rest. The old plugin under `~/.codex/plugins/cache/swb` is unused and safe to delete.
- A Codex session whose swb tools don't load, such as under a managed `mcp_servers` allowlist, now ends before its TUI starts, saying why, instead of running without them.
- Claude Code shows each swb tool call in its transcript: what it was called for, such as `Message · …` or `Launch · claude · …`, and what it answered, an error in red, where it used to fold every call into one `Called plugin:swb:swb` line that only ctrl+o opened. ctrl+o still shows Claude Code's own rows in full.
- pi and Claude Code show `session_reachable`, `session_search`, and `session_schedules` as the sessions or schedules they found, not the legend over the agent's list; in pi, ctrl+o shows that list whole.
- A message that starts a turn in Claude Code shows once, as that turn's prompt, without a second `↘` line under it. One that arrives mid-turn keeps its `↘` line, the only trace of it in the transcript.
- An agent no longer hears whether another session's process is running: `session_reachable` lists one that isn't as idle, and a message to it reports only that it was delivered. swb starts it as before. Tool results drop other asides an agent can't act on, such as when a queued message arrives or where an archived worktree's conversations resume.

### Fixed

- Codex on a code-mode-only model, such as gpt-6-sol, offers swb's tools directly. They were only reachable inside its `exec` tool, so an agent asked to start a session used Codex's own `spawn_agent` instead.
- A Codex session woken after `model_provider` changed in `~/.codex/config.toml` goes on with its own provider, as Codex before 0.166 did. Codex 0.166 refuses a conversation on any other, so the session closed as it opened, and a message waiting for it woke it again and again without ever arriving. A new session starts on the provider config.toml names.
- Accepting Codex's startup updater in a swb session goes on into the session, on the new Codex, instead of closing its pane.
- `swb models`, and the Deck's look for harnesses, no longer hang when a harness is a shell function in your login shell, and no longer leave the next Claude Code session slow to quit.
- A cron schedule fires each run once through the hour clocks fall back from daylight saving time. One set during that hour, or due when the machine woke in it, fired again every quarter second until the hour ended, sending its message or launching its session each time, and one already running skipped the hour's second pass.
- The Deck's cursor no longer stalls while something else is writing to the disk, such as a build or a backup. Each move wrote the Stage's card and target to files, and a key could wait 100 ms or more on those writes; they now pass over the Deck's socket.
- Claude Code in auto mode no longer reads blocked while its classifier checks a call, nor for the whole run of a command it allowed. A prompt sent in auto mode marks blocked only for `AskUserQuestion`, so the dialog auto mode falls back to after repeated denials goes unmarked, and a dialog after switching out of auto mode mid-turn can go unmarked until the next prompt.

## [0.9.0] - 2026-10-27

Schema v8: update swb and the pi line together.

### Added

- Reload: a session restarts its harness on the same conversation, so it reads its instructions, settings, extensions, plugins, skills, and MCP servers afresh. `swb_update_session` takes `reload`, `continue` or `idle`: an agent reloading itself restarts when its turn ends; another session told to continue restarts at once, picking a running turn back up and starting one when idle or dormant; told to wait, it restarts once its turn ends and waits for its next prompt. `R` in the Deck reloads to continue, and `swb reload ID [--idle]` does either from a shell.

### Changed

- Claude Code runs several `session_ask` calls from one response at once, each with its own reader, as pi and Codex do. Its swb tools now come from the line's own `swb mcp` server, so they're named `mcp__plugin_swb_swb__…` instead of `mcp__swb__…`; a permission rule naming the old ones needs the new names.

### Fixed

- Claude Code on a machine with managed settings shows when it's blocked on a permission prompt or errored, and follows `/clear` and `/resume`. Its built-in `cc-plugin-sec-default` mod skips every plugin's settings hooks, which the line used for those, and Claude Code posted a notice for each. A title set through swb still uses one, so on such a machine Claude Code doesn't take it, and says so.
- swb started with no locale, as launchd, cron, or a bare shell start it, works as from your terminal. tmux printed a tab to such a client as `_`, so a Deck opened from one lost its roster, every swb command restarted the clock, and `swb quit` failed.

## [0.8.0] - 2026-10-26

Schema v7: update swb and the pi line together.

### Added

- `session_launch`, and `session_schedule`'s `launch`, take a `group`: a name starts the new session in that Group, in any Project, and `null` starts it in none. Left out, it starts in its parent's Group as before when both are in one Project. `swb launch` takes `--group` and `--no-group`, and `swb schedule` takes `--launch-group` and `--launch-no-group`.
- `session_search` and `session_ask`, in pi, Claude Code, and Codex. `session_search` searches every other session's conversation, open or archived, its subagents' included, with phrases, `OR`, `-word`, and filters for harness, project, file, and time. `session_ask` answers a question about another session's conversation with a reader in the asker's own harness. The reader starts from a map of that session, its turns, compactions, abandoned branches, and subagents, then searches and reads it by ref, and works until it answers or you press Esc. swb indexes transcripts as they change, in `recall.db` beside its db. A managed pi needs pi-sessions 0.22.0 or later, which leaves both tools to swb; an older one registers the same tool names, and pi refuses to start with both.
- `swb adopt --all` brings in every session pi, Claude Code, and Codex ran outside swb, archived as of its last turn and indexed, so `session_search` and `session_ask` reach your history from before swb. Sessions whose directory is gone come too. Run again, it adds only what's new.
- Codex's own subagents, from either multi-agent version, are their parent session's conversation the way Claude Code's are: `session_search` finds what they said under their parent, and `session_ask`'s reader lists them in its map and reads them. A subagent that starts with a copy of its parent's conversation is read from where its own work begins.

### Changed

- `M-a s` opens the shell beside an agent's pane that's wider than it is tall and below one that isn't, keeps its side through resizes while it fits, and replaces the agent in its pane when it fits neither way, as on a narrow Deck. The new `shell_position` setting fixes it below or beside. `swb deck state` reports `layout.shell`.
- Entering split, by `M-a v`, the split tab, or `swb_show_session`, puts the keyboard on the Editor.
- swb needs tmux 3.8: a Peek, and `n`'s launch card and its menu, are floating panes over the Stage instead of a popup, so more than one shows at a time.
- `n`'s picker says what a new session starts on, its harness as well as its model and effort, on a card on the Stage, with the preset's note. `Tab` drops the shortlist under it, a harness at a time and numbered: a number picks one, typing narrows it, and `Esc` keeps the one you had. With no room on the Stage, as on a narrow Deck, the roster draws the card.
- A message, launch goal, or scheduled message over 100,000 characters is refused when it's sent, in pi, Claude Code, and Codex, telling the agent to put the detail in a file and send its path. One Codex refused for its length used to stop every message queued behind it.
- A Group's name takes only letters, digits, spaces, and `-` `_` `.`: `m` in the roster won't type anything else, and the tools and CLI refuse it. Groups already named otherwise keep their names.

### Fixed

- A session in a directory that never answers, such as a cloud drive's folder, or `~/Downloads` behind a macOS permission prompt nobody is there to answer, no longer hangs its harness as it starts, nor the Deck: swb gives git five seconds to find its repository, then treats the directory as none.
- A Codex session you rewind to an earlier prompt keeps its card up to date. A rewind goes on in a new rollout file, and swb kept reading the old one. Its card, search, and `session_ask` now follow the rewind, and what it undid becomes an abandoned branch.
- A launch's parent and Group go to the first session its process records, in every harness. In pi, `/new` before the first prompt in a session `n` started inside a Group keeps the new session in that Group, and the roster no longer nests a `/new` after a launched session's first turn under its launcher.
- `Esc` goes back to the list for as long as a session on the Stage is starting, as its hint says. Once its harness's process was up, but not yet its screen, `Esc` went to the harness, which showed it as `^[`.
- A sessions server killed under a Deck always comes back. A check that ran as the server shut down could stop the Deck's background worker, after which `w` and `⏎` did nothing, and the error saying so went with the next key. A check that fails now says so and the next one tries again, and a stopped worker's error stays.
- A prefix key pressed just after moving to another pane acts on that pane: `M-a l` then `M-a v` could leave split for the Editor instead of the agent.
- `swb deck state` shows a split's or a shell's pane gone once tmux has closed it, not just before.
- Widening a narrow Deck, `M-a z` hides the roster as soon as `swb deck state` says the Deck is wide. It used to report the Deck wide while it was still laying itself out, when `M-a z` still acted as on a narrow Deck.
- A long message reaches a Codex session on macOS. swb wrote each request to Codex's app-server socket in one go, and what didn't fit in the socket's buffer, 8 KB on macOS, was lost, so a message much over that never arrived. The rest now waits until the socket takes it.
- A message's receipt in Claude Code no longer ends in a stray `�`.
- Several swb processes opening a new database at once, as the first sessions after an install or the first indexing after this update do, no longer fail with `database is locked`.
- Waking a session in Inactive leaves its row there while it starts, instead of moving it to its Project and back.

## [0.7.0] - 2026-10-21

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

## [0.6.4] - 2026-10-16

### Fixed

- On tmux 3.8, a row's Peek and the `?` help were dark grey boxes on a light terminal, their dim text hard to read, and copy mode highlighted search matches in its own colours instead of your terminal's. All of them wear your terminal's colours again, as on tmux 3.7.
- ctrl-hjkl move out of an nvim Editor again when your config is LazyVim, whose own window keys used to replace swb's.

## [0.6.3] - 2026-10-16

Requires Claude Code 2.1.300 or later, and pi 1.2.0 or later.

### Changed

- Copying text in pi now works when your terminal is on another machine.

### Fixed

- Claude Code: after an upgrade restarted a session, a prompt you'd already sent could reappear in the input box, and a restored draft could be lost at the next restart.

## [0.6.2] - 2026-10-15

### Added

- `swb adopt` takes Claude Code and Codex sessions too, by id or transcript path. Subagent threads are refused.

### Fixed

- In Claude Code, swb's tools could fail with `--from is required`, and the session go unrecorded, when the line missed Claude Code's `SessionStart` event. The line now asks Claude Code which session it is.
- The cursor flickered while a session worked: neither of swb's tmux servers sent the terminal synchronized frames, so it drew each redraw partway.
- A Claude Code session launched with a title keeps it, instead of Claude Code's generated one replacing it.
- Codex asked permission before every call to swb's tools. They now declare themselves read-only, or non-destructive and closed-world, which Codex's default policy runs without asking.
- A Codex session swb had just started could have an error printed over its screen: swb read its thread before Codex had written it. A read now has five seconds to succeed before swb says so.

## [0.6.1] - 2026-10-15

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

## [0.5.0] - 2026-10-10

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

## [0.4.0] - 2026-10-10

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

## [0.3.0] - 2026-10-09

### Added

- **`M-a z`** hides the list in a wide Deck, leaving pi, the editor, or the split full width; `M-a h` or `Tab` brings it back. A narrow Deck keeps zooming.
- **Prefix roster keys** — `M-a` followed by `n a w y Y / j k` does what the list's own key does, from any pane. `M-a j`/`k` restage without taking the keyboard off pi.
- **Clickable tabs and legend** — the selected session's `pi`, `editor`, and `split` tabs switch its view, and the legend's hints run their keys.

### Changed

- `M-a e` and the other view keys put the keyboard on the pane they bring up. A split refused for want of columns puts it on pi.

## [0.2.2] - 2026-10-09

### Fixed

- A project's own tools win in managed pi again. When `tmux` resolved to a mise shim, it prepended the starting project's mise PATH to each new pane, and the shell's mise activation then pushed the project's `.venv/bin` far down PATH, so `python3` resolved to mise's python instead of the venv's.

## [0.2.1] - 2026-10-09

### Added

- **`M-a q`** closes the Deck from any pane, pi included. Sessions keep running.

### Fixed

- Managed pi and the editor start in your login shell from the passwd entry. Before, they ran under tmux's `/bin/sh`, skipping your shell setup and mise activation, so a project tool could resolve to the system one (e.g. a python too old for `tomllib`).
- swb's tmux servers no longer pick up the starting project's mise env through a mise `tmux` shim.

## [0.2.0] - 2026-10-09

### Added

- **`swb adopt`** — brings a pi session started outside swb under management, so it joins the roster and wakes in swb from then on. Subagents are refused.
- **pi-sessions host** — with pi-sessions 0.15.0 or later, a handoff launches its child as a managed swb session instead of a tmux split or Ghostty window. A message to a dormant swb session wakes it and delivers; pi-sessions 0.16.0 builds its index on its own, so this works on a fresh install.

### Fixed

- A session is tracked from its first turn, not its first user message. A pi-sessions handoff child, which starts with a custom message, used to never get a row. A provider retry after `swb_archive` no longer reopens the session.

## [0.1.0] - 2026-10-08

### Added

- **The Deck** — `swb` opens a roster of every open pi session, grouped by project, beside the selected session's real, interactive pi, its directory's editor, or a split of both.
- **Persistence** — sessions stay tracked from their first turn through quits, crashes, and reboots until archived. A session whose pi died mid-turn shows as Interrupted, and `w` or Enter wakes it where it left off.
- **Attention** — working, blocked, idle, and Unseen show live in the roster; sessions quiet for 72 hours fold into Inactive.
- **Moves** — pi-wt's `/mv` and `/wt` take the session with them, into the new directory's project, and it wakes there.
- **Scriptable surface** — `swb new`, `open`, `archive`, `unarchive`, `ls --json`, plus `swb drive` and `swb deck state` to drive a Deck exactly as a human does.
- **pi recorder** — `@thurstonsand/pi-agent-switchboard` records lifecycle, activity, and attention to the shared db, and says so in pi's footer when it can't.
- **`swb_archive`** — ask a managed pi to archive itself; it does, and quits once its final message lands.
