# Factory loop: testbed run 6

Stage D of the [factory loop conversion](https://github.com/cbundy/dev-system/issues/521), sixth
and last run, on the private testbed `cbundy/dev-system-testbed` on 2026-10-14, on the "loop
rewrite v0.1" build at 8857e13 (the same code as run 5). This run's question was whether the loop
holds up on a testbed that matches a real consumer: the testbed was first updated to dev-system's
0.35.0 templates (`callum-dev update`, new reset point `1d1fd18`).

## Headline

- **9 of 12 issues merged.** Five merged in the first 13 minutes (claims at 10:40, merges 10:48
  to 10:53), two more at 11:00 and the last two at 11:21 and 11:22, after a usage pause.
- **The last three are not loop bugs.** Each was escalated to the owner, as it should be: a scope
  question, and two no-mistakes failures, now filed
  ([#492](https://github.com/cbundy/dev-system/issues/492) and
  [#571](https://github.com/cbundy/dev-system/issues/571)).
- **Usage tiering worked live for the first time.** As the five-hour usage window filled, the
  loop slowed (10:43), stopped starting new work (10:53) and paused entirely (11:01). It resumed
  by itself at 11:20 and finished what it could.
- **Every agent answer came through the answer script**
  ([#561](https://github.com/cbundy/dev-system/issues/561)): 61 of 61, with no repair message and
  no unreadable reply, as in run 5.
- **The kill switch stopped it cleanly** at 13:28: the next pass skipped its actions with "kill
  switch".

## Setup

- **Issues**: [#140](https://github.com/cbundy/dev-system-testbed/issues/140) to
  [#151](https://github.com/cbundy/dev-system-testbed/issues/151) under tracker
  [#152](https://github.com/cbundy/dev-system-testbed/issues/152), the same twelve as runs 3 and
  5: three conflict pairs on the same lines of `src/slugify.js` and six throughput issues in
  their own files, alternating.
- **Testbed**: updated from callum-dev 0.7.1 to 0.35.0, so its PR template, `CLAUDE.md`,
  permissions and `.no-mistakes.yaml` are the ones a real consumer has today.
- **Settings**: at most 10 issues in flight, rate caps lifted, trace mode on, answer channel
  `script` (the default).

## Results

| PR | Merged (UTC) | Note |
|---|---|---|
| [#154](https://github.com/cbundy/dev-system-testbed/pull/154) | 10:48 | |
| [#157](https://github.com/cbundy/dev-system-testbed/pull/157) | 10:49 | |
| [#155](https://github.com/cbundy/dev-system-testbed/pull/155) | 10:51 | |
| [#159](https://github.com/cbundy/dev-system-testbed/pull/159) | 10:52 | |
| [#161](https://github.com/cbundy/dev-system-testbed/pull/161) | 10:53 | |
| [#163](https://github.com/cbundy/dev-system-testbed/pull/163), [#165](https://github.com/cbundy/dev-system-testbed/pull/165) | 11:00 | #163 is the run-it rollout |
| [#164](https://github.com/cbundy/dev-system-testbed/pull/164) | 11:21 | conflict loser, rebased |
| [#166](https://github.com/cbundy/dev-system-testbed/pull/166) | 11:22 | conflict loser, rebased |

- **204 passes.** Actions: 12 claims, 12 delegations, 49 spawns, 9 merges, 32 guards, 15
  fast-forwards, 11 worktree returns, 4 superseded PRs closed, 14 gate responses, 3 judge wakes,
  1 run-it task, 3 escalations.
- **Pass time**: median 10.8 s, p90 24.4 s. The median is lower than run 5's because two hours of
  the run were idle passes waiting on the owner.

## The three escalations

- **Issue 148, a scope call.** The change made two docs outside the brief's files stale
  (`docs/api.md` and a JSDoc comment). The documentation gate's adjudicator judged widening the
  scope to be the owner's call and escalated rather than guess. The owner chose not to answer it
  this time; the loop keeps its worktrees while it waits.
- **Issue 150, a no-mistakes PR body failure.** GitHub rewrites control characters in a stored
  PR body, and no-mistakes embeds evidence verbatim and then byte-compares the body it sent with
  the one GitHub stored. The root cause is on
  [#492](https://github.com/cbundy/dev-system/issues/492). The setting that avoids it needs
  no-mistakes 1.95 or later, and the base image carries 1.84
  ([#572](https://github.com/cbundy/dev-system/issues/572)).
- **Issue 151, a no-mistakes run that aborted itself.** The implementer added a
  `Co-Authored-By` trailer; no-mistakes' fixer amended the commit to drop it, and no-mistakes'
  own descendant check then aborted the run
  ([#571](https://github.com/cbundy/dev-system/issues/571)).

## What run 6 adds to run 5

- The loop works unchanged on a consumer with current templates.
- Usage tiering slows, stops new work and pauses as the usage window fills, lets merges already
  in flight finish (two merged under "stop new work"), and resumes by itself.
- An idle loop with only owner escalations left stays quiet, keeps its leases and heartbeats,
  and stops on the kill switch.

Evidence is archived in the testbed workspace at `/persist/claude/factory-loop-build-testbed-run6/`
(decision log, trace, store, session and agent transcripts, configs).
