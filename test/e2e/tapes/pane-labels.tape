# Every pane names itself on its top edge, the focused one lit; with M-a down, the others show the key that reaches them.
Source common.tape

Type "# each pane wears its name, the focused one lit; M-a shows the key to each" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /▾ \S+ \(2\)/
Sleep 1s
# Onto the top session, whichever one the cursor started on, so M-a j has one below it.
Type "g"
Sleep 300ms
Type "jj"
Sleep 1s
Screenshot ../artifacts/phase6/videos/pane-labels-sidebar.png
Enter
Wait+Screen /faux-1/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/pane-labels-pi.png
Alt+a
Type "v"
Wait+Screen /README/
Sleep 1.5s
Alt+a
Type "s"
Sleep 2s
Screenshot ../artifacts/phase6/videos/pane-labels-shell.png
Alt+a
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/pane-labels-shell-prefix.png
Type "k"
Sleep 1.5s
Alt+a
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/pane-labels-pi-prefix.png
Type "h"
Sleep 1.5s
Alt+a
Sleep 1s
Type "h"
Sleep 1.5s
# A Group's name, typed in the sidebar: its cursor is the terminal's, so it goes when the sidebar loses the keyboard.
Type "m"
Sleep 800ms
Type "review"
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/pane-labels-name-focused.png
Alt+a
Type "l"
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/pane-labels-name-unfocused.png
Alt+a
Type "h"
Sleep 1s
Escape
Sleep 1s
Alt+a
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/pane-labels-sidebar-prefix.png
Type "j"
Sleep 2s
Screenshot ../artifacts/phase6/videos/pane-labels-next-session.png
Sleep 1s
