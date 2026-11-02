# On gpt-6-sol, which takes most tools only through code mode's exec, swb's tools stay direct: asked for a session, Codex calls session_launch, not its own spawn_agent.
Source common.tape

Type "# Codex on gpt-6-sol launches a swb session with session_launch, which nests under it" Sleep 1s Enter
Type "swb" Sleep 400ms Enter
Wait+Screen /Draft the v3 docs/
Sleep 1.5s
Type "/Plan the v3" Sleep 300ms Enter
Sleep 300ms
Escape
Sleep 600ms
Enter
Wait+Screen /Called swb\.session_launch/
Sleep 2.5s
Screenshot ../artifacts/phase6/videos/codex-code-mode.png
Sleep 1s
