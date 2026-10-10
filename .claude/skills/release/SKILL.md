---
name: release
description: Cut a dev-system release - propose the semver bump, draft the curated release notes (release-notes/vX.Y.Z.md) from the merged PRs since the last tag, stop for owner approval, then run the bump PR and the Release workflow. Use when asked to release, cut a release, or write release notes for dev-system.
---

# Release dev-system

Repo-local skill (not shipped in `plugins/`). RELEASING.md has the mechanics; this is the
judgement part: the version and the notes. Never merge or run the workflow before the owner
approves the draft.

## 1. Prepare
- `git fetch --tags`; confirm main is up to date and `ci` is green on its HEAD
  (`gh run list --branch main --workflow ci.yml --limit 1`).
- Previous tag: the highest `v*` semver tag. List PRs merged since it:
  `git log --first-parent --format=%s <prev>..origin/main`, then `gh pr view <N>` for the
  title and body of each.
- Propose the bump per RELEASING.md: patch for wording fixes, minor for a new
  skill/template/capability, major for a breaking change to an existing contract. Give reasons.

## 2. Changed layers (from paths)
`git diff --name-only <prev>..origin/main`:
- `plugins/` - plugin layer.
- `bin/` or `templates/` - CLI and templates layer.
- `images/base/` - base image layer; list it only when `images/base/VERSION` moved, and note it
  is its own publish.

## 3. Draft `release-notes/vX.Y.Z.md`
Format (checked by `node scripts/release-notes.js --check X.Y.Z`, cap 40 lines):
- `##` headings only, in this order: `Breaking`, `New`, `Changed`, `Fixed`, `Upgrade`. Leave out
  empty groups. At least one of the first four, and `Upgrade`, are required.
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
- Base image (only if `images/base/VERSION` moved): rebuild or re-pull the dev container.

## 4. Show and stop
Run `node scripts/release-notes.js --check X.Y.Z` and
`node scripts/release-notes.js --body X.Y.Z --from <prev> --to origin/main` (the preview).
Show the proposed version, the notes, the validator result and the preview, then STOP and wait
for the owner's approval.

## 5. Ship (after approval)
1. On a branch from main: `node scripts/release-bump.js X.Y.Z`; add `release-notes/vX.Y.Z.md`
   to the same bump PR (`npm run lint` fails without it).
2. Merge when `ci` is green.
3. `gh workflow run release.yml -f version=X.Y.Z`, wait for it, then confirm the published
   body with `gh release view vX.Y.Z` (curated groups, Upgrade, collapsed technical list).
