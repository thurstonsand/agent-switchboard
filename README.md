# Agent Switchboard

`swb` keeps track of every coding-agent session I start, in pi, Claude Code, or Codex, from its first turn until I archive it, across quits, crashes, and reboots, and gets me back into any of them in one keystroke. The sessions can message each other, across harnesses and projects.

Sessions run headless in a dedicated tmux server. `swb` opens a Deck: a roster of those sessions, showing which ones need me, beside the selected session's real, interactive pi, Claude Code, or Codex.

## Install

`swb` needs tmux 3.7 or newer and pi 1.2.0 or newer.

1. The `swb` binary, for linux-x64 or darwin-arm64, from the [latest release](https://github.com/thurstonsand/agent-switchboard/releases/latest), or with mise:

   ```sh
   mise use -g github:thurstonsand/agent-switchboard
   ```

2. The pi line, swb's pi extension, from npm, or from this repo's generated `pi` branch where an npm mirror lags. With pi-sessions, it needs pi-sessions 0.19.0 or later:

   ```sh
   pi install npm:@thurstonsand/pi-agent-switchboard
   pi install git:github.com/thurstonsand/agent-switchboard@pi
   ```

## Use

```text
swb                          open a Deck where the last one in this Project left off
swb -c, --continue           open a Deck on this Project's most recent session, or a new one
swb new [--cwd DIR] [--harness pi|claude|codex]   open a Deck on a new session
swb open ID                  open a Deck on a session
swb adopt ID|TRANSCRIPT      track a pi, Claude Code, or Codex session run outside swb, then open it; quit it first
swb ls [--json]              list sessions with derived state
swb dirs [--json]            list the directories n offers for a new session
swb archive ID               archive a session
swb unarchive ID             reopen an archived session
swb snooze ID one_hour|one_day|monday|next_message|off|TIME   snooze a session; TIME is ISO 8601, local unless it has an offset
swb quit [--force]           stop every session, Deck, and swb's clock; sessions stay open
swb wake ID                  start a dormant session in the background
swb models [--harness H] [QUERY]   list every model and agent the harnesses offer
swb launch [--harness H] [--model M] [--effort E] [--agent A] [--cwd DIR] [--from ID] [--title T]   start a new session in the background on a preset, or the default; its goal on stdin
swb send --from ID --to ID [--request-response] [--cancel]   message a session, waking it if dormant; the body on stdin
```

### Harnesses

swb runs Claude Code (2.1.300 or later) and Codex CLI (0.149 or later) the way it runs pi: the real TUI, in swb's tmux server, on the roster. Each plugs in through a **line** that swb ships and loads itself, so there is nothing else to install: Claude Code gets a plugin with a mod, and Codex runs on a private app-server that swb starts with it. `n`'s picker opens on the default preset, and `Tab` steps through the rest of the shortlist (see Settings).

Every managed session's agent gets the same tools, whatever its harness:

- `session_reachable`: every other open session, in any harness or project, live or dormant, with its Group if it's in one
- `session_send_message`: a message to one of them, arriving mid-turn when it's working, or starting a turn when it's idle; a dormant one is woken first
- `session_cancel`: stops another session's turn
- `session_launch`: starts a new session in any harness, whose first turn is the goal it's given
- `session_schedule`: a message for later, once (`at`: an ISO 8601 time or duration) or on a 5-field cron, to this session, another, or a new session launched when it fires; `snooze` snoozes the recipient until then
- `session_schedules` and `session_unschedule`: the schedules a session set or receives, and cancelling one
- `swb_update_session`: archives, unarchives, snoozes, or unsnoozes a session, moves it into a Group, or retitles it, any of them in one call. `family` archives everything it started too; a member mid-turn, blocked, cut off, or errored refuses the whole call by name, changing nothing, until `force` archives it anyway and cancels the turn. A new title becomes the harness's own name: pi and Codex take it at once, a dormant one as it starts, and Claude Code with its next prompt. Renaming the session in its harness later wins
- `swb_show_session`: takes you to another session, moving the Deck you're watching this one in onto it and starting it if it's dormant, as clicking its row would; `view` (`agent`, `editor`, or `split`) opens it in a given view instead of the one it was last left in

Messages wait in swb's db until their session takes them, so one sent to a session that's starting, or whose sender has quit, still arrives. Claude Code takes a message at its next tool call, or as a new turn when idle; pi and Codex steer the running turn. Codex's own `/archive` archives the session in swb too.

swb's clock runs in its tmux server, which stays up after every Deck closes, so schedules fire with no Deck open, waking a dormant recipient. After a reboot it starts with the first `swb`; anything due meanwhile, or while the machine slept, fires then, and the message says when it was scheduled for and when it arrived. A recurring schedule that missed several runs fires once. Claude Code's own scheduler (`CronCreate`, `/loop`) is switched off in sessions swb runs, since it dies with its process. `swb quit` stops everything; sessions stay open and schedules wait for the next `swb`.

A snoozed session waits in the roster's Snoozed section, folded like Archived, each row saying when it wakes, `↘` for its next message. A timed snooze holds through any conversation; `next_message` ends with the next message or prompt. Blocked, cut off, or errored, it shows in its usual place anyway, and when its time runs out it comes back Unseen, so it can't fold into Inactive before you've looked.

An idle session nobody is viewing stops after `reap_after`, and an upgrade stops idle sessions; pi and Claude Code get their unsent prompt back on the next wake. Codex has no way for swb to read its prompt box, so a Codex session loses an unsent prompt when it stops.

### With pi-sessions

Inside a managed pi, swb owns coordination between sessions, so pi-sessions keeps only its subagent tools (`subagent_launch`, `subagent_send`, and the rest). Subagents still run in their parent's tmux and never become sessions. A pi launched by another session records its parent where pi-sessions sees it, so the lineage survives the session leaving swb. The roster nests a session under the one that started it, and marks one whose parent sits elsewhere `↳`, or `⌁` when an Operator started it.

In the roster, `j`/`k` move, `Enter` focuses the session (waking it if it's dormant), `w` wakes it in the background (either one continues a turn its process died in), `x` stops its agent and keeps it open, `n` picks a directory for a new session, starting from the highlighted one, `N` adds a directory and starts one there, `a` archives or unarchives (on a session that started others still open, it asks first whether they go too), `s` snoozes for an hour, a day, a week, or until its next message, or unsnoozes, `p` goes to the session that started this one, `h`/`l` fold and open the family under a session, `m` picks the session's Group from a list or names a new one (or renames one from its header), `/` filters, and `q` quits. Every pane names itself on its top edge, the one with the keyboard lit. `M-a` is the Deck's prefix from anywhere, and while it's down, the other panes show the key that reaches them: `M-a h`/`j`/`k`/`l` move to the pane that way, `Tab` returns to the pane you left, `M-a J`/`M-a K` stage the next or previous session from anywhere, as `M-a j`/`k` do in the roster, `M-a e` swaps the agent and the editor and focuses it, `M-a v` splits them, `M-a s` opens the directory's shell under the agent (`ctrl-d` closes it), `M-a z` hides the roster, `M-a S` snoozes or unsnoozes, `M-a n`/`M-a N` and the other roster keys work after it too, `M-a q` closes the Deck, `M-a ?` lists the rest. `ctrl-h`/`j`/`k`/`l` move between panes; with nvim as the editor they walk its windows first and step off its edge into the Deck, and its line highlight shows only while it has the keyboard. Dragging a session onto a Group, or anywhere beneath one, moves it there. Hovering a session, or moving onto it with `j`/`k`, opens its Peek beside it: its full title, state, directory and branch, its last turn, and its keys as buttons, which act on that session wherever the cursor is. The Peek goes when the pointer leaves the roster and the Peek, or a key is typed outside the roster. A narrow Deck, with no Stage beside the roster, draws the Peek at the roster's right edge instead. Clicking a session focuses it, and the tabs under the roster (`shell` among them) and its legend are clickable; any control lights up under the pointer. While the Stage fills the Deck, `◂` at the top brings the roster back.

`n`'s picker lists each repository with its worktrees beneath it, alongside plain directories: those under `[dirs]`, every directory a session is in, and ones added with `N`. Typing filters it, best match first. `M-a d`, or the `✕` on the highlighted row, removes a directory from the list, and a repository's worktrees go with it; adding it again with `N` brings it back. A directory that no longer exists drops off on its own.

### Operators

The Operators section sits atop the roster: sessions that coordinate the others rather than work in a Project. `n` on it opens the picker on `~/.config/agent-switchboard/operator`, where `Tab` picks its preset; that folder's AGENTS.md, which swb keeps current, makes it the dispatcher. An Operator reads only that AGENTS.md, not the user-level one or any above it, and reaches the other sessions through swb's tools. Codex is the exception: it always reads `~/.codex/AGENTS.md`. Its new sessions are always `session_launch`es, in whichever harness suits the work, and its subagents are off, since the Deck can't see them. It can't start another Operator. Settings' Operators section holds your own instructions, which swb adds after its own in that AGENTS.md. To promote an existing pi session, `/mv` it into that folder.

## Settings

`,` in the roster, or `M-a ,` from anywhere, opens Settings across the whole Deck: every setting by section, with search (`/`) over names, descriptions, and the words you'd look for. A value is dim while it's the default and bright once you set it, and setting it back to the default takes it out of the file. Toggles and choices save at once; the rest edit in place and save on `⏎`. Every key works by mouse too. Changes apply to every open Deck as soon as they're saved, whether from Settings or by hand.

Behind it is `${XDG_CONFIG_HOME:-~/.config}/agent-switchboard/config.toml`, which Settings edits in place, so your comments stay, except the ones on a key it removes. A file swb can't read stops every new swb command with the line at fault; an open Deck keeps what it had, says so in red, and `O` opens the file at that line.

The Harnesses section holds the shortlist: the presets, each a harness, a model and effort or a Claude Code agent, and a note, that `n`'s picker offers (it opens on the ★ default, and `Tab` steps through the rest) and that agents choose from in `session_launch`. Until you edit it, swb makes one from each harness's own list, up to four each from Claude Code and Codex and two from pi; your first edit writes that list into the file, and `r` on it brings the automatic one back. `swb models` lists everything the harnesses offer.

<!-- settings:start (generated by scripts/settings-readme.ts) -->
```toml
wake_on_highlight = false # true starts a dormant session after the cursor rests 500 ms on its row
roster_width = 42         # columns, or a share of the Deck like "25%"; never more than half
inactive_after = "72h"    # open sessions idle this long, with all they started, move to Inactive
reap_after = "30m"        # an idle live session nobody is viewing is stopped after this long
harnesses = ["pi", "claude", "codex"] # which harnesses new sessions may start in; all of them by default
warn_long_shortlist = true # Settings warns once the shortlist passes 10 entries
editor = "nvim"           # defaults to $EDITOR
clipboard = "wl-copy"     # defaults to wl-copy, else xclip, else pbcopy

[operator]
instructions = "Prefer Codex for anything in Rust." # after swb's own, in every Operator's AGENTS.md; up to 16,000 characters

[dirs]
scan = ["~/code"]         # git checkouts and their worktrees beneath these; none by default
depth = 2                 # how far beneath each to look, 1 to 10; a checkout is never entered
include = ["~/notes"]     # always offered, git or not
exclude = ["dotfiles"]    # like .gitignore: a bare name anywhere, a pattern with a slash under each scan root, or one ~/ path
sort = "name"             # "recent" puts directories with the latest session activity first

[keys]
prefix = "M-a"            # as tmux spells it

[[targets]]                 # the shortlist; without any, swb makes one from each harness's own
harness = "claude"          # "pi", "claude", or "codex"
model = "opus"
effort = "high"             # off, minimal, low, medium, high, xhigh, max, ultra, as the harness takes them
use = "Hard design and review" # a line for agents choosing among them
default = true              # what n opens on and agents get when they pick none; else the first

[[targets]]
harness = "pi"
provider = "openrouter"     # pi's targets name their provider
model = "moonshotai/kimi-k3"
effort = "low"

[[targets]]
harness = "claude"
agent = "Explore"           # Claude Code only: the whole session runs as this agent, on its model and effort
```
<!-- settings:end -->

## Development

See [DEV.md](DEV.md). The design lives in [docs/designs/01-agent-switchboard.md](docs/designs/01-agent-switchboard.md).

## License

MIT
