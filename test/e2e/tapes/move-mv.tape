# pi-wt's /mv moves the session to another directory; swb follows it there.
Source common.tape

Type "# /mv moves the session's directory; swb follows it" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /0 open/
Sleep 1s
Type "n"
Wait+Screen /faux-1/
Sleep 1s
Type "reply before the move" Sleep 400ms Enter
Wait+Screen /(?s)before the move.*before the move/
Sleep 1.5s
Type "/mv ../elsewhere" Sleep 600ms Enter
Sleep 600ms
Enter
Wait+Screen /swb-e2e-\w+\/elsewhere/
Sleep 1.5s
Alt+a
Type "h"
Sleep 4s
