# cbundy/dev-system-scratch: setup notes (2026-10-15)

## Seed

- One commit, `95ddf08` "Seed the scratch repo from dev-system-testbed", tagged `drill-base`.
- Source: cbundy/dev-system-testbed main at `f3f3884` (callum-dev templates 0.37.0), exported
  with `git archive`.
- Kept: `.callum-dev.json`, `.callum-dev/baseline/`, `.claude/settings.json`, `CLAUDE.md`
  (repo-owned block updated), `.no-mistakes.yaml` (repo-owned `document` block updated),
  `.github/pull_request_template.md`, `.devcontainer/devcontainer.json` (repo-owned name and
  machine name), `.gitignore`, `treehouse.toml`, `docs/api.md`, `src/`, `test/`,
  `scripts/slugify-lines.js`, `package.json` and `package-lock.json` (renamed).
- Dropped (base-image testing, not loop testing): `.github/workflows/base-image.yml`,
  `.devcontainer/local/`, `.devcontainer/extended/`, `scripts/smoke.sh`,
  `scripts/check-volumes.sh`, `scripts/build-local-image.sh`, `TESTING.md`.
- Added: `scripts/lint.js` (`npm run lint`), `test/properties.test.js` (seeded property tests,
  300000 runs per property), `.claude/factory-loop.json`, a new `README.md`, CI job `ci`.

## Gate timings

- Local (this container): `npm run lint` 0.6 s, `npm test` 6.7 s, 69 tests, none need `npm ci`.
- CI run 38795701741 on the seed push: 19 s, success.
- Mutation check: making `slugify` append `-` to 3-letter slugs fails two property tests with
  `not a slug: "ene-" (seed 20261015, run 0, input "éñé日本")`.

## Protection smoke test (then reset)

- PR 1 (docs change) was `BLOCKED` while `ci` ran, then `CLEAN`; `gh pr merge 1 --merge` merged it.
- PR 2 with a trailing-whitespace lint error: `ci` FAILURE, `BLOCKED`, `gh pr merge` refused.
- PR 2 fixed after PR 1 merged: `ci` SUCCESS but `BEHIND`; `gh pr merge 2 --merge` refused;
  `gh pr update-branch 2` then `ci` SUCCESS gave `CLEAN`.
- `scratch-reset.sh` then closed PR 2, deleted `smoke-a` and `smoke-b`, moved main from
  `ede0e96` back to `95ddf08`, and all seven end-state checks passed.
- Issue and PR numbers continue from 3 (PRs 1 and 2 used).

## Files

- `scratch-reset.sh` - the reset between drills (`--dry-run` to preview).
- `scratch-protection.json` - the exact branch protection body the reset restores.
