# A turn that runs a tool, start to finish.
Source common.tape

Type "# a tool turn: pi runs bash, swb shows it working, then idle" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /0 open/
Sleep 1s
Type "n"
Wait+Screen /faux-1/
Sleep 1s
Type "tool hello from bash" Sleep 400ms Enter
Wait+Screen /tool done hello from bash/
Sleep 3s
