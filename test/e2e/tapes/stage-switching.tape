# Three live sessions: moving the cursor swaps the real pi on the Stage at once.
Source common.tape

Type "# the Stage follows the cursor between live pis" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /▾ \S+ \(3\)/
Sleep 1s
Type "w"
Sleep 1.5s
Type "j"
Type "w"
Sleep 1.5s
Type "j"
Type "w"
Wait+Screen /faux-1/
Sleep 1.5s
Type@700ms "kkjjkkjjkk"
Sleep 2s
