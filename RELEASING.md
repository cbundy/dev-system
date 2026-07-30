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

## The Dev Container Feature (separate cadence)

The feature version lives in `features/src/*/devcontainer-feature.json` and is NOT
synced by the release workflow: GHCR publishing only pushes versions that do not
already exist, so the PR that changes a feature bumps its version, and after merge
you run the `Publish features` workflow (Actions tab). Consumers pick it up on the
next container rebuild via their `callum-tools:1` pin.

## Drift check

`npx callum-dev check` exits non-zero when a repo's applied template version
(`.callum-dev.json`) lags the installed package - usable as a CI step in consumer
repos to catch a forgotten `callum-dev update` after an `npm update`.
