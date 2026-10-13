# Agent Switchboard

`swb` keeps track of every pi session I start, from its first turn until I archive it, across quits, crashes, and reboots, and gets me back into any of them in one keystroke.

Sessions run headless in a dedicated tmux server. `swb` opens a Deck: a roster of those sessions, showing which ones need me, beside the selected session's real, interactive pi.

## Install

`swb` needs tmux 3.7 or newer and pi 1.0.4 or newer.

1. The `swb` binary, for linux-x64 or darwin-arm64, from the [latest release](https://github.com/thurstonsand/agent-switchboard/releases/latest), or with mise:

   ```sh
   mise use -g github:thurstonsand/agent-switchboard
   ```

2. The pi recorder extension, from npm, or from this repo's generated `pi` branch where an npm mirror lags:

   ```sh
   pi install npm:@thurstonsand/pi-agent-switchboard
   pi install git:github.com/thurstonsand/agent-switchboard@pi
   ```

## Use

```text
swb                          open a Deck where the last one in this Project left off
swb -c, --continue           open a Deck in pi on this Project's most recent session, or a new one
swb new [--cwd DIR]          open a Deck on a new pi session
swb open ID                  open a Deck on a session
swb adopt ID|TRANSCRIPT      track a session pi ran outside swb, then open it; quit that pi first
swb ls [--json]              list sessions with derived state
swb dirs [--json]            list the directories n offers for a new session
swb archive ID               archive a session
swb unarchive ID             reopen an archived session
swb launch --cwd DIR --session-id ID --model M   start a session managed, in the background
swb wake ID                  start a dormant session's pi in the background
```

### With pi-sessions

Inside a managed session, the recorder registers swb as a pi-sessions host, so `session_handoff` offers `launch: "swb"` in place of tmux and Ghostty splits. The child starts managed and lands on the roster. `session_reachable` lists dormant sessions too, and `session_send_message` to one wakes it first. Subagents still run in their parent's tmux and never become sessions.

In the roster, `j`/`k` move, `Enter` focuses the session (waking it if it's dormant), `w` wakes it in the background, `x` stops its pi and keeps it open, `n` picks a directory for a new session, starting from the highlighted one, `N` adds a directory and starts one there, `a` archives or unarchives, `m` picks the session's Group from a list or names a new one (or renames one from its header), `/` filters, and `q` quits. `M-a` is the Deck's prefix from anywhere: `M-a h`/`M-a l` move between the roster and the Stage, `Tab` returns to the pane you left, `M-a e` swaps pi and the editor and focuses it, `M-a v` splits them, `M-a s` opens the directory's shell under pi (`ctrl-d` closes it), `M-a z` hides the roster, `M-a n`/`M-a N`/`M-a j`/`M-a k` and the other roster keys work after it too, `M-a q` closes the Deck, `M-a ?` lists the rest. `ctrl-h`/`j`/`k`/`l` move between panes; with nvim as the editor they walk its windows first and step off its edge into the Deck. Dragging a session onto a Group, or anywhere beneath one, moves it there. Clicking a session focuses it, and the tabs under the roster and its legend are clickable.

`n`'s picker lists each repository with its worktrees beneath it, alongside plain directories: those under `[dirs]`, every directory a session is in, and ones added with `N`. Typing filters it, best match first. `M-a d`, or the `✕` on the highlighted row, removes a directory from the list, and a repository's worktrees go with it; adding it again with `N` brings it back. A directory that no longer exists drops off on its own.

### Operators

The Operators section sits atop the roster: sessions that coordinate the others rather than work in a Project. `n` on it starts one in `~/.config/agent-switchboard/operator`, whose AGENTS.md, which swb keeps current, makes it the dispatcher. An Operator reads only that AGENTS.md, not the user-level one or any above it, and reaches the other sessions through pi-sessions. Its new sessions are always swb-managed handoffs; its pi-sessions settings turn off subagents and deferred handoffs, which the Deck can't see. To promote an existing session, `/mv` it into that folder.

## Settings

`${XDG_CONFIG_HOME:-~/.config}/agent-switchboard/config.toml`. Unknown keys are an error.

```toml
hover = "lazy"            # "eager" starts a dormant session's pi after 500 ms on its row
editor = "nvim"           # defaults to $EDITOR
inactive_after = "72h"    # open sessions idle this long move to Inactive
reap_after = "30m"        # an idle live pi nobody is viewing is stopped after this long
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
