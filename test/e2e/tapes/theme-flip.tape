# The terminal flips light to dark and back: the roster and the live pi follow it.
# The drive harness plays the terminal here, as it does in the e2e suite: its theme is what flips.
Source common.tape

Type "# the terminal's theme flips; the roster and pi follow it live" Sleep 1s Enter
Hide
Type "swb drive start --theme light -- new && tmux -L swb-drive-$SWB_INSTANCE attach" Enter
Show
Wait+Screen /faux-1/
Sleep 1s
Type "reply light or dark, the switchboard follows" Sleep 400ms Enter
Sleep 12s
