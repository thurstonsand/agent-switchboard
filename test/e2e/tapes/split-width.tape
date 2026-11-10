# Split's divider sits at agent_width. Dragging it shows a notch at that column; the session keeps where it's let go,
# others keep following agent_width, and letting go by the notch, a double-click, or M-a = puts it back.
Source common.tape

Type "# drag split's divider: a notch marks agent_width; the session keeps its own; back by the notch, a double-click, or M-a =" Sleep 1s Enter
Hide
Type "swb drive start --size 196x46 && tmux -L swb-drive-$SWB_INSTANCE attach" Enter
Show
Wait+Screen /README/
Sleep 2s
Screenshot ../artifacts/phase6/videos/split-width-default.png
Wait+Screen /┰/
Sleep 1500ms
Screenshot ../artifacts/phase6/videos/split-width-dragging.png
Sleep 3s
Screenshot ../artifacts/phase6/videos/split-width-kept.png
Wait+Screen /reply notes drafted/
Sleep 3s
Screenshot ../artifacts/phase6/videos/split-width-other.png
Wait+Screen /┰/
Sleep 1500ms
Screenshot ../artifacts/phase6/videos/split-width-snapping.png
Sleep 3s
Screenshot ../artifacts/phase6/videos/split-width-snapped.png
Wait+Screen /Reset split divider/
Sleep 1500ms
Screenshot ../artifacts/phase6/videos/split-width-help.png
Sleep 3s
