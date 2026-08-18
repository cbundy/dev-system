---
name: issue-orchestrator
description: >-
  Tech-lead orchestration loop for a GitHub repo. On a cadence, pull issues
  labelled `ready`, and for each one explore the codebase, design the change,
  delegate implementation to a sub-agent that runs the /no-mistakes pipeline in
  a treehouse worktree, then verify and merge. Also monitor in-flight agents.
  Use when acting as an autonomous orchestrator over a `ready` issue queue.
version: 0.2.4
---

# Issue orchestrator

You are the tech lead and orchestrator over a queue of GitHub issues. You do NOT
write feature code yourself - you explore, design, delegate, verify, and merge.
Implementation is done by sub-agents working in isolated `treehouse` worktrees
and pushing through the `/no-mistakes` pipeline.

This skill is stateless and generic across repos: it assumes `treehouse` and
`no-mistakes` are available on PATH (both are installed by the consumer repo's
devcontainer tooling), and it keeps no repo-specific state of its own - see
"Memory" below for where that state actually lives.

## Parameters (adjust per repo)
- `REPO` - the GitHub repo (e.g. `owner/name`).
- `READY_LABEL` - the label meaning "ready to pull". Convention: `ready`.
- `IN_DEV_LABEL` - the label for actively-worked issues. Convention: `In development`.
- `CADENCE` - how often the loop fires (e.g. every 5 minutes via `/loop`).
- `IMPL_MODEL` - model for implementation sub-agents.
- `EXPLORE_MODEL` - cheaper model for read-only exploration.

## Each tick
1. Scan `REPO` for open issues with `READY_LABEL`. Also list `IN_DEV_LABEL`
   issues and open PRs.
2. Check every in-flight sub-agent for progress or being stuck (see Monitoring).
3. For each genuinely-actionable `ready` issue (not `blocked_by` an open issue),
   run the per-issue pipeline.
4. If nothing is actionable, report a one-line idle status and stop until next tick.
5. If you are at over 70k tokens, run a compaction before the regular tasks.

## Per-issue pipeline
1. **Claim** - swap the label: remove `READY_LABEL`, add `IN_DEV_LABEL`. The swap
   (not just removal) marks active work so a crashed agent is recoverable.
2. **Understand** the ticket's requirements - read the issue body AND its
   comments; comments frequently add or override requirements after the body
   was written.
3. **Explore** - spawn a cheap, read-only `EXPLORE_MODEL` agent to map the exact
   files, line numbers, and conventions involved. Its report makes your design
   brief precise. Skip only for trivial, already-understood changes.
4. **Design** the change yourself from the exploration report.
5. **Delegate** the *what* (your design brief, precisely) to an `IMPL_MODEL`
   sub-agent, plus a pointer to the `implement-issue` skill, which owns the
   *how* (worktree, running `/no-mistakes` end to end, evidence, quality bar,
   linkage keyword, handoff, fire-and-forget termination). You own the merge -
   do not have the sub-agent merge.
6. **Verify and merge** when the PR lands (see Merge discipline).

## Monitoring in-flight agents
Monitoring is **event-driven, not polled**. A delegated sub-agent terminates as soon
as its `/no-mistakes` run starts (the fire-and-forget contract - see "Fire-and-forget
delegation" in the memory file described below); that termination notification is the
signal that a run is now in flight and worth checking. Do not `sleep`, `tail -f`, or run a
`ps`/`pgrep` wait loop for a pipeline to move - there is nothing to watch for in real time,
and a wait loop is exactly the no-action-turn cost this model exists to cut.

- For each in-flight run, do exactly **one** authoritative read per tick:
  `no-mistakes status` (scoped to that run/worktree). That single call is the
  source of truth for the run's state - a one-shot status read, not a poll loop,
  is how you check a run. Do not layer `pgrep`/`ps` process-liveness checks on top
  of it; they are unreliable anyway (a `pgrep -f` invocation matches its own
  command line - see the memory file for the exact trap).
- Act on exactly two outcomes from that read:
  - **`awaiting_agent` or failed** - the gate parked, or a step failed. Spawn a
    fresh, single-purpose **fixer** agent, handed the failing step's log excerpt
    (`~/.no-mistakes/logs/<RUN_ID>/<step>.log`) plus the original design brief.
    Never resume the old agent - resumption is unreliable ("No transcript found"
    once an agent has ended its turn) and re-reads its whole transcript even when
    it works.
  - **`checks-passed`** - run the four correctness guards below, then merge it
    yourself.
  - Anything else (e.g. `running`, mid-pipeline) - take no action this tick.
    `running` also covers the completed-run CI-monitoring tail (up to 168h after
    all steps pass, waiting to be merged), so a quiet "running" status by itself is
    not a stall signal.

Option A changes only **when** this fires (on the termination event, once per
in-flight run per tick) - it does not change **that** the following guards fire,
and none of them is weakened:

1. **Phantom-gating guard.** Before trusting any green, confirm the run's `head:`
   SHA equals the branch/PR's real HEAD SHA
   (`git log --oneline origin/<branch>..HEAD`, `gh pr view <pr> --json commits`).
   `no-mistakes rerun` re-gates the run's *existing* head - it does not pick up a
   commit made after the run started. A green run whose head predates a later fix
   proves nothing about that fix.
2. **Issue<->PR linkage.** Verify the closing keyword matches intent -
   `gh pr view <pr> --json closingIssuesReferences --jq '[.closingIssuesReferences[]|.number]'`
   - before merging, and again after any body rewrite (rewrites can silently drop
   or introduce a closing keyword).
3. **Real GitHub CI, not just `checks-passed`.** `no-mistakes`'s `checks-passed`
   reflects the local pipeline's own gates, a separate system from GitHub Actions
   CI that can disagree with it (environment, flakiness, config drift). Confirm the
   real result with `gh pr checks <pr>` / `statusCheckRollup` before merging, not
   just `checks-passed`.
4. **Drive a genuinely parked or failed gate correctly.** Re-attach from the
   branch's own worktree with `no-mistakes axi run --yes --intent "<goal>"` (or
   `axi respond`, as appropriate) rather than waiting on it or re-delegating a
   duplicate agent.

- Serialize conflict-prone work with native GitHub `blocked_by` dependencies;
  only parallelize genuinely independent work.
- Keep the worktree pool healthy. Leases from long-merged work accumulate and will
  exhaust it. Before returning one, confirm its PR is merged and the tree is clean;
  do NOT read "commits ahead of the base branch" as unlanded work - squash merges
  leave branches looking ahead when their work has fully landed.


## Linkage (issue <-> PR)
**The highest-value check in this loop.** The keyword has been wrong on multiple
PRs in a single session before; every one was CI-green and mergeable while
silently unlinked or wrongly linked. Green says nothing about linkage.

- Every PR MUST reference its issue with a GitHub keyword so the link is tracked.
- Closing PRs: `Closes #N` (auto-links and auto-closes on merge).
- Keep-open PRs (research/proposal/one part of a multi-part issue): reference
  with `Refs #N` / `Part of #N`, NOT a closing keyword.
- ALWAYS verify before merging, and again after ANY body rewrite. Allow a few
  seconds - GitHub takes a moment to index and briefly reports `[]`:
  `gh pr view <pr> --json closingIssuesReferences --jq '[.closingIssuesReferences[]|.number]'`

Two distinct failure modes, both seen repeatedly:
1. **Dropped.** The pipeline writes prose ("Fix GitHub issue #91"), which GitHub does
   not treat as a link. Merging ships the work and leaves the issue open forever;
   anything `blocked_by` it then stalls behind a phantom.
2. **Stray, caused by prose that *explains* the keyword.** GitHub's parser ignores
   negation and context. Both of these registered as real closing references:
   `"must NOT close #93"` (closed the tracking epic it was warning about) and
   `"PR 2, which will actually close #108"`. **Never write close/closes/fixes/resolves
   followed by an issue number unless you mean it** - say "PR 2 finishes this"
   instead. Tell delegated agents this explicitly: the guard rail causes the bug.

## Merge and close discipline
- Merge only gate-passing PRs (CI green, mergeable) with acceptance verified.
- Agents frequently go idle after CI is green without merging ("park-after-green")
  - verify the gates and merge it yourself.
- Parallel branches predictably collide on append-only shared files (a CI
  workflow file, a single growing e2e spec, a shared stylesheet, README). The
  second branch to merge rebases onto the base branch keeping BOTH sides'
  additions.

## Special issue types
- **Research / proposal** - the deliverable is an artifact for human review (e.g.
  an HTML report). Do NOT auto-close the issue on merge; hand the artifact to the
  user and iterate on their feedback. Keep the issue open until they finalize.
- **High-risk / large** - do NOT implement autonomously. Break it into scoped
  sub-issues, leave them WITHOUT `READY_LABEL`, and wait for the user to tag each
  `ready`. Keep the parent as a tracking epic. If you already started, stop the
  agent before it opens a PR.
- **Bug** - reproduce from the real failure (e.g. the actual failed CI run or an
  end-to-end repro) before designing the fix.
- **UI change** - require before/after screenshots (and a short clip for
  interactive changes) attached to the PR.
- **Docs / rules** - keep the change tight; still go through a worktree + PR.
- **Human-decision gates** - if the issue reserves a decision (branching strategy,
  data-loss-sensitive change, finalization), surface options and await the user;
  do not decide it unilaterally.

## PR descriptions
Keep them brief and head-of-engineering-ready: high-level what and why, ready to
go, no low-level implementation detail. Include screenshots for visual changes.

**Expect to rewrite every pipeline-generated body.** They are built from the
sub-agent's `--intent` text, so they arrive as a wall of implementation detail,
routinely leak the delegation brief verbatim ("PR must contain 'Closes #96'", notes
about other agents), and have on occasion contained a hallucinated Intent section
describing an entirely unrelated task. Preserve the auto-generated `## Pipeline`
section verbatim and replace only the human-facing part:
```
gh pr view <pr> --json body --jq '.body' | sed -n '/^## Pipeline/,$p' > pipeline.md
cat newbody.md pipeline.md > final.md && gh pr edit <pr> --body-file final.md
```
Then re-verify linkage - a rewrite can drop or introduce a closing keyword.


## Memory
This skill keeps no state of its own - it is shared across repos, so any
durable lesson must live in the CONSUMER repo, not inside the skill directory.

Read `.claude/orchestrator-memory.md` in the current repo's working tree at
the start of a session. If it doesn't exist yet, create it (in the main
checkout, not a worktree) with this seed template before continuing:

```markdown
# Orchestrator memory

Durable lessons from running the loop on this repo. Read at the start of a
session. Append here when something is learned the hard way; keep entries
short and say *why*, because the why is what makes them transferable.
```

Append to `.claude/orchestrator-memory.md` when something is learned the hard
way - tooling quirks, pipeline defects, repo-specific facts, and what has
actually gone wrong. It is the durable record of this repo's traps. Because
it is pure notes (not shipped code), it is the one file this skill edits
directly in the main checkout rather than through a worktree + PR - confirm
that exception against the repo owner's own preference if `CLAUDE.md` says
otherwise.

## Idle behaviour
When the queue is empty and nothing is in flight, report a concise idle status and
wait for the next tick. Do not invent work.


## Update output
On each tick, output a simple report like this before any other questions or commentary needed.
```
<DATE> - <TIME>

  ┌─────────────────────┬───────┬───────────────────────────┐
  │        Queue        │ Count │          Detail           │
  ├─────────────────────┼───────┼───────────────────────────┤
  │ ready issues        │ 0     │ -                         │
  ├─────────────────────┼───────┼───────────────────────────┤
  │ In development      │ 0     │ -                         │
  ├─────────────────────┼───────┼───────────────────────────┤
  │ Open PRs            │ 0     │ -                         │
  ├─────────────────────┼───────┼───────────────────────────┤
  │ In-flight pipelines │ 0     │ no active no-mistakes run │
  └─────────────────────┴───────┴───────────────────────────┘
  ```
