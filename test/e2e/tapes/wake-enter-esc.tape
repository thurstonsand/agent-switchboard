# w wakes a dormant session in place; Enter wakes it and hands me the keyboard; esc backs out while it still comes up.
Source common.tape

Type "# three dormant sessions: w wakes in place, Enter wakes and focuses, esc backs out" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /▾ \S+ \(3\)/
Sleep 2s
Type "w"
Wait+Screen /faux-1/
Sleep 2s
Type "j"
Sleep 1.5s
Enter
Wait+Screen /faux-1/
Sleep 1s
Type "reply typed straight into the woken pi" Sleep 400ms Enter
Wait+Screen /(?s)typed straight into the woken pi.*typed straight into the woken pi/
Sleep 1.5s
Alt+a
Type "h"
Sleep 1s
Type "G"
Type "k"
Sleep 1.5s
Enter
Wait+Screen /back to the list/
Sleep 100ms
Escape
Sleep 4s
