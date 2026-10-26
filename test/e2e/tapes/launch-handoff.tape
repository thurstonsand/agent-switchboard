# A launch leaves its parent and Group in swb's db for the first session its process records, which takes them; a /new after that takes neither. The Deck is above, a live view of the db below.
Source common.tape

Hide
Type `tmux -L demo -f /dev/null new-session -s demo \; set -g status off \; split-window -v -l 19 'watch -t -c -n 0.4 swb-db' \; select-pane -t 0` Enter
Sleep 1s
Type "env -u TMUX swb" Enter
Show
Wait+Screen /lab \(1\)/
Sleep 2s
Screenshot ../artifacts/phase6/videos/launch-handoff-start.png

# n on base, in lab: a pi starts there, not yet prompted, and its launch waits in the db
Type "/base" Sleep 400ms Enter
Sleep 600ms
Type "/"
Escape
Sleep 800ms
Type "n"
Wait+Screen /new session in/
Sleep 800ms
Enter
Wait+Screen /faux-1/
Wait+Screen /project-\S+\s+—\s+lab\s+—/
Sleep 2s
Screenshot ../artifacts/phase6/videos/launch-handoff-n.png

# /new before any prompt: nothing recorded yet, so the launch is still the next session's to take
Type "/new" Sleep 600ms Enter
Sleep 4s
Screenshot ../artifacts/phase6/videos/launch-handoff-n-new.png

# its first turn records it, in lab, and takes the launch's row
Type "reply first" Sleep 600ms Enter
Wait+Screen /lab \(2\)/
Sleep 3s
Screenshot ../artifacts/phase6/videos/launch-handoff-n-recorded.png

# base launches a child: its parent and its Group
Alt+a
Type "h"
Sleep 800ms
Type "/base" Sleep 400ms Enter
Sleep 600ms
Type "/"
Escape
Sleep 800ms
Enter
Sleep 2s
Type `call session_launch {"harness":"pi","goal":"reply child","title":"child","requestResponse":false}` Sleep 600ms Enter
Wait+Screen /lab \(3\)/
Sleep 3s
Screenshot ../artifacts/phase6/videos/launch-handoff-child.png

# /new in the child after its first turn: no one's child, in no Group
Alt+a
Type "h"
Sleep 800ms
Type "/child" Sleep 400ms Enter
Sleep 600ms
Type "/"
Escape
Sleep 800ms
Enter
Sleep 2s
Type "/new" Sleep 600ms Enter
Sleep 4s
Screenshot ../artifacts/phase6/videos/launch-handoff-child-new.png
Type "reply after" Sleep 600ms Enter
Sleep 4s
Screenshot ../artifacts/phase6/videos/launch-handoff-child-new-recorded.png

# a wake: its row says which session it resumes, for as long as that process lives
Alt+a
Type "h"
Sleep 800ms
Type "/base" Sleep 400ms Enter
Sleep 600ms
Type "/"
Escape
Sleep 800ms
Type "x"
Sleep 4s
Type "w"
Wait+Screen /project-\S+\s+—\s+—\s+base/
Sleep 2s
Screenshot ../artifacts/phase6/videos/launch-handoff-wake.png
Type "x"
Sleep 6s
Screenshot ../artifacts/phase6/videos/launch-handoff-wake-gone.png
Sleep 2s

Hide
Alt+a
Type "q"
Sleep 1s
Type "tmux -L demo kill-server" Enter
Sleep 500ms
