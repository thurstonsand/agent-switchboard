# Beside a Peek, the footer keeps its ⏎, which the Peek no longer repeats. On its way from a row into the row's Peek,
# the pointer cuts across the rows, header, section, and empty roster below it, and the Peek holds.
Source common.tape

Type "# the footer keeps ⏎ beside a Peek; the pointer can cut across the roster into it" Sleep 1s Enter
Hide
Type "swb drive start && tmux -L swb-drive-$SWB_INSTANCE attach" Enter
Show
Wait+Screen /(?s)Organize.*⏎ (focus|wake)/
Sleep 1s
Screenshot ../artifacts/phase6/videos/peek-aim-keys.png
Wait+Screen /╭─ Group /
Sleep 500ms
Screenshot ../artifacts/phase6/videos/peek-aim-group.png
Sleep 3s
