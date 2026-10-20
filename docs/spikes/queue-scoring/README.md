# Queue scoring spike

Raw notes and probe for the queue scoring epic ([#992](https://github.com/cbundy/dev-system/issues/992)).
The write-up with the charts is the
[Factory queue scoring proposal](https://claude.ai/code/artifact/f4340cc1-6f02-49f5-9c2e-743ef82476f4).

## Question

Would a deterministic score order the ready queue better than today's rule (the owner's `priority`
list, then lowest issue number)?

## Method

- The last 30 issues claimed in cbundy/dev-system, 09:40 to 17:08 UTC on 2026-10-18, from
  `factory.events` (`claims.csv`: first `ready` and first `claimed` per issue).
- Issue facts from `callum-flow-issue-read --json` and `--timeline`: labels, blocked-by and
  blocking links, sub-issue parents and when each closed. `facts.json` snapshots exactly what the
  replay used, so it can run again without GitHub.
- An issue counts as claimable at the later of its `ready` time and its last blocker's close,
  capped at its real claim time.
- The size factor used each merged PR's changed lines as a stand-in for a designer estimate.
  The owner later dropped size from the score (see Results). Factory health was judged from the
  titles.
- Two replays in `probe.js`:
  1. **Real day.** At each real claim moment, take the highest-scoring issue that was claimable
     then (`result-real-day.json`: actual place, proposed place, score and factors).
  2. **All ready at once.** Drain all 30 one at a time, blockers respected, under today's rule
     and under the score (`result-all-ready.json`: the two orders).

`probe.js` was run from `/tmp` against the fetched issue JSON; its paths point there.

`result-this-score.json` pins the "all ready at once" order the shipped score (`plugins/factory-loop/hooks/v2/score.ts`, default weights, no size factor) gives; `tests/factory-loop-score-backtest.test.js` drains `facts.json` with the real code and compares it to this file and to `result-all-ready.json`.

## Results

- Today's order rarely holds work up: 28 of 30 issues were claimed within 5 minutes of becoming
  claimable, and none waited more than 17 minutes. In the real-day replay, the score only swapped
  three pairs of neighbours.
- When work queues, the score brings bugs forward: average place 12.4 under today's rule against
  5.0 with the score. The three factory-health bugs the owner had not pinned moved from places
  22, 23 and 30 to places 4 to 6.
- Size pulls against finishing epics: the factory-events epic finished at place 23 instead of 8,
  because its XL child was pushed back. The owner dropped the size factor.
- The designer runs after the claim, so a designer stamp cannot inform the order. Facts that need
  judgement (area, an open owner decision, touched paths) need an intake step before the claim
  ([#995](https://github.com/cbundy/dev-system/issues/995)).
