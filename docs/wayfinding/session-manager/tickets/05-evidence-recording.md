---
status: closed
type: research
blocked-by: []
---

# Recording video evidence on the work Mac

## Question

The implementation must ship with recorded videos of the tool working through realistic scenarios. What is the most reliable, scriptable way to produce them on the work Mac?

- **TUI-only scenarios** (roster rendering, archive/undo, sections, filter): charmbracelet `vhs` tapes or an equivalent. Check availability through Homebrew or the work Go proxy, output formats, and whether it can drive a Bubble Tea v2 app.
- **Ghostty-integrated scenarios** (open a viewer tab, focus an existing viewer, revive after reboot): screen recording of the real Ghostty window. Options are `screencapture -v`, ffmpeg avfoundation, or others. Cover the permission prompts (Screen Recording TCC) on a managed corporate Mac, cropping to one window, and driving input reproducibly (gty input, AppleScript, tmux send-keys).
- **Reboot simulation**: how to demonstrate reboot survival without rebooting (kill the tmux server and pi processes, change boot id?), and what an honest demo needs.
- Where artifacts should live (not in git, or git-lfs?) and how to hand them to Thurston for review.

Verify on this machine where possible.

## Resolution

Use VHS tapes and MP4 renders for deterministic TUI evidence; use the built-in `screencapture` for real Ghostty evidence only after approved Screen Recording access, driven through `gty input` or `tmux send-keys`. Demonstrate reboot-relevant behavior as explicitly labeled isolated process loss, not a forged reboot, and keep rendered videos out of Git by attaching them to the PR or a release. See [the findings](../research/evidence-recording.md).
