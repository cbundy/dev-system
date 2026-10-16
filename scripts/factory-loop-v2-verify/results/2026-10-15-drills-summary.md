# Factory loop v2: fault drills, run 2

Run 2 of the SPEC 17.3 fault drills, 2026-10-15 21:24 to 2026-10-16 01:29 UTC, on cbundy/dev-system-scratch with
the loop on the Coder workspace dev-system-testbed-loop. Build: feat/factory-loop-v2 at ea5c268 (this includes
bc85323 and 4b7ecde). Claude Code 2.1.301, planner v2, K 2, trace on. The mode is off at the end and the workspace
is still running. Working notes, with every decision-log pass, event and operator touch timed:
`verify/drills/NOTES.md`, section "Run 2". Snapshots: `verify/drills/run2-*.txt`.

**Verdict: the loop cannot merge.** Blocker B1 parks every v2 PR at the head of the merge queue. Drills 2 and 3
were run as variants that work around it: a merge by hand, and outside pushes to main. Every behaviour before the
merge passed. That covers the restart, the long command, the guard, the park and resume, the ghost, the stop gate,
the usage tier, the breaker and triage. Eight minor findings came up along the way.

## Summary

The time column runs from claim to the merge queue, because the loop merged nothing. The only merge in the run
was by hand (#18, 10.9 min after its claim).

| Drill | Expected | Result | Interventions naming the issue | Time |
|---|---|---|---|---|
| 1 Happy path (#8, #9) | claim to merge with no intervention | **FAIL (B1).** Claim, design, build, PR, review and merge queue all clean. Q2 then fails `linkage` twice and parks (T15) | loop queue:linkage, loop park (both from B1) | 10.0 / 11.0 min to the queue; no merge |
| 2' Conflict pair (#18, #19) | the second PR conflicts at the queue head, a fixer, merged; no -vN, no 2nd PR | **PASS up to B1.** I merged PR #20 by hand: E3, closed merged-by-hand, `merged` event, rollout. #19 at the head got T9 conflict, then one fixer (merged main, no rebase, no force push), then review round 2 approved, then the queue, then parked by B1. One branch and one PR per issue | #18: person hand-merge. #19: loop fix:conflict (expected), then B1's two | #19: 10.7 min to the queue, conflict to the queue again 6.0 min |
| 3' Outside merge during the head's CI wait (#23) | the head is updated once more, merged, no churn | **PASS up to B1, with R2-F4.** Q1 ran once per outside merge (keys `update/f3dd733`, `update/5780f92`). Only the head was touched (one update-branch on PR #24 while #22 was head, three on #25). One update failed on a GitHub GraphQL error, giving U2 | loop unknown:cli (R2-F4), then B1's two | 8.1 min to the queue; 15 min at the head |
| 4 Restart mid-build (#12) | one free re-run (free:load), no stuck issue | **PASS** up to the queue | loop free:load; fleet person restart | 13.3 min to the queue; restart to re-run 2.2 min |
| 5 Long command and the guard (#14, #15, #38) | commands in the foreground; a write outside the slot and a push to main refused | **PASS.** A 151 s benchmark ran in one foreground Bash call (the agent set timeout 400000). No background job or polling. Through an owner note, the builder of #38 tried `git push origin HEAD:main` and a Write to the main checkout. Both were refused, logged in companion.jsonl and recorded as interventions | #38: loop guard:push, loop guard:write, person op:note | 7.8-9.0 min to the queue |
| 6 Parked question and resume (#22) | parked with a question, slot freed; label removed with an answer, resumes designing | **PASS** up to the queue. The resumed brief opens with the owner's answer | loop park, person unpark | parked 3.4 min after claim; resumed 65 s after the label went |
| 7 Ghost claim (#27) | released at once, one reconcile intervention | **PASS, with R2-F5 and R2-O2.** Released on the first pass (requeue: ready on, labels off), `reclaimed` reason=reconcile outcome=requeue lives=1, exactly one intervention. Re-claimed as life 2 five minutes later | loop reconcile | release 45 s after the plant; re-claim 5.0 min later |
| 8 Stop gate (#26, #30) | the gate refuses a finish while tests fail; the builder fixes before answering | **PASS.** #30: "Stop hook feedback: The stop gate failed in your slot ...: `npm test` exited 1 ..." then the builder implemented, pushed and answered, and the gate passed. #26: gate pass first time with no hand-run tests | none of its own | refusal to pass 29 s |
| 9 Usage tier (#30) | a free re-run held until the tier allows it | **Hold PASS; free:usage not feasible.** Tier stop-all for 4 min held the reviewer (skip "tier stop-all (agent-step)"), spent no attempt, and let free work run (PR ensure, slot prepare). Lowered thresholds never kill a running agent, so no usage-caused unknown can be made without a real 429 | fleet person config-file | 4-min hold |
| 9b API-type error on two issues (#32, #33) | breaker 30 min, owner told, no park | **PASS, with R2-F7 and R2-F8.** An invalid reviewerModel made the engine refuse each reviewer spawn (unknown:spawn, not unknown:api). The third unknown tripped the breaker, which held agent steps 31 min. No park, no triage spent. Both reviews then approved | #32: unknown:spawn, free:breaker. #33: unknown:spawn. Fleet: loop breaker x2 | 31-min hold; claim to queue 45.9 min |
| Triage check (#36) | (a build-flagged gap) | Two spawn failures, then U3 triage. The triage ran in the issue's slot, with its cwd set by the companion, so it was guarded. It chose park with a correct diagnosis. A resume by label (budgets reset) went on to review round 2 and the queue | unknown:spawn x2, triage, park, person unpark | triage 15 s |

## Bugs, most severe first

1. **B1 (blocker): no v2 PR can merge.** Q2 runs `callum-flow-merge <p> --patch <id>` without `--issue`. v2
   names every branch `issue-<N>` (SPEC 3.5). `check-pr-linkage.sh` only takes an issue from `issue-([0-9]+)-`,
   with a hyphen after the number (`features/src/callum-tools/check-pr-linkage.sh:212-221`), so it prints `SKIP`.
   The guard then fails linkage, because `--issue` is empty (`images/base/callum-flow-merge-guard:430-437`). The
   guard's own rollout regex does accept `issue-9` (`merge-guard:396`). The re-rendered body fails again, so T15
   parks with "the linkage still fails ...: GUARD linkage FAIL SKIP #10 issue-9 (branch names no issue, pass --issue
   N) class=linkage". All 15 PRs that reached Q2 did this, though each was CLEAN with green CI and GitHub
   listed the right `closingIssuesReferences`. A resume repeats the same failure.
2. **R2-F5 (medium): a re-claim made inside the old claim's lease logs no `claimed` event.** R1's requeue and
   `/factory drop` leave the claim comment, with its 120-min lease, in place. When the claim tool then finds this
   device's own live claim, it exits 0 and posts and logs nothing (`images/base/callum-flow-claim:209-222`). #27's
   life 2 (S0 23:33:27, lives=2) has no `claimed` event, and neither do run 1's #3 and #4 after a drop and re-added
   `ready`. Readers that start a life at its first `claimed` miss these lives: metric 3, and "within 3 hours of
   their claim" in the cutover bar.
3. **R2-F6 (medium-low): a hand edit back to an earlier config version is never logged.** The config-file fact is
   keyed by the digest of the new version (`rules-interventions.ts` configFacts). A return to any version logged
   before counts as already logged, and `files:<repo>` takes it silently. Six hand edits were made to config.json
   while acting, and only three were logged. The three missing ones all have digest faa65ce3, which I recomputed
   from the stored texts: mode off to act at 21:37:58, and the restores at 23:52:15 and 00:14:10. So toggling the
   loop off and on, or restoring a setting, under-counts person interventions. This is also why run 1's 20:04:36
   off to act edit was not logged. control-file facts use the same digest key.
4. **R2-F4 (low): a queue update gets no retry on a transient GitHub error.** `gh pr update-branch` has one attempt
   per key. A GitHub "GraphQL: Something went wrong" error at 23:16 became U2 plus a loop unknown:cli intervention
   naming #23. That alone makes the issue count as "touched" for the cutover bar. ci-rerun retries transient errors
   3 times with backoff; queue-update does not.
5. **R2-F2 (low): an issue closed together with its PR parks first.** PRs are read on every pass, but an issue's
   open or closed state only at the github cadence. So E4 (pr-closed) wins over E2 (issue-closed) despite SPEC
   4.1's order. Before the drills, #3 and #4 (closed by the reset at 21:30) were parked at 21:32. Each got a park
   comment on the closed issue, `factory:parked`, an owner tell, and loop park plus person pr-closed interventions.
   They closed 2 minutes later.
6. **R2-F7 (low): one fault trips two breakers.** The foundation's executor breaker (kind agent-step) and the
   step-unknown breaker both tripped, so the owner got two breaker tells and two loop breaker interventions 11 s
   apart (00:13:46 and 00:13:57). The step breaker's hold also ran from its U1 transition (00:13:52), not from the
   unknown that tripped it (00:12:25).
7. **R2-F8 (low): an invalid `reviewerModel` is accepted.** The agent tool takes only sonnet, opus, haiku or fable.
   Any other value makes every reviewer spawn fail with InputValidationError. The decision log shows no config
   problem, only the generic unknown path and the breaker. `triageModel` is probably the same.
8. **R2-F1 (low): a loop upgrade reads as a person's config edit.** `settingsOf` digests the resolved settings,
   defaults included (`sources-interventions.ts:161-166`). The first acting pass of the new build therefore logged
   "settings changed with no op: config.json mode, maxLives", though nobody set maxLives.
9. **Gap (low), confirmed: gate results are not in the decision log.** Neither #30's refusal nor any pass appears
   there. The only record is `factory-gate.json` in the slot's git dir, and the next gate run overwrites it.
10. **Cosmetic.**
    - A config-file reason lists each key twice ("config.json usageSlowPct, usageSlowPct").
    - The triage's park question says "re-add ready to resume" instead of removing `factory:parked`.
    - One designer brief told the second PR to "rebase".
    - factory-state marks every v2 parked issue "STUCK S3" after 30 min, and shows the v1 text "no matching run in
      the mirror" for v2 issues.

## Gaps the build flagged

- **Slotless triage runs unguarded:** this did not arise. The one triage (#36) ran in its slot, and its cwd was set
  by the companion's spawn hook, so the companion guarded it as a reader. In this build `agentStep` holds every
  agent step, triage included, until W1 leases a slot (`rules-agent.ts:282-283`).
- **Gate result not in the decision log:** confirmed (bug 9).
- **Stop gate with the companion installed the way the loop runs it:** verified in the live loop session, for
  agents spawned by the loop's timer, on Claude Code 2.1.301. The companion was loaded as a session plugin dir
  (`CLAUDE_CODE_PLUGIN_DIRS`), and both the refusal and the pass worked. Not verified: installing it from the
  marketplace through the orchestrator-loop template. That is not possible until the companion is released.

## Observations (latency, not correctness)

- **Most of the time to the queue is the pass cadence.** About 8 of the 10 minutes from claim to the queue for a
  small issue is waiting. An agent step starts about 2 minutes after its transition, because the entry actions, the
  prepare and the spawn each wait for a timer pass. Agent time was about 2 minutes (design 23 s, build 40 s,
  review 35 s).
- A new `ready` label is seen by the queue watcher, which polls every 2 minutes, so a claim can wait up to about
  3 minutes.
- A requeued ghost waits up to one github read period (5 minutes) before S1 sees its `ready` label (R2-O2).
- GitHub showed the head's merge state as UNKNOWN for about 6 minutes after main moved, so the head waited 4
  passes before Q1 (R2-O1).
- The designer drops guard-provoking instructions from briefs, so the guard could only be tested through an owner
  note.

## Not exercised

- **free:usage:** it needs a real 429.
- **unknown:api:** the engine rejects an invalid model before any API call is made, so the drill produced
  unknown:spawn instead.
- **The companion's default 600000 Bash timeout:** the one long command carried its own timeout.

## Environment changes (verify tooling only; no loop code was changed)

- **The reset script:** `verify/scratch-reset.sh` now ensures the 9 labels, including `factory:rejected`, before it
  strips any. It also checks that no issue carries `ready` or a `factory:*` label. The run-1 copy is in
  `drills/scratch-reset.sh.run1-backup`.
- **The scratch repo:** main is at 5780f92, 5 commits after drill-base: c0e637d (adds `sleep 120` to CI), PR
  #20's commit and its hand merge (9d3baa9, 8567a88), and two README lines (f3dd733, 5780f92).
- **Left in place:** 15 issues are parked, each by B1. The last scratch-reset run returns the repo to drill-base.
