---
name: implement-issue
description: >-
  End-to-end procedure a delegated sub-agent follows to implement one GitHub
  issue in a treehouse worktree and ship it via the /no-mistakes pipeline:
  worktree bootstrap, safe app-boot, verification discipline, private-repo
  evidence capture, the quality bar, the pipeline's fire-and-forget contract,
  issue linkage, and handoff shape. Use this when you are a sub-agent that has
  been delegated a single issue to implement (as opposed to orchestrating a
  queue of issues).
version: 0.2.1
---

# Implement issue

You have been delegated one issue's implementation. This skill owns the *how*;
whoever delegated to you owns the *what* (the design/brief). Follow this
procedure tightly and terminate when done - do not babysit.

This skill assumes `treehouse` and `no-mistakes` are available on PATH (both
are installed by the consumer repo's devcontainer tooling) and that the
consumer repo documents its own canonical commands - check its `CLAUDE.md`
"canonical commands" section (or equivalent config/README) whenever this
skill says to look one up, rather than assuming any specific command.

## 1. Worktree bootstrap
- Run `treehouse help` first, to confirm `treehouse` is installed and to
  understand the tool. Do this before any edit.
- Check whether this repo wraps worktree bootstrap in a helper script - look
  in `CLAUDE.md`'s canonical commands section or under `scripts/` for
  something like `scripts/worktree-bootstrap.sh <issue-number> <slug>
  [leaseholder]`. If one exists, use it: it typically leases a worktree from
  the base branch via `treehouse get --lease` (defaulting the leaseholder to
  "Issue \<N\> \<slug\>" if you omit it), creates/checks out a conventionally-
  named branch, and on success prints two machine-readable lines to stdout -
  capture both:
  ```
  WORKTREE <absolute path>
  BRANCH <branch name>
  ```
  e.g. `cd "$(scripts/worktree-bootstrap.sh 222 worktree-bootstrap | awk '/^WORKTREE/{print $2}')"`.
- If no such wrapper exists, do the two steps directly: `treehouse get
  --lease` to lease a worktree from the base branch, then `git checkout -b
  <branch>` inside it. Capture the worktree's absolute path and the branch
  name yourself - you need both for everything that follows.
- Branch naming is a convention, not a hard requirement of this skill: the
  standard across repos using this workflow is `feat/issue-<N>-<slug>` by
  default, or `fix/issue-<N>-<slug>` / `docs/issue-<N>-<slug>` for a bugfix or
  docs-only change. Follow whatever this repo's own convention documents if
  it differs.
- If `treehouse` is missing from PATH, it (or its wrapper script) fails
  clearly with a reinstall command instead of silently falling back to
  anything else. Run that command, confirm `treehouse help` works, then retry
  - never fall back to plain `git worktree`.
- Do ALL work inside the worktree. Never use plain `git worktree` - always go
  through `treehouse` (directly, or via a repo's wrapper script).

## 2. Booting the app (only if you need it for evidence or manual checks)
- Look for a documented boot command first - check `CLAUDE.md`'s canonical
  commands section or `scripts/` for something like `scripts/dev-server.sh`.
  A well-behaved boot script auto-selects a free port, launches the app in
  the background, and blocks until it is actually healthy (polling a real
  health endpoint, not just a "listening" log line) before returning,
  printing its port/URL, PID, and log path on stdout, e.g.:
  ```
  READY http://localhost:<port>
  PID <pid>
  LOG <path>
  ```
  Capture those three values from its output - do not pick your own port or
  assume a fixed one.
- Never boot on a port the repo has reserved for the user's own long-running
  dev server (check `CLAUDE.md`/config for which, if any, is reserved) - a
  well-behaved boot script already refuses to, even if forced.
- Capture the exact PID the boot process reports and only ever kill that
  PID. Never `pkill`/`kill` by process name (the language runtime, browser
  driver, etc.) - that kills the worktree owner's and other agents'
  processes too.
- On failure, a well-behaved boot script prints nothing to stdout, exits
  non-zero, and prints a tail of the server log plus diagnostics to stderr -
  look there first.

## 3. Verification discipline
- Run this repo's canonical "check" command (lint + typecheck + unit tests)
  from the repo root before considering the change done - look it up in
  `CLAUDE.md`'s canonical commands section rather than assuming a specific
  one; it should be the same command CI runs, so nothing you verify locally
  can drift from the gate.
- If the change touches UI or another end-to-end-sensitive surface, ALSO run
  the repo's e2e suite locally. Confirm from `CLAUDE.md`/config whether the
  fast "check" command already includes e2e or excludes it - a fast unit-only
  command that silently excludes e2e is a common trap, and running only that
  one can look green while an e2e regression ships.
- For bug fixes, confirm the regression test reproduces the reported failure
  against the BROKEN code before applying your fix. A test that only ever
  passed proves nothing.

## 4. UI evidence on a private repo
- On a private repo, inline images often do not render in PR bodies: GitHub's
  image proxy (camo) cannot authenticate to a private repo, so a raw file
  link (e.g. `raw.githubusercontent.com`) shows broken.
- Check whether this repo documents an evidence-capture convention for this -
  typically a single script under `scripts/` (see `CLAUDE.md`/`docs/` for the
  exact command) that boots the app, drives a browser to capture a screenshot
  (and, for interactive changes, a short clip), uploads the result somewhere
  that returns a readable signed URL, and prints that URL ready to paste
  straight into the PR body as `![description](<url>)`. Use it if present -
  it exists precisely to solve the camo problem above. Only ever kill the
  exact server PID it launched.
- Fallback only (no such convention documented, or its upload credentials are
  unavailable): commit screenshots/clips under a docs path scoped to the
  issue (e.g. `docs/design/issue-<N>-<slug>/screenshots/`) and link them in
  the PR by blob URL pinned to the commit SHA. Verify the URL actually
  resolves before handing off.

## 5. Quality bar
Meet all four before calling the work done - each one caught a real bug that
tests would otherwise have missed:
- **Run the regression test against the broken code first.** Confirm it
  actually reproduces the reported failure; a test that only ever passed
  proves nothing.
- **Fix the test double before trusting it.** A fake that ignores the
  parameter under test makes the regression test worthless even if it's green.
- **Manufacture the case you cannot find.** If real data cannot exercise a
  guard (e.g. no cyclic data for a cycle check), build a fixture that does
  rather than declaring it untestable.
- **Prove the guard actually works** - e.g. show the traversal really escapes
  when the guard is removed. Otherwise "blocked" and "impossible anyway" look
  identical.

## 6. The /no-mistakes pipeline - fire-and-forget contract
- Run `/no-mistakes` end to end: rebase -> review -> test -> document -> lint
  -> push -> PR -> CI.
- Then: ensure your commits are pushed, reconcile with the remote
  (`git fetch && git rebase origin/<branch>`), confirm `no-mistakes status`
  head equals your real commit SHA, write a self-contained handoff (see
  section 8), and TERMINATE. Do NOT babysit the pipeline - it is detached and
  self-driving while its steps keep passing.
- If a step FAILS and parks the run awaiting a driver, you may re-attach from
  the branch worktree with `no-mistakes axi run --yes --intent "<goal>"`.
- Do NOT merge. Merging is the delegator's decision, not yours, unless your
  brief explicitly says otherwise.

## 7. Issue linkage (what you write)
- Put an exact closing keyword in the PR body when the issue should close on
  merge, e.g. `Closes #<N>`. Follow whatever your brief says about whether
  this PR should close its issue.
- NEVER write close/closes/fixes/resolves immediately before an issue number
  you do not mean to close - GitHub's parser ignores negation and surrounding
  context, so `"must NOT close #93"` still registers as a closing reference.
  Phrase around it instead (e.g. "part of #93", "finishes the work started in
  PR X").
- Linkage verification is the delegator's job, not yours - but writing it
  correctly the first time avoids a stalled downstream dependency.

## 8. Handoff shape
Your final message must be self-contained - the reader has no other context:
- Worktree path and branch name.
- Latest commit SHA.
- `/no-mistakes` run id.
- PR number and URL.
- Exactly what you verified, and how (commands run, what passed).
- What remains, if anything.
- Known risks.

## 9. Efficiency
- Do not narrate each step to yourself. Think, act, and summarise only at the
  handoff.
- Batch independent shell commands into a single call rather than one call per
  command.
- Pipe large command outputs to a file and `grep`/`tail` the relevant part
  rather than dumping full logs into context.
- When reporting, distinguish a documented guarantee from your own inference.
