# Codex's own subagents are their parent's evidence: never a session, but in its map, its search, and session_search.
Source common.tape

Type "# a Codex subagent is never a session, but its parent's map, search, and session_search find it" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Find the deploy beacon/
Sleep 1.5s
Type "/Find the deploy" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Wait+Screen /spawn_agent|find_beacon/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/codex-subagents-stage.png
Alt+a
Type "h"
Sleep 800ms
Type "q"
Sleep 1s
Type `P=$(swb ls --json | jq -r '.[0].id')` Enter
Type `echo '{"question":"Where is the beacon?"}' | swb recall begin $P | jq -r .text | sed -n '/Its subagents/,$p'` Sleep 400ms Enter
Wait+Screen /find_beacon/
Sleep 1.5s
Type `echo '{"query":"beacon"}' | swb recall search $P | jq -r .text` Sleep 400ms Enter
Wait+Screen /subagent "find_beacon"/
Sleep 1.5s
Type `echo 'beacon hello' | swb search --from nobody | jq -r .text` Sleep 400ms Enter
Wait+Screen /in subagent/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/codex-subagents.png
Sleep 1s
