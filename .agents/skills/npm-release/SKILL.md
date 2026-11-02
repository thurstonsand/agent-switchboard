---
name: npm-release
description: "Prepare, tag, publish, and verify a release of Agent Switchboard: the swb binaries, the generated pi branch, and the npm package. Use when the user wants to release swb or @thurstonsand/pi-agent-switchboard."
---

# Release

One `vX.Y.Z` tag on `main` produces three things, all from `.github/workflows/release.yml`:

- a GitHub release with `swb-linux-x64` and `swb-darwin-arm64` attached
- the `pi` branch, force-replaced with the bundled pi line
- `@thurstonsand/pi-agent-switchboard` on npm, the same bundle, through Trusted Publishing (OIDC)

## Prerequisites

- npm Trusted Publishing for `@thurstonsand/pi-agent-switchboard`: repository `thurstonsand/agent-switchboard`, workflow `release.yml`, environment `npm`. A mismatch fails only at publish time.
- A GitHub environment named `npm` in the repository.

## Release model

- Release from `main` with `mise run release X.Y.Z`. Nothing else bumps a version, and CI never commits.
- The released version lives on `main` in `packages/lines/pi/package.json`. The npm package publishes it, and `release:build` stamps the swb binaries with it.
- `CHANGELOG.md` holds the human release notes: `## [Unreleased]`, then `## [X.Y.Z] - YYYY-MM-DD` sections, newest first. `mise run check` fails when a heading doesn't parse, versions don't strictly descend, or the latest release isn't the version in `package.json`. The npm package ships the changelog, so pi shows a release's entries after an update. The annotated tag and the GitHub release carry the same section.
- Stable tags are immutable. Never force-push a release tag.
- The `pi` branch is generated. Never edit it by hand.

## 1. Inspect release state

- Check git state first. Leave unrelated changes alone. If release-relevant changes are uncommitted, ask whether they belong in the release.
- Inspect changes since the latest stable tag.
- Summarize user-facing features and fixes, install or release changes, and the likely semver bump.

Ask the user to confirm the target version unless they already gave one.

## 2. Review the release notes

Read `## [Unreleased]` against the changes. Omit internal refactors with no user-facing effect. If the user edits the notes, keep their wording. Commit and push any edits, and wait for CI on that commit.

## 3. Release

```sh
mise run release X.Y.Z
```

It refuses unless you're on `main`, the tree is clean, `main` matches `origin/main`, CI on `HEAD` succeeded, `[Unreleased]` has entries, and `X.Y.Z` is greater than the current version. Then it runs `mise run release:check`, moves `[Unreleased]`'s entries under `## [X.Y.Z] - <today>`, writes the version to `packages/lines/pi/package.json` and `bun.lock`, commits `chore(release): X.Y.Z`, tags `vX.Y.Z` with that section as its body, and pushes `main` and the tag together.

If it refuses, fix the cause and run it again. If it fails after committing, inspect before retrying; never move or overwrite a tag that was pushed.

## 4. Watch the workflow

`gh run list --workflow Release`, then watch it to completion. It first checks that the tag, `package.json`'s version, and the changelog's latest release agree, then runs CI, builds, replaces the `pi` branch, publishes to npm with the `latest` dist-tag (skipped when that version is already on npm), and creates the GitHub release last. Every step is safe to re-run, so a failure at any step is fixed and retried with `gh run rerun --failed`. A fix that needs a code change ships as the next patch: the tag is immutable.

## 5. Verify

```sh
VERSION=X.Y.Z
gh release view "v${VERSION}" --json assets --jq '.assets[].name'
git ls-remote origin refs/heads/pi "refs/tags/v${VERSION}"
git fetch origin pi && git show origin/pi:package.json | grep '"version"'
npm view @thurstonsand/pi-agent-switchboard version dist-tags --json
```

Report the version published, the release commit and tag, the workflow run and its result, each verification above, and any follow-up.
