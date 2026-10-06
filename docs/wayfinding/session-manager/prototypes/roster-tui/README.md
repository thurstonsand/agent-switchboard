# Roster TUI prototype (ticket 09)

PROTOTYPE, never ships. It answers [ticket 09](../../tickets/09-roster-tui-prototype.md): does the roster *feel* right in a real terminal? Everything runs on fake in-memory data. There's no db, no tmux, and no Ghostty; Enter only shows a toast.

It starts from [the round 2 mocks](../round-2-mocks.md): mock A (compact) by default, switching to mock C (roster + preview) at a width breakpoint.

## Run

```sh
bun install && bun run start
```

Quit with `q` or `ctrl+c`. Two environment knobs:

- `SWB_BREAKPOINT=120 bun run start` moves the A↔C breakpoint (default `DEFAULT_BREAKPOINT = 110` at the top of `roster.ts`; `[` and `]` also move it live by 5)
- `SWB_TICK=off bun run start` starts with the fake activity tick paused (the capture script uses this)

pi-tui version: **`@earendil-works/pi-tui@1.0.0`**. The work Mac's mirror resolved 1.0.0 on 2026-10-06 (published upstream 2026-10-01), so the "mirror stops at 0.87.1" note from ticket 12 is already out of date. 1.0.0 is newer than the installed Pi's 0.99.2. `bun.lock` is gitignored because it pins Artifactory tarball URLs; `package.json` pins the exact version anyway.

Runtime: Bun 1.4.2, inside tmux 3.x, on the work Mac.

## Key map

Roster keys:

- `j`/`k` or `↓`/`↑`: move
- `g`/`G`: top / bottom (Home/End are taken by pi-tui, see friction)
- `⏎` or `space`: on a session, a "would open `<id>`" toast that also records a Visit (so ● unseen clears); on a project or Inactive header, toggle it; on `› Archived`, drill into the Archived view
- `h`/`l` or `←`/`→`: collapse / expand the group under the cursor
- `a`: archive the selected session; the bottom rule shows `archived "…" · u undo 5s`, counting down
- `u`: undo the last archive while that countdown runs
- `U`: unarchive (in the Archived view)
- `y`: copy `swb open <id>` with `pbcopy`
- `Y`: copy `@session:<uuid>` with `pbcopy`
- `/`: filter by title, project, branch, or id. Typing filters live; `⏎` keeps the filter (shown in the header), `esc` clears it. `↑`/`↓` still move while typing
- `esc`: clear the filter, else leave the Archived view
- `?`: key overlay; any key closes it
- Mouse: click selects, double-click activates, wheel moves the cursor. pi-tui made this about 20 lines, so it's in

Prototype-only keys, all shown in the magenta `PROTOTYPE` bar on the last row:

- `v`/`V`: next / previous variant
- `[`/`]`: breakpoint −5 / +5
- `t`: toggle the fake activity tick (every 3 s)
- `.`: run one tick now

The `PROTOTYPE` bar also shows the current width, the breakpoint, which layout `adaptive` resolved to, and the last tick event (for example `last ◐→● Roster TUI prototype`).

## Variants

1. **adaptive A↔C**: mock A below the breakpoint, mock C at or above it. The default
2. **forced A**: compact rows at any width. Past 104 columns the row stops growing (`A_MAX_WIDTH`), because the state column drifts too far from the titles to read across
3. **forced C**: roster plus preview at any width, to feel how cramped it gets at 80
4. **D stacked**: A's rows on top, the preview below a dotted rule, using about 45% of the height. My bet for the structurally different alternative that might beat C: the preview stays at any width, and the roster keeps its full-width columns

## Fake data

There are 26 sessions across 4 projects (ansiblonomicon, pi-sessions, harbor-deploy, agent-switchboard): 13 open, 3 inactive, and 10 archived. Every state is seeded: ◆ blocked, ◐ working, ● unseen, ○ idle, ◌ dormant, ⚠ interrupted, plus ⧉ viewer open and ⎇ worktree branches. Some titles are long enough to truncate. Some edge cases are seeded on purpose:

- **GhosttyKit viewer seam spike**: 4 days old but unseen, so it stays open instead of going inactive
- **Bump chart to 4.12…**: dormant *and* unseen. It shows as ● unseen, and the preview says it "resumes on open"
- **Handoff prompt template**: live in tmux but inactive (4 days idle)
- **Region failover runbook**: interrupted 9 days ago, so it's inactive
- Unarchiving **Search ranking relaxation** lands it back in pi-sessions as dormant

States are derived from stored facts (live, activity, activity_at, visited_at, viewer, archived_at), never stored. That matches the schema ticket. The tick picks a live, open, non-inactive session and moves it working→idle, working→blocked, blocked→working, or idle→working (a fake prompt from me, which also counts as a Visit). Dormant sessions never move, because nothing auto-continues. The tick uses a seeded PRNG, so a run is reproducible key for key.

## Captures

`./capture.sh` regenerates everything. It runs the prototype inside `tmux -L swb-proto` with the status bar off, drives it with `send-keys`, captures with `capture-pane -e -p`, and kills the server at the end. It also overwrites your clipboard twice, because it proves `y` and `Y` with `pbpaste`. Each capture comes in two forms: `.ansi` is the raw `-e` capture (`cat` it in a terminal to see the colors and the cursor's background highlight), and `.txt` is plain text for reading in an editor.

All paths are under `captures/`.

80×24 (adaptive resolves to A):

- `80-01-initial`: first paint
- `80-02-cursor-on-uvlock`: cursor moved to "Retire uv.lock mask"
- `80-03-archived-with-undo`: after `a`; the row is gone, the counts read 12 open · 11 archived, the cursor dropped to the next row, and the rule says `archived "Retire uv.lock mask" · u undo 5s`
- `80-04-undone`: after `u`; the row is back with the cursor on it
- `80-05-after-4-ticks`: four ticks later, agent-switchboard has jumped above ansiblonomicon, and the cursor followed "Retire uv.lock mask" from row 6 to row 10
- `80-06-filter-typing`, `80-07-filter-kept`: `/flak` while typing, then kept after `⏎`
- `80-08-archived-view`, `80-09-unarchived`: the drill-in, and `U` on "Search ranking relaxation"
- `80-10-inactive-expanded`: Inactive expanded and grouped by project; the list scrolls, with `↑`/`↓` markers
- `80-11-variant-D-stacked`, `80-12-variant-forced-C`: the variants at 80
- `80-13-help`: the `?` overlay
- `80-14-enter-toast`, `80-15-copy-toast`: the `would open <id>` and `copied swb open <id>` toasts
- `80-15-clipboard.txt`, `80-16-clipboard-session-ref.txt`: what `pbpaste` returned after `y` and `Y`

140×32 (adaptive resolves to C): the same `140-01` … `140-09` sequence, plus:

- `140-10-variant-forced-A`, `140-11-variant-D-stacked`
- `140-12-live-tick`: the tick turned on with `t` and left alone for 10 s. The cursor sat on the agent-switchboard header while the projects reshuffled around it

Live resize (one process, resized with `tmux resize-window`):

- `resize-01-100-cols`: A at 100 columns
- `resize-02-140-cols`: the same process after a resize to 140; it switched to C on its own, cursor intact
- `resize-03-100-cols-breakpoint-100`: back to 100 with the breakpoint lowered to 100 via `[` `[`, so C at 100

## What felt right, what felt wrong

Right:

- **A at 80 columns.** Dense, and every row reads in one glance. The glyph does all the work; color plus shape is enough to pick out the two ◆ blocked rows from across the room.
- **C at 140.** The preview answers "what was it doing?" without opening anything, and it's the only place the four facts read separately: `● unseen · live in tmux · no viewer`. That line is the tenet made visible. I'd keep it.
- **Undo in the bottom rule.** It doesn't shift the layout, it's where the eye goes after pressing `a`, and 5 s is long enough to notice a mistake without nagging.
- **Cursor tracking by id.** It holds through archive, undo, unarchive, filter, and project reshuffles. When the row it was on disappears, falling back to the same index (the next row) is what you expect after `a`.
- **Archived as a drill-in** rather than an inline section. The footer gets to change (`⏎ open (unarchives on first turn)  U unarchive`), and 41 archived rows never push the open ones around.

Wrong, or at least suspicious:

- **Strict newest-activity-first is restless under live updates.** The cursor survives, but my eye doesn't. Watching `140-12-live-tick` happen live, whole project groups leapfrog every few seconds, and finding the session I was about to open again takes a re-scan. Rows moving within a project are tolerable; projects moving is not. My proposal: keep project order stable (alphabetical, or by first activity of the day) and sort rows by activity only within a project.
- **The cursor `▸` collides with the collapsed caret `▸`.** In `80-06-filter-typing`, `▸ ◆ Flaky…` (cursor) sits right under `▾ harbor-deploy` and right above `▸ Inactive` (collapsed). The background highlight disambiguates in color, but not in a plain capture or on a dim screen. I'd drop the `▸` cursor and rely on the highlight, or use a left bar `▌` like mock B.
- **A's state label column duplicates the glyph.** At 80 columns it costs 13 columns that long titles want. C has no label and loses nothing. I'd drop it from A, or keep it only for the rare states (blocked, interrupted).
- **Forced C at 80 is unusable.** Titles cut at around 22 characters. At 100 it's tolerable but cramped (`resize-03`). 110 feels like the right default breakpoint; I wouldn't go lower.
- **D stacked doesn't beat C.** At 140 the preview strip is a worse C: same content, less of it, and half the roster height gone. At 80 it's the only way to get a preview, but it costs a third of the rows. It would win only in a tall, narrow pane. I'd drop it, unless you plan to run `swb` in a narrow split.
- **Expanding Inactive at the bottom of the list** puts its content off-screen until you move into it (`80-10`). Expanding should probably scroll the new rows into view.
- **Toasts cover the header counts**, because pi-tui's `flash()` always draws top-right (see friction).

## Questions for Thurston

Key map:

- `g`/`G` instead of Home/End, and nothing on PageUp/PageDown (pi-tui owns those in alt-screen mode; we can rebind them). Fine?
- Should `⏎` on a project header toggle it, or should headers be skipped by the cursor entirely? Right now they're cursor stops, which makes `j` walk through 4–6 extra rows.
- Should `u` also undo an unarchive, or is unarchive cheap enough to reverse with `a`?
- `v` is free in the real roster once the prototype bar goes away. Do you want it back for something, such as `R` revive's sibling or "visit without opening"?
- Should `/` in the main view also list matching archived sessions inline, rather than only updating the `› Archived (n)` count?

Glyphs:

- Fix the `▸` cursor/caret collision: highlight-only, `▌`, or a different collapsed caret?
- Keep or drop the state label column in A?
- Dormant and unseen at once currently shows ● and lets the preview say "resumes on open". Is that the right priority, or should dormancy also show on the row, for example a dim ●?
- A session with a ⧉ viewer can still be ● unseen here, because the prototype doesn't model focus. The schema says a *focused* viewer is never unseen. Is ⧉ plus ● a combination you expect to see often?
- ◆◐●○◌ are East Asian *ambiguous* width. They're fine in Ghostty's defaults, but a terminal set to wide-ambiguous would misalign every row. Worth a fallback set?

Breakpoint:

- 110 columns: try `[`/`]` live and tell me where it should flip. My vote is 110–120.

Layout:

- Stable project order with rows sorted within each project, or strict newest-first everywhere as the map says today?
- Should blocked sessions pin to the top of their project (or of the roster) regardless of activity time?
- C's left pane takes 42% of the width, clamped to 34–64 columns. More roster or more preview?
- Short ids: real Pi session ids look like UUIDv7, so every session from the same week shares its first 8 hex digits. This prototype uses the *last* 8 for `swb open <id>`. That's a schema question, but the roster is where it shows.

## pi-tui friction

- **Components only receive a width.** `render(width)` never sees a height, so a full-screen roster that keeps its cursor in view reads `tui.terminal.rows` itself and scrolls by hand. `VStack`/`HStack` allocate heights, but only `ScrollView` acts on them, and its API scrolls by line offset (`scrollTo`, `scrollBy`); it has no "keep this row visible". I skipped the stacks and rendered one root component of exactly `rows` lines through `setLayoutRoot`. That was simple, and resizing still works.
- **`TuiAltScreen` takes some keys before the app sees them**: PageUp/PageDown, Home/End, `ctrl+up`/`ctrl+down` (prompt jumps), and `ctrl+shift+f` (transcript search). Taking them back means overriding the `tui.altScreen.*` keybindings with `setKeybindings`.
- **`flash()` toasts are fixed** at the top-right, inverse video, stacked one per line, with no way to position them. Here they cover the header counts. They're good enough for a prototype; the real roster probably wants its own message slot, like the undo rule.
- **No sectioned-list widget.** `SelectList` is flat and owns its own cursor, so the roster rendering and input are fully custom. Not a problem for a list this small.
- **Esc-prefixed input is ambiguous.** `Escape` immediately followed by `G` arrives as `alt+G`. That's a terminal fact, not a pi-tui bug, but it bit the capture script until it sent one key per `send-keys`. Humans don't type that fast.
- **Resize works as advertised.** `ProcessTerminal` picks up `SIGWINCH`, `TuiAltScreen` redraws in full, and adaptive switches A→C live (`resize-02`).
- **Mouse is cheap.** `{ mouse: true }`, plus a `handleMouse` on the root component, gives click, double-click (`clickCount`), and wheel. Drag-to-select copies with OSC 52 for free. I tested it with synthetic SGR mouse sequences through tmux, not a physical mouse.
- **`Input` worked unchanged** for the `/` filter, with `onSubmit`, `onEscape`, editing keys, and its own `/ ` prompt.
- **Nothing was typechecked.** Bun runs the TypeScript directly, and the prototype has no `tsc`.
