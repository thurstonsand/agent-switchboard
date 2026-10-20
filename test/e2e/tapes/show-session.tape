# An Operator takes me to the session I ask about with swb_show_session.
Source common.tape

Type "# An Operator takes me straight to a session with swb_show_session" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Morning triage/
Sleep 1.5s
Type "/Morning triage" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Wait+Screen /on it/
Sleep 1.5s
Type "show Rotate the staging certs" Sleep 400ms Enter
Wait+Screen /\/infra/
Sleep 2s
Screenshot ../artifacts/phase6/videos/show-session.png
Sleep 1.5s
