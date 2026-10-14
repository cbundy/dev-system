# Factory loop: testbed run 2

Stage D of the [factory loop conversion](https://github.com/cbundy/dev-system/issues/521), second
run, on the private testbed `cbundy/dev-system-testbed` on 2026-10-13. The loop ran in act mode in
the `spike-reconcile-mod` workspace from 22:44 UTC until you cancelled it at 23:51 UTC.

## Headline

- **9 of 12 issues merged in 67 minutes**, with no hand fixes to the testbed. The three left at
  cancel were conflict-pair losers and the keep-open research issue.
- **Throughput issues flowed**: each one merged 2 to 5 minutes after its PR opened.
- **Conflict losers waited on loop bugs**, not on the conflicts: the fixer resolved each conflict,
  but a missing re-guard and worktrees the pipeline left behind kept them parked.
- **Six bugs found, all filed** in milestone "loop rewrite v0.1"; one was fixed live.

## Setup

- **Issues**: 12, [#30](https://github.com/cbundy/dev-system-testbed/issues/30) to
  [#41](https://github.com/cbundy/dev-system-testbed/issues/41), under tracker
  [#42](https://github.com/cbundy/dev-system-testbed/issues/42). Three conflict pairs that change
  the same lines of `src/slugify.js` (A: [#30](https://github.com/cbundy/dev-system-testbed/issues/30) and [#32](https://github.com/cbundy/dev-system-testbed/issues/32), B: [#34](https://github.com/cbundy/dev-system-testbed/issues/34) and [#36](https://github.com/cbundy/dev-system-testbed/issues/36), C: [#38](https://github.com/cbundy/dev-system-testbed/issues/38) and [#40](https://github.com/cbundy/dev-system-testbed/issues/40)) and six
  throughput issues in their own new files, the numbers alternating between the two kinds.
- **Settings**: at most 5 issues in flight, rate caps lifted, control `only: [42]`.
- **Plugin**: build 85849bf at the start, hot-reloaded at 23:11:54 to 53d1fbe, which carried the
  parser fix for [#546](https://github.com/cbundy/dev-system/issues/546). That was the only live
  code change.
- **One config change**, at 23:36 and approved by you: guard expiry cut from 30 minutes to 3, to
  work around [#550](https://github.com/cbundy/dev-system/issues/550).

## Results

| Issue | Kind | Claimed | PR | Merged |
|---|---|---|---|---|
| [#30](https://github.com/cbundy/dev-system-testbed/issues/30) | conflict A | 22:45:16 | [45](https://github.com/cbundy/dev-system-testbed/pull/45) | 23:37:38 |
| [#31](https://github.com/cbundy/dev-system-testbed/issues/31) | throughput | 22:45:23 | [43](https://github.com/cbundy/dev-system-testbed/pull/43) | 22:51:58 |
| [#32](https://github.com/cbundy/dev-system-testbed/issues/32) | conflict A | 22:45:28 | [44](https://github.com/cbundy/dev-system-testbed/pull/44), [50](https://github.com/cbundy/dev-system-testbed/pull/50), [57](https://github.com/cbundy/dev-system-testbed/pull/57) | not merged |
| [#33](https://github.com/cbundy/dev-system-testbed/issues/33) | throughput | 22:45:34 | [48](https://github.com/cbundy/dev-system-testbed/pull/48) | 23:16:31 |
| [#34](https://github.com/cbundy/dev-system-testbed/issues/34) | conflict B | 22:46:16 | [46](https://github.com/cbundy/dev-system-testbed/pull/46) | 23:21:54 |
| [#35](https://github.com/cbundy/dev-system-testbed/issues/35) | throughput, run-it | 22:52:17 | [47](https://github.com/cbundy/dev-system-testbed/pull/47) | 23:02:18 |
| [#36](https://github.com/cbundy/dev-system-testbed/issues/36) | conflict B | 22:52:29 | [53](https://github.com/cbundy/dev-system-testbed/pull/53) | 23:38:10 |
| [#37](https://github.com/cbundy/dev-system-testbed/issues/37) | throughput, docs | 23:17:01 | [49](https://github.com/cbundy/dev-system-testbed/pull/49) | 23:24:47 |
| [#38](https://github.com/cbundy/dev-system-testbed/issues/38) | conflict C | 23:24:16 | [56](https://github.com/cbundy/dev-system-testbed/pull/56) | 23:48:42 |
| [#39](https://github.com/cbundy/dev-system-testbed/issues/39) | throughput | 23:24:26 | [51](https://github.com/cbundy/dev-system-testbed/pull/51) | 23:30:00 |
| [#40](https://github.com/cbundy/dev-system-testbed/issues/40) | conflict C | 23:30:10 | [54](https://github.com/cbundy/dev-system-testbed/pull/54), [58](https://github.com/cbundy/dev-system-testbed/pull/58) | not merged |
| [#41](https://github.com/cbundy/dev-system-testbed/issues/41) | throughput, keep-open | 23:30:24 | [55](https://github.com/cbundy/dev-system-testbed/pull/55), [59](https://github.com/cbundy/dev-system-testbed/pull/59) | not merged |

- **9 merged**, 3 open at cancel. Throughput issues merged within minutes of their PR. [#33](https://github.com/cbundy/dev-system-testbed/issues/33) took
  31 minutes because of [#546](https://github.com/cbundy/dev-system/issues/546); the other merged
  throughput issues went from claim to merge in 5 to 10 minutes.
- **Paths exercised**: the conflict fixer with a re-gate onto a `-v2` branch, owner decisions sent
  through Remote Control ([#36](https://github.com/cbundy/dev-system-testbed/issues/36) and [#37](https://github.com/cbundy/dev-system-testbed/issues/37)), a run-it rollout ([#35](https://github.com/cbundy/dev-system-testbed/issues/35)), and an owner `/factory retry` ([#33](https://github.com/cbundy/dev-system-testbed/issues/33)).
- **Passes**: 164, all executed. A quiet pass took 4 to 6 seconds; one with guards or merges 12 to
  17 seconds.

## Findings

Each has its own issue in milestone "loop rewrite v0.1".

1. **Prose before a verdict voided an adjudicator's reply**
   ([#546](https://github.com/cbundy/dev-system/issues/546)). A reply whose prose opened with a
   verdict word was refused, so [#33](https://github.com/cbundy/dev-system-testbed/issues/33) stuck until two retries. Fixed live at 23:11:54.
2. **The in-flight cap overshot to 6 of 5**
   ([#547](https://github.com/cbundy/dev-system/issues/547)). When [#31](https://github.com/cbundy/dev-system-testbed/issues/31) merged, one slot opened and
   two issues were claimed in the next passes, because a fresh claim did not count until observed.
3. **A run 1 wake blocked every wake from 22:44 to 23:01**
   ([#549](https://github.com/cbundy/dev-system/issues/549)). Run 1's reset cleared the store, so
   the first pass rebuilt the ledger from the event log, which brought back an unanswered run 1
   wake. No new wake could start for 17 minutes.
4. **No re-guard after a repair that made no commit**
   ([#550](https://github.com/cbundy/dev-system/issues/550)). PRs then waited out the 30-minute
   guard expiry. The issue now also covers judging each failure once and a 5-minute expiry.
5. **Pipeline commits left the worktree behind**
   ([#551](https://github.com/cbundy/dev-system/issues/551)). The guard's head check then failed,
   which cost a judge wake and a fixer each time, six times or more.
6. **Superseded PRs were never closed**
   ([#553](https://github.com/cbundy/dev-system/issues/553)). Each re-gate opened a new PR and left
   the old one open: 9 open PRs for 4 live issues at the peak, one of them for an issue already
   merged.

Two improvements came out of the run too: agents answering through a validated tool rather than
parsed text ([#548](https://github.com/cbundy/dev-system/issues/548)), and a trace mode with timing
for each pass and its phases ([#552](https://github.com/cbundy/dev-system/issues/552)).

**A false alarm on the first pass**: it showed run 1 ghosts (issues still being worked, wakes
open) and the tracker not yet expanded into its issues. Both cleared on the second pass, except the one
ghost wake in finding 3.

## Evidence

Archived in the workspace at `/persist/claude/factory-loop-build-testbed-run2/`: the loop's
decision log and run files, the store, the session transcripts, the factory events, the PRs and
the pipeline runs. The testbed was then reset to its pre-run state for run 3.
