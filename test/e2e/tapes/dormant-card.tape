# A dormant session's card: its last turns, read from the transcript, without starting pi.
Source common.tape

Type "# dormant sessions show their last turns without starting pi" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /▾ \S+ \(2\)/
Wait+Screen /⏎ wake/
Sleep 3s
Type "j"
Sleep 3s
Type "k"
Sleep 2s
