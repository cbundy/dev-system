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
  using this repo's e2e visual verification tooling (<REPLACE: path to your e2e visual verification doc, e.g.
  `docs/design/e2e-visual-verification.md`>), and attach it to the PR description before the PR is considered ready.
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

<REPLACE: list this repo's canonical commands here, e.g. lint / typecheck / test / test:all /
a combined check command. State which command CI calls for each gate, so the local command
and the CI gate can never drift apart. If you add a new category of tests, extend the single
entrypoint here rather than adding a bespoke CI step.>

## Implementation sub-agents

Any agent making code changes - solo or delegated - works inside a <REPLACE: this repo's
worktree/isolation mechanism, e.g. a treehouse worktree>. Sub-agents delegated an issue
follow the `implement-issue` skill for the full working procedure (worktree, build, verify,
evidence, /no-mistakes pipeline, handoff). Orchestration is driven by the
`issue-orchestrator` skill.

<REPLACE: note any repo-specific variations to the above (e.g. extra build/boot steps
before an agent can safely run this repo's app).>
<!-- end repo-owned -->
