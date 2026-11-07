# An agent starts Claude Code and Codex in a worktree neither has trusted, and pi beside .pi settings; each starts. Stopped,
# with the worktree deleted, each still takes its next message: woken, in place or in the main checkout.
Source common.tape

Type "# An agent launches into folders no harness trusts; then stopped, worktree deleted, each still takes a message" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Coordinator/
Sleep 1.5s
Enter
Wait+Screen /Claude Code v/
Sleep 1s
Type@12ms `call session_launch {"harness":"claude","cwd":"../project-feat/api","title":"API","briefing":"reply API up","report_back":false}` Sleep 400ms Enter
Wait+Screen /Launched a Claude Code session/
Sleep 2s
Type@12ms `call session_launch {"harness":"codex","cwd":"../project-feat/web","title":"Web","briefing":"reply Web up","report_back":false}` Sleep 400ms Enter
Wait+Screen /Launched a Codex session/
Sleep 2s
Type@12ms `call session_launch {"harness":"pi","cwd":"docs","title":"Docs","briefing":"reply Docs up","report_back":false}` Sleep 400ms Enter
Wait+Screen /Launched a pi session/
Sleep 2s
Alt+a
Type "h"
Sleep 6s
Escape
Sleep 300ms
Type "/Coordinator" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Sleep 800ms
Type "run git worktree remove --force ../project-feat" Sleep 400ms Enter
Wait+Screen /tool done/
Sleep 1.5s
Type "tell pi Are the docs done?" Sleep 400ms Enter
Wait+Screen /Delivered to "Docs"/
Sleep 1.5s
Type "tell claude Is the API done?" Sleep 400ms Enter
Wait+Screen /Delivered to "API"/
Sleep 1.5s
Type "tell codex Is the web app done?" Sleep 400ms Enter
Wait+Screen /Delivered to "Web"/
Sleep 2.5s
Alt+a
Type "h"
Type "/API" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Wait+Screen /(?s)Is the API done\?.*● got/
Sleep 3s
Alt+a
Type "h"
Type "/Web" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Wait+Screen /(?s)Is the web app done\?.*• got/
Sleep 3s
Alt+a
Type "h"
Type "/Docs" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Wait+Screen /(?s)Are the docs done\?.*got/
Sleep 3s
