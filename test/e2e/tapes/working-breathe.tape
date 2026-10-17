# A working session's glyph breathes in the theme's own cyan, and follows the terminal from dark to light and back.
# Its own settings, smaller than common.tape's: at 1800×900 VHS can't keep real time, and the breathing would race.
Set Shell bash
Set FontFamily "BerkeleyMono Nerd Font Mono, DejaVu Sans Mono"
Set FontSize 18
Set Width 1200
Set Height 520
Set Framerate 20
Set Padding 12
Set TypingSpeed 45ms
Set WaitTimeout 40s
Set CursorBlink false

Hide
Type 'cd "$SWB_DEMO_PROJECT" && clear' Enter
Type "swb drive start --theme dark && tmux -T RGB -L swb-drive-$SWB_INSTANCE attach" Enter
Show
Wait+Screen /Rewrite the parser/
Wait+Screen /released breath/
Sleep 2s
