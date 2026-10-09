# Prompting an archived session unarchives it.
Source common.tape

Type "# a new prompt in an archived session reopens it" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Archived \(1\)/
Sleep 1.5s
Type "G"
Sleep 500ms
Type "l"
Sleep 1s
Type "j"
Sleep 2s
Enter
Wait+Screen /faux-1/
Sleep 1.5s
Type "reply one more thing after all" Sleep 400ms Enter
Wait+Screen /▾ \S+ \(1\)/
Sleep 3s
