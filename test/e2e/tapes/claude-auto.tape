# Claude Code in auto mode: its classifier answers an ask, so the row stays working; a question for me turns it blocked.
Source common.tape

Type "# Claude Code in auto mode: only a question for me reads blocked" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Auto worker/
Sleep 1s
Enter
Wait+Screen /auto mode on/
Sleep 1s
Type "hold deploy" Sleep 400ms Enter
Wait+Screen /entered >/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/claude-auto-working.png
Wait+Screen /released deploy/
Sleep 1.5s
Type 'call AskUserQuestion {"questions":[{"question":"Ship to staging or production?","header":"Target","options":[{"label":"Staging","description":"try it first"},{"label":"Production","description":"go live"}],"multiSelect":false}]}' Sleep 400ms Enter
Wait+Screen /Ship to staging or production\?/
Wait+Screen /◆/
Sleep 2s
Screenshot ../artifacts/phase6/videos/claude-auto-question.png
Enter
Wait+Screen /tool done/
Sleep 3s
