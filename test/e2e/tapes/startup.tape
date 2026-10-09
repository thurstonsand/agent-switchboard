# Startup: n on Operators starts an Operator; a new Deck comes back where the last one left off; swb -c lands in pi.
Source common.tape

Type "# n on Operators starts an Operator" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /bravo/
Sleep 1.5s
Type "g"
Sleep 600ms
Type "n"
Wait+Screen /faux-1/
Sleep 1s
Type "reply on duty" Sleep 400ms Enter
Sleep 2s
Alt+a
Type "h"
Wait+Screen /Operators \(1\)/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/startup-operator.png
Type "/alpha" Sleep 400ms Enter
Sleep 800ms
Escape
Sleep 1.5s
Type "q"
Sleep 800ms
Type "# a new Deck in this Project restores the cursor" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /alpha/
Sleep 2s
Screenshot ../artifacts/phase6/videos/startup-restored.png
Type "q"
Sleep 800ms
Type "# swb -c puts pi on this Project's most recent session" Sleep 1s Enter
Type "swb -c" Sleep 400ms Enter
Wait+Screen /faux-1/
Sleep 2s
Screenshot ../artifacts/phase6/videos/startup-continue.png
Sleep 1s
