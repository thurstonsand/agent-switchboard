# An Operator in Claude Code: n on Operators, Tab picks the harness, and it messages a Codex session.
Source common.tape

Type "# n on Operators, Tab: a Claude Code Operator, dispatching to Codex" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Docs writer/
Sleep 1.5s
Type "g"
Sleep 600ms
Type "n"
Wait+Screen /new session in/
Sleep 1.2s
Tab
Sleep 1.5s
Enter
Wait+Screen /Claude Code v/
Sleep 1s
Type "tell codex Draft the v3 endpoint docs" Sleep 400ms Enter
Wait+Screen /Delivered to "Docs writer"/
Sleep 2.5s
Alt+a
Type "h"
Sleep 1s
Type "j"
Sleep 600ms
Type "j"
Sleep 600ms
Enter
Wait+Screen /got Draft the v3 endpoint docs/
Sleep 3s
