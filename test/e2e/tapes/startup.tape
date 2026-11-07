# Startup: n and Enter on Operators start an Operator, which can't start subagents; q leaves the Deck, and swb comes back to it as it was; swb -c lands in pi.
Source common.tape

Type "# n and Enter on Operators start an Operator" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /bravo/
Sleep 1.5s
Type "g"
Sleep 600ms
Type "n"
Wait+Screen /Preset/
Sleep 1.5s
Enter
Wait+Screen /(?s)Operators \(1\).*faux-1/
Sleep 1s
Type "reply on duty" Sleep 400ms Enter
Sleep 2s
Type "subagent scout" Sleep 400ms Enter
Wait+Screen /tool done scout/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/startup-operator-refused.png
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
Type "# swb comes back to the Deck as it was" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /alpha/
Sleep 2s
Screenshot ../artifacts/phase6/videos/startup-restored.png
Type "q"
Sleep 800ms
Type "# swb -c moves the Deck to this Project's most recent session" Sleep 1s Enter
Type "swb -c" Sleep 400ms Enter
Wait+Screen /faux-1/
Sleep 2s
Screenshot ../artifacts/phase6/videos/startup-continue.png
Sleep 1s
