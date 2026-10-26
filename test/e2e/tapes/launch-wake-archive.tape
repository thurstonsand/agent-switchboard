# Claude Code launches a Codex session; once it's dormant, a message wakes it; Codex's own /archive archives it in swb.
Source common.tape

Type "# Claude launches Codex; a message wakes it; /archive in Codex archives it in swb" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /API worker/
Sleep 1.5s
Enter
Wait+Screen /Claude Code v/
Sleep 1s
Type "launch codex Write the v3 migration guide" Sleep 400ms Enter
Wait+Screen /Launched a Codex session/
Sleep 2.5s
Alt+a
Type "h"
Wait+Screen /● Write the v3 migration/
Sleep 3.5s
Type "/API worker" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Sleep 800ms
Type "tell codex Add a section on auth" Sleep 400ms Enter
Wait+Screen /Delivered to "Write the v3 migration guide", which was woken/
Sleep 2.5s
Alt+a
Type "h"
Type "/Write the v3" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Wait+Screen /got Add a section on auth/
Sleep 2.5s
Type "/archive" Sleep 500ms Enter
Wait+Screen /Archive this session/
Sleep 1.5s
Type "2"
Wait+Screen /Archived \(1\)/
Sleep 3s
