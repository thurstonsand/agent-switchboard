# Deterministic Pi end-to-end tests

## Answers

### Use Pi AI's faux provider through one test extension

Pi AI 0.99.2 ships a purpose-built `fauxProvider`; the real Pi CLI does not expose it as a provider by itself—the built-in provider registry imports its production providers but not faux ([all.ts:1-46, 136-187](/Users/tsandberg/.cache/pi-source/v0.99.2/packages/ai/src/providers/all.ts)). A small test extension must construct it, queue scripted responses, and register `faux.provider` with `pi.registerProvider()`. This is already proven code in pi-sessions: its smoke extension registers provider `smoke`/model `scripted`, recursively scripts plain replies and tool calls, supplies local fake auth, and runs with a zero-cost model ([install.ts:20-65](/Users/tsandberg/code/personal/pi-sessions/test/smoke/install.ts), [faux.ts:480-488, 687-709](/Users/tsandberg/.cache/pi-source/v0.99.2/packages/ai/src/providers/faux.ts)). Run Pi with `--offline` as a second, independent guard against automatic network activity ([cli.md:227-240](/Users/tsandberg/.cache/pi-source/v0.99.2/packages/coding-agent/docs/cli.md)). No credentials or network endpoint are needed.

Use one scenario-aware extension, not separate fake binaries:

- Plain reply: return `fauxAssistantMessage("E2E_IDLE")`.
- Tool call: return `fauxAssistantMessage(fauxToolCall(name, args))`, then return a completion reply when the latest context message is the tool result. Pi AI exposes both constructors directly ([faux.ts:52-100](/Users/tsandberg/.cache/pi-source/v0.99.2/packages/ai/src/providers/faux.ts)); pi-sessions uses this exact loop ([install.ts:28-33, 53-58](/Users/tsandberg/code/personal/pi-sessions/test/smoke/install.ts)).
- Held turn: return an async response factory which writes a `turn-entered` sentinel and waits for a `release-turn` file while honoring the supplied abort signal. Faux response steps may return promises and are awaited by the provider ([faux.ts:109-116, 490-555](/Users/tsandberg/.cache/pi-source/v0.99.2/packages/ai/src/providers/faux.ts)). pi-sessions already uses a release-file loop for a held worker response ([install.ts:43-50](/Users/tsandberg/code/personal/pi-sessions/test/smoke/install.ts)). This provides an exact point at which to assert Working and kill the process.
- Blocked turn: script a call to a test-only `attention` tool. Its execution emits `glimpseui:attention:request` with the tool-call ID, writes `attention-entered`, waits for `release-attention`, and emits `glimpseui:attention:resolve` in `finally`. Pi's extension bus is synchronous at `emit()` ([event-bus.ts:3-27](/Users/tsandberg/.cache/pi-source/v0.99.2/packages/coding-agent/src/core/event-bus.ts)); the production interview adapter establishes the exact channel and payload contract ([interview-attention.ts:3-15](/Users/tsandberg/code/personal/ansiblonomicon/bootstrap/capabilities/agent-harness/configuration/assets/pi/extensions/interview-attention.ts)). Assert Blocked before releasing it and Idle only after recorder settlement.

The extension should fail if it receives an unknown scenario, runs out of scripted responses, or observes a tool error. Faux itself turns an exhausted queue into an error rather than inventing a fallback ([faux.ts:505-524](/Users/tsandberg/.cache/pi-source/v0.99.2/packages/ai/src/providers/faux.ts)). This is useful. Tests deserve fewer improvisational instincts than agents.

### Reuse pi-sessions isolation and polling, but put interactive Pi itself in tmux

Reuse these mechanics from pi-sessions:

- Verify the real `pi --version` matches the pinned development dependency before starting ([pi.smoke.ts:137-146](/Users/tsandberg/code/personal/pi-sessions/test/smoke/pi.smoke.ts)).
- Give every run a disposable `HOME`, `PI_CODING_AGENT_DIR`, working directory, broker/state directory, transcript tree, and private tmux socket; write settings which select only the checkout under test and the scripted provider ([pi.smoke.ts:147-180](/Users/tsandberg/code/personal/pi-sessions/test/smoke/pi.smoke.ts)). The eventual Sessions suite must also point the real CLI and recorder at an isolated database initialized through the real migration command, never a hand-authored fixture schema.
- Use exact UUIDs and readiness files from `session_start`, then poll with a deadline and a process-liveness check instead of sleeping ([install.ts:66-81](/Users/tsandberg/code/personal/pi-sessions/test/smoke/install.ts), [pi.smoke.ts:48-60, 201-215](/Users/tsandberg/code/personal/pi-sessions/test/smoke/pi.smoke.ts)).
- Stamp and locate panes by exact IDs/options, retain pane captures and the disposable state on failure, kill the private server in cleanup, and write a success manifest only after cleanup succeeds ([pi.smoke.ts:252-260, 314-380](/Users/tsandberg/code/personal/pi-sessions/test/smoke/pi.smoke.ts)).

Do not copy its topology unchanged. The current smoke parent and peer are real Pi processes in RPC mode outside tmux; the harness synthesizes `$TMUX` so spawned workers use its private server ([pi.smoke.ts:67-72, 197-200](/Users/tsandberg/code/personal/pi-sessions/test/smoke/pi.smoke.ts)). Sessions e2e must instead launch the real interactive Pi as the pane command in the isolated server so the recorder proves its actual management boundary. RPC remains useful for nonvisual pi-sessions tests, but it does not exercise Pi's TUI, viewer pane, or terminal input.

A proof of concept on the work Mac did this with Pi 0.99.2, the existing pi-sessions smoke extension, disposable state under `/tmp/deterministic-pi-e2e.L7FRUD`, and `tmux -L e2e-research`. It sent a JSON-scripted `write` tool request to the interactive Pi, observed the real tool rendering and `SMOKE_TURN_DONE` through `capture-pane`, and asserted the file contents. The captured primary output identifies Pi 0.99.2, the loaded extensions, tool invocation, and reply ([tool-result.txt:1-5](/tmp/deterministic-pi-e2e.L7FRUD/tool-result.txt), [tool-capture.txt:3-34](/tmp/deterministic-pi-e2e.L7FRUD/tool-capture.txt)). `kill-server` was followed by a failed `kill -0` for the recorded Pi PID, and the throwaway socket reported no server. No model service or default/`sessions` tmux server was contacted.

### Drive text literally; wait on durable state; capture the screen for evidence

For terminal input, use `tmux -L <test-socket> send-keys -l -t <pane> -- "$text"`, then a separate `send-keys ... Enter`. `-l` disables key-name interpretation, while named keys such as `Enter`, `Escape`, and `C-c` remain explicit ([tmux(1), `send-keys`](https://man.openbsd.org/tmux.1#send-keys)). Always target an exact pane ID. Do not send a prompt until the extension readiness sentinel exists and the pane PID is live.

Use two assertion planes:

- Authoritative feature assertions poll the real `sessions` CLI or isolated SQLite database with a deadline: row exists, runtime is Live, phase is Working/Blocked/Idle, archive/visit timestamps changed, and after process loss the derived state is Dormant or Interrupted. Settlement waits for the recorder's `agent_settled` write, never merely for assistant text or `agent_end`.
- Visual assertions poll `capture-pane -p -t <pane> -S -100` for stable labels, and save the final capture. `capture-pane -p` writes pane contents to stdout and `-S` includes history ([tmux(1), `capture-pane`](https://man.openbsd.org/tmux.1#capture-pane)). Visual text proves presentation; it must not replace a database assertion for lifecycle state.

Prefer application/file sentinels for provider entry and release because they name the state being synchronized. `tmux wait-for` is suitable only when a pane script or hook can explicitly signal a one-shot channel; tmux defines it as blocking until `wait-for -S` signals the same channel ([tmux(1), `wait-for`](https://man.openbsd.org/tmux.1#wait-for)). Hooks are appropriate for pane/client lifecycle, not agent settlement: `pane-exited` reports process exit and `client-focus-in`/`client-focus-out` report viewer focus ([tmux(1), Hooks](https://man.openbsd.org/tmux.1#HOOKS)). Set `remain-on-exit` during failure-oriented tests so the pane remains inspectable, then assert `#{pane_dead}`, `#{pane_dead_status}`, or `#{pane_dead_signal}` before cleanup ([tmux(1), `remain-on-exit`](https://man.openbsd.org/tmux.1#remain-on-exit), [tmux(1), formats](https://man.openbsd.org/tmux.1#FORMATS)). Every wait needs a deadline which prints the latest DB rows, pane formats, capture, and recorder/Pi logs on failure.

### Simulate process loss, not a reboot

The deterministic reboot-relevant scenario is explicitly **simulated process loss**:

1. Start a fresh isolated database through the real Sessions CLI and launch two real managed Pi panes on a private socket. Drive one through `agent_settled` to Idle; hold the other after its provider/tool entry sentinel while its durable phase is Working or Blocked.
2. Record session IDs, PIDs, transcript paths, and the DB snapshot. Run `tmux -L <test-socket> kill-server`; tmux specifies that this kills the server and clients and destroys all sessions ([tmux(1), `kill-server`](https://man.openbsd.org/tmux.1#kill-server)). Poll until both recorded PIDs fail `kill(pid, 0)` and the socket has no server.
3. Leave the database, WAL/SHM files, and transcripts intact. Start a fresh `sessions` process against that same state. Assert that the formerly Idle session derives Dormant and the held session derives Interrupted.
4. Revive/open each through the real CLI, assert a new PID/runtime and transcript continuity, and assert that the interrupted turn is not automatically continued.

This tests all application-owned consequences of losing tmux and Pi processes while preserving durable state. It does not test a new kernel boot identity, login-time environment, or filesystem availability after a real macOS reboot. Keep the real current boot ID, label the scenario accurately in output and video, and schedule an actual reboot separately only if those OS properties become acceptance criteria. Never edit a boot ID to make the picture more exciting.

### Make the same scenarios produce VHS evidence

Keep scenario setup and assertions in an executable harness, with a headless driver (`send-keys` plus `capture-pane`) and a VHS-facing command surface. A versioned tape should start the isolated harness, attach to or display the relevant real tmux pane, type the same scenario actions, and use `Wait+Screen`/`Wait+Line` regexes for visible checkpoints rather than fixed sleeps. VHS documents terminal sizing, typed/special-key input, regex waits, and MP4/GIF/WebM outputs in its command reference ([VHS command reference](https://github.com/charmbracelet/vhs#vhs-command-reference)). The harness still performs DB/CLI assertions and exits nonzero on failure; the tape records those results rather than recreating state with fixture rows.

Produce one reviewable recording per accepted scenario: first-turn/Idle, tool turn, Blocked/release, archive/undo, unarchive-on-turn, viewer focus, Dormant revival, and labeled process-loss Idle-versus-Interrupted. VHS covers terminal-only Pi and Sessions flows. Ghostty tab creation/focus still requires the separately approved real-Ghostty screen-capture lane; a VHS virtual terminal cannot prove application focus.

## Recommended implementation contract

- Add one e2e suite only. It launches the built `sessions` executable, real Pi 0.99.2, real recorder, real isolated SQLite store, and real private tmux server. Do not add provider, DB, or TUI unit-test doubles.
- Vendor the tiny scripted extension with the test harness, borrowing the faux-provider loop from pi-sessions. Pin/check Pi's version and fail before running if it differs.
- Give each scenario a fresh short `/tmp` root and socket path, a hard deadline, a `try/finally` server kill, PID-death verification, and retained failure artifacts. Never use the default server or production `-L sessions` in tests.
- Treat readiness/provider-entry/release files and DB state as synchronization. Treat pane captures and videos as review evidence.

## Uncertainties

- Pi AI's faux API is exported in 0.99.2, but it is test-oriented API rather than a documented CLI stability promise. The version check makes an upstream change a loud harness failure; upgrading Pi may require updating the extension.
- A full recorder/database/CLI/TUI scenario cannot be executed until Sessions v2 exists. The proof of concept establishes the risky seam—real interactive Pi, scripted offline provider, real tool execution, private tmux driving, capture, and teardown—not the future product's schema behavior.
- VHS and ffmpeg are not installed yet, and real Ghostty capture still needs Screen Recording approval, as recorded in the evidence research. This does not block the headless e2e harness.