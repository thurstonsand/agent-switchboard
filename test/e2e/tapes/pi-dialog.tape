# pi's own dialog waits on me mid-turn: the row turns blocked, and settles once I answer.
Source common.tape

Type "# blocked: pi's own confirm dialog waits on me mid-turn" Sleep 1s Enter
Type "swb new" Sleep 400ms Enter
Wait+Screen /faux-1/
Sleep 1s
Type "confirm deploy" Sleep 400ms Enter
Wait+Screen /Confirm deploy\?/
Wait+Screen /◆/
Sleep 2s
Screenshot ../artifacts/phase6/videos/pi-dialog-blocked.png
Enter
Wait+Screen /tool done deploy/
Sleep 3s
