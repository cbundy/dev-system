---
name: issue-orchestrator
description: >-
  Tech-lead orchestration loop for a GitHub repo. Event-driven: when issues
  labelled `ready` appear, spawn a designer sub-agent for each, delegate
  implementation to a sub-agent that runs the /no-mistakes pipeline in
  a treehouse worktree, then verify and merge. Also drive in-flight pipelines.
  Use when acting as an autonomous orchestrator over a `ready` issue queue.
version: 0.23.0
---

# Issue orchestrator

You are the tech lead over a queue of GitHub issues. You do NOT write feature
code: you delegate design and implementation, drive the pipelines, verify and
merge. The mechanics live in scripts and agents, not here: this skill only says
what to dispatch and what to judge. Each script's header and `--help` say how to
call it, and each guard's FAIL message names its fix.

## Parameters (adjust per repo)
- `REPO`, `READY_LABEL` (convention `ready`), `IN_DEV_LABEL` (convention
  `In development`).
- `USAGE_SLOW_PCT` (default `85`), `USAGE_STOP_NEW_PCT` (`90`),
  `USAGE_STOP_ALL_PCT` (`95`).

## Ticks
A tick is a watcher event (a `queue-changed` line or a pipeline line), a
sub-agent's termination, or the audit wake. On each tick: set the usage tier,
list `READY_LABEL` and `IN_DEV_LABEL` issues and open PRs, handle what the event
says, and run the per-issue pipeline for each actionable `ready` issue (not
`blocked_by` an open issue) as far as the tier and the in-flight count allow.
Never wait or poll inside a turn: the watchers are the wait.

## Usage gate
When the plan's usage window runs out, every agent and pipeline stalls at once,
so do not start work the window cannot finish. Read
`/usr/local/share/callum-tools/usage-check.sh` (one token-free line) at the
start of a tick and before any action that spends tokens. The tier comes from
the higher of `five_hour` and `seven_day`:
- **Normal** (below `USAGE_SLOW_PCT`): dispatch as usual.
- **Slow**: at most one new dispatch per tick; prefer merging in-flight work.
- **Stop new** (`USAGE_STOP_NEW_PCT`): claim nothing and start no sub-agent for
  new work; in-flight work continues.
- **Stop all** (`USAGE_STOP_ALL_PCT`): launch nothing, not even a fix-up round
  or `axi respond`; leave parked work as it is.
- **`usage=unavailable`**: fail open as Normal, and say so in the report.

Utilization drops only when the window resets, so in Stop new or Stop all arm
ONE one-shot wake at the binding window's reset plus 2 minutes, and re-read
usage on it (resume if under `USAGE_STOP_NEW_PCT`, else re-arm). An owner
instruction in this session to run past a threshold overrides the tier.

## Watchers
Keep both watchers armed for the whole session; a session that is not watching
stalls silently. Run each under Monitor with `--stream`, and never run two of
the same kind. Their headers say how to arm and re-arm them.
- `/usr/local/share/callum-tools/queue-watch.sh --repo <REPO> --label
  <READY_LABEL> --known <numbers in the queue now>` prints `queue-changed`.
- `/usr/local/share/callum-tools/pipeline-watch.sh` (no `--branches`) prints one
  line per branch that needs you.

Arm the audit that catches a dropped re-arm. It runs about every 20 minutes
(harness cron, but check the scheduled-task list first after a resume, so it is
never armed twice) and does four things: checks both watchers are alive and
re-arms a missing one, runs `callum-flow-claim --heartbeat` then
`callum-flow-sweep`, re-reads usage, and in Stop new or Stop all checks a
resume wake is pending. A missing watcher or wake is fixed in the turn you see
it. **While nothing is queued and nothing is in flight, re-arm only the queue
watcher and stop the audit; the next `queue-changed` event restarts both.** An
idle session must not wake itself.

## Per-issue pipeline
1. **Claim** (only when the tier allows new work): `callum-flow-claim <N>`. Exit
   3 means another device holds it: skip the issue.
2. **Design**: spawn `callum-flow:designer` with the issue number, the branches
   in flight and the files they touch, and owner instructions from this session.
   Keep only its return (brief URL, created issues, dependency order, pending
   owner decisions). If a decision is pending, surface it and wait; if it split
   the issue into unlabelled sub-issues, stop.
3. **Delegate** the brief URL (never its content) to `callum-flow:implementer`,
   with a pointer to the `implement-issue` skill. Log `delegated` and spawn with
   `OTEL_RESOURCE_ATTRIBUTES=issue=<N>,device=$DEV_MACHINE_NAME`. Keep keyword
   talk (`Closes`, `Fixes`) out of briefs.
4. **Verify and merge** when the PR lands (see Merge).
5. **Done by Rollout** (`callum-flow-rollout <N>`): `merge` - the PR closes it
   (on an epic base, follow the merge script's manual closure instruction).
   `run-it` - release on its own, never batched with another `run-it` issue,
   then do the Run it; whoever ran it records the result and closes the issue.
   `keep-open` - the owner closes it.

Whenever you abandon claimed work, log `callum-flow-event abandoned --issue
<N>`; include `--run <id>` and `--branch <b>` when known.

## Upgrading the workspace you run in
To pick up a new image or template on your own workspace, run `dev-restart-self`
(`--restart` forces the scheduled variant). Never `coder restart`, `stop` or `update`
on it: the `forbid-coder-self` hook refuses them. The session resumes after the
restart, so check CronList before re-arming loops.

Delegate only through the named `callum-flow:*` agents, with no `model`
argument: their frontmatter pins the model. If the issue has a `model:<alias>`
label, pass `model: "<alias>"` on every sub-agent call for that issue, later
fixers included. Never delegate ad hoc with `model` omitted. Serialize
conflict-prone work with native `blocked_by`; parallelize only independent work.
How many issues are in flight is your call: independent issues run in parallel,
bounded by the tier and the worktree pool.

## Pipeline events
Each pipeline line is `<state> <branch> <run-id> ... head=<sha>`. Never read a
gate's log or the diff yourself, and never `sleep` or poll a run.
- **`parked`**, or **`failed`** with a failing step (a failed step parks the run
  at an approval gate): the gate is judged, not read.
  1. On a `review` gate only, cap the run at 3 review fix rounds. Count its
     `fix_requested` events with `--note review` in the event log; at 3, give the owner the brief
     URL and the run's `verdict` lines and wait.
  2. Spawn `callum-flow:adjudicator` with the run id, branch, brief URL and the
     parked step. It returns verdict lines and one `ACTION:` line.
  3. Log each verdict: `callum-flow-event verdict --issue <N> --run <id>
     --branch <b> --note "<line>"`.
  4. Do the `ACTION:` line: `no-mistakes axi respond` (`approve`, `fix`, `skip`),
     launched with `run_in_background`, since it blocks like `axi run`. A `fix`
     on `review` also logs `fix_requested ... --note review`. `escalate:` goes to
     the owner. `fixer:` spawns `callum-flow:fixer` with the instructions and the
     brief URL, only when the pipeline cannot write the fix from instructions or the run is done.
     Never pass `--yes`. The `implement-issue` skill says how `respond` and
     `rerun` behave.
- **`failed`** with no log directory (run id `unknown`): an infrastructure
  failure, not a code defect. Check `~/.no-mistakes/logs/daemon.log`, rebase the
  branch and start a fresh `axi run`; no fixer, no adjudicator.
- **`merge-ready`**: run the merge guard, then merge.
- **`head-mismatch`**, **`conflict`**: never merge. Run the guard and follow the
  fix its FAIL line names; for a non-trivial conflict spawn a fixer. A rebase
  keeps BOTH sides of colliding additions.
- **`cancelled`**: re-drive it or drop it. Never resume an old agent.
- **`ci-stalled`**: `reason=no-workflow` - tell the owner the default branch has
  no CI workflow and do not merge; `reason=no-checks` - `gh pr close <pr> && gh
  pr reopen <pr>` once, and if it stalls again tell the owner the workflow
  triggers do not match.

## Merge
`callum-flow-merge-guard <pr>` reads only and prints one `GUARD <name> FAIL
<reason>` line per failed guard, with the fix named in the reason. Act on each,
re-run it, and merge with `callum-flow-merge <pr>` once it prints nothing.
Before merging:
- Read every `no-mistakes(<step>)` fix commit against the issue's requirements:
  a green run can have deleted a requirement and rewritten its tests to match.
- Check the pipeline-built PR body (`implement-issue`, issue linkage).
- On `GUARD linkage FAIL`, run `callum-flow-fix-linkage <pr>` from the main
  checkout and re-run the guard.

A run that sits green without a merge (park-after-green) is yours to merge. If
the harness refuses the merge, give the owner the PR link and the guard output
and carry on: the watchers and the other work do not stop. Release the worktree
after merge as `implement-issue` says.

## Special issue types
- **High-risk or large**: the designer splits it into unlabelled sub-issues;
  wait for the owner to tag each `ready`. If implementation has begun, stop the
  agent before it opens a PR.
- **UI change**: require before/after screenshots (a clip when interactive) on
  the PR.
- **Human-decision gates** (branching strategy, data-loss risk, finalization):
  surface the options and wait for the owner.

## Memory
Read `.claude/orchestrator-memory.md` in the repo's main checkout at the start
of a session, and create it if missing. It holds only this repo's lessons and
state, appended directly in the main checkout (it is notes, not shipped code).
A generic lesson belongs in this plugin, so propose it upstream with
`/update-dev` rather than recording it there.

## Tick report
Output a short report first: ready, in-development and open-PR counts, each
in-flight pipeline, the watchers (`armed`, `idle` or `MISSING`), and the usage
tier with the resume wake id when paused.
