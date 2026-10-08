# A new pi from an empty Deck: its first prompt makes it a Session, which works, settles to idle, and takes its title.
Source common.tape

Type "# n starts a pi; its first prompt makes it a tracked Session" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /0 open/
Sleep 1.5s
Type "n"
Wait+Screen /faux-1/
Sleep 1s
Type "hold first" Sleep 400ms Enter
Wait+Screen /released first/
Sleep 1.5s
Type "/name Wire up the switchboard" Sleep 400ms Enter
Sleep 3s
