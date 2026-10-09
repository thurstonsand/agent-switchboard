# AGENTS.md

Agent Switchboard (`swb`) keeps track of every coding-agent session I start, from its first turn until I archive it, across quits, crashes, and reboots, and gets me back into any of them in one keystroke. Sessions run headless in a dedicated tmux server. `swb` opens a Deck: a roster of those sessions, showing which ones need me, beside the selected session's real, interactive pi.

## Motivation

I run a lot of agent sessions in parallel, all on the command line. It gets hard to keep track of them all, ESPECIALLY when the machine reboots, closes a tab, or crashes, I lose track of which sessions were mid-flight and which were done. T3 Code and Amp Code get the workflow right: a sidebar of threads grouped by project, live status, and an explicit act that marks a thread finished. But it's a GUI app that I can't use on all my machines, so I must go afield. Herdr and agent-deck are the terminal-native answers. Herdr isn't available to me iether, and agent-deck is hacky and unreliable. So this is the session-management functionality I need, built for the terminal and for Pi.

## Project context

See @CONTEXT.md for project vocabulary.

## Tenets

- Persistence first: a session stays tracked through every exit, crash, and reboot until I archive it
- pi is a black box: `swb` never draws into or alters pi's own screen. The only exception is anything in scope for the recorder extension
- tmux is an execution engine and should not be directly interactible in a tmux-y way
- The TUI must be snappy: move processing to the background as much as possible, keeping the TUI fast to navigate, with loaders in place as needed
- Say it once: each piece of state appears in exactly one place on screen. A second badge, line, or header saying the same thing costs space and splits attention
- Fail loudly: a recorder that can't record says so in pi's footer instead of silently drifting

## Features

- `swb`: opens a Deck where the last one in this Project left off. The roster lists Operators, then open sessions grouped by project, then Inactive, then Archived. Beside it, the Stage shows the selected session as pi, its directory's editor, or a split of both
- `swb -c`: opens a Deck in pi on this Project's most recent session, or a new one
- Operators: sessions in swb's Operator folder that coordinate the rest, reading only that folder's AGENTS.md
- `swb new`, `open`, `adopt`, `archive`, `unarchive`, `ls --json`: the scriptable surface
- `swb drive` and `swb deck state`: an agent drives a Deck exactly as a human does, and captures its screen as text
- The pi recorder extension: lifecycle, activity, and attention written to the shared db; it also registers swb as a pi-sessions host for handoffs, dormant discovery, and wake

## Developer notes

See @DEV.md for code style and commands.
