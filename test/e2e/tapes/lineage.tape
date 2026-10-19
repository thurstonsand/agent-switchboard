# Sessions an agent started nest under it: the Peek says who started a session, p goes there, h folds a family, a child starts in its parent's Group, and a asks whether it goes too.
Source common.tape

Type "# sessions an agent started nest under it; p goes to the parent, h folds, a asks about the family" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Measure lineage depth/
Sleep 2s
Screenshot ../artifacts/phase6/videos/lineage-tree.png
Type "j"
Sleep 300ms
Type "k"
Wait+Screen /started by/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/lineage-peek.png
Type "p"
Sleep 2s
Screenshot ../artifacts/phase6/videos/lineage-parent.png
Type "k"
Sleep 400ms
Type "k"
Sleep 800ms
Type "h"
Wait+Screen /folded \+3/
Sleep 2s
Screenshot ../artifacts/phase6/videos/lineage-folded.png
Type "l"
Sleep 1s
Type "m"
Sleep 600ms
Type "lab"
Sleep 600ms
Enter
Wait+Screen /lab \(1\)/
Sleep 2s
Screenshot ../artifacts/phase6/videos/lineage-group.png
Wait+Screen /lab \(2\)/
Sleep 2s
Screenshot ../artifacts/phase6/videos/lineage-group-child.png
Type "a"
Wait+Screen /A all 6/
Sleep 2s
Screenshot ../artifacts/phase6/videos/lineage-archive-prompt.png
Type "A"
Wait+Screen /Archived \(6\)/
Sleep 2s
Screenshot ../artifacts/phase6/videos/lineage-archived.png
Sleep 1s
