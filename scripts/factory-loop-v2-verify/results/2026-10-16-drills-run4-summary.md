# Factory loop v2: fault drills, run 4

Run 4 of the SPEC 17.3 fault drills, 2026-10-16 04:24 to 07:34 UTC, on cbundy/dev-system-scratch with the loop on
the Coder workspace dev-system-testbed-loop. Build: feat/factory-loop-v2 at f6f8728 (the testbed checkout
/persist/claude/loop/dev-system-v2 moved forward from 2219ae9 at 04:25:25Z). Planner v2, K 2, pass timer 10 s, trace
on. Part A (04:24-05:33) unstuck run 3's records and re-ran the regressions of the round 2 and 3 fixes. Part B
(05:36-07:34) ran the nine SPEC 17.3 drills not run before. The mode is off at the end, passEvery stays 10 s, and the
workspace is running. Working notes, with every pass, event and operator touch timed: `verify/drills/NOTES.md`,
sections "Run 4 ..." and "Run 4 part B ...". Snapshots: `verify/drills/run4-*.txt` and `run4b-*.txt`.

**Verdict.** Every regression passed (part A). Of the nine new drills, seven passed outright and one passed on
behaviour but not on its expected evidence. Drill 7 failed: when the companion plugin is missing after a restart,
the workspace rail lets agent steps start for up to 3 minutes (R4-F3, high). The store wipe rebuilt every record,
but it dropped the builder's evidence from two PR bodies (R4-F4) and logged some facts twice (R4-F5). Every finding
is a seam bug or a by-design observation. None needs a special case. The loop made 16 merges in the run.

## Summary

Time is claim to merge unless the row says otherwise.

| Drill | Expected | Result | Interventions naming the issue | Time |
|---|---|---|---|---|
| A0 Setup | build loads, every v2 source ok | **PASS.** P1-P12 10 s apart, v2.prs ok with PR #35's empty diff (R3-F3 fixed) | fleet: person restart, person config-file | load 8.6 s after the restart |
| A1 Unstick (#33 empty PR, #36, #38), resume #22 | no stuck record; the empty patch reviewed like any other | **PASS.** #36 merged; #38 took the freed slot; #33 under review/0000000: changes, a review fixer, a conflict fixer, approve, update, merged; #22 unparked to fixing and merged | #38: loop fix:conflict, guard:push, guard:write (its run-2 owner note). #33: loop fix:conflict. #22: person unpark | #36 1:47 after mode act; #38 3:35 from its slot; #33 8:49; #22 6:43 from the label removal |
| A2 Merged once (R3-F1) | one `merged` per merge across sweeps | **PASS.** 7 merges, 7 `merged`, none repeated across 3 sweeps | - | sweeps 04:29, 04:59, 05:29 |
| A3 Queue head speed (R3-O1) | the next head updated within seconds of main moving | **PASS.** Update planned 7 s and the new head there 14 s after main moved | none | queue turn 2:56 |
| A4 Ghost re-claim (R2-F5, R2-O2) | released at once, re-claimed in a pass, one `claimed` | **PASS.** Released on the first pass, re-claimed 19 s later (run 2: 5 min) | #60: loop reconcile | merged 5:25 after the re-claim |
| A5 (i) Invalid reviewerModel (R2-F8) | a config problem; the default model used | **PASS** | fleet: person config-file x2 | - |
| A5 (ii) Issue closed with its PR (R2-F2) | closed, no park | **PASS.** E4 waited one pass for the issue read, then E2 | #61: person issue-closed | 10 s after the close |
| A5 (iii) Upgrade's config intervention (R2-F1) | one true one, no false key | **PASS** | fleet: person config-file | - |
| A5 (iv) Triage park text | - | **Not run:** no triage arose | - | - |
| A6 GitHub blips | no blip ends a step | **PASS by absence.** No blip happened | - | - |
| B1 A PR closed by hand in reviewing (#64) | parked; the resume reopens the PR and review runs; not parked again | **PASS.** Parked 15 s after the close (reviewer stopped); `/factory resume` reopened PR #65; round 2 approved; merged | person pr-closed, loop park, person op:resume | 7:03 (51 s parked) |
| B2 An issue closed by hand during a build (#66) | closed, slot freed, person issue-closed | **PASS.** E2 from building at the 5-min issue read; builder stopped; slot freed; no PR | person op:note (setup), person issue-closed | close to E2 4:32 (R4-O3) |
| B3 A hand push to a branch in reviewing (#67) | person push; the new patch reviewed | **PASS.** Seen 6 s after the push; old reviewer stopped; new reviewer on the new patch, same round; merged | person push | 5:25 |
| B4 A hung process left by a builder (#69) | killed at the next seq (`KILLED 1`) | **PASS on behaviour, FAIL on evidence (R4-F2).** The `sleep 3600` outlived its builder and was ended by the reviewer's slot prepare 25 s later, before any agent started there. No `KILLED 1` anywhere | person op:note (setup) | 5:14 |
| B5 A flaky check (#71) | one ci-rerun, then merged, no fixer | **PASS.** Attempt 1 failed by design; re-run 1 s later; attempt 2 green; merged | loop ci-rerun | 5:44 |
| B6 A reviewer that always asks for changes (#73) | parked after 3 fix rounds; the only intervention the park | **PASS.** 4 review rounds, 3 fixers, T10 park; the question carries round 4's finding once | person op:note (setup), loop park | claim to park 10:38 |
| B7 The companion plugin disabled (#75, #76) | agent steps held with skip `workspace`; tell(workspace) once | **FAIL (R4-F3).** For 2 min 41 s after the restart the rail passed: #75's reviewer, #76's designer and #76's builder started without the companion (no guard, no stop gate). Then the hold, one tell and one loop workspace intervention, and the resume after the companion came back, all as expected | none naming #75 or #76; fleet: person restart x2, loop workspace | #76 held 5:24; merged 13:24 |
| B8 `/factory new off` for 20 min with work in flight (#79, #80, #82) | no attempt spent; steps resume when on | **PASS.** #80's design and #82's claim held 20 min with no attempt, clock or tell; #79's review and merge went on; on the op's own pass the lease, then the designer at attempt 1 | none naming the issues; fleet: person op:new x2 | #79 5:15; #80 27:37; #82 10:03 |
| B9 A store wipe (#73 parked, #80 and #82 in reviewing) | records rebuild from events | **PASS, with R4-F4, R4-F5, R4-O5.** 41 records rebuilt (the newest life per issue). Recorded review answers reused (no new reviewer). Both merged; no transition repeated; #73 untouched. But PR #83 and #84 bodies lost their Evidence, `reviewed` was logged again, and #38's four guard interventions were logged again | #38: loop guard:push x2, guard:write x2 (repeats); fleet: person restart, person config-file | rebuild in the first act pass (17.8 s) |

Not run (out of scope): two loops on two devices, and a triage that times out. Still not exercised: a GitHub blip
inside an attempt, a PR read that keeps failing, and a triage park.

## Merges

16 loop merges, each by `callum-flow-merge` at the queue head, one PR and one branch per issue.

| Issue (PR) | Merged | Claim to merge | Interventions naming it |
|---|---|---|---|
| #36 (#37) | 04:30:48 | unstuck, 1:47 after mode act | none |
| #38 (#39) | 04:34:41 | 3:35 from its slot | loop fix:conflict, guard:push, guard:write |
| #33 (#35) | 04:37:50 | 8:49 after mode act | loop fix:conflict |
| #22 (#24) | 04:45:11 | 6:43 from the label removal | person unpark |
| #56 (#59) | 04:53:05 | 5:30 | none |
| #57 (#58) | 04:55:59 | 8:18 (one queue turn) | none |
| #60 (#62) | 05:03:11 | 5:25 from the re-claim | loop reconcile |
| #64 (#65) | 05:51:49 | 7:03 | person pr-closed, loop park, person op:resume |
| #67 (#68) | 06:08:10 | 5:25 | person push |
| #69 (#70) | 06:15:50 | 5:14 | person op:note |
| #71 (#72) | 06:23:59 | 5:44 | loop ci-rerun |
| #75 (#77) | 06:45:04 | 5:28 | none (its reviewer ran unguarded, R4-F3) |
| #76 (#78) | 06:55:49 | 13:24 (5:24 held) | none (designer and builder ran unguarded, R4-F3) |
| #79 (#81) | 07:03:30 | 5:15 | none |
| #80 (#83) | 07:28:26 | 27:37 (20 min new off, then the wipe) | none |
| #82 (#84) | 07:31:16 | 10:03 (the wipe, one queue turn) | none |

Not merged, as their drills meant: #61 and #66 closed by hand, #73 parked at the fix cap.

## Measurements

- **Claim to merge, no hold:** 5:14 to 5:44 for the first PR of a pair, ~8:20 for the second (one queue turn).
- **Stages, typical:** claimed to queued 7-12 s; designer starts 15-25 s after the claim and runs 18-50 s; builder
  starts ~15 s after the brief and runs 32-50 s (stop gate 9-12 s); reviewer starts 25-30 s after T5 and runs 30-60
  s; CI ~2.4 min from the PR's open; the queue head merges 13-19 s after T8; a second head takes ~2.8-2.9 min (update
  14 s after main moved, CI, merge).
- **Reactions:** hand PR close to park 15 s; resume op to P1 in the op's own pass; hand push seen in 6 s; failed
  check re-run in 1 s; ghost released on the first pass and re-claimed 19 s later; `new on` to lease in the op's
  pass; issue closed mid-step seen in up to 5 min; companion missing held only after 2:41.
- **Passes:** part A 412 act passes (busy median 2.8 s, p90 6.5 s, max 21.6 s; idle median 0.9 s). Part B 711 act
  passes (median 2.1 s, p90 4.9 s, max 17.9 s, the rebuild pass).
- **Decision log:** part A 423 lines in 1.06 h (401/h; busy 0.78 MB/h, idle 0.44 MB/h); part B 741 lines in
  1.79 h (415/h, 0.66 MB/h).
- **GitHub API, core** (cbundy's one per-user quota, shared with both live loops in observe and this operator):
  part A busy ~1250/h (725 used in 34.8 min), idle ~350-440/h; part B ~925/h (06:15-07:04) and ~965/h
  (07:16-07:33). About 19-25% of the 5000/h budget while busy. **graphql:** 30-60/h.
- **GitHub-touching commands the loop logged:** part A busy ~1110/h (issue-read 271, pr checks 163 in 0.58 h);
  part B ~520/h over its act time, which includes 20 idle minutes (issue-read 423, pr checks 230, queue-watch 100,
  issue edit 72, git ls-remote 49). Run 4 is pinned to f6f8728, before fix round 4's PR read cadence (39a6eba). A
  short run 5 should measure that.
- **Outcomes:** no failed outcome, no attempt above 1, no source failure and no pass error in either part.

## Findings, most severe first

1. **R4-F3 (seam bug, high): the workspace rail passes for up to 3 minutes after a restart without the companion.**
   The rail takes the handshake as live when it is under 3 minutes old and written no more than 90 s before the
   module loaded (sources-workspace.ts:14, :19, :39-40; SPEC.md:1624). The companion writes every 60 s
   (factory-loop-workspace/hooks/register.ts:37). So at a restart the old process's file is at most 60 s old, and
   always inside the grace. The code and the spec both say the opposite (sources-workspace.ts:17 "the old file never
   passes the first pass after a restart"; SPEC.md:1626 "The age check catches a session resumed under the same id
   without the companion"). In drill 7: handshake 06:41:41.4, load 06:42:02.0, hold from 06:44:43.4. In between,
   three agent steps started with no write guard, no Bash timeout rewrite and no stop gate. One was a builder,
   which answered with no gate run. They behaved only because their prompts name the slot. A writer started in the
   window keeps running unguarded for its whole step. **Root fix:** one owner for "the companion runs in this
   process". The handshake names its writer's process (pid or a per-process start id; both plugins live in the
   same Claude Code process), and the rail accepts only this process's handshake. That replaces the load grace. No
   new rule.
2. **R4-F4 (seam bug, medium-low): after a store rebuild, the PR body loses the builder's evidence.** The first act
   pass after the wipe re-ran the reviewing seq's `pr ensure` and rewrote PRs #83 and #84 without "## Evidence".
   PR #81, which was not rewritten, still has it, and the build answers hold it
   (answers/i80_ltmznh1_s3_build_a1.answer.json). `workOf` reads the title, summary and evidence only from the
   life's done build entry in the ledger (rules-review.ts:93-100). Without that entry, `used` falls back to the
   PR's body for the summary but not for the evidence, so the body differs and is written (act-pr.ts:261-269).
   **Root fix:** one durable source for the builder's work text: the recorded build answer (as agent steps already
   look up their answers, SPEC 10.8), or the PR's own body for every part. No new rule.
3. **R4-F1 (seam bug, low): a resume into fixing logs no `fix_requested`.** SPEC 4.5 (SPEC.md:614) and 7.1
   (SPEC.md:988) log it on every entry to fixing. The T1 row (SPEC.md:481) logs only `transition`, and the code
   follows the rows (table.ts:162-163). #22 entered fixing through T1 at 04:41:27 with no `fix_requested`. Readers
   that count fix rounds from it (SPEC.md:1104) miss that round. **Root fix:** emit it on entering the state,
   with the record's last fix reason, or change the spec to say "per row". No new rule.
4. **R4-F2 (seam bug, low): a leftover process of a finished step is ended silently.** SPEC 17.3 expects `KILLED
   1` at the next seq (SPEC.md:2542). But the `slot kill` entry action runs only while an old step still runs
   (SPEC.md:611; rules-entry.ts:148). The leftover is then ended by the next prepare (SPEC.md:1464;
   factory-slot:358), which prints only `PREPARED head=` (factory-slot:374), as W2's free does. In drill 4,
   `sleep 3600` (pid 1334572, cwd the slot, ppid 1) was gone within 25 s, but nothing in the decision log, the
   events or the trace shows that an agent left a process behind. **Root fix:** the one "end the slot's processes"
   reports its count wherever it runs (prepare and free too), or the test plan changes. No new rule.
5. **R4-F5 (seam bug, low): "logged once" lives only in the ledger.** Intervention and review events are deduped
   by their ledger keys (`iv/<fact>`, `.../reviewed`), but their sources (companion.jsonl, answers/) outlive the
   store. After the wipe, #38's four guard interventions from runs 2 and 4 were logged again, and so was each
   recorded review of #80 and #82. Per-issue intervention counts and review rounds (SPEC 7.3) double for those
   facts. **Root fix:** take "already logged" from the event log the rebuild already reads (factory.events), as the
   R3-F1 fix did for `merged`. No new rule.
6. **R4-O5 (seam, low): a rebuilt record keeps only what fits a transition note.** SPEC 3.3 says the note "carries
   every record field" (SPEC.md:284-285), but 7.1 clips the question and notes to NOTE_MAX 500 (SPEC.md:953;
   events.ts:15-16, :27). #73's question went from 873 to 113 characters. A daily park reminder, or a record rebuilt
   in fixing with findings in its notes, gets the clipped text. The park comment on GitHub keeps it whole. **Root
   fix:** the spec says which fields are clipped, and anything that needs the whole text reads it from its durable
   home (the park comment, the answers). No new rule.
7. **R4-O1 (seam, low, by design today): a closed record's claim stays live until the next sweep** (up to 30 min).
   factory-state counts it as live (#60 and #82 here). **Optional root fix:** the loop's close ends its own claim.
   No new rule.
8. **R4-O3 (latency, by design): an issue closed by hand mid-step is seen only at the 5-min issue read**
   (githubEveryMs). #66's builder worked and pushed for 4.5 min on a closed issue. Bounded and cheap. A shorter
   period costs reads.
9. **R3-F2 (design question, carried): the fix cap counts conflict rounds made by other PRs' merges.** In part A,
   #33 reached fixes 3 = fixCap and merged only because its queue update was clean. A fix would need a rule for one
   situation: **a special case**, so not recommended. It is noted for real load on dev-system.
10. **R4-O4 (agent behaviour, not a loop bug):** told to run a foreground sleep, the builder was blocked by Claude
    Code itself ("use run_in_background"), started a background Bash task, and then polled for it. The companion
    refuses background `Agent` calls, not background Bash. The stop at E2 ended the task with its agent. A guard
    rule for this one pattern would be **a special case**, and the slot kill already covers what it leaves.
11. **R4-O2 (not a bug):** an owner note stays with the record for every later step of the life. Run 2's guard note
    on #38 made run 4's conflict fixer try the push and the write again. The guard held, and the interventions are
    true. One-shot notes would be **a special case**.
12. **Cosmetic.** The fix-cap park question joins the finding and the instruction with ".;" and names an answer
    path on the loop's workspace that the owner cannot open. The judge's workspace tell said "two designs" were on
    hold when one review was. factory-state marks a v2 park over 30 min "STUCK S3" (as in run 2).

## Confirmed fixed in this run

R3-F3 (the empty PR has the zero patch id), R3-F1 (merged once), R3-O1 (head updated within seconds), R2-F5 and
R2-O2 (one `claimed` per re-claim, within one pass), R2-F8 (an invalid model is a config problem), R2-F2 (an issue
closed with its PR closes without a park), R2-F1 (no default key in the upgrade's intervention), R2-F6 (a revert is
logged). Run 3's cosmetic doubling of the park question did not recur on the fix-cap park.

## Environment changes (verify tooling and the scratch repo only; no loop code changed)

- Testbed: /persist/claude/loop/dev-system-v2 at f6f8728. `/persist/claude/settings.json` was changed and
  restored for drill 7; its backup `settings.json.before-drill7` stays beside it. The pre-wipe store is kept at
  `/persist/claude/plugins/store/factory-loop_inline-25b28b09a45e.json.drill9-aside`. The live store is the rebuilt
  one.
- Scratch repo: three person pushes to main for drill 5 (6e533f3 the flaky step, 98da113 its YAML fix, 15cdd9e
  ci.yml restored). Open: #73 parked with PR #74. Its owner note still tells the reviewer to ask for changes every
  round, so a resume needs a new note or a drop. Branch issue-66 (unmerged) and the merged branches stay on origin.
- Operator helpers for this run are in the operator's scratchpad (`r4b/`): a 2 s event or decision-log wait, a
  time-ranged pass viewer, a `/factory` op typer (tmux send-keys), and the companion off and on restart. Worth
  adding to the kit: waiting on a fact the loop logs at 2 s resolution caught every window here.
