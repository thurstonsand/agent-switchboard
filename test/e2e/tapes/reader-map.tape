# What session_ask's reader works from: a map of the session, search within it, and reading by ref, subagents included.
Source common.tape

Type "# session_ask's reader: a map of the session, then search and read by ref" Sleep 1s Enter
Type `P=$(swb ls --json | jq -r '.[] | select(.title == "Parent ready").id')` Enter
Type `echo '{"question":"What did the beacon search find?"}' | swb recall begin $P | jq -r .text` Sleep 400ms Enter
Wait+Screen /Its subagents/
Sleep 1.5s
Type `echo '{"query":"beacon"}' | swb recall search $P | jq -r .text` Sleep 400ms Enter
Wait+Screen /Hits, best first/
Sleep 1.5s
Type `R=$(echo '{"query":"beacon"}' | swb recall search $P | jq -r .text | grep -o 'sub:[^ ]*' | head -1); echo "{\"ref\":\"$R\",\"before\":10}" | swb recall read $P | jq -r .text` Sleep 400ms Enter
Wait+Screen /beacon at/
Sleep 2s
Screenshot ../artifacts/phase6/videos/reader-map.png
Sleep 1s
