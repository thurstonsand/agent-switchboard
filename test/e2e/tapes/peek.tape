# A Peek: a session's particulars and keys beside its row, for the row under the pointer or, after j and k, the
# cursor's. It never covers the roster, it goes when the pointer does, and its buttons act on its own row.
Source common.tape

Type "# hover a row for its Peek; its buttons act on that row; j and k bring the cursor's; it leaves with the pointer" Sleep 1s Enter
Hide
Type "swb drive start && tmux -L swb-drive-$SWB_INSTANCE attach" Enter
Show
Wait+Screen /error recovery/
Sleep 1s
Screenshot ../artifacts/phase6/videos/peek-hover.png
Sleep 2s
Screenshot ../artifacts/phase6/videos/peek-button.png
Wait+Screen /x Shut down/
Sleep 1s
Screenshot ../artifacts/phase6/videos/peek-woken.png
Sleep 5.5s
Screenshot ../artifacts/phase6/videos/peek-tab-hover.png
Wait+Screen /notes drafted/
Sleep 300ms
Screenshot ../artifacts/phase6/videos/peek-cursor.png
Wait+Screen /(?s)── editor.*stable now/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/peek-split.png
Sleep 4s
Screenshot ../artifacts/phase6/videos/peek-short.png
Sleep 3s
