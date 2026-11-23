# An agent opens a file at a line in my Editor with swb_show_file: split beside it, the keyboard on it, and word on its border.
Source common.tape

Type "# an agent shows me a file: swb_show_file opens it at a line in my Editor" Sleep 1s Enter
Type "swb new" Sleep 400ms Enter
Wait+Screen /faux-1/
Sleep 1s
Type 'call swb_show_file {"path":"src/parser.ts","line":120}' Sleep 400ms Enter
Wait+Screen /pi opened src\/parser.ts:120/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/show-file.png
Type ":tabedit README.md" Sleep 300ms Enter
Sleep 1.5s
Alt+a
Type "l"
Sleep 1s
Type 'call swb_show_file {"path":"src/parser.ts","line":42}' Sleep 400ms Enter
Wait+Screen /pi opened src\/parser.ts:42/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/show-file-existing-tab.png
Sleep 6s
