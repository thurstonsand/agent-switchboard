# pi asks for my attention mid-turn: the row turns blocked, and settles once I answer.
Source common.tape

Type "# blocked: pi is waiting on me mid-turn" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Archived \(0\)/
Sleep 1s
Type "n"
Wait+Screen /faux-1/
Sleep 1s
Type "attention deploy-approval" Sleep 400ms Enter
Wait+Screen /blocked/
Wait+Screen /attention deploy-approval released/
Sleep 3s
