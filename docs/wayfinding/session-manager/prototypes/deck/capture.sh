#!/usr/bin/env bash
# PROTOTYPE. Regenerates captures/ by driving the Deck through the agent driver, exactly as an agent would.
# Every capture is a .txt (plain), an .ansi (cat it in a terminal), and a .state.json (the Deck's view state).
# The copy captures write the macOS clipboard; it's saved first and restored on exit.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf captures
mkdir -p captures
clip=$(mktemp)
pbpaste >"$clip"
trap 'pbcopy <"$clip"; rm -f "$clip"' EXIT

d() { bun drive.ts "$@"; }
snap() { d snap "$1" >/dev/null; echo "  $1"; }
# Moves the cursor the way a human would: filter to the title, keep it, then clear the filter. The clear uses
# ctrl+u rather than esc, because an esc followed closely by a synthetic key reaches the roster as an Alt chord.
goto() { d keys / -l "$1" Enter / C-u Enter; sleep 0.1; }
# The capture row and column of the first match of a text, 0-based.
cell() { d capture | python3 -c "import sys; t=sys.argv[1]; ls=sys.stdin.read().split('\n'); r=next(i for i,l in enumerate(ls) if t in l); print(len(ls[r][:ls[r].index(t)]), r)" "$1"; }
# Waits for the blocked glyph's next flash phase to begin, then snaps it: 1 is full (bold), 2 is dim.
snap_phase() {
	local want=$'\e['"$1"$'m\e[38;2;192;132;252m'
	until d capture --ansi | grep -aqF "$want"; do sleep 0.03; done
	snap "$2"
}
copy_drag() { # <text on screen> <cells> <capture name>
	read -r col row < <(cell "$1")
	echo "SENTINEL" | pbcopy
	d drag "$col" "$row" $((col + $2 - 1)) "$row"
	sleep 0.6
	snap "$3"
	pbpaste >"captures/$3.clipboard.txt"
	echo "    pbpaste: $(cat "captures/$3.clipboard.txt")"
}

echo "140x40, lazy hover (the default)"
d start --fresh --size 140x40
d wait stage.kind=live >/dev/null
sleep 1.6 # let the prestarted sessions finish their own startup
snap 140-01-initial

echo "lazy: a dormant row shows its last prompt and reply; w wakes it"
d keys j # Schema v1 grilling: dormant and unseen
sleep 0.9
snap lazy-01-dormant-card
d keys w
sleep 0.3
snap lazy-02-woken-loading
d wait stage.kind=live >/dev/null
snap lazy-03-live
sleep 1.1
snap lazy-04-visited

echo "⏎ on a dormant row: the keyboard stays in the roster, focus follows once pi is up"
goto "canary"
d keys Enter
sleep 0.3
snap enter-01-starting-keyboard-stays
d wait focus=stage >/dev/null
snap enter-02-focused-once-up

echo "M-a h / l, and h / l in the roster"
d keys M-a h
sleep 0.3
snap nav-01-M-a-h-to-roster
d keys M-a l
sleep 0.3
snap nav-02-M-a-l-to-session
d keys M-a h
sleep 0.3
d keys l
sleep 0.3
snap nav-03-l-on-session-focuses-it
d keys M-a h
sleep 0.3
d keys h
snap nav-04-h-to-project-header
d keys h
snap nav-05-h-collapses-header
d keys l
snap nav-06-l-expands-header

echo "header clicks (synthetic SGR mouse)"
read -r col row < <(cell "harbor-deploy")
d click "$col" "$row"
sleep 0.2
snap click-01-project-header-collapsed
sleep 0.6 # past the double-click window
d click "$col" "$row"
sleep 0.2
snap click-02-project-header-expanded
read -r col row < <(cell "Inactive (")
d click "$col" "$row"
sleep 0.2
snap click-03-inactive-section-expanded
sleep 0.6
d click "$col" "$row"

echo "blocked: ◆ flashes in #c084fc at 1 Hz"
goto "flaky"
d keys k # onto the project header, so only the row's glyph animates
snap_phase 1 blocked-01-flash-full
snap_phase 2 blocked-02-flash-dim

echo "eager hover (H), navigating away during loading, snapping back"
d keys H
goto "schema" # live since lazy-02; the row above Recorder footer status
d keys j # Recorder footer status (worktree), dormant
snap eager-01-countdown
sleep 0.75
snap eager-02-loading
d keys j j # past the ansiblonomicon header onto Fix fnox host routing (live, unseen)
snap eager-03-moved-on-instantly
sleep 1.6
d keys k k
snap eager-04-back-snapped-to-live
d keys H

echo "focus into the session and type"
goto "recorder"
d keys Enter
d wait focus=stage >/dev/null
d keys -l "what does the footer show when the db is locked?"
snap focus-01-typing
d keys S-Enter -l "and in the status line?"
snap focus-02-shift-enter-through-three-tmux-layers
d keys Enter
sleep 0.4
snap focus-03-working
sleep 3
snap focus-04-replied

echo "copy by highlighting: fullscreen pi selects and copies on its own"
copy_drag "A failed write sets" 30 copy-01-fullscreen-pi-drag

echo "editor swap"
d keys M-a e
sleep 2.5
snap editor-01-nvim
d keys M-a e
sleep 0.3
snap editor-02-back-to-pi

echo "zoom"
d keys M-a z
sleep 0.4
snap zoom-01-zoomed
d keys M-a h
sleep 0.3
snap zoom-02-M-a-h-unzooms-to-roster

echo "help, and the M-a M-a passthrough"
d keys M-a '?'
sleep 0.4
snap help-01-popup
d keys q
sleep 0.2
d keys M-a l M-a M-a '['
sleep 0.4
snap passthrough-01-inner-copy-mode
d keys q
d keys M-a h
sleep 0.2

echo "archive refused"
goto "deck mock" # mid-turn
d keys a
sleep 0.2
snap archive-01-refused

echo "archive + undo"
goto "recorder" # live, idle, and its worktree editor is open
d keys a
sleep 0.4
snap archive-02-archived-pi-and-editor-killed
d keys u
sleep 0.3
snap archive-03-undone
goto "schema" # shares the project root with Deck mock round 2
d wait stage.kind=live >/dev/null
d keys M-a e
sleep 1.5
d keys M-a e
d keys a
sleep 0.4
snap archive-04-shared-dir-editor-kept
d keys u

echo "Archived is an inline section; a toggles"
d keys G
sleep 0.2
snap archived-01-inline-collapsed
d keys Enter
sleep 0.3
snap archived-02-inline-expanded
d keys j
sleep 0.9
snap archived-03-row-card
d keys a
sleep 0.3
snap archived-04-a-unarchived
goto "unifi"
d keys a
sleep 0.3
snap archived-05-a-archives-again

echo "not running"
goto "fnox" # live
d keys Enter
d wait focus=stage >/dev/null
d keys -l /quit Enter
sleep 0.6
snap notrunning-01-pi-quit-while-on-view
d keys j
sleep 0.2
d keys k
sleep 0.8
snap notrunning-02-back-shows-summary

echo "interrupted: waits for w, and pi comes back plain"
goto "pod042"
sleep 0.8
snap interrupted-01-card
d keys w
d wait stage.kind=live >/dev/null
snap interrupted-02-live-plain-pi

echo "unfocused Deck: a turn that finishes on view is still unseen"
goto "flaky" # blocked on a permission prompt
d wait stage.kind=live >/dev/null
d keys Enter
d wait focus=stage >/dev/null
snap blocked-03-permission-prompt
d focus out
d keys y
sleep 4.5
snap visit-01-unfocused-finished-unseen
d focus in
sleep 0.2
snap visit-02-focused-seen-at-once
sleep 1.1
d state >captures/visit-03-visited.state.json

echo "theme: the stand-in terminal (Gruvbox Light Hard) switches to Dark Hard live"
d keys M-a h
goto "canary" # live, on view
sleep 0.5
snap theme-01-light
d theme dark
sleep 3
snap theme-02-dark-live-switch
goto "retire" # dormant: the card is drawn by the placeholder with ANSI colors, so it follows on its own
sleep 0.5
snap theme-03-dark-card
goto "flaky" # live, but not on view during the switch
sleep 1
snap theme-04-dark-once-viewed
d theme light
sleep 3
snap theme-05-light-again

echo "perf: key → right-pane repaint, measured outside the Deck, with ◆ flashing"
d keys M-a h
goto "flaky"
d bench 30 >captures/perf-bench.json
d state >captures/perf-final.state.json
cp /tmp/swb-mock-PROTOTYPE/deck-drive.log captures/deck-drive.log
cp /tmp/swb-mock-PROTOTYPE/sessions-hooks.log captures/sessions-hooks.log
d stop

echo "100x30"
d start --size 100x30
sleep 1
snap 100-01-initial
d keys j
sleep 0.2
snap 100-02-dormant-card
d stop
echo "resize 100x30 → 160x45 live"
d start --size 100x30
d resize 160x45
sleep 0.6
snap resize-01-160x45
d stop

echo "copy by highlighting: regular-mode pi, through the sessions server's copy mode and OSC 52"
d start --fresh --pi regular
d wait stage.kind=live >/dev/null
sleep 1.6
copy_drag "build round 2 of the Deck" 30 copy-02-regular-pi-drag
for s in swb-mock swb-mock-ui swb-mock-drive; do echo "$s: $(tmux -L $s show-buffer)"; done >captures/copy-02-regular-pi-drag.buffers.txt

d reset
echo "done; all mock servers killed"
