# Agent Switchboard

`swb` keeps track of every coding-agent session I start, in pi, Claude Code, or Codex, from its first turn until I archive it, across quits, crashes, and reboots, and gets me back into any of them in one keystroke. The sessions can message each other, across harnesses and projects.

Sessions run headless in a dedicated tmux server. `swb` opens a Deck: a roster of those sessions, showing which ones need me, beside the selected session's real, interactive pi.

## Install

`swb` needs tmux 3.7 or newer and pi 1.0.4 or newer.

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
swb -c, --continue           open a Deck in pi on this Project's most recent session, or a new one
swb new [--cwd DIR] [--harness pi|claude|codex]   open a Deck on a new session
swb open ID                  open a Deck on a session
swb adopt ID|TRANSCRIPT      track a session pi ran outside swb, then open it; quit that pi first
swb ls [--json]              list sessions with derived state
swb dirs [--json]            list the directories n offers for a new session
swb archive ID               archive a session
swb unarchive ID             reopen an archived session
swb wake ID                  start a dormant session in the background
swb launch --harness H [--cwd DIR] [--from ID] [--title T]   start a new session in the background; its goal on stdin
swb send --from ID --to ID [--request-response] [--cancel]   message a session, waking it if dormant; the body on stdin
```

### Harnesses

swb runs Claude Code (2.1.287 or later) and Codex CLI (0.149 or later) the way it runs pi: the real TUI, in swb's tmux server, on the roster. Each plugs in through a **line** that swb ships and loads itself, so there is nothing else to install: Claude Code gets a plugin with a mod, and Codex runs on a private app-server that swb starts with it. `n`'s picker starts pi by default; `Tab` in it cycles to Claude Code and Codex, and `harness` in the settings changes the default.

Every managed session's agent gets the same tools, whatever its harness:

- `session_reachable`: every other open session, in any harness or project, live or dormant
- `session_send_message`: a message to one of them, arriving mid-turn when it's working, or starting a turn when it's idle; a dormant one is woken first
- `session_cancel`: interrupts another session's turn
- `session_launch`: starts a new session in any harness, whose first turn is the goal it's given
- `swb_update_session`: archives or unarchives a session

Messages wait in swb's db until their session takes them, so one sent to a session that's starting, or whose sender has quit, still arrives. Claude Code takes a message at its next tool call, or as a new turn when idle; pi and Codex steer the running turn. Codex's own `/archive` archives the session in swb too.

An idle session nobody is viewing stops after `reap_after`, and an upgrade stops idle sessions; pi and Claude Code get their unsent prompt back on the next wake. Codex has no way for swb to read its prompt box, so a Codex session loses an unsent prompt when it stops.

### With pi-sessions

Inside a managed pi, swb owns coordination between sessions, so pi-sessions keeps only its subagent tools (`subagent_launch`, `subagent_send`, and the rest). Subagents still run in their parent's tmux and never become sessions. A pi launched by another session records its parent where pi-sessions sees it, so the lineage survives the session leaving swb.

In the roster, `j`/`k` move, `Enter` focuses the session (waking it if it's dormant), `w` wakes it in the background, `x` stops its pi and keeps it open, `n` picks a directory for a new session, starting from the highlighted one, `N` adds a directory and starts one there, `a` archives or unarchives, `m` picks the session's Group from a list or names a new one (or renames one from its header), `/` filters, and `q` quits. `M-a` is the Deck's prefix from anywhere: `M-a h`/`M-a l` move between the roster and the Stage, `Tab` returns to the pane you left, `M-a e` swaps pi and the editor and focuses it, `M-a v` splits them, `M-a s` opens the directory's shell under pi (`ctrl-d` closes it), `M-a z` hides the roster, `M-a n`/`M-a N`/`M-a j`/`M-a k` and the other roster keys work after it too, `M-a q` closes the Deck, `M-a ?` lists the rest. `ctrl-h`/`j`/`k`/`l` move between panes; with nvim as the editor they walk its windows first and step off its edge into the Deck. Dragging a session onto a Group, or anywhere beneath one, moves it there. Hovering a session, or moving onto it with `j`/`k`, opens its Peek beside it: its full title, state, directory and branch, its last turn, and its keys as buttons, which act on that session wherever the cursor is. The Peek goes when the pointer leaves the roster and the Peek, or a key is typed outside the roster. A narrow Deck, with no Stage beside the roster, draws the Peek at the roster's right edge instead. Clicking a session focuses it, and the tabs under the roster (`shell` among them) and its legend are clickable; any control lights up under the pointer. While the Stage fills the Deck, `◂` at the top brings the roster back.

`n`'s picker lists each repository with its worktrees beneath it, alongside plain directories: those under `[dirs]`, every directory a session is in, and ones added with `N`. Typing filters it, best match first. `M-a d`, or the `✕` on the highlighted row, removes a directory from the list, and a repository's worktrees go with it; adding it again with `N` brings it back. A directory that no longer exists drops off on its own.

### Operators

The Operators section sits atop the roster: sessions that coordinate the others rather than work in a Project. `n` on it opens the picker on `~/.config/agent-switchboard/operator`, where `Tab` picks pi, Claude Code, or Codex; that folder's AGENTS.md, which swb keeps current, makes it the dispatcher. An Operator reads only that AGENTS.md, not the user-level one or any above it, and reaches the other sessions through swb's tools. Codex is the exception: it always reads `~/.codex/AGENTS.md`. Its new sessions are always `session_launch`es, in whichever harness suits the work, and its subagents are off, since the Deck can't see them. To promote an existing pi session, `/mv` it into that folder.

## Settings

`${XDG_CONFIG_HOME:-~/.config}/agent-switchboard/config.toml`. Unknown keys are an error.

```toml
wake_on_highlight = false # true starts a dormant session after the cursor rests 500 ms on its row
harness = "pi"            # what n starts: "pi", "claude", or "codex"; Tab in the picker cycles it
editor = "nvim"           # defaults to $EDITOR
inactive_after = "72h"    # open sessions idle this long move to Inactive
reap_after = "30m"        # an idle live session nobody is viewing is stopped after this long
clipboard = "wl-copy"     # defaults to wl-copy, else xclip, else pbcopy
roster_width = 42         # columns, or a share of the Deck like "25%"; never more than half
group_by = "project"      # "worktree" buckets each Project's ungrouped sessions by worktree branch

[dirs]                    # what n offers, beside every directory a session is in and ones added with N
scan = ["~/code"]         # git checkouts and their worktrees beneath these; none by default
depth = 2                 # how far beneath each to look, 1 to 10; a checkout is never entered
include = ["~/notes"]     # always offered, git or not
exclude = ["dotfiles"]    # like .gitignore: a bare name anywhere, a pattern with a slash under each scan root, or one ~/ path
sort = "name"             # "recent" puts directories with the latest session activity first

[keys]
prefix = "M-a"
```

## Development

See [DEV.md](DEV.md). The design lives in [docs/designs/01-agent-switchboard.md](docs/designs/01-agent-switchboard.md).

## License

MIT
