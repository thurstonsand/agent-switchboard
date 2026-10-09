# A pi session started outside swb comes under management with swb adopt, then resumes inside a Deck.
Source common.tape

Type "# a pi session started outside swb, adopted, then resumed in a Deck" Sleep 1s Enter
Type 'pi -p "reply started outside swb"' Sleep 400ms Enter
Wait+Screen /started outside swb\n/
Sleep 1s
Type "swb ls" Sleep 400ms Enter
Sleep 1.5s
Type 'swb adopt "$PI_CODING_AGENT_DIR"/sessions/*/*.jsonl' Sleep 400ms Enter
Wait+Screen /not running/
Sleep 2.5s
Enter
Wait+Screen /faux-1/
Sleep 1.5s
Type "reply back inside swb" Sleep 400ms Enter
Wait+Screen /back inside swb\s/
Sleep 2s
Alt+a
Type "h"
Sleep 1s
Type "q"
Sleep 1s
Type "swb ls" Sleep 400ms Enter
Sleep 3s
