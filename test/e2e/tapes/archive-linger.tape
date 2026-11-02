# Archiving keeps the row on view, its card on the Stage, until the cursor leaves. A wake while its harness is still
# quitting, from the Deck or from a shell, waits for it to go, then starts it afresh.
Source common.tape

Type "# archive: the row stays on view until you leave it; a wake waits out the harness's shutdown" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /▾ \S+ \(3\)/
Sleep 1s
# Onto the top session, "Bisect the flaky test".
Type "g"
Sleep 300ms
Type "jj"
Sleep 1s
Enter
Wait+Screen /faux-1/
Sleep 2s
# From the Stage: archive it. The row stays put, marked, and the Stage shows its card while its pi shuts down.
Alt+a
Type "a"
Wait+Screen /a unarchive/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/archive-linger-kept.png
Sleep 1s
# Enter while its pi is still quitting: the wake waits for it, then starts a fresh pi.
Enter
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/archive-linger-waiting.png
Wait+Screen /faux-1/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/archive-linger-woken.png
# Back to the roster, and j moves on as if the row were gone; it drops into Archived.
Alt+a
Type "h"
Sleep 1.5s
Type "j"
Sleep 2s
Screenshot ../artifacts/phase6/videos/archive-linger-moved-on.png
Type "w"
Wait+Screen /faux-1/
Sleep 1.5s
# The project's shell, beside Draft: look up Draft's id there for later, then back to the roster.
Alt+a
Type "s"
Sleep 1.5s
Type@20ms `id=$(swb ls --json | jq -r '.[] | select(.title == "Draft the changelog").id')` Enter
Sleep 800ms
Alt+a
Type "h"
Sleep 400ms
Alt+a
Type "h"
Sleep 800ms
# Archive Draft and move on to Profile, while Draft's pi is still quitting.
Type "a"
Wait+Screen /a unarchive/
Sleep 1s
Type "j"
Sleep 1s
Alt+a
Type "l"
Sleep 400ms
Alt+a
Type "l"
Sleep 500ms
# Unarchive and wake Draft from that shell: swb wake waits for the old pi to go, then starts a fresh one.
Type@20ms "date +%T; swb unarchive $id && swb wake $id; echo done $(date +%T)" Sleep 200ms Enter
Sleep 1.2s
Screenshot ../artifacts/phase6/videos/archive-linger-cli-waiting.png
Wait+Screen /done \d/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/archive-linger-cli.png
Sleep 2s
