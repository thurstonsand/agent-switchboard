# Three sessions visited in turn: [ and ] step back and forward through them, from the roster and from pi.
Source common.tape

Type "# [ and ] step through the sessions I visited" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /▾ \S+ \(3\)/
Sleep 1s
Type "gjj"
Enter
Wait+Screen /faux-1/
Sleep 2s
Alt+a
Type "h"
Sleep 500ms
Type "j"
Enter
Sleep 3s
Alt+a
Type "h"
Sleep 500ms
Type "j"
Enter
Sleep 3s
Alt+a
Type "["
Sleep 2s
Screenshot ../artifacts/phase6/videos/history-back-from-pi.png
Alt+a
Type "["
Sleep 2s
Alt+a
Type "h"
Sleep 1s
Type "]"
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/history-forward-in-roster.png
Type "]"
Sleep 1.5s
Type "]"
Sleep 2s
Screenshot ../artifacts/phase6/videos/history-at-the-end.png
Sleep 1s
