---
name: npm-release
description: Prepare, tag, publish, and verify a release of Agent Switchboard: the swb binaries, the generated pi branch, and the npm package. Use when the user wants to release swb or @thurstonsand/pi-agent-switchboard.
---

# Release

One `vX.Y.Z` tag on `main` produces three things, all from `.github/workflows/release.yml`:

- a GitHub release with `swb-linux-x64` and `swb-darwin-arm64` attached
- the `pi` branch, force-replaced with the bundled recorder extension
- `@thurstonsand/pi-agent-switchboard` on npm, the same bundle, through Trusted Publishing (OIDC)

## Prerequisites

- npm Trusted Publishing for `@thurstonsand/pi-agent-switchboard`: repository `thurstonsand/agent-switchboard`, workflow `release.yml`, environment `npm`. A mismatch fails only at publish time.
- A GitHub environment named `npm` in the repository.

## Release model

- Release from `main`.
- Versions come from the tag. Nothing is bumped locally: the workflow runs `scripts/set-release-version.ts` before building.
- `CHANGELOG.md` holds the human release notes. The GitHub release and the annotated tag carry the same text.
- Stable tags are immutable. Never force-push a release tag.
- The `pi` branch is generated. Never edit it by hand.

## 1. Inspect release state

- Check git state first. Leave unrelated changes alone. If release-relevant changes are uncommitted, ask whether they belong in the release.
- Inspect changes since the latest stable tag (all of `main` for the first release).
- Summarize user-facing features and fixes, install or release changes, and the likely semver bump.

Ask the user to confirm the target version unless they already gave one.

## 2. Prepare release notes

Promote `## UNRELEASED` in `CHANGELOG.md` to a versioned entry in the existing format:

```md
## X.Y.Z — YYYY-MM-DD

### Added

- **Summary** — detail
```

Omit internal refactors with no user-facing effect. If the user edits the notes, keep their wording.

## 3. Verify locally

```sh
mise run check
mise run e2e
mise run release:check
```

`release:check` builds every artifact into a scratch dir, runs this host's binary, and lists the npm tarball. Do not proceed on failures; fix them or report the blocker.

## 4. Commit and push

Stage only release-relevant files, commit, and push `main`.

## 5. Tag

```sh
VERSION=X.Y.Z
scripts/extract-release-notes.sh "v${VERSION}" > "/tmp/agent-switchboard-v${VERSION}-notes.md"
cat "/tmp/agent-switchboard-v${VERSION}-notes.md"
git tag -a "v${VERSION}" --cleanup=verbatim -F "/tmp/agent-switchboard-v${VERSION}-notes.md"
git push origin "v${VERSION}"
```

If the tag already exists, stop and inspect; do not overwrite it.

## 6. Watch the workflow

`gh run list --workflow Release`, then watch it to completion. It runs CI, builds, replaces the `pi` branch, publishes to npm with the `latest` dist-tag (skipped when that version is already on npm), and creates the GitHub release last. Every step is safe to re-run, so a failure at any step is fixed and retried with `gh run rerun --failed`. A fix that needs a code change ships as the next patch: the tag is immutable.

## 7. Verify

```sh
VERSION=X.Y.Z
gh release view "v${VERSION}" --json assets --jq '.assets[].name'
git ls-remote origin refs/heads/pi "refs/tags/v${VERSION}"
git fetch origin pi && git show origin/pi:package.json | grep '"version"'
npm view @thurstonsand/pi-agent-switchboard version dist-tags --json
```

Report the version published, the release commit and tag, the workflow run and its result, each verification above, and any follow-up.
