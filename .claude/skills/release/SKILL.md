---
name: release
description: Cut a dev-system release end to end - draft the curated release notes (release-notes/vX.Y.Z.md) from the merged PRs since the last tag, open and merge the bump PR, run the Release workflow and the image publish, and report each step. The guide the loop judge's release agent follows once the judge has decided to release; also for a person asked to release, cut a release, or write release notes for dev-system.
---

# Release dev-system

Repo-local skill (not shipped in `plugins/`), the guide for the **release agent**. The loop's
judge decides *when* to release and the version step (patch or minor); it then starts you with
that step. You do the release, every step below, and report back. You decide nothing about
whether to release. RELEASING.md has the full mechanics. The owner has given standing release
authority: ship without asking, then report.

When a person runs this skill with no step given, pick the step yourself in step 1.

## Rules for the release agent
- Work in a leased worktree (`treehouse get --lease -b chore/release-vX.Y.Z`), never in the main
  checkout: a tracked change there holds every claim and agent of the loop. Add files by name,
  never `git add -u` or `-A` in a shared checkout. Return the worktree when done.
- Check first that `vX.Y.Z` is not already tagged (`git tag -l vX.Y.Z` after `git fetch --tags`).
  If it is, stop and report `already released`.
- Wait on checks and runs with a 60 s interval (see the end of this guide), never the defaults.
- Never push Coder templates, restart or upgrade a workspace, or change the loop's settings: an
  outside foreman session moves the loops onto a new release.
- Report back in one line per step (notes, bump PR, merge, CI on main, Release, image publish,
  milestone) and finish with the version, the image version when it changed, and the release URL.
  The report ends with one line for the foreman: when the release changes anything under `plugins/`
  since the previous tag (`git diff --name-only <prev>..origin/main -- plugins/`), exactly
  `push coder/push.sh orchestrator-loop to move the loops onto plugin vX.Y.Z`; otherwise `no Coder template push needed`.
  If a step fails, stop there and report which step and why; do not retry by force-pushing,
  re-tagging or skipping a check.

## 1. Prepare
- `git fetch --tags`; confirm main is up to date and `ci` is green on its HEAD
  (`gh run list --branch main --workflow ci.yml --limit 1`).
- Previous tag: the highest `v*` semver tag. List PRs merged since it:
  `git log --first-parent --format=%s <prev>..origin/main`, then
  `callum-flow-issue-read --pr <N>` for the title and body of each.
- Milestone: `node scripts/release-milestone.js --plan X.Y.Z --to origin/main` (read-only; X.Y.Z is
  your chosen version). It lists the `Next release` milestone's items, its expected-bump line,
  the PRs in the git range that are missing from it, and the items in it that are not in the range.
  - If it says `Next release` still has open items, stop and report them as the reason (the judge
    passes it on). Do not release past them; the owner moves them to `Later` (or finishes them).
    Never move them yourself.
  - Draft the notes from the milestone's items and flag every difference from the `git log`
    range in your report to the owner. The release workflow reconciles the milestone itself.
  - With no `Next release` milestone, ignore this and work from `git log` as before.
- The version: the next version at the step the judge gave you. With no step given, pick it per
  RELEASING.md: patch for wording fixes, minor for a new skill/template/capability, major for a
  breaking change to an existing contract. Never release a major version unless the owner has
  agreed to it. Give reasons in your report. When the milestone has an `expected:` line, show it
  next to the version and say why you agree or differ.

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
  does not advance the pinned ref. A loop workspace on the `orchestrator-loop` template picks up
  the plugin only after that template is pushed at the release (`coder/push.sh orchestrator-loop`),
  because the template's plugin ref beats the repo's `.claude/settings.json` pin.
- CLI and templates: `npm update @callum/dev-system && npx callum-dev update`.
- Base image (only if the release bumps `images/base/VERSION`): rebuild or re-pull the dev container.

## 4. Validate
Run `node scripts/release-notes.js --check X.Y.Z` and
`node scripts/release-notes.js --body X.Y.Z --from <prev> --to origin/main` (the preview), and
fix the notes until the validator passes and the preview reads well. Do not wait for approval.

## 5. Ship
1. On a branch from main: `node scripts/release-bump.js X.Y.Z` (add `--image A.B.C` when image
   inputs changed, at the level you picked); add `release-notes/vX.Y.Z.md`
   to the same bump PR (`npm run lint` fails without it). The bump PR's branch is
   `chore/release-vX.Y.Z`: the factory loop holds its own merges while the bump PR's checks run, up to 45
   minutes from each push (`releaseBranchPrefix`, `releaseHold`), so main stays put while the bump
   PR's CI runs; a push restarts the hold and a failed check ends it. Open the PR only when the notes are final, and merge it as soon as `ci` is green.
   If the 45 minutes run out first, the loop merges again and the bump PR may fall behind main:
   update it and re-run `ci`, as before.
2. Merge when `ci` is green, then wait for `ci` to pass on the merge commit on main: the
   Release workflow refuses while that run is in progress.
3. `gh workflow run release.yml -f version=X.Y.Z`, wait for it, then confirm the published
   body with `gh release view vX.Y.Z` (curated groups, Upgrade, collapsed technical list). The
   workflow's last step rolls the milestone over; check `vX.Y.Z` is closed and a fresh
   `Next release` exists (when the repo had one).
4. If the release bumped the image: `gh workflow run publish-base-image.yml` on main to publish the
   new tags, then confirm the run is green. Once it is green, the `Publish dev image` workflow
   starts by itself (`workflow_run`): find that run with `gh run list --workflow publish-dev-image.yml
   --event workflow_run --limit 1 --json databaseId,headSha,status,conclusion,url`, check it is newer
   than the base run, wait on it with `gh run watch <id> --exit-status --interval 60`, and confirm it
   is green.
5. Report (to the judge that started you, or to the owner when a person ran this skill): the
   version and image level with the reasons in one line each, the tag, the release URL
   (`gh release view vX.Y.Z --json url`), and the result of each workflow run, including the dev image run.
   Close the report with one line for the foreman, decided by
   `git diff --name-only <prev>..origin/main -- plugins/`: when it lists anything, exactly
   `push coder/push.sh orchestrator-loop to move the loops onto plugin vX.Y.Z`; when it is empty, `no Coder template push needed`.

Waiting on a check or a run: the whole fleet (every loop and session) shares one GitHub rate limit,
and the image publish alone takes about 15 minutes. Always wait with a slow interval:
`gh pr checks <pr> --watch --interval 60` and `gh run watch <id> --exit-status --interval 60`.
Never use their defaults (10 s and 3 s): one release with the image publish then costs about a
thousand requests, enough to starve the loops.
