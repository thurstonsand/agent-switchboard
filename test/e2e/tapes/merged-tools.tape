# The merged tools: session_launch launches later with at, session_list_schedules lists, and swb_update_session cancels another session's turn.
Source common.tape

Type "# A coordinator schedules a launch, lists it, and cancels another session's turn" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Coordinator/
Sleep 1.5s
Type "/Coordinator" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Wait+Screen /on it/
Sleep 1s
Type `call session_launch {"harness":"pi","briefing":"reply triaged","title":"Nightly triage","report_back":false,"at":"PT25S","schedule_label":"in 25 seconds"}` Sleep 400ms Enter
Wait+Screen /Scheduled for/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/merged-tools-launch-at.png
Type "call session_list_schedules {}" Sleep 400ms Enter
Wait+Screen /in 25 seconds \(\d+ more lines?, /
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/merged-tools-schedules.png
Type `update Watch CI {"cancel":true}` Sleep 400ms Enter
Wait+Screen /Cancelled "Watch CI"'s turn/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/merged-tools-cancel.png
Sleep 14s
Screenshot ../artifacts/phase6/videos/merged-tools-launched.png
Sleep 1s
