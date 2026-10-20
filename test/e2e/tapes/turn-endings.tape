# A dormant session's card ends where its last turn stopped short of a reply: cut off, stopped, or errored. Waking the cut-off one continues it.
Source common.tape

Type "# Turns that never replied: pi killed mid-tool, Claude Code stopped, Codex errored" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Fix the flaky login test/
Sleep 1s
Type "/Fix the flaky" Sleep 300ms Enter
Sleep 300ms
Escape
Wait+Screen /─ cut off ─/
Sleep 1.2s
Screenshot ../artifacts/phase6/videos/turn-endings-cut-off.png
Sleep 1s
Type "k"
Sleep 800ms
Type "j"
Wait+Screen /cut off · killed/
Sleep 800ms
Screenshot ../artifacts/phase6/videos/turn-endings-cut-off-peek.png
Sleep 1.5s
Type "/Tidy the parser" Sleep 300ms Enter
Sleep 300ms
Escape
Wait+Screen /─ stopped ─/
Sleep 1.2s
Screenshot ../artifacts/phase6/videos/turn-endings-stopped.png
Sleep 1.5s
Type "/Bump the API" Sleep 300ms Enter
Sleep 300ms
Escape
Wait+Screen /─ errored ─/
Sleep 1.2s
Screenshot ../artifacts/phase6/videos/turn-endings-errored.png
Sleep 1s
Type "k"
Sleep 800ms
Type "j"
Wait+Screen /errored · not running/
Sleep 800ms
Screenshot ../artifacts/phase6/videos/turn-endings-errored-peek.png
Sleep 1.5s
Type "/Fix the flaky" Sleep 300ms Enter
Sleep 300ms
Escape
Wait+Screen /─ cut off ─/
Sleep 1s
Type "w"
Wait+Screen /Continue where you left off/
Wait+Screen /continued/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/turn-endings-continued.png
Sleep 2s
