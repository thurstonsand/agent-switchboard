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
swb                          open a Deck
swb new [--cwd DIR]          open a Deck on a new pi session
swb open ID                  open a Deck on a session
swb adopt ID|TRANSCRIPT      track a session pi ran outside swb, then open it; quit that pi first
swb ls [--json]              list sessions with derived state
swb archive ID               archive a session
swb unarchive ID             reopen an archived session
swb launch --cwd DIR --session-id ID --model M   start a session managed, in the background
swb wake ID                  start a dormant session's pi in the background
```

### With pi-sessions

Inside a managed session, the recorder registers swb as a pi-sessions host, so `session_handoff` offers `launch: "swb"` in place of tmux and Ghostty splits. The child starts managed and lands on the roster. `session_reachable` lists dormant sessions too, and `session_send_message` to one wakes it first. Subagents still run in their parent's tmux and never become sessions.

In the roster, `j`/`k` move, `Enter` focuses the session (waking it if it's dormant), `w` wakes it in the background, `n` starts a new session in the highlighted directory, `N` in the one you ran `swb` from, `a` archives or unarchives, `/` filters, and `q` quits. `M-a` is the Deck's prefix from anywhere: `M-a h` returns to the roster, `M-a e` swaps pi and the editor and focuses it, `M-a z` hides the roster, `M-a n`/`M-a N`/`M-a j`/`M-a k` and the other roster keys work after it too, `M-a q` closes the Deck, `M-a ?` lists the rest. The tabs under the roster and its legend are clickable.

## Settings

`${XDG_CONFIG_HOME:-~/.config}/agent-switchboard/config.toml`. Unknown keys are an error.

```toml
hover = "lazy"            # "eager" starts a dormant session's pi after 500 ms on its row
editor = "nvim"           # defaults to $EDITOR
inactive_after = "72h"    # open sessions idle this long move to Inactive
reap_after = "30m"        # an idle live pi nobody is viewing is stopped after this long
clipboard = "wl-copy"     # defaults to wl-copy, else xclip, else pbcopy
roster_width = 42         # columns, or a share of the Deck like "25%"; never more than half

[keys]
prefix = "M-a"
```

## Development

See [DEV.md](DEV.md). The design lives in [docs/designs/01-agent-switchboard.md](docs/designs/01-agent-switchboard.md).

## License

MIT
