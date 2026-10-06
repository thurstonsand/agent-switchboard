# Nested tmux Alt+Enter and images

## Result

- Alt+Enter has a configuration-only fix. Add one binding to the sessions server. The Deck server does not need an Alt+Enter binding.
- tmux 3.7c translates Alt+Enter to legacy `ESC CR` each time it writes the key to a pane, regardless of `extended-keys-format`. The sessions-server binding intercepts the logical `M-Enter` key and writes Pi's CSI-u representation directly to the application pane.
- Pi 0.99.2 deliberately disables images when `TERM` starts with `tmux`. In the accepted topology it renders a textual image fallback and emits no Kitty graphics bytes.
- There is no configuration-only way to make Pi images traverse both tmux layers. Forcing Kitty support makes Pi emit an unwrapped APC, while tmux requires one explicit passthrough wrapper per layer. tmux does not add those wrappers.

## Alt+Enter configuration

- Keep the Deck/UI server's existing extended-key configuration:

```tmux
set -g default-terminal tmux-256color
set -s extended-keys always
set -g extended-keys-format csi-u
set -as terminal-features ',*:extkeys'
```

- Use these exact lines on the sessions server:

```tmux
set -s extended-keys always
set -g extended-keys-format csi-u
bind-key -n M-Enter if-shell -F '#{m:*Ext*,#{pane_key_mode}}' 'send-keys -H 1b 5b 31 33 3b 33 75' 'send-keys M-Enter'
```

- The hexadecimal bytes are `ESC [ 1 3 ; 3 u`, or `ESC[13;3u`.
- The `pane_key_mode` condition preserves legacy `ESC CR` for applications that have not enabled an extended-key mode. Pi and the raw probe reported `Ext 1`, so they receive CSI-u.
- Do not add the same binding only to the Deck server. The sessions server would parse the injected CSI-u key and translate it back to `ESC CR` before writing it to Pi.

## Alt+Enter evidence

- A raw probe directly inside the Deck server, with both the client and pane in extended-key mode, received:
  - Alt+Enter: `ESC CR`
  - Shift+Enter with `extended-keys-format csi-u`: `ESC[13;2u`
  - Shift+Enter with `extended-keys-format xterm`: `ESC[27;2;13~`
- This locates the first translation in the Deck server's pane encoding. Changing `extended-keys-format` changes Shift+Enter but never Alt+Enter.
- With an outer-only `M-Enter` hex binding, the nested raw probe still received `ESC CR`. This proves that the sessions server performs the same translation when it writes the key to its pane.
- With no outer binding and the sessions-server binding above, a physical-client CSI-u Alt+Enter reached the nested raw probe as:

```text
1b5b31333b3375  b'\x1b[13;3u'
```

- The final raw-mode regression probe received:
  - Alt+Enter: `ESC[13;3u`
  - Shift+Enter: `ESC[13;2u`
  - Enter: `CR`
  - Escape followed by Ctrl+C: `ESC ESC[99;5u`; the bytes were correct and happened to be returned by one `read(2)` call
- `user-keys[0] = "\e[13;3u"` did not help. tmux's extended-key parser recognized the sequence first and encoded it as `ESC CR`.
- `extended-keys` values, the `extkeys` terminal feature, and `default-terminal` govern negotiation and the other modified keys, but none changes tmux's Alt+Enter pane encoding. The working binding is still dependent on the baseline extended-key settings so Pi recognizes the injected sequence.

## Real Pi verification

- The test ran the real Pi 0.99.2 binary with `TMUX` and `TMUX_PANE` unset through both servers.
- A scratch `PI_CODING_AGENT_DIR` temporarily mapped `app.model.select` to `alt+enter` and disabled `app.message.followUp`. This made the key observable without submitting an editor buffer or calling a model.
- Alt+Enter opened Pi's model selector. Escape closed it.
- Typing `SAFE`, pressing Shift+Enter, and typing `LINE` left a two-line editor. Ctrl+C cleared it. Empty Enter was harmless, and the Pi pane remained alive.
- Pi's normal `app.message.followUp` handler intentionally behaves like submit while idle, so a non-empty idle test is unsafe. It only queues a follow-up while the agent is streaming (`packages/coding-agent/src/modes/interactive/interactive-mode.ts:4344-4373`).

## Surviving alternative Pi keys

- No Pi override is required when the sessions-server binding is installed.
- A raw nested probe nevertheless verified both of these alternatives:
  - Ctrl+Enter arrived as `ESC[13;5u`.
  - Ctrl+Q arrived as byte `11` (`DC1`).
- If a deployment cannot add the tmux binding, this exact `~/.pi/agent/keybindings.json` override avoids Alt+Enter:

```json
{
  "app.message.followUp": ["ctrl+enter", "ctrl+q"]
}
```

- Neither key conflicts with a Pi 0.99.2 core/TUI default. Ctrl+Q is also Pi's built-in Windows/WSL follow-up default (`packages/coding-agent/src/core/keybindings.ts:134-137`).

## Pi image detection

- Pi 0.99.2 image capability detection is environment-based (`packages/tui/src/terminal-image.ts:70-170`). It checks in this order:
  - `TMUX` set or `TERM` beginning with `tmux`: no images.
  - `TERM` beginning with `screen`: no images.
  - Kitty indicators: `KITTY_WINDOW_ID` or `TERM_PROGRAM=kitty`.
  - Ghostty indicators: `TERM_PROGRAM=ghostty`, `TERM` containing `ghostty`, or `GHOSTTY_RESOURCES_DIR`.
  - WezTerm and Warp indicators: Kitty graphics.
  - iTerm2 indicators: iTerm2 graphics.
  - Known non-image terminals and unknown terminals: no images.
- The tmux check occurs before Ghostty and Kitty checks. Inherited `GHOSTTY_RESOURCES_DIR` or `KITTY_WINDOW_ID` therefore cannot enable images while `TERM=tmux-256color`.
- `PI_IMAGE_PROTOCOL=kitty` or the `terminal.images: "kitty"` setting can force the protocol. `PI_IMAGE_PROTOCOL=none` or `0` disables it.
- Pi does not query for image support. Its Kitty keyboard query is unrelated. The `CSI 16 t` cell-size query is sent only after images are already enabled (`packages/tui/src/tui.ts:960-967`).

## Current image behavior

- In the accepted launch environment, `TMUX` is unset but `TERM=tmux-256color`. The `TERM` check selects `images: null`.
- `renderImage` returns `null`, and image components/tool output use `imageFallback` (`packages/tui/src/terminal-image.ts:638-731`, `packages/coding-agent/src/core/tools/render-utils.ts:50-60`). A representative fallback is:

```text
[Image: /tmp/swb-keys-spike/example.png [image/png] 640x480]
```

- Pi therefore degrades gracefully. It does not emit an unwrapped Kitty APC that disappears. The fallback includes the path when available, MIME type, and dimensions; the path can be an OSC 8 link when hyperlinks are enabled.
- A low-level pi-tui run under the topology environment corroborated the source trace: capabilities reported `images: null`, `renderImage` returned `null`, and the text fallback was returned. The executable test used the available pi-tui 1.0.0 dependency; the installed Pi 0.99.2 source above is authoritative and has the same detection and fallback path.

## Why Kitty graphics cannot be configured through

- Pi's Kitty encoder emits raw `ESC_G … ESC\\` and contains no tmux passthrough wrapping (`packages/tui/src/terminal-image.ts:216-255`).
- Forcing `PI_IMAGE_PROTOCOL=kitty` under `TERM=tmux-256color` produced a raw Kitty sequence, not a tmux DCS wrapper.
- The precursor nested-terminal spike established:
  - Unwrapped Kitty APC: dropped by the first tmux layer.
  - One tmux passthrough wrapper: consumed by one layer and then dropped by the other.
  - Two wrappers: reached the outer Ghostty client.
- `allow-passthrough all` only permits an already wrapped sequence. It does not wrap ordinary output or recursively add a second wrapper.
- tmux 3.7c's documented terminal features include native SIXEL graphics but no Kitty graphics feature. `extended-keys`, `terminal-features`, `default-terminal`, bindings, and environment variables cannot transform arbitrary Pi output into two nested DCS wrappers.
- Keep this on both servers for applications that do their own correct wrapping, but it does not enable Pi images:

```tmux
set -g allow-passthrough all
```

- For Pi 0.99.2, the supported configuration is to leave image detection conservative, optionally making it explicit with `PI_IMAGE_PROTOCOL=none`. The resulting textual fallback is acceptable degradation; claiming inline image fidelity would not be accurate.

## Scratch evidence

- New evidence is under `/tmp/swb-keys-spike/`, including `e2e-fixed.txt`, `inner-only.txt`, `outer-only.txt`, `format-variants.txt`, `replacement-keys.txt`, Pi captures, and `image-capabilities.txt`.
- The prior double-wrapper evidence remains under `/tmp/swb-nested-spike/`.
