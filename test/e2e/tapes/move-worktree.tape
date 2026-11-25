# Move & worktrees: m opens the Move menu in git repos (Fork, Checkout, Merge with dirty-tree guard, Rebranch, Remove).
Source common.tape

Type "# m opens Move & worktrees; g names a Group" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Worktree demo/
Alt+a
Type "h"
Sleep 800ms
Type "m"
Wait+Screen /Move · ⎇ main/
Sleep 1.2s
Screenshot ../artifacts/phase6/videos/move-menu.png
Type "2"
Wait+Screen /Fork · from main/
Sleep 1s
Type "feat-ui"
Sleep 1s
Screenshot ../artifacts/phase6/videos/move-fork.png
Enter
Wait+Screen /feat-ui/
Sleep 2s
Type "m"
Wait+Screen /Move · ⎇ feat-ui/
Sleep 1.2s
Screenshot ../artifacts/phase6/videos/move-menu-worktree.png
Type "4"
Wait+Screen /requires clean tree/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/move-merge-dirty.png
Enter
Wait+Screen /\(main\)/
Sleep 2s
