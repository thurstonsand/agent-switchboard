# pi archives its own session with the swb_archive tool once the work is done.
Source common.tape

Type "# pi archives its own session with swb_archive" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /0 open/
Sleep 1s
Type "n"
Wait+Screen /faux-1/
Sleep 1s
Type "reply the fix is merged" Sleep 400ms Enter
Wait+Screen /fix is merged\s/
Sleep 1.5s
Type "archive this, we're done" Sleep 400ms Enter
Wait+Screen /1 arch/
Sleep 3s
Type "G"
Sleep 3s
