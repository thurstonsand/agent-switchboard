# n opens the directory picker on the cursor's directory; search ranks; M-a d removes a repository with its worktrees; N adds a directory; the highlight follows the pointer.
Source common.tape

Hide
Type 'cd ~/code/agent-switchboard && clear' Enter
Sleep 300ms
Show
Type "swb" Sleep 400ms Enter
Wait+Screen /Reaper flake/
Sleep 1.5s
Type "/Prototype" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 800ms
Type "n"
Wait+Screen /new session in/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/dir-picker-open.png
Sleep 1s
Type "pi"
Wait+Screen /\/ pi/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/dir-picker-search.png
Sleep 1s
Ctrl+U
Sleep 300ms
Up
Sleep 500ms
Alt+a
Type "d"
Wait+Screen /from this list/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/dir-picker-confirm.png
Sleep 1s
Type "y"
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/dir-picker-removed.png
Sleep 1s
Escape
Sleep 800ms
Type "N"
Wait+Screen /› ~\/code\//
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/dir-picker-add.png
Sleep 1s
Type "ma"
Wait+Screen /code\/ma/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/dir-picker-add-filtered.png
Sleep 1s
Down
Sleep 500ms
Enter
Wait+Screen /faux-1/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/dir-picker-started.png
Sleep 1s
Alt+a
Type "n"
Wait+Screen /new session in/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/dir-picker-after-add.png
Wait+Screen /pi-sessions\s+✕/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/dir-picker-hover.png
Sleep 1s
Escape
Sleep 1s
