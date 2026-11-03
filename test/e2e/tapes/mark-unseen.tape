# u marks the session on view Unseen: the dot shows at once, holds while I stay and after I leave, and a visit back clears it.
Source common.tape

Type "# u marks it Unseen until I leave it and come back" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /▾ \S+ \(2\)/
Sleep 1s
Type "gjj"
Enter
Wait+Screen /faux-1/
Sleep 2.5s
Alt+a
Type "u"
Sleep 1s
Screenshot ../artifacts/phase6/videos/mark-unseen-on-view.png
Sleep 3s
Screenshot ../artifacts/phase6/videos/mark-unseen-still-on-view.png
Alt+a
Type "h"
Sleep 500ms
Type "j"
Sleep 2s
Screenshot ../artifacts/phase6/videos/mark-unseen-after-leaving.png
Type "k"
Sleep 500ms
Enter
Sleep 3s
Screenshot ../artifacts/phase6/videos/mark-unseen-visited-back.png
Sleep 1s
