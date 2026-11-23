# f picks a lens: every session, the sessions that need me, or one Group in every Project. ! is needs me. The Deck keeps it.
Source common.tape

Type "# f picks a lens, ! is needs me, and the Deck keeps it" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Add the login screen/
Alt+a
Type "h"
Sleep 2s
Screenshot ../artifacts/phase6/videos/lenses-all.png
Type "f"
Wait+Screen /all sessions/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/lenses-picker.png
Enter
Wait+Screen /auth ✕/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/lenses-group.png
Type "!"
Wait+Screen /needs me ✕/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/lenses-needs.png
Type "q"
Sleep 1.5s
Type "swb" Sleep 400ms Enter
Wait+Screen /needs me ✕/
Sleep 2s
Screenshot ../artifacts/phase6/videos/lenses-kept.png
Type "!"
Wait+Screen /Fix the release build/
Sleep 1.5s
Type "f"
Wait+Screen /all sessions/
Sleep 800ms
Type@120ms "flaky"
Sleep 800ms
Enter
Wait+Screen /Quarantine the flaky suite/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/lenses-long.png
