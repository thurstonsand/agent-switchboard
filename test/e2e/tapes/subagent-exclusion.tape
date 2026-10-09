# A pi-sessions subagent runs as its own pi, and never becomes a Session.
Source common.tape

Type "# a pi-sessions subagent is its own pi process, and never a Session here" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Archived \(0\)/
Sleep 1s
Type "n"
Wait+Screen /faux-1/
Sleep 1s
Type "subagent scout" Sleep 400ms Enter
Wait+Screen /tool done scout/
Wait+Screen /▌\s+○/
Sleep 2s
Alt+a
Type "h"
Type "q"
Sleep 1s
Type "swb ls" Sleep 400ms Enter
Sleep 3s
