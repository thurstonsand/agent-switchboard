# A pi-sessions handoff launches its child through swb; once the child goes dormant, a message finds it and wakes it.
Source common.tape

Type "# a pi-sessions handoff becomes a managed Session; messaging it while dormant wakes it" Sleep 1s Enter
Type "swb new" Sleep 400ms Enter
Wait+Screen /faux-1/
Sleep 1s
Type "handoff scout" Sleep 400ms Enter
Wait+Screen /▾ \S+ \(2\)/
Sleep 1.5s
Alt+a
Type "h"
Type "k"
Wait+Screen /child scout done/
Wait+Screen /not running/
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
Type "/child scout" Sleep 300ms Enter
Sleep 300ms
Escape
Wait+Screen /child scout done/
Sleep 4s
