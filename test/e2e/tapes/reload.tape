# R reloads a working pi: it restarts on the same conversation, reading its config afresh, and picks its turn back up.
# Then pi reloads itself, and the keyboard stays on it throughout.
Source common.tape

Type "# R reloads a working pi, which restarts on fresh config and picks its turn back up" Sleep 1s Enter
Type "swb new" Sleep 400ms Enter
Wait+Screen /faux-1/
Sleep 1s
Type "hold build" Sleep 400ms Enter
Wait+Screen /Working/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/reload-working.png
Alt+a
Type "R"
Wait+Screen /continued/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/reload-continued.png
Sleep 1s
Type 'call swb_update_session {"reload":"continue"}' Sleep 400ms Enter
Wait+Screen /restarted to reload/
Sleep 1.5s
Type "reply still typing here" Sleep 400ms Enter
Wait+Screen /still typing here/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/reload-self-keyboard.png
Sleep 1s
