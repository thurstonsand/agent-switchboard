#!/usr/bin/env bash
# Regenerates captures/ by driving the prototype inside a private tmux server.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
T=(tmux -L swb-proto)
mkdir -p "$DIR/captures"
rm -f "$DIR/captures/"*

start() {
	"${T[@]}" kill-server 2>/dev/null || true
	"${T[@]}" -f /dev/null new-session -d -s proto -x "$1" -y "$2" -c "$DIR" -e SWB_TICK=off "bun run start; sleep 600"
	"${T[@]}" set-option -g status off
	"${T[@]}" resize-window -t proto -x "$1" -y "$2"
	sleep 1.5
}
# One key per send: tmux would otherwise deliver "Escape G" as alt+G, and four dots in the same millisecond.
keys() {
	if [[ $1 == -l ]]; then
		"${T[@]}" send-keys -t proto -l "$2"
	else
		for k in "$@"; do
			"${T[@]}" send-keys -t proto "$k"
			sleep 0.15
		done
	fi
	sleep 0.4
}
cap() {
	"${T[@]}" capture-pane -e -p -t proto >"$DIR/captures/$1.ansi"
	"${T[@]}" capture-pane -p -t proto >"$DIR/captures/$1.txt"
}

scenario() {
	local w=$1
	cap "$w-01-initial"
	keys j j
	cap "$w-02-cursor-on-uvlock"
	keys a
	cap "$w-03-archived-with-undo"
	keys u
	cap "$w-04-undone"
	keys . . . .
	cap "$w-05-after-4-ticks"
	keys /
	keys -l flak
	cap "$w-06-filter-typing"
	keys Enter
	cap "$w-07-filter-kept"
	keys Escape G Enter
	cap "$w-08-archived-view"
	keys j U
	cap "$w-09-unarchived"
	keys Escape g
}

start 80 24
scenario 80
keys G k Enter j j
cap 80-10-inactive-expanded
keys v v v
cap 80-11-variant-D-stacked
keys V
cap 80-12-variant-forced-C
keys '?'
cap 80-13-help
keys x g j j Enter
cap 80-14-enter-toast
keys y
cap 80-15-copy-toast
pbpaste >"$DIR/captures/80-15-clipboard.txt"
keys Y
pbpaste >"$DIR/captures/80-16-clipboard-session-ref.txt"

start 140 32
scenario 140
keys v
cap 140-10-variant-forced-A
keys v v
cap 140-11-variant-D-stacked
keys v t
sleep 10
cap 140-12-live-tick

start 100 28
keys j j
cap resize-01-100-cols
"${T[@]}" resize-window -t proto -x 140 -y 28
sleep 0.6
cap resize-02-140-cols
"${T[@]}" resize-window -t proto -x 100 -y 28
sleep 0.6
keys '[' '['
cap resize-03-100-cols-breakpoint-100

"${T[@]}" kill-server
