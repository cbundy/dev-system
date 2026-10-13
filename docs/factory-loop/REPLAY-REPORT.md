# Factory loop: replay against the live orchestrator

Phase 2 of the [conversion brief](https://github.com/cbundy/dev-system/blob/spike/reconcile-mod/spikes/reconcile-mod/CONVERSION-BRIEF.md).
`scripts/factory-loop-replay.js` rebuilds the factory's state at past moments and runs `plan()`
on it, then compares what the loop would have done with what the live dev-system orchestrator
did next. Raw results are in [`replay/`](replay/): `comparison.json` per window, and every
sample's plan in `replay.json.gz`.

## Headline

Every live decision the event log can show was matched by the loop, or the difference has a
named cause. On a normal evening the loop matched 24 of the orchestrator's 35 decisions:
- **matched:** every adjudication, heartbeat and merge, and 5 of 7 claims;
- **unmatchable:** the other 11 are either invisible in the log (what a designer returned) or
  judgment the loop leaves to agents and the model.

Beyond sweeps, which the log can't show when nothing changes, it proposed one thing the
orchestrator didn't do: claim #467 and #468, ready and unblocked all evening. The orchestrator
missed them, and still has (see [Corrections](#corrections-2026-10-13)). In the morning drain,
run under your directives, the loop matched all 7 merge flows, 13 of 15 adjudications and 2 of 3
heartbeats. Its extra proposals were the directives the replay could not encode, blind spots of
the event log, and the live orchestrator's renewal gaps.

The replay drove six changes to the plan and the reader, and a second look on 2026-10-13 found
three faults in the harness and one more gap in the plan. All are fixed and tested (listed below).

## How it works

For each sample time `t` (every 2 or 3 minutes, one and twenty seconds before each live decision,
and five seconds after each issue joins the queue):

- **factory**: `callum-flow-factory-state --at t --github off`, byte for byte as of `t`;
- **events**: the event log up to `t`, giving the facts (briefs, review rounds, verdicts) and a
  ledger derived from the orchestrator's own events (`derive.ts`, SPEC 7.5);
- **GitHub**: each candidate issue's timeline through `callum-flow-issue-read --timeline`,
  replayed to `t`: labels, open blockers (with each blocker's closing time) and sub-issues;
- **usage**: the orchestrator's own `usage` event nearest before `t`;
- **pool**: 16 slots less the issues it held in implementation; **control**: as given per window.

A live decision counts as matched when some sample in the hour before it planned the same thing:
the same claim, an adjudicator for the same run (planned after that park), or the merge flow
(guard) for the same PR. A heartbeat matches when the loop planned one in the five minutes
before, or would have in the two minutes after.

## Window 1: 2026-10-12, 18:30 to 20:50 UTC, normal operation

Your memory file records no directive in force: you labelled new issues `ready` and the
orchestrator worked them. 140 samples, 35 live decisions.

| Decision | Live | Matched | Lead (median) |
|---|---|---|---|
| adjudicate a parked gate | 8 | 8 | 0 to 1 min |
| heartbeat | 6 | 6 | within 30 s of each |
| merge flow (guard, then merge) | 5 | 5 | the loop starts at merge-ready; the merge came after CI |
| claim | 7 | 5 | 0 to 1 min |
| delegate | 6 | not comparable | |
| review fix, run-it closure | 3 | not comparable | |

The two claims the loop would not have made then:

- **#498 at 18:50:** usage was 85% (Slow). The orchestrator claimed 6 minutes after its last claim.
  The loop waits 10 (`slowGapMs`, DECISIONS D-07), so it would have claimed about 4 minutes later.
  In the same Slow stretch the orchestrator spaced claims 4 and 6 minutes apart.
- **#406 at 19:20:** it had two open blockers. The orchestrator claimed it anyway, to keep a
  run-it issue whose release was due from being dispatched again (memory file, 2026-10-12). That
  is judgment the loop does not copy: a blocked issue is not actionable (SKILL:30-31). You would
  say it with a `/loop priority` or `skip` directive.

Not comparable from the log: a designer's return is not logged, so the replay cannot see when a
brief is ready. In every sample between a claim and its delegation, the loop correctly waited:
it never planned a second designer. Review fixes follow from the adjudicator's `ACTION`, and the
run-it closure was the model's Run it.

Planned with no live decision:
- **two sweeps.** The sweep logs only what it changes, so a sweep that found nothing leaves no
  trace to compare;
- **claims of #467 and #468**, from 18:30 on. Both were labelled `ready` at 04:53 while blocked by
  #466, which closed at 14:04. The orchestrator ran idle that evening, with only its label
  watcher (memory file, v0.34.0 entry), so it claimed what you labelled after 18:30 and never
  re-read the queue. The loop reads it every two minutes. Both are still unclaimed.

## Window 2: 2026-10-12, 09:30 to 14:30 UTC, your morning drain

Control given: no new work. Your memory file also records issues paused at 06:45 and drained one
at a time in a fixed order from 08:50, with #476 made top priority mid-drain; the replay could not
encode that changing pause list. 173 samples, 40 live decisions.

| Decision | Live | Matched |
|---|---|---|
| merge flow | 7 | 7 |
| adjudicate | 15 | 13 |
| heartbeat | 3 | 2: the orchestrator renewed at 13:35, 15 minutes after its 13:20 renewal |
| claim (#476) | 1 | 0: you prioritized it mid-drain; the replay held "no new work" |

**The two missed adjudications** (#481 at 09:34, #359 at 13:27) were second parks on the same
head, at the next gate. The watcher logs a park only when its state and head change, so it never
logged them. The orchestrator learned of them from `axi respond`, which blocks until the next
gate. In act mode the loop reads runs directly (`pipeline-watch.sh --once`, with the step), so
this limits shadowing and replay only. A watcher change to log every park is a separate fix.

**Planned with no live decision:**

| What | Count | Cause |
|---|---|---|
| adjudicate a paused issue's gate (09:30) | 5 | your 06:45 pause, not given to the replay |
| adjudicate a gate the orchestrator had answered | 5 | a review with zero findings is approved with no verdict lines, so the log shows no answer. In act mode the loop's ledger has it |
| ask the model about a cancelled run | 4 | the orchestrator cancelled them itself, re-gating for the drain. The loop skips a cancel its own fixer or re-drive caused, but the replay cannot see the orchestrator's |
| guard PR 497 | 1 | the PR was replaced by PR 499 |
| heartbeat (09:30) | 1 | a real gap: the orchestrator renewed no claim between about 05:00 and 13:20 |
| heartbeat (14:18) | 1 | due 20 minutes after the 13:56 renewal; the orchestrator renewed at 14:40 |
| sweep | 7 | not comparable, as above |

## What the replay changed

1. **A park stays parked until answered.** For a past `--at` the run mirror keeps only each run's
   latest row, and the live mirror syncs every few minutes. So a park the log shows no answer
   to (a verdict or a fix after it) counts as parked. Before this change the loop matched none
   of the 8 adjudications in window 1.
2. **The newest run wins.** A run the watcher has seen that is newer than the mirror's is the
   issue's current run.
3. **A window that has reset counts as zero.** Usage keeps each window's reset time, and a
   reading taken before its window reset counts as zero for that window once the reset passes.
   Before this, the loop sat in Stop all for minutes after a reset.
4. **A title can mark a tracker.** #340 is titled "Epic: ..." with no linked sub-issues. The
   orchestrator never claimed it, and the loop now doesn't either (`trackerTitle`).
5. **A self-caused cancel is not a question.** A failed or cancelled run while the loop's own
   fixer or re-drive is at work on the issue is that work's doing.
6. **A failed run's step is optional.** The adjudicator finds it, since the log never records it.

## Corrections (2026-10-13)

The #522 shadow comparison ([SHADOW-REPORT](SHADOW-REPORT.md#522-the-first-real-work-2026-10-13))
led to a closer look at this harness, which found three faults in it and one gap in the plan.
Both windows were replayed again with all four fixed; the tables above and the files in
[`replay/`](replay/) are the new results.

- **A closed blocker read as open.** GitHub's timeline names a blocker with `"state": "closed"`
  and an empty `closed_at`, and the harness counted every blocker without a close time as open.
  It now reads the blocker's own close time. #467 and #468 then show as unblocked from 14:04,
  which is where the evening's extra claims come from. The first report said the loop proposed
  nothing else but sweeps; that was this fault.
- **Heartbeats matched too loosely.** A live heartbeat counted as matched when any sample in the
  hour before planned one, so the first rule's heartbeat right after the 18:40 claims "matched"
  the live renewal 20 minutes later. A heartbeat now matches only when the loop planned one in
  the five minutes before, or would have in the two minutes after.
- **Adjudications matched by run, not by park.** A second park of a run counted as matched by a
  plan made for its first park. A match must now come after its own park, and every lead in the
  tables is the time from park to plan.
- **In the plan, two parks on one head were one gate.** Without a step (the event log has none),
  a run that parked at review and then at test on the same head gave both parks the same key, so
  the loop took the second for answered. A stepless gate is now keyed by its park's time. In act
  mode the watcher's `--once` output names the step, so this mattered for shadowing and replay.
  The first report's 8 of 8 had counted these two parks through the loose matching; they now
  match on their own.

The heartbeat rule changed too: a claim now counts as its own lease's renewal (DECISIONS D-36).
With it, each of the evening's six live renewals falls within 30 seconds of the loop's.

## Limits

- GitHub labels, blockers and sub-issues are replayed from each issue's timeline. A blocker's
  closing time is read as of now, which is right unless it was reopened since.
- The worktree pool is estimated; `--github off` keeps factory-state's own GitHub read out.
- The queue comes from the database, so an issue labelled `ready` while no queue watcher is armed
  is unknown to the replay until it is claimed (#522 on 2026-10-13). The shadow reads GitHub's own
  list and sees it.
- Guard and merge-review outcomes are not logged, so the replay can show the loop starting a merge
  flow but not finishing it. The shadow run has the same limit. In act mode the loop's own
  ledger carries them.

## Run it again

```sh
node scripts/factory-loop-replay.js --repo cbundy/dev-system --device coder-dev-system-orchestrator \
  --from 2026-10-12T18:30:00Z --to 2026-10-12T20:50:00Z --step-minutes 2 --out /tmp/replay
```

It reads the database and GitHub only, and writes only into `--out`. The issue reader logs an
`untrusted_stripped` event as a side effect of filtering; the harness sends those to a scratch
sink. The first runs on 2026-10-12 did not, and left nine such events in the factory log under
device `coder-devsystem` (23:12 to 23:29 UTC).
