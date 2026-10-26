# pi-wt's /wt fork moves the session into a new worktree; swb follows it, in the same project.
Source common.tape

Type "# /wt fork moves the session into a new worktree; swb follows it" Sleep 1s Enter
Type "swb new" Sleep 400ms Enter
Wait+Screen /faux-1/
Sleep 1s
Type "reply before the fork" Sleep 400ms Enter
Wait+Screen /(?s)before the fork.*before the fork/
Sleep 1.5s
Type "/wt fork feature" Sleep 600ms Enter
Wait+Screen /worktrees\/project\/feature/
Sleep 1.5s
Alt+a
Type "h"
Sleep 800ms
# The row marks a worktree; its Peek, after j and k, names the branch.
Type "j"
Sleep 300ms
Type "k"
Wait+Screen /⎇ feature/
Sleep 4s
