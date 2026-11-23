# An agent that ends its turn on swb_ask_user shows a yellow ?, its Peek shows the question, and ! keeps it in view.
# Answering it, its next turn, takes the mark off.
Source common.tape

Type "# an agent asks; its row says ? until its next turn" Sleep 1s Enter
Hide
Type "swb drive start && tmux -L swb-drive-$SWB_INSTANCE attach" Enter
Show
Wait+Screen /› Rebuild the sessions table/
Sleep 2s
Screenshot ../artifacts/phase6/videos/asking-peek.png
Wait+Screen /needs me ✕/
Sleep 2s
Screenshot ../artifacts/phase6/videos/asking-needs.png
Wait+Screen /asking · a question for you/
Sleep 2s
Screenshot ../artifacts/phase6/videos/asking-help.png
Wait+Screen /go with a column/
Sleep 4s
Screenshot ../artifacts/phase6/videos/asking-answered.png
