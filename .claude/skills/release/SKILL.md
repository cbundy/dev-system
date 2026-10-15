---
name: release
description: Cut a dev-system release - pick the semver bump, draft the curated release notes (release-notes/vX.Y.Z.md) from the merged PRs since the last tag, then run the bump PR and the Release workflow and report the result to the owner. Use when asked to release, cut a release, or write release notes for dev-system.
---

# Release dev-system

Repo-local skill (not shipped in `plugins/`). RELEASING.md has the mechanics; this is the
judgement part: the version and the notes. The owner has given standing release authority: pick
the version and the image level yourself, validate the notes, ship, then report the tag, the release
URL and the workflow results to the owner afterwards.

## 1. Prepare
- `git fetch --tags`; confirm main is up to date and `ci` is green on its HEAD
  (`gh run list --branch main --workflow ci.yml --limit 1`).
- Previous tag: the highest `v*` semver tag. List PRs merged since it:
  `git log --first-parent --format=%s <prev>..origin/main`, then
  `callum-flow-issue-read --pr <N>` for the title and body of each.
- Milestone: `node scripts/release-milestone.js --plan X.Y.Z --to origin/main` (read-only; X.Y.Z is
  your chosen version). It lists the `Next release` milestone's items, its expected-bump line,
  the PRs in the git range that are missing from it, and the items in it that are not in the range.
  - If it says `Next release` still has open items, STOP and name them to the owner. Do not
    release past them; the owner moves them to `Later` (or finishes them). Never move them yourself.
  - Draft the notes from the milestone's items and flag every difference from the `git log`
    range in your report to the owner. The release workflow reconciles the milestone itself.
  - With no `Next release` milestone, ignore this and work from `git log` as before.
- Pick the bump per RELEASING.md: patch for wording fixes, minor for a new
  skill/template/capability, major for a breaking change to an existing contract. Give reasons in your report. When the milestone has an
  `expected:` line, show it next to your choice and say why you agree or differ.

## 2. Changed layers (from paths)
`git diff --name-only <prev>..origin/main`:
- `plugins/` - plugin layer.
- `bin/` or `templates/` - CLI and templates layer.
- `images/base/` - base image layer; list it only when image inputs changed (below) and the image
  version is bumped, and note it is its own publish.

Image inputs: `git diff --name-only <prev>..origin/main` paths under `images/base/` other than
`images/base/VERSION`, or under `features/src/callum-tools/` (the publish workflow's PR paths). If
there are any, pick an image bump level with the RELEASING.md rules (patch for fixes, minor for
a new tool or capability, major for a breaking change), starting from the current
`images/base/VERSION`, and report it next to the release version. Feature PRs never bump that file;
the release bump does.

## 3. Draft `release-notes/vX.Y.Z.md`
Format (checked by `node scripts/release-notes.js --check X.Y.Z`, cap 40 lines):
- `##` headings only, in this order: `Breaking`, `New`, `Changed`, `Fixed`, `Upgrade`, `Verify`.
  Leave out empty groups. At least one of the first four, and `Upgrade`, are required.
- `Verify` is required, last, plain `- ` bullets (no bold title or PR link), at most 10, not
  counted in the 40-line cap and not shown in the final release: what to check on a release
  candidate.
- Each item: `- **Title** - one or two sentences ([#N](https://github.com/cbundy/dev-system/pull/N))`
  with at least one PR link.
- No `<details>` block and no "Technical changes" heading: the workflow appends the technical
  list from the commits.

Writing rules: concise over complete. Merge PRs that deliver one change into one item. Leave out
bumps, CI, refactors, tests and docs-only changes unless consumers notice. Say what changes for
the user, not how.

Upgrade section lists only the layers that changed:
- Plugin: run `npx callum-dev update`, commit the `.claude/settings.json` it produces, then
  restart the container or run `dev-init --plugins`. A plain `/plugin marketplace update`
  does not advance the pinned ref.
- CLI and templates: `npm update @callum/dev-system && npx callum-dev update`.
- Base image (only if the release bumps `images/base/VERSION`): rebuild or re-pull the dev container.

## 4. Validate
Run `node scripts/release-notes.js --check X.Y.Z` and
`node scripts/release-notes.js --body X.Y.Z --from <prev> --to origin/main` (the preview), and
fix the notes until the validator passes and the preview reads well. Do not wait for approval.

## 5. Ship
1. On a branch from main: `node scripts/release-bump.js X.Y.Z` (add `--image A.B.C` when image
   inputs changed, at the level you picked); add `release-notes/vX.Y.Z.md`
   to the same bump PR (`npm run lint` fails without it).
2. Merge when `ci` is green.
3. `gh workflow run release.yml -f version=X.Y.Z`, wait for it, then confirm the published
   body with `gh release view vX.Y.Z` (curated groups, Upgrade, collapsed technical list). The
   workflow's last step rolls the milestone over; check `vX.Y.Z` is closed and a fresh
   `Next release` exists (when the repo had one).
4. If the release bumped the image: `gh workflow run publish-base-image.yml` on main to publish the
   new tags, then confirm the run is green.
5. Report to the owner: the version and image level with the reasons in one line each, the tag,
   the release URL (`gh release view vX.Y.Z --json url`), and the result of each workflow run.
