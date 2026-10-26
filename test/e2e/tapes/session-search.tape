# A pi session searches every conversation on the switchboard, Claude Code's and Codex's included, archived too.
Source common.tape

Type "# session_search finds what any session said, in any harness, archived or not" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Planner/
Sleep 1.5s
Type "/Planner" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Sleep 1.5s
Type "search redirect cookie" Sleep 400ms Enter
Wait+Screen /searched/
Sleep 1s
Type "search redirect harness:codex" Sleep 400ms Enter
Wait+Screen /searched[\s\S]*searched/
Sleep 2s
Screenshot ../artifacts/phase6/videos/session-search.png
Sleep 1s
