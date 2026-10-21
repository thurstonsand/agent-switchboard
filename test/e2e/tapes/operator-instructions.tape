# Settings' Operators section is an editor: my instructions, saved as I go, after swb's in every Operator's AGENTS.md; at 16,000 characters it takes no more.
Source common.tape

Type "# Settings › Operators: my instructions, after swb's" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Plan the v3 migration/
Sleep 1.5s
Type ","
Wait+Screen /Wake on highlight/
Sleep 800ms
Type "]]"
Wait+Screen /Tell your Operators how to speak/
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/operator-instructions-empty.png
Type "Prefer Codex for anything in Rust, Claude Code for design and review."
Enter
Enter
Type "- Ask me before starting more than three sessions at once."
Enter
Type "- When several sessions need me, lead with the one that's waited longest."
Sleep 2s
Screenshot ../artifacts/phase6/videos/operator-instructions-editing.png
Wait+Screen /16,000 \/ 16,000/
Sleep 1s
Type "and one more thing"
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/operator-instructions-full.png
Tab
Sleep 1.5s
Screenshot ../artifacts/phase6/videos/operator-instructions-rail.png
Escape
Sleep 2s
