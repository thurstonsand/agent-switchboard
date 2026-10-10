# M-a e swaps the Stage to the session's editor and back; M-a v splits it beside pi.
Source common.tape

Type "# the session's editor: swap with M-a e, split with M-a v; M-a s for a shell; ctrl-hjkl between them" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Archived \(0\)/
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
Alt+a
Type "s"
Sleep 2s
Sleep 1s
Type "git status --short; echo shell in $PWD" Sleep 400ms Enter
Wait+Screen /shell in/
Sleep 2s
Screenshot ../artifacts/phase6/videos/editor-shell.png
Ctrl+K
Sleep 1.2s
Ctrl+H
Sleep 1.2s
Type ":vsplit" Sleep 300ms Enter
Sleep 1.5s
Ctrl+L
Sleep 1.2s
Ctrl+H
Sleep 1.2s
Screenshot ../artifacts/phase6/videos/editor-nvim-nav.png
Ctrl+H
Sleep 1.5s
Ctrl+L
Sleep 1.2s
Ctrl+L
Sleep 1.2s
Ctrl+L
Sleep 1.2s
Ctrl+J
Sleep 1.5s
Ctrl+D
Sleep 2s
Screenshot ../artifacts/phase6/videos/editor-shell-closed.png
Ctrl+H
Sleep 1.2s
Ctrl+H
Sleep 1.2s
Ctrl+H
Sleep 1s
Type "?"
Sleep 2s
Screenshot ../artifacts/phase6/videos/help.png
Escape
Sleep 1s
