# A pi-sessions handoff launches its child through swb; once the child goes dormant, a message finds it and wakes it.
Source common.tape

Type "# a pi-sessions handoff becomes a managed Session; messaging it while dormant wakes it" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /0 open/
Sleep 1s
Type "n"
Wait+Screen /faux-1/
Hide
Type "/session-index" Sleep 300ms Enter
Sleep 1.5s
Type "r"
Sleep 1s
Enter
Wait+Screen /[Ii]ndex/
Sleep 3s
Show
Sleep 1s
Type "handoff scout" Sleep 400ms Enter
Wait+Screen /2 open/
Sleep 1.5s
Alt+a
Type "h"
Type "k"
Wait+Screen /child scout done/
Wait+Screen /pi exited/
Sleep 2.5s
Type "j"
Sleep 1s
Enter
Sleep 800ms
Type "reach w1" Sleep 400ms Enter
Wait+Screen /tool done w1/
Sleep 1.5s
Alt+a
Type "h"
Type "g"
Type "j"
Wait+Screen /child scout done/
Sleep 4s
