# Factory loop: testbed runs 4 and 5

Stage D of the [factory loop conversion](https://github.com/cbundy/dev-system/issues/521), on the
private testbed `cbundy/dev-system-testbed` on 2026-10-14, on the "loop rewrite v0.1" build at
06e6a11 (feat/factory-loop). Both runs used run 3's twelve issues, so the three compare directly.

## Headline

- **Run 5 merged all 12 issues in 45 minutes** (claims from 09:35, last merge 10:18 UTC). The first
  ten merged in 13 minutes (09:42 to 09:55); the last two waited on owner answers that came
  through the loop, not around it.
- **Every agent answer came through the answer script** ([#561](https://github.com/cbundy/dev-system/issues/561)):
  52 of 52 in run 5 and 48 of 48 in run 4. No text fallback, no repair, no unreadable reply.
  Unreadable replies had been the most frequent failure in runs 1 to 3.
- **Worktrees go back** ([#563](https://github.com/cbundy/dev-system/issues/563)): 13 returned in
  run 5, one per finished issue. The pool never ran short, even with 10 issues in flight.
- **The environment re-run worked live** ([#537](https://github.com/cbundy/dev-system/issues/537)):
  a push GitHub rejected was escalated, the owner resumed it, the loop re-ran the step itself and
  the PR merged.
- **An owner decision went end to end**: a merge review held a PR on a real conflict between two
  issues' acceptance criteria; the owner's note and resume reached the loop, a fixer applied the
  decision, and the PR merged.

## Run 4 (09:00 to 09:30 UTC), stopped

Run 4 used the old in-flight limit of 5. After 23 minutes it had merged 4 issues, every answer had
come through the script and 6 worktrees had gone back. It was stopped because Codex, the only agent
the testbed's pipeline used, hit its usage limit and the remaining runs failed on it one by one.
The testbed's synced `.no-mistakes.yaml` came from callum-dev 0.7.1 and pinned `agent: codex`,
overriding the fleet-wide `[codex, claude]` fallback. The pin was removed, the testbed was reset
to a new reset point, `50d813d` (the old reset point plus that one change), and the in-flight
limit was raised to 10 for run 5.

## Run 5 setup

- **Issues**: [#112](https://github.com/cbundy/dev-system-testbed/issues/112) to
  [#123](https://github.com/cbundy/dev-system-testbed/issues/123) under tracker
  [#124](https://github.com/cbundy/dev-system-testbed/issues/124): three conflict pairs on the same
  lines of `src/slugify.js` and six throughput issues in their own files, alternating, as in run 3.
- **Settings**: at most 10 issues in flight, rate caps lifted, trace mode on, answer channel
  `script` (the default).
- **Plugin**: 06e6a11, loaded fresh with a session restart before the run.

## Run 5 results

| PR | Merged (UTC) | Note |
|---|---|---|
| [#125](https://github.com/cbundy/dev-system-testbed/pull/125) | 09:42 | |
| [#127](https://github.com/cbundy/dev-system-testbed/pull/127) | 09:43 | |
| [#126](https://github.com/cbundy/dev-system-testbed/pull/126), [#128](https://github.com/cbundy/dev-system-testbed/pull/128) | 09:44 | |
| [#129](https://github.com/cbundy/dev-system-testbed/pull/129), [#132](https://github.com/cbundy/dev-system-testbed/pull/132) | 09:46 | |
| [#131](https://github.com/cbundy/dev-system-testbed/pull/131) | 09:48 | run-it rollout |
| [#134](https://github.com/cbundy/dev-system-testbed/pull/134) | 09:50 | |
| [#135](https://github.com/cbundy/dev-system-testbed/pull/135) | 09:52 | conflict loser, rebased to `-v2` |
| [#136](https://github.com/cbundy/dev-system-testbed/pull/136) | 09:54 | keep-open research |
| [#138](https://github.com/cbundy/dev-system-testbed/pull/138) | 10:07 | issue 120, after the owner's decision |
| [#139](https://github.com/cbundy/dev-system-testbed/pull/139) | 10:18 | issue 116, after the environment re-run |

- **77 passes.** Actions: 12 claims, 12 delegations, 40 spawns, 12 merges, 24 guards, 4
  fast-forwards, 13 worktree returns, 3 superseded PRs closed, 3 linkage repairs, 9 gate responses,
  2 judge wakes, 1 environment re-run.
- **Pass time**: median 17.7 s, p90 36.7 s (run 3: 13.7 s and 25 s). With twice the issues in
  flight there is more to read each pass; the pipeline watcher still takes a median 8.2 s of it
  ([#562](https://github.com/cbundy/dev-system/issues/562)).

## The two owner calls

- **Issue 116: a rejected push.** The pipeline's push of a correct change was rejected by GitHub
  with no reason, and the branch never reached the testbed. The adjudicator judged it `ENV` and
  escalated. The owner resumed it at 10:10; the loop ran `env-retry` on the same head, the push went
  through, and PR #139 merged at 10:18. The cause of the first rejection is unknown; it did not
  recur.
- **Issue 120: contradictory criteria.** Pair C's two issues contradicted each other: one makes
  `slugify([1])` valid array input, the other's test expects `[1]` to be refused with "got array".
  This was a flaw in the test issues, not the loop. The merge review held the PR instead of
  guessing (`merge-hold`); the owner approved changing that test at 09:59 with `/factory note` and
  resumed; the next review asked a fixer for exactly that, and PR #138 merged at 10:07.

## Compared with earlier runs

| Run | Build | In flight | Merged | Time to merge all that merged | Answers unreadable |
|---|---|---|---|---|---|
| 1 | stage C | 5 | 5 of 8 | 75 min | several |
| 2 | v0.1 start | 5 | 9 of 12 (cancelled) | 67 min | several |
| 3 | v0.1 | 5 | 12 of 12 (2 after a retry) | 47 min for 10, then stuck | 3 merge reviews |
| 5 | v0.1 final | 10 | 12 of 12 | 13 min for 10, 45 min for all | none |

## Still open

- The testbed's other synced files are still from callum-dev 0.7.1 (PR template, `CLAUDE.md`,
  permissions). Only the Codex pin was fixed. A full `callum-dev update`, made the new reset
  point, would make the testbed match a real repo.
- The registered answer tools stay off until Claude Code lets timer-spawned agents reach a
  plugin's own `tool.call` hook ([#560](https://github.com/cbundy/dev-system/issues/560); the probe
  in `docs/factory-loop/probes/timer-spawn-probe/` shows when).

Evidence is archived in the testbed workspace at `/persist/claude/factory-loop-build-testbed-run4/`
and `/persist/claude/factory-loop-build-testbed-run5/`.
