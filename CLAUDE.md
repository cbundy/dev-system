<!-- synced: do not edit (managed by dev-system) -->
# global agent instructions

- Never use the em dash. Use plain dash "-" instead
- When writing commit messages, NEVER auto-add your agent name as co-author
- Never manually modify CHANGELOG.md files or any files that are marked as auto-generated
- If an issue is research-only, do not close it when its PR merges - leave the issue open
  after the PR is merged so follow-up work can continue.
- Every PR MUST link to the issue it addresses using a GitHub keyword in the PR body, so the two stay
  connected for tracking. Use a closing keyword - `Closes #N` (or `Fixes #N` / `Resolves #N`) - when the
  issue should auto-close on merge; use a non-closing keyword instead - `Refs #N` or `Part of #N` - when
  the issue must stay open (research-only, under review, or one part of a multi-part issue).
- Before merging, verify the linkage matches intent with `gh pr view <pr> --json closingIssuesReferences`:
  the issue number must appear for a closing PR and be absent for a keep-open PR. Re-check after any
  pipeline rewrite of the PR body - rewrites can silently drop the keyword, and a stray `Closes #N` pasted
  inside description text can wrongly auto-close the wrong issue.
- When making technical decisions, do not give much weight to development cost.
  Instead, prefer quality, simplicity, robustness, scalability, and long term maintainability.
- When doing bug fixes, always start with reproducing the bug in an E2E setting as closely aligned with how an end user would experience it as possible.
  This makes sure you find the real problem so your fix will actually solve it.
- When end-to-end testing a product, be picky about the UI you see and be obsessed with pixel perfection.
  If something clearly looks off, even if it is not directly related to what you are doing, try to get it fixed along the way.
- For any PR that changes UI, capture a screenshot (and a short video/GIF for animated/interactive changes)
  using this repo's e2e visual verification tooling (n/a - no UI), and attach it to the PR description before the PR is considered ready.
- Keep PR descriptions brief and concise. They are reviewed by a head of engineering, not an engineer,
  so they must be high quality and ready to go without low-level technical detail. Always attach pictures
  (screenshots, and a short video/GIF for animated/interactive changes) when the change is visual.
- Apply that same high standard to engineering excellence: lint, test failures, and test flakiness.
  If you see one, even if it is not caused by what you are working on right now, still get it fixed.

## Dev container is ephemeral

This repo is worked on inside a development container. You are free to install any
tools, system packages, browsers, language runtimes, etc. that you need to get
things working - go ahead and install them in the running container.

But anything you install by hand is lost when the container is rebuilt. It does not
survive a rebuild. So installing a tool is only ever a temporary fix.

Whenever you settle on the right tools/steps to set up a dependency (i.e. you have
confirmed the exact packages/commands that make something work), raise a GitHub
issue labelled `bug` so the dev container build process (`.devcontainer/`) can be
updated to include it permanently. Record in the issue: what breaks without the
dependency, the exact confirmed install commands, and how to bake it into
`.devcontainer/` (feature, `postCreateCommand`, etc.).

- Do NOT edit `.devcontainer/` in the same change that you are doing your feature
  work. Container build changes are applied out of cycle, deliberately, so they do
  not interrupt the container that is currently in use.
<!-- end synced -->

<!-- repo-owned: edit freely - fill in the sections below for this repo -->
## Canonical commands

Run these from the repo root. Do not re-derive per-directory commands or run
test suites file-by-file - use a single entrypoint per gate so nothing is ever skipped,
and adding a new test file should require no extra wiring.

- `npm run lint` - syntax-checks every shell script under `images/base/`,
  `features/src/callum-tools/`, `features/test/` and `plugins/callum-flow/hooks/`, and
  runs `node --check` on the JavaScript under `bin/`, `plugins/` and `scripts/`, and
  fails if a generated skill is out of date (`scripts/build-skills.js --check`)
  (`scripts/lint.sh`).
  Interim until shellcheck replaces the `-n` checks (see #116).
- `npm test` - the CLI and hook tests under `tests/`, plus the plain-shell `callum-tools`
  script tests (`pin-codex-model`, `recover-no-mistakes`).

The no-mistakes lint and test steps (`.no-mistakes.yaml`) call exactly these two commands,
and CI's `test-cli.yml` runs `npm test`. A new test or script check belongs inside one of
these entrypoints, not in a bespoke CI step.

## This repo

This is the source of truth for Callum's portable dev system (see docs/architecture.md for the
architecture). Rules specific to working here:

- Shared skills in `plugins/` must stay generic and stateless - no repo-specific state or
  hardcoded paths from a consumer repo. Repo-specific state belongs at repo-local paths in
  the consumer (e.g. `.claude/orchestrator-memory.md`).
- Behavior changes ship by tagging a release; consumers pull. Never advise patching a copy
  of a skill or template inside a consumer repo.
- The `callum-tools` Dev Container Feature is deprecated (#89); the base image in
  `images/base/` is the supported environment. Never add capabilities to the feature or
  the `feature` devcontainer template, and never steer a consumer onto them. Put new
  tooling in `images/base/`. The scripts in `features/src/callum-tools/` are still the
  image's source, so fixing them is fine.
- Templates in `templates/` must keep a clear split between synced content and repo-owned
  values so `callum-dev update` can merge cleanly.
- The `onboard` skill's `SKILL.md` is generated from `docs/onboarding.md` (plus
  `SKILL.src.md` beside it) by `scripts/build-skills.js`. Edit those, then run
  `npm run build:skills`; `npm run lint` fails while the generated file is stale.
- Test Coder template changes only with `coder/dev-system/push-next.sh` (pushes
  `dev-system-next`). Never run `coder templates push` for `dev-system` yourself, even
  though the token could: promoting to the production template is the owner's step.

This repo is also a consumer of its own templates (`.callum-dev.json`,
`.callum-dev/baseline/`). Run the checkout's own CLI, `node bin/callum-dev.js`, never an
npm dependency on this package. After each release, bring the stamp up to date
(RELEASING.md).

## No Docker in the dev environment (for now)

The dev environment has no Docker access yet (tracked under #114). Changes under
`images/base/`, `features/` and `coder/` are verified by PR CI: `publish-base-image.yml`
builds the image and runs `images/base/test/test.sh`, and `test-features.yml` runs the
feature tests. Never claim an image, devcontainer or feature-in-container test ran
locally - point to the PR's CI run instead.

## Trying skill changes

Sessions in this repo run the *released* callum-flow plugin from the marketplace, not this
checkout, so editing `plugins/callum-flow/` does not change the running session. To try a
skill or hook change, start a session with `claude --plugin-dir plugins/callum-flow`.

## Implementation sub-agents

Any agent making code changes - solo or delegated - works inside a treehouse worktree.
Sub-agents delegated an issue follow the `implement-issue` skill for the full working
procedure (worktree, build, verify, evidence, /no-mistakes pipeline, handoff).
Orchestration is driven by the `issue-orchestrator` skill.

There is no app to boot here. Image, devcontainer and feature changes cannot be exercised
locally (see "No Docker in the dev environment" above), so their evidence is the PR's CI run.
<!-- end repo-owned -->
