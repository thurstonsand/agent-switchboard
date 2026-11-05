# M-a z inside Settings leaves the list where Settings holds it; Tab after still takes the keyboard to the Stage, and M-a z there hides the list.
Source common.tape

Type "# M-a z in Settings changes nothing; Tab after still reaches the Stage" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Plan the v3 migration/
Sleep 1.5s
Type ","
Wait+Screen /Wake on highlight/
Sleep 1s
Alt+a
Type "z"
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/roster-hide-settings.png
Escape
Sleep 1.5s
Alt+a
Tab
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/roster-hide-stage.png
Alt+a
Type "z"
Wait+Screen /show list/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/roster-hide-hidden.png
