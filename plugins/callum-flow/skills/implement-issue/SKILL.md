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
version: 0.19.0
---

# Implement issue

You have been delegated one issue's implementation, normally as the named
`callum-flow:implementer` (or `callum-flow:fixer`) agent, which the plugin pins
to Sonnet. Sub-agents you spawn yourself must also go through a named
`callum-flow:*` agent; never delegate ad hoc with `model` omitted, because that
inherits your model. If your brief names a model override (an issue `model:<alias>`
label), pass it explicitly as `model` on any sub-agent you spawn.

 This skill owns the *how*;
whoever delegated to you owns the *what* (the design/brief). The brief normally
arrives as a pointer, an issue comment URL: read it with `gh` and use its
`## Acceptance criteria` as the `--intent` (section 6). Follow this
procedure tightly and terminate when done - do not babysit.

This skill assumes `treehouse` and `no-mistakes` are available on PATH (both
are installed by the consumer repo's devcontainer tooling) and that the
consumer repo documents its own canonical commands - check its `CLAUDE.md`
"canonical commands" section (or equivalent config/README) whenever this
skill says to look one up, rather than assuming any specific command.

Never install toolchains, browsers, or system packages yourself (no
`playwright install --with-deps`, `apt-get`, runtime installs, and so on) -
everything a task needs is baked into the consumer repo's devcontainer. A tool
that looks missing is a container-build bug, not something to fix inline:
report it in your handoff (and raise a `bug` issue if the consumer repo's
`CLAUDE.md` asks for one) and carry on with what you can.

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
- Never use `git stash`, including `list`/`show`. `refs/stash` is ONE ref
  shared by every worktree of the repo, so another agent's `git stash pop`
  can land on top of your changes, or yours can land on top of theirs - a
  plugin-shipped hook refuses the command for exactly this reason. To shelve
  work-in-progress instead: commit it on your own branch (amend or squash it
  away later), or save it with `git diff > <file>` (or
  `git diff --cached > <file>` for staged changes) and restore it later with
  `git apply <file>`.
- Never touch the default tmux socket: no `tmux kill-server`, `tmux
  kill-session`, `pkill tmux` or `killall tmux`. The long-running Claude
  session (the orchestrator) lives on that socket, so killing it kills the
  agent running the command and every other session on the host. Anything
  that needs tmux for a test uses a private socket (`tmux -L <unique-name>
  ...`); a plugin-shipped hook refuses the default-socket commands.

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
- Run targeted tests for the files you touched, using the repo's documented
  commands. The `/no-mistakes` pipeline is the full gate, so do not run the
  canonical full check locally just to duplicate it.
- Do NOT run the repo's e2e suite locally. The `/no-mistakes` pipeline runs
  the full suite (e2e included) and resolves small failures itself, so a local
  run only duplicates cost and context. The one exception is a bug fix whose
  reported failure can only be reproduced end to end - run the single relevant
  spec, not the suite.
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
- Launch it detached from the first command, never through `tail`: `nohup
  no-mistakes axi run --intent "<goal>" > /tmp/no-mistakes-<branch>.log
  2>&1 &`. Then make exactly one `no-mistakes status` read to capture the run
  id and confirm its `head` equals your commit SHA. Record it with
  `callum-flow-event run_started --issue <N> --run <id> --branch <branch>
  --head <sha>` (skip if the command is missing). Write a self-contained
  handoff (see section 8), and TERMINATE.
- Never pass `--yes` (to `axi run` or `axi respond`). It makes the pipeline
  apply `ask-user` findings - scope and policy judgement calls, including
  "remove this component" - with no escalation, which can silently delete
  requirements the issue asked for. Without it those findings park the run
  for the delegator to decide; routine auto-fix findings still self-fix.
- Make `<goal>` the issue's acceptance criteria, stated as requirements
  (e.g. "OWNER REQUIREMENTS - do not remove or flag for removal: ..."), not
  a description of the diff. no-mistakes treats an explicit intent as the
  authoritative acceptance criteria its review checks fixes against.
- Waiting for the run to progress, polling status, tailing logs, or `sleep` of
  any duration is out of scope. The orchestrator's watcher observes pipeline
  events after your handoff.
- If you are re-entering a branch that already has a run on it (e.g. you were
  delegated to fix something a review flagged) and the fix is something you
  can describe rather than something you must write yourself, drive the
  existing run instead of committing around it: `no-mistakes axi respond
  --action fix --findings <ids>`, `--add-finding '<json finding>'`, and/or
  `--instructions "<what to do>"` - never `--yes`. This commits on the run's
  own head in the run's own worktree, so there is no second writer on the
  branch and none of the rebase/abort rules below apply.
  `axi respond` blocks like `axi run`, so launch it detached the same way
  (`nohup ... > <log> 2>&1 &` or `run_in_background`), never in the
  foreground, where the 120s tool timeout kills the driver and strands the run.
- Only when the fix needs your own commit - code the pipeline cannot write
  from instructions alone, or the run has already completed - do the rebase
  and abort steps apply. If you are committing on a branch that already has a
  run or PR (e.g. you are a fixer re-entering a worktree), `git fetch` and
  rebase your commit onto `origin/<branch>` first. The pipeline pushes its
  own review/document/lint commits while a run is in progress, so a worktree
  that was correct at bootstrap can be stale by the time you commit - a fix
  committed on that stale base is not on the PR's history. Resolve conflicts
  keeping both sides (your fix and the pipeline's commits); never force-push
  in a way that discards the pipeline's commits.
- Before running `axi run` on that branch, check whether a run is already
  live on it - including a completed run's CI-monitoring tail, which still
  reports `running` for up to 168h. If one is live, run `no-mistakes axi
  abort` first - never abort a live run just to fix a finding yourself when
  `axi respond` could have done it; that discards the pipeline's in-flight
  work and forces a full re-validation for nothing. `axi run` on a branch
  with a live run attaches to that same run instead of starting a new one, so
  it gates nothing for your new commit - it will report the old run's id and
  head. Re-attaching with `axi run --intent "<goal>"` without aborting is
  only correct for a gate that is PARKED awaiting a decision and needs no new
  commit of yours; it does not gate a new commit against a run that is still
  live.
- Do NOT merge. Merging is the delegator's decision, not yours, unless your
  brief explicitly says otherwise.

## 7. Issue linkage (what you write)
- Read the brief's `## Rollout`. Write `Closes #<N>` in the PR body when it is
  `merge`, and `Refs #<N>` for `run-it` and `keep-open`. Keep instructions *about* the keyword out of
  the `--intent` text (section 6); the delegator checks linkage at merge.
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
- If you drove the run with `axi respond` instead of committing your own fix,
  say so instead of comparing heads: name the action and step you responded
  to (e.g. "responded --action fix --findings F1,F2 to the review step") and
  its outcome - there is no separate commit of yours to check against the
  run's head.
- Whenever you added your own commit: the `/no-mistakes` run id, together
  with the run's `head` SHA read from `no-mistakes status` - and state
  plainly whether `head` equals the commit SHA above. A head that differs
  from your commit SHA means your commit was not gated: write "NOT GATED" in
  plain words and explain why (e.g. a run was already live and `axi run`
  attached to it instead of starting a new one). Never rationalise a
  mismatch away as expected.
- PR number and URL if the pipeline has already created one; otherwise the run
  id is the handoff identifier. Never wait for a PR to exist.
- Exactly what you verified, and how (commands run, what passed).
- What remains, if anything.
- Known risks.
- Any tooling that appeared missing or broken in the container (never
  installed inline - see the note at the top of this skill).

## 9. Efficiency
- Do not narrate each step to yourself. Think, act, and summarise only at the
  handoff.
- Batch independent shell commands into a single call rather than one call per
  command.
- Pipe large command outputs to a file and `grep`/`tail` the relevant part
  rather than dumping full logs into context.
- When reporting, distinguish a documented guarantee from your own inference.
