# The search eval replays every session_search the agents made, scored by the session each went to next, and keeps each run.
Source common.tape

Hide
Type `alias eval-search="bun $(realpath "$OLDPWD/../../eval/search.ts") --out $HOME/eval"` Enter
Type "clear" Enter
Sleep 300ms
Show

Type "# mise run eval:search: every session_search, replayed against this checkout's ranker" Sleep 1s Enter
Type "eval-search --note baseline" Sleep 400ms Enter
Wait+Screen /results:/
Sleep 1s
Screenshot ../artifacts/phase6/videos/search-eval-run.png
Sleep 2s
Type "eval-search --note 'same ranker'" Sleep 400ms Enter
Wait+Screen /results:[\s\S]*results:/
Sleep 1s
Type "clear" Enter
Type "# mise run eval:compare: the latest two runs, on the examples both have" Sleep 1s Enter
Type "eval-search compare" Sleep 400ms Enter
Wait+Screen /worse/
Sleep 1s
Type "eval-search history" Sleep 400ms Enter
Wait+Screen /same ranker\n/
Sleep 2s
Screenshot ../artifacts/phase6/videos/search-eval.png
Sleep 1s
