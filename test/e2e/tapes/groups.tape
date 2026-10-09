# Groups: worktree buckets by default, m names a Group, and dragging a session moves it between them.
Source common.tape

Type "# group_by = worktree; m names a Group; drag moves a session into one" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /⎇ wt/
Sleep 2s
Screenshot ../artifacts/phase6/videos/groups-buckets.png
Type "/alpha" Sleep 400ms Enter
Sleep 800ms
Type "m"
Sleep 600ms
Type "review" Sleep 600ms Enter
Sleep 800ms
Escape
Wait+Screen /review \(1\)/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/groups-named.png
Wait+Screen /drop into review/
Sleep 500ms
Screenshot ../artifacts/phase6/videos/groups-dragging.png
Wait+Screen /review \(2\)/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/groups-dropped.png
Wait+Screen /✗ not here/
Sleep 500ms
Screenshot ../artifacts/phase6/videos/groups-refused.png
Wait+Screen /nothing moved/
Sleep 2s
Type "n"
Wait+Screen /faux-1/
Sleep 1s
Type "reply joined review from n" Sleep 400ms Enter
Sleep 2s
Alt+a
Type "h"
Wait+Screen /review \(3\)/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/groups-joined.png
Sleep 1s
