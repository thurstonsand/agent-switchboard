# Round 2 roster mocks

Charting-session mocks Thurston reviewed on 2026-10-05. Verdict: **A by default, C when the terminal is wide enough.** Glyphs: ◆ blocked · ◐ working · ● unseen · ○ idle · ◌ dormant · ⚠ interrupted · ⧉ open in a Ghostty viewer.

## A: compact

```text
 sessions                                7 open · 3 inactive · 41 archived
 ────────────────────────────────────────────────────────────────────────
 ▾ ansiblonomicon
   ◆ Plan sessions v2 TUI                   blocked       2m  ⧉
 ▸ ◐ Fix fnox host routing                  working      now
   ● Retire uv.lock mask   ⎇ uvlock         unseen       14m
   ○ Ghostty quick terminal keybind         idle         40m  ⧉
   ◌ Pod042 herdr unit                      dormant       1d
 ▾ pi-sessions
   ⚠ Subagent report race                   interrupted   3h
 ▾ harbor-deploy
   ◌ Canary rollback flag                   dormant       2d
 ▸ Inactive (3)
 ▸ Archived (41)
 ────────────────────────────────────────────────────────────────────────
 ⏎ open  a archive  u undo  y copy cmd  Y copy @session  / filter  ? keys
```

Archived view:

```text
 sessions › Archived                                                   41
 ────────────────────────────────────────────────────────────────────────
 ▸ Migrate UniFi provider fork      ansiblonomicon           3h
   Search ranking relaxation        pi-sessions              1d
   fnox activation receipt          ansiblonomicon           2d
   Fix flaky canary test            harbor-deploy  ⎇ flaky   4d
 ────────────────────────────────────────────────────────────────────────
 ⏎ open (unarchives on first turn)  U unarchive  esc back  / filter
```

## B: two-line cards (not chosen)

```text
 ansiblonomicon ─────────────────────────────────────────────────── 5
  ◆ Plan sessions v2 TUI                                         2m
    blocked · interview: sessions v2 — Round 2 · main · ⧉ viewing
 ▌ ◐ Fix fnox host routing                                       now
 ▌   working · 12 tool calls this turn · main
  ● Retire uv.lock mask                                          14m
    unseen · ⎇ uvlock · "Done. mise run pull now lifts the skip…"
```

## C: roster + preview

```text
 ▾ ansiblonomicon             │ Retire uv.lock mask
   ◆ Plan sessions v2 TUI   ⧉ │ ~/c/p/ansiblonomicon/.worktrees/uvlock
   ◐ Fix fnox host routing    │ ⎇ uvlock · pi · opus · 2h old
 ▸ ● Retire uv.lock mask      │ ● unseen · live in tmux · no viewer
   ○ Ghostty quick term…  ⧉   │ ─────────────────────────────────
   ◌ Pod042 herdr unit        │ you 16m
 ▾ pi-sessions                │ make the pull task handle the
   ⚠ Subagent report race     │ uv.lock mask on its own
 ▾ harbor-deploy              │ agent 14m
   ◌ Canary rollback flag     │ Done. `mise run pull` now lifts
 ▸ Inactive (3)               │ the skip-worktree bit, checks out
 ▸ Archived (41)              │ the lock, re-syncs, and re-masks.
```

Open feedback carried into [Roster TUI prototype](../tickets/09-roster-tui-prototype.md): add a PR glyph later (see the map's Not yet specified).
