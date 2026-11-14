# / ranks every session by its conversation and title, as session_search does, as each key goes in. A quote not yet
# closed reads as a plain word until it closes.
Source common.tape

Type "# / finds the sessions that best match what was said in them" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /▾ \S+ \(6\)/
Sleep 2s
Type "/"
Sleep 800ms
Type@400ms "mutex"
Wait+Screen /3 found/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/filter-search-ranked.png
Escape
Sleep 1.2s
Type "/"
Sleep 800ms
Type@400ms "readme"
Wait+Screen /1 found/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/filter-search-title.png
Escape
Sleep 1.2s
Type "/"
Sleep 800ms
Type@400ms '"mutex'
Wait+Screen /3 found/
Sleep 2s
Type@400ms '"'
Wait+Screen /2 found/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/filter-search-exact.png
Escape
Sleep 1.5s
