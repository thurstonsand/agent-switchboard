# Deck mock, round 3 (ticket 09)

PROTOTYPE, never ships. Round 3 of the Deck mock folds in Thurston's feedback from playing with [round 2](#what-changed-since-round-2), and adds two investigations: [copy by highlighting](#investigation-a-copy-by-highlighting) and [theme detection](#investigation-b-theme-detection). It continues [ticket 09](../../tickets/09-roster-tui-prototype.md) and is still the proof of [ticket 08's agent-drivability requirement](../../tickets/08-launch-hosting-reopen-contract.md#agent-drivability-requirement).

Everything is real tmux. Only pi is fake, and the fake pi is a black box: nothing in this mock draws into pi's screen.

## Run

From a bare Ghostty tab, ideally 140 columns or wider:

```sh
cd docs/wayfinding/session-manager/prototypes/deck
bun install && bun run deck     # bun run start is an alias
```

Inside your own tmux, the outer tmux eats `M-a` before the Deck sees it, so use `SWB_PREFIX=C-s bun run deck` there.

- `q` in the roster closes the Deck. The sessions keep running on the mock sessions server, and the next `bun run deck` finds them again.
- `bun run reset` kills all three mock tmux servers (which SIGHUPs every fake pi and nvim) and wipes `/tmp/swb-mock-PROTOTYPE/`.
- Env knobs:
  - `SWB_HOVER=eager`: the default is now `lazy`. `H` toggles it live.
  - `FAKEPI_TUI=regular`: the fake pi runs fullscreen by default, like your pi (`"tuiMode": "fullscreen"`). `regular` imitates pi's main-screen mode, where tmux's copy mode handles drags.
  - `SWB_PREFIX` (default `M-a`), `SWB_DECK_ID` (default random), `SWB_MOCK_STATE` (the state dir).

pi-tui is pinned at **`@earendil-works/pi-tui@1.0.0`**, on Bun 1.4.2 and tmux 3.7c. `bun.lock` is gitignored because it pins Artifactory URLs.

## What changed since round 2

- **The fake pi is a black box.** The "previous turn was interrupted" notice is gone. An interrupted session comes back as plain pi (`interrupted-02-live-plain-pi`). Nothing else in the mock pretends `swb` draws into pi. The recorder's footer status is the one thing the real pi extension may add, and the mock doesn't need it.
- **Lazy hover is the default.** `w` wakes a session in the background; `⏎` wakes it and focuses it once it's up. Eager is `SWB_HOVER=eager` or `H`.
- **`⏎` on a session that isn't up keeps the keyboard in the roster.** The card says "Focus follows once it's up", the detail line says `on view: starting · focus when up`, and focus moves the moment pi is ready, if the cursor is still on that session (`enter-01`, `enter-02`). Round 2's lost type-ahead can't happen any more.
- **A dormant session shows its last prompt and its last reply** on the right, plus `w wake · ⏎ focus` (`lazy-01-dormant-card`). The same excerpts appear on the interrupted, not-running, and archived cards.
- **Archived is an inline accordion** at the bottom, like Inactive, collapsed by default and flat inside (`archived-01`, `archived-02`). The separate Archived view is gone, and so is `esc` "back".
- **`a` toggles.** On an archived row it unarchives (`archived-04`). `U` is gone. `u` still undoes the last archive within 5 s.
- **Clicking a header toggles it**: project headers, Inactive, and Archived (`click-01` … `click-03`).
- **h/l navigation.** `M-a h` focuses the roster and `M-a l` focuses the session, from either pane. In the roster, `l` on a session row is `⏎`, and `h` on a session row jumps to its header. On a header, `h`/`l` collapse and expand. `←`/`→` do the same as `h`/`l`.
- **The blocked glyph flashes**: `◆` in `#c084fc` (the glimpse companion's `--attention-dot`), alternating bold and faint every 500 ms, so a full cycle is 1 Hz. It's drawn by the roster, not SGR blink (`blocked-01`, `blocked-02`). The `blocked` label in the detail block uses the same purple, steady.
- **The word "stage" never appears in the UI.** Hints say `⏎ focus` and `M-a h roster`; the detail block says `on view`, `on view: summary`, `on view: editor (nvim)`, or `not on view`; help talks about "the session".
- **Copy by highlighting works** in both pi modes, through all three tmux layers, verified with `pbpaste`. See [Investigation A](#investigation-a-copy-by-highlighting).
- **The fake pi themes itself like `"theme": "system"`**, and the roster's cursor follows the terminal's colors. See [Investigation B](#investigation-b-theme-detection).

## Interim behavior waiting on Thurston

These are built, and flagged here because the answers are still coming:

- **Wording for "stage".** The UI avoids the word entirely. Focus wording is `⏎ focus`, `M-a h roster`, `M-a l` "focus the session". What's on the right is "on view". The code and this README still say Stage, as the design doc does.
- **What a dormant session shows under lazy hover.** A card with the last prompt (2 lines) and last reply (4 lines) from the transcript, then `w wake · ⏎ focus` (and `a unarchive` on archived rows). The real thing reads both from the db, so it costs nothing.
- **The h/l rule.** On a header, `h`/`l` collapse and expand, and `⏎`, space, or a click toggles. On a session row, `l` focuses (like `⏎`) and `h` jumps to the header: the project header, or the Archived header for an archived row. `h` on a collapsed header does nothing; it could move to the parent section header instead, if you want tree-style navigation.

## Key map

Roster, bare keys:

- `j`/`k`, `↓`/`↑`: move. The right side follows onto session rows instantly. It stays put while the cursor is on a header, so walking past headers doesn't flicker.
- `g`/`G`: top / bottom
- `⏎` or `l` (or `→`) on a session: focus it, waking it first if needed. The keyboard stays in the roster until pi is up.
- `h` (or `←`) on a session: jump to its header
- on a header: `h`/`l` collapse / expand; `⏎`, space, or a click toggles
- `w`: wake the session under the cursor in the background
- `a`: archive. It's refused while a turn runs (working *or* blocked on a permission prompt). On an archived row, `a` unarchives.
- `u`: undo the last archive within 5 s
- `/`: filter. Typing selects the first match, `⏎` keeps the filter, and `esc` clears it. A filter opens every section that has matches.
- `?`: help popup, the same as `M-a ?`
- `H`: toggle hover lazy ↔ eager (prototype key)
- `q`, `ctrl+c`: close the Deck
- Mouse: a click selects a session row and toggles a header, a double-click focuses a session, and the wheel moves the cursor. Clicking a pane focuses it.

Deck prefix `M-a`, on the UI server, from either pane:

- `M-a h` / `M-a l`: focus the roster / the session. `M-a h` while zoomed also unzooms; `M-a l` keeps the zoom.
- `M-a Tab`: toggle focus. While zoomed, it also unzooms.
- `M-a e`: swap the right side between the session and its directory's editor (real nvim, one per exact cwd, started lazily)
- `M-a z`: zoom the session (focus mode), and again to unzoom
- `M-a ?`: help, as a tmux `display-popup`
- `M-a M-a`: send a literal `M-a` through. That reaches *your sessions-server prefix*, because your tmux.conf also uses `M-a`.

## What's on screen

- **Roster pane** (left, 30% of the width, clamped to 32–44 columns): header and counts, the list, a 4-line **detail block** (title; state, live or not running, archived; directory and `⎇ branch`; what's on view and whether it's focused or zoomed), a message line for toasts and the undo countdown, key hints that change with the row and the focus, and the magenta `PROTO` bar.
- **Glyphs**: flashing purple `◆` blocked, `◐` working, `●` unseen, `○` idle (dim when dormant), `⚠` interrupted, a cyan braille spinner while pi starts, and `✓` archived.
- **Cursor and on-view mark**: the cursor is a background highlight, mixed from the terminal's own background and foreground (reverse video until the terminal reports them). `▌` in column 0 marks the session that's on view, cyan when it has the keyboard.
- **Right pane**: a real `tmux attach` client of the sessions server. When there's no live pi to show, a per-Deck placeholder session renders a card: loading (spinner and elapsed time), idle, interrupted, not running, or archived, each with the excerpts and keys. Or nvim, after `M-a e`.

## Investigation A: copy by highlighting

### Why it didn't work in round 2

Three layers see a drag in the right pane: the UI server (`mouse on`), the sessions server (your tmux.conf's `mouse on`), and pi.

- The UI server's stock `MouseDrag1Pane` binding is `if -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' { send -M } { copy-mode -M }`. The nested `tmux attach` client in the right pane turns mouse reporting on (your sessions server has `mouse on`), so `mouse_any_flag` is 1 and the UI server forwards the drag. It never selects anything itself.
- The sessions server makes the same decision for pi's pane:
  - **Fullscreen pi** (`"tuiMode": "fullscreen"`, which is what you run) turns mouse reporting on. The drag goes on to pi, which selects and copies on its own: copy-on-select defaults to true, and on macOS pi writes the clipboard natively (`getNativeClipboard().setText`, then `pbcopy`), with no OSC 52 (`packages/coding-agent/src/utils/clipboard.ts`). That path works through the Deck without any configuration. The round-2 fake pi didn't imitate it.
  - **Regular pi** (and round 2's fake pi, a `TuiMainScreen`) leaves mouse reporting off, so the sessions server enters copy mode, highlights, and on release runs `copy-pipe-and-cancel`. Your `set -s set-clipboard on` then sends OSC 52 to its client, which is the UI server's right pane.
- **The UI server dropped that OSC 52.** Its `set-clipboard` was tmux's default, `external`, which ignores pane applications that try to set the clipboard. That was the bug.

### The fix

One line in the UI server's config (`uiConf()` in `shared.ts`):

```tmux
set -s set-clipboard on
```

Keep your sessions server's existing lines as they are (`set -s set-clipboard on`, `set -g mouse on`, `set -g mode-keys vi`, `default-terminal tmux-256color`) and tmux's stock mouse bindings on both servers. No `terminal-features` or `Ms` override is needed: both nested clients report the `clipboard` feature and `Ms=\E]52;%p1%s;%p2%s\007` from `tmux-256color` on this Mac.

And the fake pi now imitates fullscreen pi: a `TuiAltScreen` with `mouse: true`, `copyOnSelect: true`, and a `copySelection` that pipes to `pbcopy`, inside pi's own fullscreen layout (scrolling transcript, docked editor and footer, from `chat-viewport.ts`).

### Evidence

Synthetic SGR mouse through the driver (`drive drag`), which writes `ESC[<0;x;yM`, four `ESC[<32;x;yM` motions, and `ESC[<0;x;ym` into the harness pane, where the Deck's real UI client decodes them:

- **Fullscreen pi** (`copy-01-fullscreen-pi-drag`): a 30-cell drag across a line of pi's transcript. `pbpaste` returned exactly those 30 cells, `` A failed write sets `swb ✗ db `` (`copy-01-fullscreen-pi-drag.clipboard.txt`). No tmux layer entered copy mode.
- **Regular pi** (`copy-02-regular-pi-drag`, `drive start --pi regular`): the sessions server's copy mode highlighted the line, and on release all three layers held the same buffer (`copy-02-regular-pi-drag.buffers.txt`), and `pbpaste` returned `build round 2 of the Deck mock`.
- **Without the fix**, the delegated spike ([findings](#references)) reproduced round 2: the sessions server's buffer had the text, the outer layer never saw OSC 52, and the clipboard didn't change.
- **Roster input is unaffected.** The spike's roster stand-in logged the click press, release, and wheel unchanged with the fix in place. In the mock, every header click in `click-01` … `click-03` came through, and the deck log records each one.

The harness stands in for Ghostty: it has `set -s set-clipboard on` and a `pane-set-clipboard` hook that pipes the buffer to `pbcopy`. That emulates Ghostty's `clipboard-write = allow`. It isn't proof of it.

### What I tried and rejected

- **Outer copy mode on the UI server** (`MouseDrag1Pane` → `copy-mode -M`, `MouseDragEnd1Pane` → `copy-pipe-and-cancel pbcopy`). It copies for regular pi, but the UI server has `history-limit 0`, so it can only select what's on screen. It can't tell regular pi from fullscreen pi: both show up as `pane_current_command=tmux`, `mouse_any_flag=1`. With fullscreen pi it stole the drag mid-gesture and copied garbage (`ULLSCREEN_COPY_TA`). An unconditional binding would also steal roster drags.
- **Ghostty's shift+drag** bypasses mouse reporting and makes a native Ghostty selection, which Cmd+C copies. It's the fallback when an app holds the mouse and won't copy. It can't be tested synthetically, because Ghostty handles it before any SGR bytes exist. And since Ghostty knows nothing about tmux panes, a multi-line shift-drag selects across the roster too.

### Needs your mouse in real Ghostty

- A fullscreen-pi drag in the right pane highlights and lands in the clipboard. That's pi's own selection, so Cmd+C isn't involved; copy-on-select is.
- With `FAKEPI_TUI=regular`, a drag highlights in tmux copy mode and lands in the clipboard through OSC 52, with no Ghostty permission prompt. Ghostty here reports `clipboard-write = allow`, which should mean no prompt.
- Roster clicks, double-clicks, and the wheel still feel right.
- Shift+drag, as the fallback.

## Investigation B: theme detection

### Why the right pane rendered dark on a light Mac

Two causes, one of them hidden behind the other.

- **The round-2 fake pi hard-coded dark panels** (`48;5;236` and two dark RGB backgrounds), so it rendered dark whatever the terminal said. No configuration could have fixed that. The fake pi now does what `"theme": "system"` does: it queries OSC 10, 11, and 4;0–15 (then DA1) at start, enables mode 2031, and queries again on every light/dark report. A reported background wins. Without one, it falls back to the 2031 report, then `COLORFGBG`, then dark. Its panels are mixed from the reported background and palette, or from fixed light/dark sets. How it themed itself goes into its runtime file, and `drive state` shows it per live session.
- **Your gruvbox conf answers for the terminal.** `gruvbox-light.conf` sets `window-style "bg=#f9f5d7"` on the sessions server, and tmux answers OSC 11 from `window-style` when it's set. So real pi in the Deck came out light, but only by accident: the background was frozen at whatever `~/.terminal-bg` said when the sessions server started (`terminal-theme-switch.py` only re-sources the default server), while the foreground and palette came live from Ghostty. After a switch to dark, you'd get a light background with light text, and the pane never gets the 997 report that makes pi re-query. The delegated probe showed real pi's colors staying on the light set after a dark switch under gruvbox, and switching (`117;104;91` → `171;157;144`, among others) only with the fix. Round 3's first run showed the same thing with the new fake pi: `source: background`, `#f9f5d7`, no foreground, no palette.

### What each tmux layer answers

From the delegated probe (pi's exact query string plus `CSI ? 996 n`, run at every layer) and tmux 3.7c's source:

- **OSC 10/11** (fg/bg): every tmux answers these itself, never forwarding them. It uses `window-style` fg/bg if set, otherwise the colors its client's terminal reported when it attached. With neither, it doesn't reply. The cache refreshes only on a 997 report from the terminal (or a resize, at most every 30 s).
- **OSC 4** (palette): answered from `pane-colours` if set. Otherwise tmux forwards the query, live, to the terminal of the most recently active attached client. The fake Ghostty logged all 16 queries arriving from the innermost pane through both layers.
- **Mode 2031 / 997**: tmux derives a pane's theme from its background (a hard-coded `window-style` wins), then from its clients' reported theme. It sends `ESC[?997;1|2n` to a pane that enabled 2031 when a client attaches or switches to its session, and when the theme changes.
- **The startup race**: `deck.ts` builds the Deck detached, then attaches. A right-pane client created before your terminal attached got no fg/bg in 2 of 3 runs, so pi got nothing and fell back to dark. Created after the attach, 3 of 3 were right.
- **The harness is an artifact.** A detached tmux with no styles answers only DA1, so anything under the round-2 driver saw a terminal that reports nothing.

### The fix

In the sessions overlay, after your tmux.conf:

```tmux
set -g window-style default
set -g window-active-style default
```

And in the mock:

- `stage.sh` waits until the Deck's UI session has a client before its first `attach`, so the nested client inherits your terminal's colors.
- The roster enables 2031 and re-queries on every 997, like pi. Its cursor highlight is mixed from the reported background and foreground (20% toward the foreground with the keyboard, 8% without), falling back to reverse video when the terminal reports nothing. It used fixed `48;5;238`/`48;5;235` before, which are dark grays on any theme.
- The UI server's pane border uses `brightblack` (palette 8) instead of the fixed `colour238`.
- Nothing in either swb server sets `pane-colours` or a style fg/bg.

The rest of the roster already used ANSI palette colors (`31`–`36`, `90`, faint), which follow any theme. The one deliberate exception is the blocked `◆` in `#c084fc`.

### Evidence

The harness now stands in for Ghostty with Gruvbox Light Hard (from `Ghostty.app/Contents/Resources/ghostty/themes`), via `window-style bg=#f9f5d7,fg=#3c3836` and `pane-colours[0..15]`. `drive theme dark` switches it to Dark Hard live.

- `theme-01-light`: the roster reports `bg 249,245,215`, fg, and 16/16 palette (`terminalColors` in the state). The on-view pi reports `source: background+palette, #f9f5d7`.
- `theme-02-dark-live-switch`: after `drive theme dark`, the roster logged `terminal colors (997 dark): … bg 29,32,33 … 16/16` and re-mixed its cursor. The on-view pi re-themed to `#1d2021`. A live pi that wasn't on view still says light.
- `theme-03-dark-card`: a dormant session's card. It's ANSI colors only, so it follows without querying.
- `theme-04-dark-once-viewed`: moving onto that stale pi sent it a 997 on `switch-client`, and it re-themed to dark.
- `theme-05-light-again`: switching back, the roster and the on-view pi follow again (`997 light` in `deck-drive.log`).
- Prestarted pis that nobody has viewed yet start with nothing (`source: default`, dark) and re-theme on first view. That's the same mechanism.

### Fallbacks and tradeoffs

- **Copying the terminal's colors into `window-style`/`pane-colours` at Deck start** works, but it freezes them. `swb` would need to re-apply them on every switch, and it's wrong for a sessions server viewed from two terminals. Rejected.
- **`COLORFGBG`** is read once at pi startup, is static, and loses to any reported background. It's only worth having as an extra light/dark hint for prestarted sessions before their first viewer, set from the launcher's own query. I didn't add it.
- **2031/997 alone** gives light/dark only, no palette. But it's what makes pi re-query, so the fix depends on tmux sending it.
- **Two Decks on different terminals viewing the same session** at once: the pane answers from one of them. There's only one pane, so nothing fixes that.
- If you ever point `terminal-theme-switch.py` at the sessions server, its re-source would bring gruvbox's `window-style` back. `swb` should re-assert the two lines after any re-source.

### Needs your real Ghostty

- That Ghostty answers OSC 10/11/4 and `?996n`, and sends `ESC[?997;1|2n` when macOS flips appearance. From a bare Ghostty tab, run `python3 /tmp/swb-r3-theme/probe.py --listen 15 --label ghostty-bare` and flip appearance during the 15 s.
- In a real Deck: the roster cursor and pi's panels come out light, and a macOS appearance flip re-themes the roster and the on-view session within about 2 s.
- The startup race on real hardware. Ghostty may answer fast enough to hide it; the ordering fix is cheap either way.
- Running the Deck from inside your default tmux makes that tmux the outer layer, and its own gruvbox `window-style` answers OSC 11 for the Deck. That one is kept live by `terminal-theme-switch.py`, so it should mostly work.

## How it's built

- **Sessions server** `tmux -L swb-mock`: loads `~/.config/tmux/tmux.conf`, then sources the overlay (`sessionsOverlay()` in `shared.ts`): chrome off, `window-style default` and `window-active-style default` (see Investigation B), ticket 08's options plus `exit-empty off` and `detach-on-destroy on`, focus and detach hooks appended with `-ga`, and appended hooks that re-assert `status off` against your config's pane-focus hooks.
- **UI server** `tmux -L swb-mock-ui`: an embedded config (`uiConf()`) with ticket 08's terminal features, no status bar, `mouse on`, `set-clipboard on`, `unbind -a -T prefix`, and the prefix bindings. `M-a h` and `M-a l` are `select-pane -t :.0` and `:.1`. `{left}`/`{right}` looked nicer, but in a zoomed window they resolve to the one visible pane, so `M-a h` did nothing while zoomed. Hooks `curl` the Deck's unix socket; `destroy-unattached` is switched on per Deck by a `client-attached` hook.
- **Deck** (`deck.ts`): creates `deck-<id>` with the right pane first, splits the roster to its left, and attaches your terminal. The right pane runs `stage.sh`, which waits for your terminal to attach (so the nested client inherits its colors), then loops, re-attaching to whatever the Deck last wrote to its target file, falling back to the placeholder.
- **Roster** (`roster.ts`): the pi-tui app. One tmux control-mode client to the sessions server for commands and `%sessions-changed`; fake-pi runtime files through `fs.watch`; its view state on `deck-<id>.sock`. One `desired()` maps (session on view, mode, runtime, archive mark, pending focus) to a tmux target or a card, and `apply()` makes it so.
- **The flash** is a pure function of the clock (`flashOn(now)`), drawn by the 100 ms ticker that already ran in round 2. pi-tui diffs frames line by line and writes only the rows that changed, and a keypress renders immediately, preempting the ticker's throttled frame. See Performance.
- **Fake pi** (`fakepi.ts`): pi-tui's own `Editor` in pi's fullscreen layout, with copy on select. It sleeps 1.5 s before its first frame, then shows a pi-like header, the session's history, the editor, and pi's two-line footer. `⏎` runs a canned 2 s turn, `/long` a 30 s one, `/quit` or `ctrl+d` exits, and `esc` aborts. It writes a runtime file in place of the recorder's row, including how it themed itself.
- **Fake data**: 14 sessions in 4 projects with scratch git repos under `/tmp/swb-mock-PROTOTYPE/code/` (11 open, 3 archived), one real worktree, two sessions sharing a directory, three prestarted (mid-turn, blocked, idle and unseen), one interrupted, one inactive.

## The driver

`drive.ts` is the prototype of `swb drive` and `swb deck state`. New in round 3: mouse verbs, `--pi`, and a harness that stands in for Ghostty's colors and clipboard.

- `bun run drive start [--size 140x40] [--hover lazy|eager] [--pi fullscreen|regular] [--theme light|dark] [--fresh]`: starts the hidden harness server (`tmux -L swb-mock-drive`) with one pane of that size, running `bun deck.ts`, and returns once the Deck answers on its socket. The harness answers color queries with Gruvbox Light Hard or Dark Hard, and writes OSC 52 to the macOS clipboard.
- `bun run drive theme light|dark`: switches the harness's colors live, the way a macOS appearance flip switches Ghostty's.
- `bun run drive keys [--delay ms] <tmux key names…>`: `send-keys` into the harness pane, one key per call, 60 ms apart. `-l <text>` sends literal text.
- `bun run drive click <col> <row> [--double]`, `click-text <text> [--double]`, and `drag <col> <row> <col> <row>`: SGR mouse reports as raw bytes into the harness pane, 0-based cells of the capture. `click-text` clicks the first cell of the first match, so an agent can click "harbor-deploy" without counting rows.
- `bun run drive capture [--ansi]`, `state`, `wait <path>=<value>`, `focus in|out`, `resize`, `snap <name>`, `bench [n]`, `stop`, `reset`: as in round 2. `state` now has `stage.pendingFocus`, sections' `expanded`, each live session's `theme`, the roster's `terminalColors`, and the new perf counters.

## Captures

`./capture.sh` regenerates everything in about 90 s. It starts fresh, drives every feature through `drive`, and ends with `drive reset`, so no mock server or process survives it. The two copy captures write the clipboard; the script saves it first and restores it on exit. Each name has `.txt`, `.ansi` (`cat` it in a terminal), and `.state.json` under `captures/`.

Sizes:

- `140-01-initial`: first paint at 140×40, lazy hover, with the prestarted, mid-turn "Deck mock round 2" live on the right
- `100-01-initial`, `100-02-dormant-card`: a second Deck at 100×30 against the still-running sessions server
- `resize-01-160x45`: a live resize from 100×30

Lazy hover and the dormant card:

- `lazy-01-dormant-card`: cursor onto dormant, unseen "Schema v1 grilling". Last prompt, last reply, `w wake · ⏎ focus`. Nothing starts.
- `lazy-02-woken-loading`, `lazy-03-live`, `lazy-04-visited`: after `w`

`⏎` on a dormant row:

- `enter-01-starting-keyboard-stays`: the card says "Focus follows once it's up", the detail line says `focus when up`, and `focus` is still `roster`
- `enter-02-focused-once-up`: pi came up and took the keyboard

Navigation:

- `nav-01-M-a-h-to-roster`, `nav-02-M-a-l-to-session`
- `nav-03-l-on-session-focuses-it`
- `nav-04-h-to-project-header`, `nav-05-h-collapses-header`, `nav-06-l-expands-header`
- `zoom-01-zoomed`, `zoom-02-M-a-h-unzooms-to-roster`

Header clicks (synthetic SGR mouse):

- `click-01-project-header-collapsed`, `click-02-project-header-expanded`: two single clicks on "harbor-deploy"
- `click-03-inactive-section-expanded`: one click on "Inactive"

Blocked:

- `blocked-01-flash-full`, `blocked-02-flash-dim`: the same `◆`, `ESC[1m ESC[38;2;192;132;252m` then `ESC[2m ESC[38;2;192;132;252m` in the `.ansi` files
- `blocked-03-permission-prompt`: the blocked session's permission box

Archived:

- `archived-01-inline-collapsed`: `▸ Archived (3)` at the bottom
- `archived-02-inline-expanded`: after `⏎` on it
- `archived-03-row-card`: an archived row's card, with excerpts and `a unarchive`
- `archived-04-a-unarchived`: `a` on it. It's back in ansiblonomicon, and the cursor stayed in place, on the next archived row.
- `archived-05-a-archives-again`: `a` on it in its project, with the undo countdown
- `archive-01-refused`: `a` on the mid-turn session
- `archive-02-archived-pi-and-editor-killed`, `archive-03-undone`, `archive-04-shared-dir-editor-kept`: as in round 2

Eager hover (after `H`):

- `eager-01-countdown`, `eager-02-loading`: "Starting in 500 ms", then the spinner
- `eager-03-moved-on-instantly`: `j j` while it loads
- `eager-04-back-snapped-to-live`: `k k` after it came up

Focus and typing:

- `focus-01-typing`, `focus-02-shift-enter-through-three-tmux-layers`, `focus-03-working`, `focus-04-replied`

Copy:

- `copy-01-fullscreen-pi-drag` and its `.clipboard.txt`
- `copy-02-regular-pi-drag`, its `.clipboard.txt`, and `.buffers.txt` (all three servers' buffers)

Theme (the harness standing in for Ghostty, Gruvbox Light Hard → Dark Hard → Light Hard):

- `theme-01-light`, `theme-02-dark-live-switch`, `theme-03-dark-card`, `theme-04-dark-once-viewed`, `theme-05-light-again`. The colors are in each `.state.json` (`terminalColors`, and each live session's `theme`) and in the `.ansi` files.

Everything else:

- `editor-01-nvim`, `editor-02-back-to-pi`, `help-01-popup`, `passthrough-01-inner-copy-mode`
- `notrunning-01-pi-quit-while-on-view`, `notrunning-02-back-shows-summary`: under lazy hover, coming back shows the summary card instead of restarting
- `interrupted-01-card`, `interrupted-02-live-plain-pi`: after `w`, plain pi, no notice
- `visit-01-unfocused-finished-unseen`, `visit-02-focused-seen-at-once`, `visit-03-visited.state.json`
- `perf-bench.json`, `perf-final.state.json`, `deck-drive.log` (every start with its trigger, Visit, archive, unarchive, click, and editor decision), `sessions-hooks.log`

## Performance

From `captures/perf-final.state.json` and `captures/perf-bench.json`, with three tmux servers, four fake pis, one nvim, and `◆` flashing on screen throughout:

- **Key → right-pane repaint, seen from outside: 33.9 ms average, 42.7 ms max (n=30)**, against round 2's 38 / 44. `drive bench` alternates `j`/`k` between two live sessions, one of them the flashing blocked row, and polls `capture-pane` until the new title appears. One poll costs about 12 ms, so the true figure is lower.
- **Key → `switch-client` acknowledged, inside the Deck: 1.76 ms average, 4.3 ms max (n=51).** An earlier run showed a 436 ms max. That was a measuring bug, not latency: the filter branch didn't clear the keypress timestamp, so a later `M-a e` swap was timed from a stale filter keystroke. Fixed, and the roster now logs any key → switch over 50 ms; the final run logged none.
- **`switch-client` over control mode: 0.79 ms average, 2.0 ms max (n=59).**
- **The flash costs nothing on the input path.** The ticker changed 0.41 rows per 100 ms tick on average (max 4), and pi-tui's line diff writes only those rows (64 bytes per tick on average). A keypress renders immediately (`requestImmediateRender`), cancelling any throttled ticker frame, so animation can't delay input. Roster render: 0.67 ms average, 10 ms max (n=943).
- **Starts**: `new-session` 2.5 ms average, start → ready 1.70 s for a 1.5 s simulated startup.
- **Lazy hover starts less.** The whole capture run started 4 pis: 2 by `w`, 1 by `⏎`, and 1 by hover during the eager segment. Round 2's run started 4 by hover alone.

## Friction

New in round 3:

- **`{left}`/`{right}` pane targets break under zoom.** They resolve against the visible layout, which is one pane while zoomed. Pane indices work.
- **A synthetic `Escape` followed by another key within a few hundred ms reaches the roster as an Alt chord** (`ESC` then `l` arrived as `ESC[108;3u`, `M-l`), even with `escape-time 0` on every server. Round 1 hit the same thing (`Escape G` became `alt+G`). It's intermittent: a lone `Escape` with nothing after it always arrived alone, in about 28 ms. The capture script's `goto` now clears the filter with `/ ctrl+u ⏎` instead. I didn't find the layer; it's worth a real-keyboard check (`/foo`, `⏎`, `esc`, `j` quickly) before trusting `esc` in the real roster.
- **pi-tui made fullscreen pi cheap to imitate.** `TuiAltScreen` takes `copyOnSelect` and `copySelection`, and pi's `chat-viewport.ts` layout is two `VStack`s and a `ScrollView`.

Still true from round 2: no height in `render(width)`; no focus-event API (focus comes from UI-server hooks); `destroy-unattached` has to be set per Deck after attach; `detach-on-destroy on` belongs in the overlay; `tmux attach` stdout goes to `/dev/null`; your config's pane-focus hooks turn the status bar back on unless the overlay re-asserts it; control mode wants one command per line, `=name:` targets, and both lines of `new-session` + `set-option` written before awaiting either; hook `run-shell -b` commands end in `|| true`; pane ids go through URLs as `#{s/%//:pane_id}`; your unprefixed root bindings (`M-[`, `M-z`, `M-s`) act on the sessions server.

## Decisions I made that you didn't

- `u` only undoes an archive. Unarchiving is undone with `a`.
- After `a` either way, the cursor stays in place, on the row that followed, rather than chasing the session into its new section.
- Focus-once-up is cancelled as soon as the cursor leaves that session, including onto a header.
- A filter opens Archived too when it has matches, the same as Inactive.
- `M-a l` only moves focus. It doesn't wake a dormant session; `⏎` and `l` in the roster do.
- Every click on a header toggles it, so a fast double-click toggles twice.
- The flash uses SGR faint for the dim phase, so it dims relative to whatever background the terminal has, instead of a second fixed color.

## Open questions for Thurston

- **Wording**: what replaces "stage"? The mock says "on view" and "focus the session". Does "on view" read right, or do you want a noun?
- **The dormant card**: are last prompt and last reply the right two facts? Is 2 + 4 lines the right length?
- **h/l**: is the interim rule right? Should `h` on a collapsed header move to its parent section?
- **`u`**: should it also undo an unarchive?
- **Escape timing**: does `esc` then a quick `j` in the real roster ever turn into `M-j` for you?
- **Theme**: should `swb` set `COLORFGBG` for sessions it starts, so a prestarted pi is on the right side of light/dark before anyone views it? And are you happy with the overlay overriding your gruvbox `window-style` on the sessions server? It's the only way pi sees Ghostty's real background.
- Still open from round 2: the nested `M-a` prefix collision, editor stickiness across cursor moves, narrow Decks below ~120 columns, header rows as cursor stops, and Visit on focus loss.

## References

- Copy spike findings: `/tmp/swb-r3-copy/FINDINGS.md` (scratch; the evidence above is reproduced by `capture.sh`)
- Theme spike findings: `/tmp/swb-r3-theme/FINDINGS.md` (scratch)
