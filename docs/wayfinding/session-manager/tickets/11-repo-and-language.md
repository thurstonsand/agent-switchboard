---
status: closed
type: grilling
blocked-by:
  - 12
---

# Repo and language for sessions v2

## Question

Thurston raised this while resolving [Shared session db: schema and ownership](07-shared-db-schema-and-ownership.md). The recorder (a TS Pi extension) and `sessions` (currently Go) now share one db, its schema, and its derivation rules. Should they move out of ansiblonomicon into their own repo, and should the CLI/TUI be rewritten in TS so the two sides share code?

- **Repo**: stay here (recorder under `agent-harness` assets, CLI under `software/sources`), or a standalone repo that publishes both the Pi extension package and the executable, like pi-sessions or GhosttyKit. How ansiblonomicon would then install it on the work Mac (mirror constraints for npm, Homebrew tap, Go proxy).
- **Language**: keep Go (Bubble Tea, modernc) with the recorder in TS; or all-TS (CLI and TUI compiled with Bun, sharing the schema, migrations, and derivations with the recorder). Weigh the TUI library options and single-binary distribution from [TS TUI and single-binary options on the work Mac](12-ts-tui-and-binary-options.md).
- What moves with it: CONTEXT.md, this wayfinding map, design 15's successor.
- How the e2e testing standard fits each choice.

## Inputs

- **The mirror lags, but isn't frozen** (checked 2026-10-05). It carries pi-tui 0.75.3, 0.79.1, 0.80.3, 0.83.0, 0.85.1, and 0.87.1. 0.87.1 was published upstream on 2026-09-22 (13 days ago). 0.99.0 (published 6 days ago) and later are absent, and upstream is already at 1.0.3. That fits a curation cooldown of roughly 1–2 weeks. Pi itself reaches the work Mac through GitHub releases (mise `github:earendil-works/pi`), which is why Pi runs 0.99.2 while the npm packages stop at 0.87.1.
- **The shared code is thinner than it looks.** The recorder writes raw facts. Every derivation (Live, Unseen, Interrupted, Inactive, ordering) and every migration lives only in the reader/CLI. What a single language would actually share: row types, the schema-version constant, the db path, connection policy, and the one `/archive` UPDATE. The e2e suite crosses the db contract regardless of language.
- **The recorder never needs npm pi-tui.** Pi supplies its own bundled modules to extensions at runtime. Only a standalone TS CLI would depend on the mirror's copy.

## Resolution

Resolved with Thurston on 2026-10-06.

**Name.** The project is **Agent Switchboard**, the repo is `thurstonsand/agent-switchboard` (public), and the CLI is `swb`. That name replaces `sessions` throughout:
- tmux socket: `tmux -L swb`
- db: `${XDG_STATE_HOME:-~/.local/state}/agent-switchboard/swb.db`
- pi footer: `swb: not recording: …`

**Stack.** TypeScript on Bun. The TUI uses `@earendil-works/pi-tui`, and the CLI ships as an arm64 `bun build --compile` executable. The CLI tracks the latest pi-tui and may take any dependencies, since they're compiled in. Builds that need the newest deps happen on the personal Mac or in CI. A work-Mac build works once the mirror catches up, which takes about 1–2 weeks.

**Layout on `main`.** Bun workspaces:
- `packages/cli` gets top billing.
- `packages/pi` holds the recorder extension, with as few dependencies as possible. Pi-provided packages are peers, and `bun:sqlite` is a built-in.
- `packages/shared` holds the schema version, row types, db path, and connection policy.
- `packages/claude` comes later.

**Distribution.**
- One release workflow, triggered by tags, builds the `swb` binary as a GitHub release asset. From the same commit it publishes a generated **`pi` branch** that contains only the extension: a single `bun build` bundle with `shared` inlined and Pi's host packages left external, plus a source map, a `package.json` with the pi manifest and zero dependencies, and a README.
- The release workflow is the only writer of `pi`, and it overwrites the branch wholesale. The same build runs locally (`mise run dist:pi`), and the e2e tests install that output as a real pi package.
- Because `pi` moves only on releases, it always matches the latest release.
- A later Claude plugin follows the same pattern with a `claude` branch.
- npm publishing is deferred. The `pi` branch is already npm-ready, but the work mirror would serve it 1–2 weeks late.

**Installation (ansiblonomicon).**
- mise installs `github:thurstonsand/agent-switchboard` at `latest`. It needs no tap formula and no notarization; verify the downloaded binary carries no quarantine flag.
- Pi lists `git:github.com/thurstonsand/agent-switchboard@pi` on the work Mac. On the personal Mac, Pi loads `packages/pi` from the local checkout through the existing local-package pattern, and `mise run install` builds `swb` from the same checkout.
- Pi processes still running during an upgrade keep the old recorder in memory and show the red footer once the db migrates.
- Verify early that jiti follows the workspace symlink to `packages/shared`, and that Pi moves a branch ref on `pi update`.

**Releases.** Tagged releases only. Unreleased work is dogfooded through a local `mise run install`.

**Where things live.** The new repo owns the recorder, the schema and migrations, and the dedicated tmux server: `swb` starts it with its own embedded `-f` config, which holds the focus hooks that run `swb visit`, turns the status bar off, and passes keys through. It also owns `swb new --cwd …`. ansiblonomicon keeps the install entries, `ide` (reduced to calling `swb new` / `swb attach`), the Ghostty keybind, and the retirement of `sources/sessions` and the session-recovery assets.

**Targets.** macOS arm64 only.

**GhosttyKit.** Accepted as a dependency, behind a narrow **viewer** seam with two operations: open a viewer and focus a viewer. It has two backends: GhosttyKit (`new-tab` and `focus-terminal`), and plain `tmux attach` in the current terminal when Ghostty or `gty` is unavailable.

**Planning artifacts.** This map, its tickets, research, and prototypes, plus CONTEXT.md, move into the new repo, along with a new AGENTS.md and DEV.md in the style of the sibling repos.

## Amendment (2026-10-06)

**npm publishing is back in.** Following Thurston's other pi extensions (`pi-sessions/.agents/skills/npm-release/SKILL.md` is the model), releases are tag-driven through `.github/workflows/release.yml`, with npm Trusted Publishing over OIDC and `CHANGELOG.md` notes reused as the annotated tag body. `package.json` versions are never bumped locally; CI sets them from the tag. Adopt that `npm-release` skill in this repo, extended so the same tag also builds the `swb` binary and regenerates the `pi` branch. The npm package is the extension, built from the same output as the `pi` branch.
- Personal hosts install the npm package through ansiblonomicon's `PERSONAL_PACKAGES`: the local checkout on the Mac, npm elsewhere.
- The work Mac keeps `git:…@pi`, because its npm mirror lags behind the binary on GitHub.
