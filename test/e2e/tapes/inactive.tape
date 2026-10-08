# Sessions quiet past inactive_after (8 s here) fold into Inactive, but never while still Unseen.
Source common.tape

Type "# inactive_after = 8s: quiet sessions fold into Inactive, but an Unseen one waits for my visit" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /1 open/
Sleep 2s
Type "n"
Wait+Screen /faux-1/
Sleep 1s
Type "reply still busy over here" Sleep 400ms Enter
Wait+Screen /Inactive/
Sleep 3s
Alt+a
Type "h"
Sleep 800ms
Type "g"
Type "j"
Sleep 1.5s
Enter
Sleep 2s
Alt+a
Type "h"
Sleep 12s
