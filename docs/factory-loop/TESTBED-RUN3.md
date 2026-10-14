# Factory loop: testbed run 3

Stage D of the [factory loop conversion](https://github.com/cbundy/dev-system/issues/521), third
run, on the private testbed `cbundy/dev-system-testbed` on 2026-10-14, on the "loop rewrite v0.1"
build. The loop ran in act mode in the `spike-reconcile-mod` workspace from 05:02 UTC, unattended
overnight, after a false start at 04:12.

## Headline

- **All 12 issues merged.** 10 merged in the first 47 minutes (05:11 to 05:49) with no hands on
  the run. The last 2 were stuck on a merge-review bug, and merged within a minute of a retry at
  07:26 once the fix was loaded.
- **Faster and smoother than run 2** (9 of 12 in 67 minutes) and run 1 (5 in 75 minutes). Conflict
  losers no longer waited 30 minutes for a guard to expire, and no fixer was needed for a worktree
  the pipeline left behind.
- **The v0.1 fixes worked live**: worktree fast-forward, closing superseded PRs, keeping the main
  checkout current, judging a guard failure once, and the run-it and keep-open rollouts.
- **Six new bugs found and fixed** ([#556](https://github.com/cbundy/dev-system/issues/556) to
  [#561](https://github.com/cbundy/dev-system/issues/561)), including a Claude Code engine bug that
  stops the loop's agents from reaching its registered answer tools.

## Setup

- **Issues**: 12, [#60](https://github.com/cbundy/dev-system-testbed/issues/60) to
  [#71](https://github.com/cbundy/dev-system-testbed/issues/71), under tracker
  [#72](https://github.com/cbundy/dev-system-testbed/issues/72). As in run 2: three conflict pairs
  on the same lines of `src/slugify.js` (A: [#60](https://github.com/cbundy/dev-system-testbed/issues/60)
  and [#62](https://github.com/cbundy/dev-system-testbed/issues/62), B:
  [#64](https://github.com/cbundy/dev-system-testbed/issues/64) and
  [#66](https://github.com/cbundy/dev-system-testbed/issues/66), C:
  [#68](https://github.com/cbundy/dev-system-testbed/issues/68) and
  [#70](https://github.com/cbundy/dev-system-testbed/issues/70)) and six throughput issues in their
  own new files, alternating. Every issue said exactly how to keep both sides of a conflict, so
  none needed an owner decision, and none asked for one.
- **Settings**: at most 5 issues in flight, rate caps lifted, trace mode on, control `only: [72]`.
- **Plugin**: c30b697 (feat/factory-loop) from 05:02. Reloaded at 07:24 to 694dcb7 for the retry
  of the last two issues; nothing else changed during the run.

## The false start (04:12)

The first start, on 2792329, acted on run 2's closed issues: run 2's failed pipeline runs were
still listed by no-mistakes, and the loop never checked whether their issues were still open. Its
first pass started an adjudicator for issue 41 and a fixer for issue 40, which leased a worktree
and began writing a test. I put the kill switch back on and restarted the session to stop both
agents; nothing reached GitHub. The fix is
[#556](https://github.com/cbundy/dev-system/issues/556): an issue closed on GitHub is finished.
The same start showed the kill switch only took effect between passes: claims for 61, 62 and 63
landed in the 15 seconds after it was set
([#557](https://github.com/cbundy/dev-system/issues/557)). Issues 60 to 63 kept the claims from
that start.

## Results

| PR | Issue | Kind | Merged (UTC) |
|---|---|---|---|
| [#74](https://github.com/cbundy/dev-system-testbed/pull/74) | 62 | conflict A, first | 05:11 |
| [#77](https://github.com/cbundy/dev-system-testbed/pull/77) | 63 | throughput | 05:11 |
| [#79](https://github.com/cbundy/dev-system-testbed/pull/79) | 60 | conflict A, rebased to `-v2` | 05:20 |
| [#81](https://github.com/cbundy/dev-system-testbed/pull/81) | 65 | throughput, run-it | 05:23 |
| [#82](https://github.com/cbundy/dev-system-testbed/pull/82) | 66 | conflict B, rebased to `-v2` | 05:26 |
| [#83](https://github.com/cbundy/dev-system-testbed/pull/83) | 67 | throughput, docs | 05:30 |
| [#84](https://github.com/cbundy/dev-system-testbed/pull/84) | 68 | conflict C | 05:34 |
| [#86](https://github.com/cbundy/dev-system-testbed/pull/86) | 69 | throughput | 05:36 |
| [#85](https://github.com/cbundy/dev-system-testbed/pull/85) | 64 | conflict B, rebased to `-v2-v2` | 05:39 |
| [#87](https://github.com/cbundy/dev-system-testbed/pull/87) | 70 | conflict C | 05:49 |
| [#73](https://github.com/cbundy/dev-system-testbed/pull/73) | 61 | throughput | 07:27, after retry |
| [#89](https://github.com/cbundy/dev-system-testbed/pull/89) | 71 | research, keep-open, `-v2` | 07:27, after retry |

- **Rollouts**: the run-it issue (65) got its Run it task and is closed; the keep-open research
  issue (71) stayed open after its PR merged, as it should.
- **129 passes** from 05:02. Actions: 59 agent spawns, 12 delegations, 11 merges, 47 guards, 13
  fast-forwards, 15 main-checkout updates, 5 superseded PRs closed, 17 gate responses, 3 judge
  wakes, 1 task, 10 notices.

## What the v0.1 fixes did live

- **Worktree fast-forward** ([#551](https://github.com/cbundy/dev-system/issues/551)): 13
  fast-forwards. 11 times a PR failed the guard only because the pipeline's own commits left its
  worktree behind, and the loop moved the worktree and guarded again within a minute, with no
  judge and no fixer. Twice it refused (the worktree had diverged) and sent the case to the judge,
  as designed; both PRs merged soon after.
- **Re-guard after a repair, judge once** ([#550](https://github.com/cbundy/dev-system/issues/550)):
  no PR waited for a guard to expire.
- **Superseded PRs closed** ([#553](https://github.com/cbundy/dev-system/issues/553)): 5 old PRs
  closed with a link to their replacement, each once the new PR existed.
- **Main checkout kept current** ([#555](https://github.com/cbundy/dev-system/issues/555)): 9
  updates, one after each merge.
- **Trace mode** ([#552](https://github.com/cbundy/dev-system/issues/552)): one record per pass,
  658 KB for the run. Passes took a median of 13.7 s (p90 25 s). Observing took 8.9 s of that, and
  8.0 s was the pipeline watcher alone, filed as
  [#562](https://github.com/cbundy/dev-system/issues/562) for after v0.1. Triggers: 58 agent
  finishes, 54 timer, 12 wakes, 1 first pass.

## Findings

All are in milestone "loop rewrite v0.1" and fixed on feat/factory-loop, each with tests and an
adversarial review.

- **[#556](https://github.com/cbundy/dev-system/issues/556) An issue closed on GitHub is
  finished.** See the false start. Observe now reads the state of every issue the loop acts on or
  counts as live; closed issues take no slot and get no work.
- **[#557](https://github.com/cbundy/dev-system/issues/557) The kill switch stops a pass between
  actions**, not only at the start of the next pass.
- **[#558](https://github.com/cbundy/dev-system/issues/558) Tool calls answered before the engine's
  hook deadline.** The engine gives each hook 10 s; the loop's tool handlers waited in its hook
  queue. Fixed, but it was not the main cause of the failures below.
- **[#559](https://github.com/cbundy/dev-system/issues/559) A merge review's notes and repair.**
  Three merge reviews (PRs 73, 80 and 89) gave a sound `merge`, then added a "Checks:" section the
  parser refused. The repair message that should have saved them was refused by the engine,
  because the loop hides its own agent types and the engine will only resume a type it offers.
  Both fixed; the retry at 07:26 proved it.
- **[#560](https://github.com/cbundy/dev-system/issues/560) The engine bug.** Every one of the 80
  or so answer-tool calls failed with "no tool.call hook answered". A probe mod reproduces it on
  Claude Code 2.1.296 and 2.1.299: an agent spawned by `$.agent.spawn` from a `$.clock` callback
  never reaches the plugin's own `tool.call` hook, while the same spawn inside a `command.run` hook
  works. The loop's passes run from its timer, so every loop agent is affected. Until the engine
  is fixed the loop asks for text. Finished agents now also show as `idle` on 2.1.299, which the
  loop now reads as ended.
- **[#561](https://github.com/cbundy/dev-system/issues/561) The answer script.** A checked script
  the agents run through Bash, which the engine bug does not touch, as a marked workaround for the
  registered tools.

## Not yet proven

- The answer script ([#561](https://github.com/cbundy/dev-system/issues/561)) on the testbed.
- The closed-issue rules ([#556](https://github.com/cbundy/dev-system/issues/556)) across a whole
  run, beyond the restart that proved the first pass.
- An owner decision through Remote Control on this build (no issue asked for one).
- The environment-failure rerun ([#537](https://github.com/cbundy/dev-system/issues/537)): no
  environment failure happened.

Evidence is archived in the testbed workspace at `/persist/claude/factory-loop-build-testbed-run3/`
(decision log, trace, store, session and agent transcripts, configs).
