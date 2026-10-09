# Simulated process loss: the sessions server dies under an idle pi and a mid-turn pi.
Source common.tape

Type "# SIMULATED PROCESS LOSS: the sessions server is killed under one idle and one mid-turn pi" Sleep 1.5s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Archived \(0\)/
Sleep 1s
Type "n"
Wait+Screen /faux-1/
Type "reply done for now" Sleep 300ms Enter
Sleep 1s
Type "/name Simulated: idle when killed" Sleep 300ms Enter
Sleep 1s
Alt+a
Type "h"
Type "n"
Wait+Screen /▾ \S+ \(2\)/
Sleep 1s
Type "reply starting the build" Sleep 300ms Enter
Sleep 1s
Type "/name Simulated: mid-turn when killed" Sleep 300ms Enter
Sleep 1s
Type "hold long-build" Sleep 300ms Enter
Wait+Screen /interrupted/
Sleep 3s
Alt+a
Type "h"
Sleep 500ms
Type "j"
Sleep 3s
Type "k"
Sleep 2s
