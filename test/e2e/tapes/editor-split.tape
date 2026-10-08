# M-a e swaps the Stage to the session's editor and back; M-a v splits it beside pi.
Source common.tape

Type "# the session's editor: swap with M-a e, split with M-a v" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /0 open/
Sleep 1s
Type "n"
Wait+Screen /faux-1/
Sleep 1s
Type "reply the editor is one keystroke away" Sleep 400ms Enter
Wait+Screen /(?s)one keystroke away.*one keystroke away/
Sleep 1.5s
Alt+a
Type "e"
Wait+Screen /README/
Sleep 3s
Alt+a
Type "e"
Wait+Screen /faux-1/
Sleep 2s
Alt+a
Type "v"
Wait+Screen /(?s)README.*faux-1|faux-1.*README/
Sleep 2s
Alt+a
Type "h"
Sleep 1.5s
Alt+a
Type "l"
Sleep 3s
