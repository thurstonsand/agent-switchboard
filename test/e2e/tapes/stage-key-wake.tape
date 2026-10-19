# M-a J from pi onto a sleeping session leaves it asleep with the keyboard on its card; any key there wakes it.
Source common.tape

Type "# from pi, M-a J onto a sleeping session; a key on its card wakes it" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /▾ \S+ \(2\)/
Sleep 1.5s
Enter
Wait+Screen /faux-1/
Sleep 1.5s
Alt+a
Type "J"
Wait+Screen /notes drafted/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/stage-key-wake-asleep.png
Sleep 1.5s
Enter
Wait+Screen /(?s)notes drafted.*faux-1/
Sleep 1s
Type "reply typed into the woken pi" Sleep 400ms Enter
Wait+Screen /(?s)typed into the woken pi.*typed into the woken pi/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/stage-key-wake-woken.png
Sleep 1s
