# A session the clock can't start for its message shows failed to start; fixed and woken, it takes the message.
Source common.tape

Type "# a session that won't start shows failed to start, its message waiting" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Write the release notes/
Sleep 1s
Wait+Screen@120s /failed to start/
Sleep 2s
Screenshot ../artifacts/phase6/videos/failed-to-start.png
Type "!"
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/failed-to-start-lens.png
Sleep 1s
Enter
Wait+Screen@60s /queued/
Sleep 2s
Screenshot ../artifacts/phase6/videos/failed-to-start-delivered.png
Sleep 1s
