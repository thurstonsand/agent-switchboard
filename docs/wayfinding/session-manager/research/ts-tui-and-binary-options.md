# TypeScript TUI and single-binary options

## Decision

A TypeScript `sessions` is viable on the work Mac. If ticket 11 chooses TypeScript, use `@earendil-works/pi-tui` directly and ship one arm64 executable built with `bun build --compile`. It combines a small direct component model, a documented standalone entry point, alternate-screen ownership, mouse input, resize handling, and width/height-responsive layouts while already being exercised by the installed Pi. OpenTUI also meets the feature requirements, but cannot currently be installed through the work mirror.

This result does not by itself say that TypeScript is preferable to Go. It says the TUI and deployment mechanics do not block that choice. The measured compiled-Bun process tax is about 2.6 ms at the median versus the current Go CLI's cheapest comparable invocation, while the binary tax is about 57 MiB. Those are acceptable for human-facing commands and probably acceptable for focus hooks, but the hook should eventually be benchmarked with the real `visit` implementation.

## Answers

### TUI library

- **Choose `@earendil-works/pi-tui` for a TypeScript implementation.** Its README explicitly documents constructing `ProcessTerminal` and `TuiMainScreen` outside Pi, and exposes `TuiAltScreen` through the same `TUI` interface (`~/.cache/pi-source/v0.99.2/packages/tui/README.md:18-75`). It is a standalone MIT package whose manifest points at the `packages/tui` directory in the Pi repository (`~/.cache/pi-source/v0.99.2/packages/tui/package.json:1-6,43-56`).
- **It covers the Dispatcher requirements rather than merely permitting escape-sequence assembly.** The alternate-screen renderer has explicit mouse, wheel, selection, URL, and clipboard options (`~/.cache/pi-source/v0.99.2/packages/tui/src/tui-alt-screen.ts:167-201`), selects reduced mouse-motion reporting under tmux, enters the alternate buffer, and restores it on stop (`~/.cache/pi-source/v0.99.2/packages/tui/src/tui-alt-screen.ts:334-395`). `ProcessTerminal` installs a stdout resize handler and refreshes dimensions after resume (`~/.cache/pi-source/v0.99.2/packages/tui/src/terminal.ts:174-205`). Every alternate-screen frame is laid out from current terminal columns and rows, and dimension changes force a full redraw (`~/.cache/pi-source/v0.99.2/packages/tui/src/tui-alt-screen.ts:1666-1695`).
- **The compact/wide roster switch is direct.** Stack entries and overlays support responsive `visible` callbacks, and geometry is rebuilt each frame (`~/.cache/pi-source/v0.99.2/packages/tui/README.md:119-165,166-243`). `HStack` allocates child widths from the available width and renders each child at its allocation (`~/.cache/pi-source/v0.99.2/packages/tui/src/components/h-stack.ts:12-42`). This is enough to select mock A or C at a width threshold without a second layout system.
- **Bun works for the package's non-native rendering path.** On the work Mac, Bun 1.4.2 ran a component imported from the 0.99.2 package source, compiled its 50-module graph, and ran the resulting 62,309,490-byte executable. The native clipboard helper is loaded dynamically from a packaged `.node` file and deliberately degrades to unavailable if it cannot load (`~/.cache/pi-source/v0.99.2/packages/tui/src/native-platform.ts:28-64`); therefore do not depend on that helper in the compiled executable. The roster's required copy actions should use OSC 52 or the existing host mechanism instead. A real interactive smoke test remains part of the prototype ticket, not this research.

### Other candidates

- **OpenTUI is the strongest technical alternative but is the wrong dependency here today.** Its official README says it supports TypeScript directly or React/Solid and supplies select, input, and scroll-box controls with keyboard and mouse; its development toolchain requires Bun 1.4.1+ and Zig 0.16.0 ([OpenTUI README](https://github.com/anomalyco/opentui/blob/main/README.md#L13-L18), [development](https://github.com/anomalyco/opentui/blob/main/README.md#L50-L60)). Core owns the alternate screen by default, handles `SIGWINCH`, and uses Yoga for responsive layout (`packages/core/src/renderer.ts:165-166,192-202,235-242,920-924,1235-1241` in the v0.5.14 source inspected under `/tmp`). It remains pre-1.0 ([v0.5.14 release](https://github.com/anomalyco/opentui/releases/tag/v0.5.14)), and its native/Bun/Zig stack buys capabilities this small roster does not need. More decisively, `npm view @opentui/core` returned 404 from the configured Artifactory npm virtual repository on 2026-10-05, and a runtime smoke test could not proceed. It cannot be selected under the standing mirror rule today.
- **Ink is credible and available, but adds React/Yoga without improving this fit.** Ink describes itself as a React renderer and uses Yoga for Flexbox ([Ink README](https://github.com/vadimdemedes/ink/blob/master/readme.md#L14-L24)); current Ink documents responsive terminal dimensions and alternate-screen rendering ([window size](https://github.com/vadimdemedes/ink/blob/master/readme.md#L2316-L2345), [alternate screen](https://github.com/vadimdemedes/ink/blob/master/readme.md#L2798-L2815)). Ink 8 deliberately discards mouse reports rather than exposing them ([v8.0.0 release](https://github.com/vadimdemedes/ink/releases/tag/v8.0.0)); pi-tui has mouse hit testing and tmux-aware capture in core. Artifactory currently trails at `ink@7.1.1`, which did resolve and install on this machine. Bun execution of a full Ink TUI was not proven here, so compatibility beyond package installation is explicitly uncertain.
- **No fourth candidate justifies prototype time.** The requirement is a modest roster, while pi-tui already supplies the exact terminal and layout machinery and shares types/utilities with the recorder's ecosystem. Adding another framework would only produce a broader comparison, an activity terminals have endured quite enough of.

### Compiled Bun executable

- **`bun:sqlite` works inside a compiled executable.** A scratch program created an in-memory database, created a table, inserted and selected `"compiled"`, and exited successfully after `bun build --compile`. Bun's own executable documentation explicitly says `bun:sqlite` imports work with `--compile` ([Bun executable docs](https://bun.sh/docs/bundler/executables#sqlite)); the SQLite API is a synchronous built-in module ([Bun SQLite docs](https://bun.sh/docs/runtime/sqlite)). This removes the database-driver blocker.
- **The output is genuinely standalone but carries a runtime.** Bun documents that `--compile` bundles imported files and packages together with the Bun runtime ([Bun executable docs](https://bun.sh/docs/bundler/executables#what-gets-bundled)). The minimal no-op and SQLite scratch programs were both 62,226,930 bytes; importing pi-tui increased that to 62,309,490 bytes. The installed Pi 0.99.2 executable is 77,217,122 bytes. The current Go `sessions` executable is 5,221,506 bytes.
- **Startup is close, not equal.** After 30 warmups, 300 sequential launches with stdout/stderr discarded produced:
  - current Go `sessions --help`: median 12.184 ms, p95 15.739 ms, mean 12.277 ms;
  - current Go `sessions list`: median 52.903 ms, p95 68.088 ms, mean 54.529 ms;
  - compiled Bun no-op `sessions-ts-noop visit`: median 14.783 ms, p95 21.882 ms, mean 15.730 ms.

  The benchmark used Python `subprocess.run` and `time.perf_counter_ns` on the work Mac; scratch sources and binaries were under `/tmp/sessions-ts-ticket12`. The existing v1 binary has no `visit` command, so `--help` is the honest process-start baseline and `list` is only an upper context point. Database work is absent from the Bun no-op. The resulting 2.599 ms median delta is small relative to a focus event, but real v2 `visit` must be measured before declaring the hook cost settled.
- **Compilation itself was uneventful through the work environment.** The installed `/opt/homebrew/bin/bun` is 1.4.2. `bun build --compile` produced arm64 Mach-O executables in 86-163 ms in the scratch trials. Bun documents `bun-darwin-arm64` as a supported standalone target ([Bun executable docs](https://bun.sh/docs/bundler/executables#cross-compile-to-other-platforms)).

### Mirror and package constraints

- The active npm registry is the work Artifactory npm mirror. On 2026-10-05, `ink@7.1.1` installed; `@opentui/core` returned 404; and `@earendil-works/pi-tui` exposed versions only through 0.87.1, not the installed Pi's 0.99.2. Thus **the chosen current pi-tui version is not yet available from the work mirror**.
- The repo's npm mirror shim addresses a narrower Git-package failure: npm resolves dev dependencies even with `--omit=dev`, so the shim temporarily removes `devDependencies`, adds `--no-package-lock`, invokes npm, then restores the manifest (`bootstrap/capabilities/agent-harness/configuration/assets/pi/npm-mirror-shim.mjs:1-37`). It does not make an absent registry release appear, and consuming a workspace subpackage directly from the Pi monorepo is not a clean standalone dependency strategy.
- Therefore ticket 11 should condition a TypeScript choice on one of two declarative supply paths: mirror the selected `@earendil-works/pi-tui` release into Artifactory, or pin and package its tarball through ansiblonomicon. Prefer the mirror. Do not quietly pin 0.87.1: the installed 0.99.2 source contains the alternate-screen and responsive-layout surface assessed here.

### macOS signing and quarantine

- `bun build --compile` outputs an ad-hoc linker-signed Mach-O. `codesign -dv --verbose=4` reported `Signature=adhoc`, no TeamIdentifier, for both the scratch executable and installed Pi. The scratch file had no quarantine xattr and ran directly. This is sufficient for ansiblonomicon building/installing the binary locally on this one Mac.
- It is **not** a generally distributable signed artifact. Apple says Gatekeeper checks downloaded outside-App-Store software for an identified developer, notarization, alteration, and first-open approval ([Apple Platform Security](https://support.apple.com/guide/security/gatekeeper-and-runtime-protection-sec5599b66df/web)). Apple requires Developer ID signing—not ad-hoc signing—for notarization ([Apple notarization guidance](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution#Prepare-your-software-for-notarization)). If binaries later move through a browser, AirDrop, or public release, add Developer ID signing and notarization or build from source on the destination. For the settled one-host scope, this is not a blocker.

## Reproduction notes

The central scratch commands were:

```sh
bun build --compile sqlite.ts --outfile sqlite-compiled
./sqlite-compiled
bun build --compile noop.ts --outfile sessions-ts-noop
codesign -dv --verbose=4 sqlite-compiled
xattr -l sqlite-compiled
npm view @earendil-works/pi-tui versions --json
npm view @opentui/core version --json
npm install --ignore-scripts ink
```

`sqlite.ts` imported `Database` from `bun:sqlite`, created and queried an in-memory table, and asserted the returned value. `noop.ts` exited immediately for the `visit` argument. Measurements are machine- and cache-specific; all throwaway material was kept under `/tmp`.
