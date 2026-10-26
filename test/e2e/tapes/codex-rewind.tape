# Rewinding a Codex session with its own Esc Esc: swb reads on from the rewind, and what it undid stays findable.
Source common.tape

Type "# rewind a Codex session with Esc Esc; swb follows, and keeps what it undid" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Name the CLI release/
Sleep 1.5s
Type "/Name the CLI" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Wait+Screen /Call it version 2\.0/
Sleep 1.5s
Escape
Sleep 500ms
Escape
Wait+Screen /rewind/
Sleep 1.5s
Enter
Wait+Screen /Conversation reverted/
Sleep 1.5s
Ctrl+U
Type "reply Call it version 1.5" Sleep 400ms Enter
Wait+Screen /• Call it version 1\.5/
Sleep 2s
Screenshot ../artifacts/phase6/videos/codex-rewind-stage.png
Alt+a
Type "h"
Sleep 800ms
Type "q"
Sleep 1s
Type `P=$(swb ls --json | jq -r '.[0].id')` Enter
Type `echo '{"question":"What did they call the release?"}' | swb recall begin $P | jq -r .text | tail -6` Sleep 400ms Enter
Wait+Screen /Abandoned branches/
Sleep 1.5s
Type `echo '{"query":"version"}' | swb recall search $P | jq -r .text` Sleep 400ms Enter
Wait+Screen /abandoned branch/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/codex-rewind.png
Sleep 1s
