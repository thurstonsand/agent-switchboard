# The Deck by mouse alone: the hidden roster's way back, the shell tab, help closed by a click, and a narrow Deck's
# Peek, over the roster's edge. The drive harness plays the terminal, and the director clicks in it; the tape watches.
Source common.tape

Type "# by mouse alone: ◂ brings a hidden roster back; shell is a tab; a narrow Deck draws its Peek over the roster" Sleep 1s Enter
Hide
Type "swb drive start && tmux -L swb-drive-$SWB_INSTANCE attach" Enter
Show
Wait+Screen /show list/
Sleep 1s
Screenshot ../artifacts/phase6/videos/mouse-hidden.png
Wait+Screen /(?s)came from a click.*came from a click/
Sleep 1s
Screenshot ../artifacts/phase6/videos/mouse-shell.png
Wait+Screen /any key or click closes/
Sleep 1s
Screenshot ../artifacts/phase6/videos/mouse-help.png
Wait+Screen /Copy @session/
Sleep 1s
Screenshot ../artifacts/phase6/videos/mouse-narrow-peek.png
Wait+Screen /show list/
Sleep 1s
Screenshot ../artifacts/phase6/videos/mouse-narrow.png
Sleep 3s
