# a is refused mid-turn; once idle it archives and kills the pi; a on the Archived row brings it back.
Source common.tape

Type "# archive with a: refused mid-turn, then archived, then unarchived" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Archived \(0\)/
Sleep 1s
Type "n"
Wait+Screen /faux-1/
Sleep 1s
Type "hold busy" Sleep 400ms Enter
Sleep 1s
Alt+a
Type "h"
Sleep 1s
Type "a"
Wait+Screen /turn running/
Wait+Screen /released busy/
Sleep 1.5s
Type "a"
Wait+Screen /Archived \(1\)/
Sleep 2s
Type "G"
Sleep 500ms
Type "l"
Sleep 1s
Type "j"
Sleep 2s
Type "a"
Wait+Screen /▾ \S+ \(1\)/
Sleep 3s
