# Archiving cancels every schedule a session set or receives: after asking whether its family goes too, a names the schedules that go with them and asks again.
Source common.tape

Type "# archive names the schedules it cancels before it cancels them" Sleep 1s Enter
Type 'swb open "$(cat ~/lead)"' Sleep 400ms Enter
Wait+Screen /Review the changelog/
Sleep 2s
Alt+a
Type "a"
Wait+Screen /Archive family \(2\)/
Sleep 2s
Screenshot ../artifacts/phase6/videos/archive-schedules-family.png
Type "A"
Wait+Screen /Cancels schedules/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/archive-schedules-prompt.png
Type "a"
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/archive-schedules-archived.png
