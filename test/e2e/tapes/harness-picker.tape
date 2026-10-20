# n starts a session on a preset: it opens on the default, Claude Code's opus, and Tab steps to Codex's.
Source common.tape

Type "# n opens on the default preset; Tab steps through the shortlist" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Plan the v3 migration/
Sleep 1.5s
Type "n"
Wait+Screen /gpt-6/
Sleep 2s
Enter
Wait+Screen /Claude Code v/
Sleep 1s
Type "reply Mapping the API surface" Sleep 400ms Enter
Wait+Screen /● Mapping the API surface/
Sleep 2s
Alt+a
Type "h"
Sleep 800ms
Type "n"
Wait+Screen /gpt-6/
Sleep 1s
Tab
Sleep 1.5s
Enter
Wait+Screen /OpenAI Codex/
Sleep 1s
Type "reply Drafting the v3 docs" Sleep 400ms Enter
Wait+Screen /• Drafting the v3 docs/
Sleep 2s
Alt+a
Type "h"
Sleep 1s
Type "j"
Sleep 1.5s
Type "j"
Sleep 2.5s
