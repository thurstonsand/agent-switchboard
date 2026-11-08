# One mode at a time: a prefix key on the archive prompt leaves it unanswered, and the menu it opens takes the keys.
Source common.tape

Type "# the archive prompt, then M-a S: snooze takes its place" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Plan the v3 migration/
Sleep 1.5s
Type "a"
Wait+Screen /Archive this session/
Sleep 1.2s
Screenshot ../artifacts/phase6/videos/modes-archive.png
Alt+a
Type "S"
Wait+Screen /Snooze/
Sleep 1.2s
Screenshot ../artifacts/phase6/videos/modes-snooze.png
Escape
Sleep 1s
Type "m"
Sleep 1s
Alt+a
Type "/"
Sleep 400ms
Type "plan"
Sleep 1.2s
Screenshot ../artifacts/phase6/videos/modes-filter.png
Escape
Sleep 1.5s
