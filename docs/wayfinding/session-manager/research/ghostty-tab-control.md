# Ghostty tab creation and terminal focus

## Answers

- **A fresh tab can be created with cwd and command atomically.** Ghostty 1.3's `new tab` accepts a `surface configuration`; that record includes both `initial working directory` and `command`. Ghostty launches the initial terminal from that configuration, rather than requiring input after creation. The command returns the new tab. Target the window from the caller tty's existing `TerminalContext`, so dispatch does not depend on whichever Ghostty window happens to be frontmost.
- **A terminal can be focused directly.** Ghostty's `focus <terminal>` command promises to focus that split and bring its window to the front. A terminal's stable ID is enough to address it; GhosttyKit already resolves a tmux client tty to `TerminalContext(terminalID, windowID, tabID)`. No separate `select tab` or `activate window` call should be necessary. This is materially better than selecting the tab alone: in Ghostty 1.3.1, `select tab` deliberately does not activate the app.
- **The created tab satisfies `ide`'s precondition.** `new tab` creates one initial terminal from the supplied base configuration. Before `ide` creates its own split, `tab-terminal-count` should therefore report exactly one. This conclusion follows from Ghostty's creation API and controller path; it was not tested by opening a tab because the ticket forbids altering the user's layout.
- **`--wait` tty reporting is feasible, but it is a GhosttyKit rendezvous rather than a Ghostty 1.3 property.** `new tab` returns a tab object, from which GhosttyKit can obtain terminal 1's stable ID and construct a `TerminalContext`. It can then reuse the existing spawn-token wrapper, claim, cache, and deferred reply used by `split --wait`; stdout should be the claimed `/dev/ttys…`. Ghostty 1.3.1's dictionary has no terminal `tty` property. Ghostty main has one, and GhosttyKit labels direct tty lookup as requiring 1.4.0+, but upgrading is unnecessary for this command.
- **Minimum Ghostty is 1.3.0; this Mac has 1.3.1.** AppleScript support, including window/tab/terminal control, was introduced in 1.3.0. Treating the API as a hard dependency is appropriate; 1.3 documented it as preview, so later Ghostty upgrades still deserve a smoke test.

## Proposed `gty` surface

```text
gty new-tab --cwd <dir> --command <command> [--tty <origin-tty>] [--wait]
gty focus-terminal --tty <target-tty> [--wait]
```

`new-tab` mirrors `split`: `--cwd`, `--command`, and `--wait`; when waiting it prints only the new terminal tty, otherwise nothing. The normal global `--tty` selects the origin terminal and therefore the target window. `focus-terminal` is distinct from the existing directional `gty focus <left|down|up|right>` and uses the target tty directly. `--wait` on focus means acknowledgement, matching the other non-spawn commands.

For the Dispatcher:

```text
gty new-tab --cwd "$cwd" --command "ide --cwd … -- tmux -L sessions attach-session …" --wait
gty focus-terminal --tty "$client_tty" --wait
```

The command must be passed as one argument using the caller's normal argv construction; it is a Ghostty command string, not post-creation keystrokes.

## Evidence

### Ghostty 1.3.1 installed on the work Mac

- `/Applications/Ghostty.app/Contents/Resources/Ghostty.sdef:104-123` defines the surface configuration fields, including initial cwd and command.
- `/Applications/Ghostty.app/Contents/Resources/Ghostty.sdef:174-182` defines `new tab`, its optional target window and configuration, and its tab result.
- `/Applications/Ghostty.app/Contents/Resources/Ghostty.sdef:86-102` gives terminals stable IDs and a `focus` handler, but contains no `tty` property.
- `/Applications/Ghostty.app/Contents/Resources/Ghostty.sdef:195-209` says terminal focus brings its window to front and separately defines window activation and tab selection.
- `/Applications/Ghostty.app/Contents/Info.plist` reports `CFBundleShortVersionString = 1.3.1` (also confirmed read-only by `/Applications/Ghostty.app/Contents/MacOS/ghostty +version`).

### Ghostty primary documentation and source

- [Ghostty AppleScript docs, Overview](https://ghostty.org/docs/features/applescript#overview) says scripting arrived in 1.3.0; [Creation and Layout](https://ghostty.org/docs/features/applescript#creation-and-layout) documents `new tab` and its returned tab; [Surface Configuration Records](https://ghostty.org/docs/features/applescript#surface-configuration-records) lists cwd and command; [Focus, Selection, and Lifecycle](https://ghostty.org/docs/features/applescript#focus-selection-and-lifecycle) says terminal focus brings the window front.
- [Ghostty 1.3.0 release notes, AppleScript](https://ghostty.org/docs/install/release-notes/1-3-0#applescript-macos) introduces control of tabs and terminals and explicitly marks the 1.3 API preview.
- [Ghostty 1.3.1 release notes](https://ghostty.org/docs/install/release-notes/1-3-1) state that AppleScript tab selection no longer activates the application, reinforcing use of terminal `focus` for a Viewer visit.
- [`macos/Sources/Features/AppleScript/AppDelegate+AppleScript.swift:214-286`](https://github.com/ghostty-org/ghostty/blob/main/macos/Sources/Features/AppleScript/AppDelegate%2BAppleScript.swift#L214-L286) parses the optional configuration, calls `TerminalController.newTab(...withBaseConfig:)`, and returns the created tab.
- [`macos/Sources/Features/AppleScript/ScriptTerminal.swift:124-145`](https://github.com/ghostty-org/ghostty/blob/main/macos/Sources/Features/AppleScript/ScriptTerminal.swift#L124-L145) resolves the owning controller and calls `focusSurface` for the exact terminal.
- [`macos/Ghostty.sdef:174-197`](https://github.com/ghostty-org/ghostty/blob/main/macos/Ghostty.sdef#L174-L197) is the upstream definition of configured tab creation and terminal focus. Main additionally exposes terminal tty at lines 94-95; that is not present in installed 1.3.1.

### GhosttyKit primary source

- `~/code/personal/ghosttykit/daemon/ghosttykitd/Sources/ghosttykitd/GhosttyControl.swift:121-148` already maps tty to terminal/window/tab IDs; its direct tty-property path is documented as Ghostty 1.4.0+, with an OSC 7 fallback for 1.3.
- `~/code/personal/ghosttykit/daemon/ghosttykitd/Sources/ghosttykitd/GhosttyControl.swift:180-204` creates a configured split, focuses by exact terminal reference, and returns its `TerminalContext`; new-tab support can follow this shape.
- `~/code/personal/ghosttykit/daemon/ghosttykitd/Sources/ghosttykitd/GhosttyControl.swift:386-398` already contains private exact-terminal focus helpers. The missing work is exposing terminal focus through `GhosttyControlling` and the protocol/CLI, not inventing AppleEvents.
- `~/code/personal/ghosttykit/daemon/ghosttykitd/Sources/ghosttykitd/Requests.swift:320-377` implements `split --wait`: wrap command, create terminal, escrow token with its context, park a deferred reply, and return the claimed tty.
- `~/code/personal/ghosttykit/daemon/ghosttykitd/Sources/ghosttykitd/SpawnWrapper.swift:3-31` makes the spawned process claim its tty before `exec`ing the requested command; the mechanism is creation-type agnostic.
- `bootstrap/capabilities/terminal-tools/files/bin/ide:17-25` refreshes its own mapping and rejects any starting tab whose terminal count is not one.

## Uncertainties and implementation cautions

- Ghostty's public contract says `focus` brings the window front, while current upstream implementation delegates to `controller.focusSurface`. No mutating runtime probe was performed. Ticket 06 should add an integration smoke test covering another app/front window, another tab, and a non-focused split.
- The existing spawn rendezvous escrows only after the synchronous creation AppleEvent returns (`Requests.swift:370-375`), while the new process can theoretically claim before escrow. This pre-existing split race appears small but real; tab creation should not duplicate it unquestioningly. A retry or pre-registered token state would make both split and tab waits deterministic.
- The configured command replaces the shell. That is correct for `ide`, whose eventual tmux attach runs in the command pane, but quoting must be produced from argv safely rather than assembled from untrusted text.
