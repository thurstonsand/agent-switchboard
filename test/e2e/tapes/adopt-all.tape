# swb adopt --all: every session pi, Claude Code, and Codex ran outside swb comes in, archived and searchable.
Source common.tape

Type "# swb adopt --all brings in every session run outside swb, archived and searchable" Sleep 1s Enter
Type "swb adopt --all" Sleep 400ms Enter
Wait+Screen /Adopted/
Sleep 2.5s
Type "swb" Sleep 400ms Enter
Wait+Screen /Archived \(4\)/
Sleep 1.5s
Type "G"
Sleep 600ms
Type "l"
Sleep 1s
Type "j"
Sleep 2s
Screenshot ../artifacts/phase6/videos/adopt-all-deck.png
Type "q"
Sleep 1s
Type `echo 'API key' | swb search --from nobody | jq -r .text` Sleep 400ms Enter
Wait+Screen /in subagent/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/adopt-all.png
Sleep 1s
