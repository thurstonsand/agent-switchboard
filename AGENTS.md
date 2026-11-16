# AGENTS.md

Agent Switchboard (`swb`) keeps track of every coding-agent session I start, from its first turn until I archive it, across quits, crashes, and reboots, and gets me back into any of them in one keystroke. Sessions run headless in a dedicated tmux server. `swb` opens a Deck: a roster of those sessions, showing which ones need me, beside the selected session's real, interactive pi, Claude Code, or Codex.

## Motivation

I run a lot of agent sessions in parallel, all on the command line. It gets hard to keep track of them all, ESPECIALLY when the machine reboots, closes a tab, or crashes, I lose track of which sessions were mid-flight and which were done. T3 Code and Amp Code get the workflow right: a sidebar of threads grouped by project, live status, and an explicit act that marks a thread finished. But it's a GUI app that I can't use on all my machines, so I must go afield. Herdr and agent-deck are the terminal-native answers. Herdr isn't available to me either, and agent-deck is hacky and unreliable. So this is the session-management functionality I need.

## Project context

See @CONTEXT.md for project vocabulary.

## Tenets

- Persistence first: a session stays tracked through every exit, crash, and reboot until I archive it
- The harness is a black box: `swb` never draws into or alters pi's, Claude Code's, or Codex's own screen, and never modifies the harness. The only exception is what a harness's line does through that harness's own extension API
- tmux is an execution engine and should not be directly interactible in a tmux-y way
- The TUI must be snappy: move processing to the background as much as possible, keeping the TUI fast to navigate, with loaders in place as needed
- Say it once: each piece of state appears in exactly one place on screen. A second badge, line, or header saying the same thing costs space and splits attention
- Fail loudly: a line that can't record says so in its harness instead of silently drifting

## Developer notes

See @DEV.md for code style and commands.
