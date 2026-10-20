# An Operator tidies the roster with swb_update_session: a Group, a better title, and a family archived only once it's safe.
Source common.tape

Type "# An Operator groups, retitles, and archives a family, refused while one is mid-turn" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Morning triage/
Sleep 1.5s
Type "/Morning triage" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Wait+Screen /on it/
Sleep 1s
Type `update Pin the base image {"group":"hygiene"}` Sleep 400ms Enter
Wait+Screen /Moved "Pin the base image" into/
Sleep 2.5s
Type `update Profile roster render {"title":"Roster render at 60 fps"}` Sleep 400ms Enter
Wait+Screen /Retitled "Profile roster render"/
Sleep 2.5s
Type `update Rotate the staging certs {"archived":true,"family":true}` Sleep 400ms Enter
Wait+Screen /Nothing changed/
Sleep 3s
Screenshot ../artifacts/phase6/videos/operator-tidy-refused.png
Type `update Rotate the staging certs {"archived":true,"family":true,"force":true}` Sleep 400ms Enter
Wait+Screen /Archived \(2\)/
Wait+Screen /Cancelled the turns of/
Sleep 2s
Screenshot ../artifacts/phase6/videos/operator-tidy-forced.png
Sleep 1s
