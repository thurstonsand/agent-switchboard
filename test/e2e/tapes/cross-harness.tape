# Sessions in pi, Claude Code, and Codex find and message each other with swb's tools, mid-turn too.
Source common.tape

Type "# pi, Claude Code, and Codex message each other, mid-turn too" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Docs writer/
Sleep 2s
Type "/API worker" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 800ms
Enter
Wait+Screen /Claude Code v/
Sleep 1s
Type "tell codex The API moved to v3; update the endpoint docs" Sleep 400ms Enter
Wait+Screen /Delivered to "Docs writer"/
Sleep 2.5s
Alt+a
Type "h"
Type "/Docs writer" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Wait+Screen /got The API moved to v3/
Sleep 2.5s
Type "tell pi Endpoint docs are on v3 now" Sleep 400ms Enter
Wait+Screen /Delivered to "Planner"/
Sleep 2s
Alt+a
Type "h"
Type "/Planner" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Wait+Screen /got Endpoint docs are on v3 now/
Sleep 2s
Type "hold review" Sleep 400ms Enter
Wait+Screen /Stop: review against v3/
Wait+Screen /got Stop: review against v3/
Sleep 4s
Alt+a
Type "h"
Sleep 1s
Type "j"
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/cross-harness-peek-claude.png
Type "j"
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/cross-harness-peek-codex.png
Type "k"
Type "k"
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/cross-harness-peek-pi.png
Sleep 1s
