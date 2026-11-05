# The db stays locked past busy_timeout as a turn starts: pi says its records wait, and they land once it lets go.
Source common.tape

Type "# db busy: pi's records wait, then land" Sleep 1s Enter
Type "swb new" Sleep 400ms Enter
Wait+Screen /faux-1/
Sleep 1s
Type "reply first turn" Sleep 400ms Enter
Sleep 3s
Type "reply while busy" Sleep 400ms Enter
Wait+Screen /swb: db busy/
Sleep 1s
Screenshot ../artifacts/phase6/videos/db-busy-waiting.png
Sleep 12s
Screenshot ../artifacts/phase6/videos/db-busy-landed.png
