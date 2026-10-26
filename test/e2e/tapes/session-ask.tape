# session_ask from each harness about another: a reader in the asker's own harness reads it and answers.
Source common.tape

Type "# session_ask: pi asks Claude Code, Claude Code asks Codex, Codex asks pi" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Planner/
Sleep 1.5s
Type "/Planner" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Sleep 1.5s
Type "ask Fix the login redirect :: what ended the redirect loop?" Sleep 400ms Enter
Wait+Screen /asked: reader found: SWB-stale-cookie/
Sleep 2s
Screenshot ../artifacts/phase6/videos/session-ask-pi.png
Alt+a
Type "h"
Type "/Fix the login" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Wait+Screen /Claude Code v/
Sleep 1s
Type "ask Document the v3 endpoints :: where does /login go now?" Sleep 400ms Enter
Wait+Screen /asked: reader found: SWB-v3-home/
Sleep 2s
Screenshot ../artifacts/phase6/videos/session-ask-claude.png
Alt+a
Type "h"
Type "/Document the v3" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Sleep 1.5s
Type "ask Planner :: when does the fix ship?" Sleep 400ms Enter
Wait+Screen /asked: reader found: SWB-ships-friday/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/session-ask-codex.png
Sleep 1s
