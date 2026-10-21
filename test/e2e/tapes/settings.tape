# , opens Settings across the Deck: a value is dim until you set it, edits save to config.toml as they happen, and the shortlist feeds n's presets.
Source common.tape

Type "# , opens Settings; the shortlist becomes n's presets" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Plan the v3 migration/
Sleep 1.5s
Type ","
Wait+Screen /Wake on highlight/
Sleep 1s
Down
Sleep 300ms
Down
Sleep 1.2s
Screenshot ../artifacts/phase6/videos/settings-general.png
Enter
Sleep 400ms
Ctrl+U
Type "3d"
Wait+Screen /= 3 days/
Sleep 1s
Screenshot ../artifacts/phase6/videos/settings-duration.png
Enter
Sleep 1s
Type "]"
Wait+Screen /gpt-6/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/settings-shortlist-automatic.png
Type "jjjjj"
Sleep 800ms
Right
Wait+Screen /↺/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/settings-shortlist-yours.png
Type "a"
Sleep 600ms
Type "explore"
Wait+Screen /read-only search agent/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/settings-add.png
Ctrl+U
Type "opus[1m]"
Wait+Screen /as a model id/
Sleep 1.2s
Screenshot ../artifacts/phase6/videos/settings-add-unlisted.png
Ctrl+U
Type "opus everyday"
Wait+Screen /everyday/
Sleep 800ms
Enter
Wait+Screen /Claude Code's own/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/settings-add-effort.png
Escape
Sleep 600ms
Escape
Sleep 600ms
Escape
Sleep 800ms
Type "n"
Wait+Screen /new session in/
Sleep 1s
Tab
Sleep 1.2s
Screenshot ../artifacts/phase6/videos/settings-picker-presets.png
Escape
Wait+Screen /config.toml:\d+: unknown key/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/settings-invalid.png
Type ","
Wait+Screen /open config.toml at that line/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/settings-invalid-pane.png
Escape
Sleep 3s
