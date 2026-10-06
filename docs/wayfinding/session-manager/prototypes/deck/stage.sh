#!/bin/sh
# PROTOTYPE. The Stage pane: a nested client of the mock sessions server. Whenever it drops (its session died,
# or someone detached it), it re-attaches to the Deck's current target, falling back to the placeholder.
# Usage: stage.sh <deck id> <state dir>
deck=$1
state=$2
# tmux learns a terminal's colors when its client attaches, and the nested client inherits whatever the UI
# server knew at that moment. Attaching before the real terminal has means pi sees no colors at all.
until env -u TMUX tmux -L swb-mock-ui list-clients -t "=deck-$deck" 2>/dev/null | grep -q .; do sleep 0.05; done
while :; do
	target=$(cat "$state/deck-$deck.target" 2>/dev/null)
	env -u TMUX tmux -L swb-mock attach -t "=$target" >/dev/null 2>&1 ||
		env -u TMUX tmux -L swb-mock attach -t "=__stage-$deck" >/dev/null 2>&1 ||
		sleep 0.2
done
