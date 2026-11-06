# A harness that dies on the Stage hands its slot to its card; the roster and the Deck's layout stay put.
Source common.tape

Type "# pi dies on the Stage: its card takes its place, nothing else moves" Sleep 1s Enter
Type "swb new" Sleep 400ms Enter
Wait+Screen /faux-1/
Sleep 1s
Type "reply about to be killed" Sleep 400ms Enter
Wait+Screen /(?s)about to be killed.*about to be killed/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/stage-death-before.png
Wait+Screen /⏎ wake/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/stage-death-after.png
