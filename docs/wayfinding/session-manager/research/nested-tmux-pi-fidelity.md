# Nested tmux Pi fidelity

## Result

The Deck topology is viable for interactive Pi 0.99.2, with one material input defect: Shift+Enter survives when both tmux servers are configured correctly, but Alt+Enter does not. Through the nested client, tmux 3.7c emits Alt+Enter as legacy `ESC CR`; Pi has already activated an extended keyboard protocol and treats that form as ordinary Enter. An Alt+Enter on a non-empty test buffer therefore submitted it instead of inserting a newline.

Rendering, ordinary editing keys, resize, session switching, focus hooks, inner copy mode, truecolor, and OSC 8 hyperlinks otherwise worked. Kitty graphics require passthrough wrapping once for each tmux layer; merely enabling `allow-passthrough` does not add those wrappers.

## Setup

- Host tmux: 3.7c.
- Pi: `~/.local/share/mise/installs/github-earendil-works-pi/0.99.2/pi/pi`.
- Sessions server: `tmux -L swbspike-s`, using the real `~/.config/tmux/tmux.conf`.
- Deck server: `tmux -L swbspike-d -f /tmp/swb-nested-spike/deck.conf`.
- The Deck had a bash roster pane and a stage pane running `env -u TMUX tmux -L swbspike-s attach -t alpha`.
- Pi ran from scratch directories under `/tmp/swb-nested-spike`, with `TMUX` and `TMUX_PANE` removed.
- Input was driven at the outer stage pane. Captures were taken independently from that pane and the sessions-server Pi pane.

## Rendering and color

The outer capture was exactly the inner capture with the sessions server's pane-border line prepended and status line appended:

```text
outer[1:-1] == inner: True
outer lines: 36
inner lines: 34
```

Both ANSI captures contained the same representative 24-bit colors, including:

```text
ESC[38;2;0;175;175m
ESC[38;2;114;87;176m
ESC[38;2;178;160;232m
ESC[38;2;200;200;200m
```

The initial outer capture contained 48 `;2;` truecolor sequences and the inner capture contained 31. The additional outer sequences painted the sessions-server border and status. There was no color downgrade in Pi content.

The Deck status was off, so status bars did not double. The real sessions config still contributed one status line and its top pane-border line, reducing an 84x36 stage to an 84x34 Pi pane. A Deck-specific sessions overlay should turn off both if those two rows are not wanted.

## Keyboard protocol and editing

Pi's TUI sends `ESC[>7u ESC[?u ESC[c`, recognizes a Kitty response when available, and otherwise falls back to xterm modifyOtherKeys. Relevant implementation is in `packages/tui/src/terminal.ts:245-367` and parsing is in `packages/tui/src/keys.ts:831-932,996-1126`.

A raw-mode program run in place of Pi recorded what reached the inner pane with `extended-keys always` and CSI-u on both servers:

```text
Shift+Enter  ESC[13;2u
Alt+Enter    ESC CR
Enter        CR
Ctrl+Left    ESC[1;5D
Ctrl+Right   ESC[1;5C
Home         ESC[1~
End          ESC[4~
Page Up      ESC[5~
Page Down    ESC[6~
Tab          HT
Escape       ESC
Ctrl+C       ESC[99;5u
```

Observed Pi behavior:

- Shift+Enter inserted a newline. The inner capture showed `> SHIFT-LINE` followed by `  AFTER-SHIFT`.
- Alt+Enter did not insert a newline. On an empty editor, Alt+Enter followed by a marker was indistinguishable from ordinary empty Enter followed by that marker. On a non-empty editor it submitted the buffer. This accidentally invoked the model once during the probe; no subsequent test submitted non-empty input.
- Ctrl+C cleared a non-empty multiline editor and Pi remained alive.
- Escape closed both the `/` completion list and the model selector.
- Left arrows, Ctrl+Left, Home, and End produced the expected deterministic edit: `AAA BBB CCC` became `HAAA BBB YXCCCE` after the test insertions.
- The `/` menu rendered 74 entries and responded to Escape. `/mo` followed by Tab remained `/mo`; Tab reached Pi but did not complete that command in this UI state.
- Ctrl+L opened the model selector. Arrow, Page Up/Down, Home, and End input did not corrupt or dismiss it; Escape returned to the editor without selecting a model.
- Page Up/Down did not get a conclusive cursor-motion assertion because repeated rapid Ctrl+C-driven setup could exit a disposable Pi session. Their exact inner escape sequences were nevertheless verified by the raw-mode probe.

The extended-key settings are required at both layers. Fresh nested clients and fresh Pi processes showed:

```text
outer off, inner always: Shift+Enter became CR
outer on, inner on:      Shift+Enter became CR
outer on, inner always:  Shift+Enter remained ESC[13;2u
both always:             Shift+Enter remained ESC[13;2u
```

Required configuration:

- Deck/UI server: `default-terminal tmux-256color`, `extended-keys on` or `always`, `extended-keys-format csi-u`, and an `extkeys` terminal feature. The proposed `always` is sound.
- Sessions server: `extended-keys always` and `extended-keys-format csi-u`. In this nested topology, `on` was insufficient even when the attached `tmux-256color` client reported `extkeys`; `always` was necessary for Pi's Shift+Enter.
- Both servers: `escape-time 0`, `focus-events on`, `RGB` and `hyperlinks` terminal features, and `allow-passthrough all`.

The real user config already has the required sessions-server options. The proposed Deck config has the required outer options.

## Resize

Pi re-rendered at the stage width after both growth and shrink, with no stale columns. After each resize, stripping the inner border and status from the outer capture again produced exact plain-text equality with the inner capture.

```text
before:       outer 84x36, inner 84x34
after grow:   outer 99x42, inner 99x40, mapped clean True
after shrink: outer 69x28, inner 69x26, mapped clean True
```

## Switching sessions

`switch-client` moved the stage client from `alpha` to `beta` in 52 ms of command wall time. After a 120 ms observation delay, the outer capture exactly matched beta's inner capture after accounting for border and status, and contained no alpha marker or stale frame:

```text
outer[1:-1] == beta inner: True
contains alpha prompt residue: False
```

No visible partial frame or cursor displacement appeared in captures. Capture-based testing cannot rule out a sub-frame flicker on a physical display.

## Scrollback and mouse

The user's unprefixed `M-[` binding passed through the Deck and entered copy mode on the sessions server:

```text
outer pane mode=0, command=tmux
inner pane mode=1, command=pi
inner status: alpha > [tmux]
```

`q` exited that inner copy mode. The Pi startup screen did not leave useful history behind its full-screen redraw, so the spike could not demonstrate a nonzero scroll position.

A synthesized SGR wheel event injected into an attached Deck client was decoded by the outer tmux. With the outer root binding explicitly set to `send-keys -M`, the sessions server decoded the same wheel event; an inner test binding logged `inner-wheel`. Thus the event traverses both layers. While Pi owns the alternate screen, tmux's default wheel binding forwards the wheel to Pi rather than automatically opening copy mode. To scroll tmux history reliably, enter the inner copy mode with `M-[` first; wheel events then remain in that mode.

## Focus hooks

With a real pseudo-terminal client attached to the Deck, moving selection to the roster removed `focused` from the sessions-server client and fired `client-focus-out`. Moving back to the stage restored `focused` and fired `client-focus-in`:

```text
after roster: alpha attached,UTF-8
out session=alpha

after stage: alpha attached,focused,UTF-8
in session=alpha
```

Selecting panes on a detached Deck produced no hooks, as expected: there was no focused outer client to generate terminal focus events.

## Hyperlinks and Kitty graphics

An OSC 8 hyperlink survived both layers. Both inner and outer `capture-pane -e` output contained `https://example.com/swb-spike`, and the attached Deck client's PTY output contained it as an OSC 8 sequence.

Kitty graphics passthrough was tested with three distinct image ids:

- Direct Kitty APC (`i=1`): did not reach the outer client.
- One tmux DCS wrapper (`i=2`): did not reach the outer client.
- Two nested tmux DCS wrappers (`i=3`): reached the outer client exactly once as `ESC_G...i=3...ESC\`.

`allow-passthrough all` permits a wrapper at each layer but does not make a single wrapper recursive. Pi is intentionally launched without `TMUX`, so an image library using only `$TMUX` to decide whether to wrap would not wrap at all. Kitty image support therefore needs an explicit nested-terminal strategy; it should not be claimed as working by configuration alone.

## Operational surprises

- The sessions prefix is `M-a`; the Deck retained the default `C-b`, so there was no outer collision. `M-a` controls the sessions server. Sending `M-a` twice delivered literal `ESC a` to the inner application, as normal tmux prefix escaping requires.
- The sessions server's status and top pane-border consume two stage rows. This is deliberate user-config inheritance, but likely unwanted Deck chrome.
- Rapid synthetic Ctrl+C setup caused disposable Pi sessions to exit when Ctrl+C arrived with an already-empty editor. Test automation must wait for editor state rather than assuming one Ctrl+C is always a harmless reset.
- Alt+Enter is the only demonstrated interactive fidelity blocker. Shift+Enter is a working multiline alternative.

## Cleanup

Both private tmux servers, their attached pseudo-terminal clients, and every Pi process started by this spike were terminated after evidence collection. Scratch evidence remains only under `/tmp/swb-nested-spike/`.
