# Snoozed: sessions out of the way until a time or their next message, in a section folded like Archived.
Source common.tape

Type "# s snoozes a session; Snoozed folds beneath Inactive, each row saying when it wakes" Sleep 1s Enter
Hide
Type "swb drive start && tmux -L swb-drive-$SWB_INSTANCE attach" Enter
Show
Wait+Screen /Snoozed/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/snooze-folded.png
Type "/Bump" Sleep 400ms Enter
Sleep 500ms
Type "s"
Wait+Screen /Until a message/
Sleep 1s
Screenshot ../artifacts/phase6/videos/snooze-menu.png
Enter
Sleep 800ms
Escape
Sleep 800ms
Type "G"
Sleep 300ms
Type "k"
Sleep 300ms
Enter
Sleep 600ms
Type "j"
Sleep 400ms
Type "j"
Wait+Screen /Weekdays, 8:57 AM/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/snooze-peek.png
Sleep 1.5s
