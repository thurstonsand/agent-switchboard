# n starts a session on a preset: the launch card on the Stage says what runs, Claude Code's opus by default, and Tab
# drops its menu, where typing codex narrows it to Codex's.
Source common.tape

Type "# n opens a launch card on the Stage; Tab drops its menu of presets" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Plan the v3 migration/
Sleep 1.5s
Type "n"
Wait+Screen /starts/
Sleep 2s
Screenshot ../artifacts/phase6/videos/harness-picker-card.png
Enter
Wait+Screen /Claude Code v/
Sleep 1s
Type "reply Mapping the API surface" Sleep 400ms Enter
Wait+Screen /[●○] Mapping the API surface/
Sleep 2s
# ctrl-h, not M-a h: VHS on macOS sends Alt+a as a plain a.
Ctrl+H
Sleep 800ms
Type "n"
Wait+Screen /starts/
Sleep 1s
Tab
Wait+Screen /Codex/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/harness-picker-menu.png
Type "codex"
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/harness-picker-narrowed.png
Enter
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/harness-picker-chosen.png
Enter
Wait+Screen /OpenAI Codex/
Sleep 1s
Type "reply Drafting the v3 docs" Sleep 400ms Enter
Wait+Screen /• Drafting the v3 docs/
Sleep 2s
Ctrl+H
Sleep 1s
Type "j"
Sleep 1.5s
Type "j"
Sleep 2.5s
