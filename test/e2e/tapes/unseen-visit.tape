# A turn that finishes while I'm looking elsewhere is Unseen; landing on it Visits it.
Source common.tape

Type "# unseen: a turn finished while I looked elsewhere; a visit clears it" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /0 open/
Sleep 1s
Type "n"
Wait+Screen /faux-1/
Sleep 1s
Type "hold background-job" Sleep 400ms Enter
Sleep 1.5s
Alt+a
Type "h"
Sleep 500ms
Type "n"
Wait+Screen /2 open/
Sleep 1.5s
Type "reply meanwhile, in front" Sleep 400ms Enter
Sleep 6s
Alt+a
Type "h"
Sleep 800ms
Type "k"
Sleep 4s
