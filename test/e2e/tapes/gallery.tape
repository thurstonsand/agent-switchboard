# The design review's gallery: every surface swb draws, on one populated Deck, in City Ruins and Copied City, then the
# Deck in other terminals' themes. Frames, not a demo: each Screenshot is one surface, held still. It picks each
# session with the roster's filter; where the director also has to act (a hover, a terminal theme or size), the tape
# leaves the filter up for the director to clear, and waits for the whole roster to come back before going on.
Set Theme { "name": "City Ruins", "background": "#101315", "foreground": "#cacccc", "selection": "#343d41", "cursor": "#a5aeb4", "black": "#101315", "red": "#de6145", "green": "#5abb88", "yellow": "#E5A72A", "blue": "#9cc4dd", "magenta": "#aeaeae", "purple": "#aeaeae", "cyan": "#707070", "white": "#cacccc", "brightBlack": "#4b4e55", "brightRed": "#de6145", "brightGreen": "#5abb88", "brightYellow": "#c9c2b4", "brightBlue": "#9cc4dd", "brightMagenta": "#9a9a9a", "brightPurple": "#9a9a9a", "brightCyan": "#707070", "brightWhite": "#a5aeb4" }
Source common.tape

Hide
Type 'cd "$SWB_DEMO_PROJECT/../switchboard" && swb drive start --theme city-ruins && tmux -T RGB -L swb-drive-$SWB_INSTANCE attach' Enter
Show
Wait+Screen /races the clock/
Sleep 3s
Screenshot ../artifacts/phase6/videos/gallery-01-deck.png

Alt+a
Type "/nested blocks"
Sleep 1s
Enter
Sleep 1s
Wait+Screen /Inactive \(1\)/
Wait+Screen /Mark Unseen/
Sleep 500ms
Screenshot ../artifacts/phase6/videos/gallery-02-peek.png
Sleep 5s

# A Peek with a parent, a Group, and Schedules.
Alt+a
Type "/check ci"
Sleep 1s
Enter
Sleep 1s
Wait+Screen /Inactive \(1\)/
Wait+Screen /Weekdays, 8:57/
Sleep 500ms
Screenshot ../artifacts/phase6/videos/gallery-03-peek-family.png
Sleep 5s

Alt+a
Type "/Migrate"
Sleep 1.5s
Enter
Escape
Wait+Screen /schema.sql/
Sleep 3s
Screenshot ../artifacts/phase6/videos/gallery-04-cut-off-card.png

# Hiding the roster takes the keyboard to the Stage, which would wake a dormant session, so on a live one.
Alt+a
Type "/Plan the Q1"
Sleep 1.5s
Enter
Escape
Wait+Screen /three themes/
Sleep 2s
Alt+a
Type "z"
Wait+Screen /show list/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/gallery-05-hidden-roster.png
Alt+a
Type "z"
Sleep 1.5s
Alt+a
Type "h"
Sleep 1s

Alt+a
Type "/Tidy"
Sleep 1.5s
Enter
Escape
Wait+Screen /stopped/
Sleep 3s
Screenshot ../artifacts/phase6/videos/gallery-06-stopped-card.png

Type "n"
Sleep 2s
Screenshot ../artifacts/phase6/videos/gallery-07-new-session.png
Tab
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/gallery-08-presets.png
Escape
Sleep 500ms
Escape
Sleep 1s

Alt+a
Type "/snooze menu"
Sleep 1.5s
Enter
Escape
Sleep 3s
Type "m"
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/gallery-09-group-picker.png
Escape
Sleep 1s
Type "s"
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/gallery-10-snooze.png
Escape
Sleep 1s
Type "a"
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/gallery-11-archive-family.png
Type "A"
Wait+Screen /Cancels schedules/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/gallery-12-archive-schedules.png
Escape
Sleep 1s

Alt+a
Type "/Polish the Peek"
Sleep 1.5s
Enter
Escape
Sleep 2s
Type "a"
Wait+Screen /Branch kept/
Sleep 1s
Screenshot ../artifacts/phase6/videos/gallery-13-archive-worktree.png
Escape
Sleep 1s

Type ","
Sleep 2s
Screenshot ../artifacts/phase6/videos/gallery-14-settings.png
Type "]"
Wait+Screen /gpt-6/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/gallery-15-settings-harnesses.png
Escape
Sleep 1s

# config.toml broken by hand while the Deck is open: the roster's line, then Settings on the error.
Alt+a
Type "/v0.13"
Sleep 1s
Enter
Sleep 1s
Wait+Screen /config\.toml:/
Sleep 1s
Type ","
Wait+Screen /open config.toml at that line/
Sleep 1s
Screenshot ../artifacts/phase6/videos/gallery-16-config-error.png
Escape
Sleep 1s
Alt+a
Type "/release notes"
Sleep 1s
Enter
Sleep 3s
Escape
Sleep 1s

Type "?"
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/gallery-17-help.png
Escape
Sleep 1s

Alt+a
Type "/Check CI"
Sleep 1.5s
Enter
Escape
Wait+Screen /38 checks passed/
Sleep 3s
Screenshot ../artifacts/phase6/videos/gallery-18-message.png

Alt+a
Type "/Q1 roadmap"
Sleep 1.5s
Enter
Escape
Wait+Screen /not recording/
Sleep 3s
Screenshot ../artifacts/phase6/videos/gallery-19-not-recording.png

Alt+a
Type "/Check CI"
Sleep 1.5s
Enter
Escape
Wait+Screen /38 checks passed/
Sleep 2s
Alt+a
Type "v"
Sleep 2s
Alt+a
Type "s"
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/gallery-20-split-shell.png
Ctrl+D
Sleep 1s
Alt+a
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/gallery-21-pane-labels.png
Type "v"
Sleep 1.5s

# Copied City, City Ruins' light twin.
Alt+a
Type "/retry test"
Sleep 1s
Enter
Sleep 1s
Wait+Screen /Inactive \(1\)/
Wait+Screen /races the clock/
Sleep 3s
Screenshot ../artifacts/phase6/videos/gallery-22-light-deck.png
Alt+a
Type "/survives nested"
Sleep 1s
Enter
Sleep 1s
Wait+Screen /Inactive \(1\)/
Wait+Screen /Mark Unseen/
Sleep 500ms
Screenshot ../artifacts/phase6/videos/gallery-23-light-peek.png
Sleep 5s

# Other terminals' themes, for how the Deck takes on whatever palette it's given.
Alt+a
Type "/the flaky"
Sleep 1s
Enter
Sleep 1s
Wait+Screen /Inactive \(1\)/
Wait+Screen /races the clock/
Sleep 3s
Screenshot ../artifacts/phase6/videos/gallery-24-catppuccin-mocha.png
Alt+a
Type "/flaky retry"
Sleep 1s
Enter
Sleep 1s
Wait+Screen /Inactive \(1\)/
Wait+Screen /races the clock/
Sleep 3s
Screenshot ../artifacts/phase6/videos/gallery-25-tokyo-night.png
Alt+a
Type "/fix the flaky"
Sleep 1s
Enter
Sleep 1s
Wait+Screen /Inactive \(1\)/
Wait+Screen /races the clock/
Sleep 3s
Screenshot ../artifacts/phase6/videos/gallery-26-solarized-light.png

# A narrow terminal, back in City Ruins: the roster alone.
Alt+a
Type "/flaky retry test"
Sleep 1s
Enter
Sleep 1s
Wait+Screen /Inactive \(1\)/
Sleep 3s
Screenshot ../artifacts/phase6/videos/gallery-27-narrow.png
