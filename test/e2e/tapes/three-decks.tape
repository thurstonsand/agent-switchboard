# Three Decks on one switchboard: a session started in one shows in all; typing and archiving in any is seen by all.
Source common.tape
Set Height 1400

Type "# three Decks, one switchboard" Sleep 1s Enter
Hide
Type "tmux -L demo -f /dev/null new -s demo swb \; split-window -v swb \; split-window -v swb \; select-layout even-vertical \; set -g status off" Enter
Show
Wait+Screen /(?s)Archived \(0\).*Archived \(0\).*Archived \(0\)/
Wait+Screen /(?s)Archived \(1\).*Archived \(1\).*Archived \(1\)/
Sleep 3s
