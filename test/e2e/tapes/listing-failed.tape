# A model listing that fails keeps the last list found: the shortlist keeps faux-1 at its only effort, and the add search says pi couldn't list.
Source common.tape

Type "# pi's model listing breaks; Settings keeps the list it last found" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Plan the v3 migration/
Sleep 1.5s
Type ","
Wait+Screen /Wake on highlight/
Sleep 1s
Type "]"
Wait+Screen /faux-1/
Sleep 3s
Screenshot ../artifacts/phase6/videos/listing-failed-listed.png
Type "R"
Sleep 3s
Screenshot ../artifacts/phase6/videos/listing-failed-shortlist.png
Type "a"
Sleep 600ms
Type "faux"
Wait+Screen /couldn't list models/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/listing-failed-add.png
Escape
Sleep 600ms
Escape
Sleep 1s
