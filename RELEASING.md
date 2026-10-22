# Releasing

Ordinary PRs never bump the main release version: only a release's own bump PR does.
Releasing is one deliberate step, run when ready.

## The main release (plugin + skills + npm/CLI layer)

Releasing never pushes to main: the version bump lands in a normal PR gated by `ci`, and
the `Release` workflow only verifies, tags and publishes.

1. On a branch from an up-to-date main, use the `release` skill
   (`.claude/skills/release/SKILL.md`) to draft `release-notes/vX.Y.Z.md` from the merged
   PRs and pick the version. Agents have standing release authority: they pick the version
   and notes, ship without waiting for approval, and report the tag, release URL and
   workflow results to the owner afterwards. Run:

   ```
   node scripts/release-bump.js X.Y.Z
   ```

   It sets the version in every `plugins/*/.claude-plugin/plugin.json`, every skill's
   `SKILL.md` frontmatter and the root `package.json`, pins the `callum` marketplace `ref` in
   `templates/.claude/settings.json` to `vX.Y.Z`, then refreshes this repo's own
   stamp (`node bin/callum-dev.js update`: `.callum-dev.json`, `.callum-dev/baseline/`
   and any merged config files). dev-system is a consumer of its own templates, so the
   bump and the stamp land in the same change. If it reports conflicts, resolve the
   markers before committing. When the release includes base image changes, add
   `--image A.B.C` (plain MAJOR.MINOR.PATCH; see "The base image" below) so the same PR sets `images/base/VERSION`;
   without `--image` that file is left untouched.
2. Commit the notes in the same bump PR. `npm run lint` validates every file in
   `release-notes/` and requires valid notes for the `package.json` version.
3. Open a PR with the result and merge it when `ci` is green. Run the `Release` workflow
   (step 4) immediately after: the bumped ref names a tag that does not exist until it runs.
4. Run the `Release` workflow from main (Actions tab, or):

   ```
   gh workflow run release.yml -f version=X.Y.Z
   ```

   It refuses to run unless `ci` passed on main's HEAD and
   `node scripts/release-bump.js --check X.Y.Z` passes there (every version, the template pin and the stamp
   at X.Y.Z) and `node scripts/release-notes.js --check X.Y.Z` passes (valid
   `release-notes/vX.Y.Z.md`); then it tags `vX.Y.Z` and creates a GitHub Release whose body
   is those notes plus a collapsed "Technical changes" list built from first-parent commits
   since the highest final (non-prerelease) `v*` tag below X.Y.Z (or the full first-parent history if
   none exists). The final release drops the notes' `Verify` section. The technical list is omitted when that range contains no commits.
   Its last step rolls the `Next release` milestone over (see Milestones below).
   An existing `vX.Y.Z` tag must point to the exact workflow commit;
   otherwise the workflow refuses to proceed. Re-running on that commit skips tagging
   and rewrites the release title and body, even if the GitHub Release already exists.

Semver: patch for wording fixes, minor for a new skill/template/capability, major for a
breaking change to an existing contract.

How each layer reaches consumers after the tag exists:

- **Plugin**: follow the [consumer update flow](docs/architecture.md#how-a-change-reaches-a-consumer-repo)
  to advance the marketplace pin and migrate the installation.
- **npm/CLI layer**: consumers depend on `github:cbundy/dev-system#semver:0.x` -
  npm resolves that range against the git tags, so `npm update @callum/dev-system`
  pulls the new tag, then `npx callum-dev update` merges template changes into the
  repo. Tags earlier than v0.3.0 predate `package.json` and cannot be npm-installed.

## Milestones

Milestones record what each release contained. The contract is shared with the base image's
`callum-flow-milestone` helper:

- The titles are exactly `Next release` and `Later`. A repo opts in by having an open milestone
  titled `Next release`.
- The `Next release` description may carry one line, `Expected: <patch|minor|major> - <reason>`,
  the expected version bump. The release skill shows it beside its own proposal.
- The `Release` workflow runs `scripts/release-milestone.js --release X.Y.Z` after the tag and
  GitHub Release exist. It adds any PR in the release range (and the closed issues it closes) that
  has no milestone (or sits in `Next release` or `Later`), renames `Next release` to `vX.Y.Z`, creates a fresh `Next release`,
  moves still-open items into it, and closes `vX.Y.Z`. Without a `Next release` it just creates a
  closed `vX.Y.Z`. Items in any other milestone are left alone. Re-running is safe.
- `--backfill X.Y.Z` builds a closed `vX.Y.Z` from a tag range, only adding items with no milestone and never touching `Next release`;
  `--plan X.Y.Z` is the read-only preview the release skill uses.
  Every mode refuses a prerelease version (exit 2); milestones are only for final releases.

What a release carried is one rule, in `images/base/release-contents.js`: the first-parent PRs since the
previous final tag, the issues they close, the issues they link with `Refs` / `Part of`, and the release
notes' headlines (the bold title leading each bullet). The technical list, the milestone and the
`released` factory event (`callum-flow-released`) all read it. A milestone holds the PRs and the closed
issues. A run-it or keep-open issue may sit in `Later` while its PR is in the release; that is not a
disagreement.

### A release cut by a repo's own workflow

A repo that cuts its releases in a GitHub workflow (not through the factory loop's release task) reaches the
factory event store with one step, added after the step that creates the GitHub Release:

```yaml
- uses: cbundy/dev-system/.github/actions/released-event@vX.Y.Z
  env:
    GH_TOKEN: ${{ github.token }}   # the job needs contents: write
  with:
    tag: v1.2.3
```

It uploads the asset `factory-released.json` (the `released` event's type, version and payload, built from the
same `release-contents.js` rule) to the Release; a re-run replaces it. Nothing is written in CI. A device running
`factory-event-push-loop` collects the asset into its own log and pushes it: automatically for a repo the device
already has a factory log for, and for any other repo once it is listed in `FACTORY_RELEASE_REPOS` (comma or
space separated `owner/name`). dev-system's own `release.yml` runs the step last, so a failure never blocks the
tag, the Release or the milestone.

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

The image version lives in `images/base/VERSION`. It is independent of the release
version and is bumped at release time, never in a feature PR (concurrent PRs each bumping
it collide and force a re-gate of every other open PR). The release bump PR sets it:
`node scripts/release-bump.js X.Y.Z --image A.B.C`. The `release` skill works out whether
image inputs changed since the last tag (`images/base/` other than `VERSION`, and
`features/src/callum-tools/`, the same paths the publish workflow builds on) and picks
the level: patch for fixes, minor for a new tool or capability, major for a breaking
change. After the bump PR merges, run the `Publish base image` workflow (Actions tab, or
`gh workflow run publish-base-image.yml`) to push the new tags. The workflow also
re-pushes the current version's tags weekly with fresh OS packages and tools, so tags
are mutable - see `images/base/README.md`.

## The dev image (no release step)

`ghcr.io/cbundy/dev-system/dev`, this repo's own dev environment
(`.devcontainer/Dockerfile`), has no version and is never released by hand. The
`Publish dev image` workflow rebuilds and pushes `latest` and `sha-<short>` after every
successful base image publish (a release's, the weekly refresh or a manual one), on every
change to `.devcontainer/` merged to main, and weekly (which also refreshes its own tools).
The release skill waits for the run the base publish starts. Its first push creates the package with this
repo's visibility (public).

## Drift check

`npx callum-dev check` exits non-zero when a repo's applied template version
(`.callum-dev.json`) lags the installed package - usable as a CI step in consumer
repos to catch a forgotten `callum-dev update` after an `npm update`.
