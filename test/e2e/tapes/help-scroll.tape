# ? shows every key: all of them on a tall Deck, and on a short one a page that scrolls, by the wheel and by j k ↑ space.
# The drive harness plays the terminal: the director turns the wheel in it, and the tape types the keys.
Source common.tape

Type "# ? shows every key; on a short Deck it scrolls, by the wheel and by j k ↑ space" Sleep 1s Enter
Hide
Type "swb drive start --size 140x46 && tmux -L swb-drive-$SWB_INSTANCE attach" Enter
Show
Wait+Screen /Archived/
Sleep 1.5s
Type "?"
Wait+Screen /any key or click closes/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/help-scroll-tall.png
Type "x"
Sleep 2s
Type "?"
Wait+Screen /↓ 12 · j k, wheel scroll/
Sleep 1s
Screenshot ../artifacts/phase6/videos/help-scroll-short.png
Wait+Screen /↑ 4 ↓ 8/
Wait+Screen /↑ 3 ↓ 9/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/help-scroll-wheel.png
Type "j"
Sleep 600ms
Type "j"
Sleep 600ms
Space
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/help-scroll-end.png
Type "k"
Sleep 600ms
Type "k"
Sleep 600ms
Up
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/help-scroll-keys-up.png
Type "q"
Sleep 2s
