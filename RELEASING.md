# Releasing

Individual PRs never bump versions. Releasing is one deliberate step, run when ready.

## The main release (plugin + skills + npm/CLI layer)

Run the `Release` workflow from main (Actions tab, or):

```
gh workflow run release.yml -f version=X.Y.Z
```

It syncs the version into every `plugins/*/.claude-plugin/plugin.json`, every skill's
`SKILL.md` frontmatter, and the root `package.json`; commits the bump to main; tags
`vX.Y.Z`; and creates a GitHub Release with generated notes. Semver: patch for wording
fixes, minor for a new skill/template/capability, major for a breaking change to an
existing contract.

How each layer reaches consumers after the tag exists:

- **Plugin**: `/plugin marketplace update` (or auto-update) picks up the bumped
  `version` field.
- **npm/CLI layer**: consumers depend on `github:cbundy/dev-system#semver:0.x` -
  npm resolves that range against the git tags, so `npm update @callum/dev-system`
  pulls the new tag, then `npx callum-dev update` merges template changes into the
  repo. Tags earlier than v0.3.0 predate `package.json` and cannot be npm-installed.

Last step, after the tag exists: bring this repo's own stamp up to date. dev-system is a
consumer of its own templates, and `node bin/callum-dev.js check` fails here while
`.callum-dev.json` lags the released version. On a branch from the updated main, run
`node bin/callum-dev.js update`, resolve any conflicts it reports, and land the result
(`.callum-dev.json`, `.callum-dev/baseline/` and any merged config files) via a PR.

## The Dev Container Feature (deprecated, separate cadence)

The feature is deprecated (cbundy/dev-system#89) and gets no new capabilities. A script
fix in `features/src/callum-tools/` reaches consumers through the base image; publish
the feature as well only when a repo still pinned to `callum-tools:1` needs the fix.

The feature version lives in `features/src/*/devcontainer-feature.json` and is NOT
synced by the release workflow: GHCR publishing only pushes versions that do not
already exist, so the PR that changes a feature bumps its version, and after merge
you run the `Publish features` workflow (Actions tab). Consumers pick it up on the
next container rebuild via their `callum-tools:1` pin.

## The base image (separate cadence)

The image version lives in `images/base/VERSION` and is NOT synced by the release
workflow. A PR that changes the image in a way consumers should be able to pin bumps
it; after merge, run the `Publish base image` workflow (Actions tab, or
`gh workflow run publish-base-image.yml`) to push the new tags. The workflow also
re-pushes the current version's tags weekly with fresh OS packages and tools, so tags
are mutable - see `images/base/README.md`.

## The dev image (no release step)

`ghcr.io/cbundy/dev-system/dev`, this repo's own dev environment
(`.devcontainer/Dockerfile`), has no version and is never released by hand. The
`Publish dev image` workflow rebuilds and pushes `latest` and `sha-<short>` on every
change to `.devcontainer/` merged to main, and weekly a few hours after the base image's
weekly rebuild. To pick up a base image release sooner, run it by hand on main
(`gh workflow run publish-dev-image.yml`). Its first push creates the package with this
repo's visibility (public).

## Drift check

`npx callum-dev check` exits non-zero when a repo's applied template version
(`.callum-dev.json`) lags the installed package - usable as a CI step in consumer
repos to catch a forgotten `callum-dev update` after an `npm update`.
