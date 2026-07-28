# global agent instructions

- Never use the em dash. Use plain dash "-" instead
- When writing commit messages, NEVER auto-add your agent name as co-author
- Every PR MUST link to its issue with a GitHub keyword in the PR body. Use `Closes #N` when
  the issue should auto-close on merge; use `Refs #N` / `Part of #N` when it must stay open.
  Verify with `gh pr view <pr> --json closingIssuesReferences` before merging.
- Prefer quality, simplicity, robustness, and long term maintainability over development cost.

# this repo

This is the source of truth for Callum's portable dev system (see README.md for the
architecture). Rules specific to working here:

- Shared skills in `plugins/` must stay generic and stateless - no repo-specific state or
  hardcoded paths from a consumer repo. Repo-specific state belongs at repo-local paths in
  the consumer (e.g. `.claude/orchestrator-memory.md`).
- Behavior changes ship by tagging a release; consumers pull. Never advise patching a copy
  of a skill or template inside a consumer repo.
- Templates in `templates/` must keep a clear split between synced content and repo-owned
  values so `callum-dev update` can merge cleanly.
