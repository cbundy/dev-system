# Releasing

Ordinary PRs never bump the main release version: only a release's own bump PR does.
Releasing is one deliberate step, run when ready.

## The main release (plugin + skills + npm/CLI layer)

Releasing never pushes to main: the version bump lands in a normal PR gated by `ci`, and
the `Release` workflow only verifies, tags and publishes.

1. On a branch from an up-to-date main, run:

   ```
   node scripts/release-bump.js X.Y.Z
   ```

   It sets the version in every `plugins/*/.claude-plugin/plugin.json`, every skill's
   `SKILL.md` frontmatter and the root `package.json`, pins the `callum` marketplace `ref` in
   `templates/.claude/settings.json` to `vX.Y.Z`, then refreshes this repo's own
   stamp (`node bin/callum-dev.js update`: `.callum-dev.json`, `.callum-dev/baseline/`
   and any merged config files). dev-system is a consumer of its own templates, so the
   bump and the stamp land in the same change. If it reports conflicts, resolve the
   markers before committing.
2. Open a PR with the result and merge it when `ci` is green.
3. Run the `Release` workflow from main (Actions tab, or):

   ```
   gh workflow run release.yml -f version=X.Y.Z
   ```

   It refuses to run unless `ci` passed on main's HEAD and
   `node scripts/release-bump.js --check X.Y.Z` passes there (every version, the template pin and the stamp
   at X.Y.Z); then it tags `vX.Y.Z` and creates a GitHub Release with generated notes.

Semver: patch for wording fixes, minor for a new skill/template/capability, major for a
breaking change to an existing contract.

How each layer reaches consumers after the tag exists:

- **Plugin**: `/plugin marketplace update` (or auto-update) picks up the bumped
  `version` field.
- **npm/CLI layer**: consumers depend on `github:cbundy/dev-system#semver:0.x` -
  npm resolves that range against the git tags, so `npm update @callum/dev-system`
  pulls the new tag, then `npx callum-dev update` merges template changes into the
  repo. Tags earlier than v0.3.0 predate `package.json` and cannot be npm-installed.

## The Dev Container Feature (deprecated, separate cadence)

The feature is deprecated (cbundy/dev-system#89) and gets no new capabilities. A script
fix in `features/src/callum-tools/` reaches consumers through the base image; publish
the feature as well only when a repo still pinned to `callum-tools:1` needs the fix.

The feature version lives in `features/src/*/devcontainer-feature.json` and is NOT
set by the release bump: GHCR publishing only pushes versions that do not
already exist, so the PR that changes a feature bumps its version, and after merge
you run the `Publish features` workflow (Actions tab). Consumers pick it up on the
next container rebuild via their `callum-tools:1` pin.

## The base image (separate cadence)

The image version lives in `images/base/VERSION` and is NOT set by the release bump.
A PR that changes the image in a way consumers should be able to pin bumps
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
