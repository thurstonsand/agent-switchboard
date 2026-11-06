# References for the design review: Claude Code and Codex on their own, without swb, in the gallery's terminal and theme.
Set Theme { "name": "City Ruins", "background": "#101315", "foreground": "#cacccc", "selection": "#343d41", "cursor": "#a5aeb4", "black": "#101315", "red": "#de6145", "green": "#5abb88", "yellow": "#E5A72A", "blue": "#9cc4dd", "magenta": "#c39acc", "purple": "#c39acc", "cyan": "#70c1c1", "white": "#cacccc", "brightBlack": "#4b4e55", "brightRed": "#de6145", "brightGreen": "#5abb88", "brightYellow": "#dfd19d", "brightBlue": "#9cc4dd", "brightMagenta": "#c39acc", "brightPurple": "#c39acc", "brightCyan": "#70c1c1", "brightWhite": "#a5aeb4" }
Source common.tape

Type "claude" Enter
Wait+Screen /Claude Code v/
Sleep 1s
Type "run git status --short" Sleep 400ms Enter
Wait+Screen /tool done/
Sleep 1s
Type "reply src/main.ts has one uncommitted change: it now says hello to v3." Sleep 400ms Enter
Wait+Screen /says hello to v3\./
Sleep 2s
Screenshot ../artifacts/phase6/videos/references-claude-code.png
Ctrl+C
Sleep 300ms
Ctrl+C
Sleep 1s
Type "clear && codex" Enter
Wait+Screen /OpenAI Codex/
Sleep 1s
Type "run git status --short" Sleep 400ms Enter
Wait+Screen /ran git status/
Sleep 1s
Type "reply src/main.ts has one uncommitted change: it now says hello to v3." Sleep 400ms Enter
Wait+Screen /says hello to v3\./
Sleep 2s
Screenshot ../artifacts/phase6/videos/references-codex.png
