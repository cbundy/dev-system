# Factory loop v2: fault drills, run 5

Run 5, 2026-10-16 08:24 to 10:13 UTC, on cbundy/dev-system-scratch with the loop on the Coder workspace
dev-system-testbed-loop. A short run before the merge into main: each check of the brief once, on the fix rounds 4
to 6. Build: feat/factory-loop-v2 at 36004c8 (the testbed checkout /persist/claude/loop/dev-system-v2 moved forward
from f6f8728 at 08:24:39Z). The branch moved to d9c358c during the run with fixes for both run 5 findings; the two
failed checks were re-run once on it at the end (10:04-10:13). Planner v2, K 2, pass timer 10 s, trace on. The mode
is off at the end, passEvery stays 10 s, and the workspace is running. Working notes, with every operator touch,
pass and event timed: `verify/drills/NOTES.md`, sections "Run 5 ...". Snapshots: `verify/drills/run5-*.txt`.

**Verdict.** Every fix of rounds 4 to 6 held on 36004c8: the rail held from the first pass after a restart
without the companion (R4-F3), background Bash was refused (R4-O4), the leftover's count shows (R4-F2),
`fix_requested` is logged on a resume into fixing (R4-F1), a merge's claim ends within seconds (R4-O1), and the
store wipe kept the PR evidence, logged nothing twice and kept long questions whole (R4-F4, R4-F5, R4-O5). The
measured hour merged four new issues in 6 to 9.5 minutes each with no touch, and the loop's own GitHub commands
fell about 20% per busy hour (PR reads about 40%). Two new seam bugs were found and fixed during the run, and both
fixes pass on d9c358c: an owner's resume note never reached the resumed step (R5-F2, high), and a second loss of
the companion in the same conversation was never told (R5-F1, medium). No finding needs a special case. 9 loop
merges; no failed outcome, no unknown, no pass error.

## Summary

Time is claim to merge unless the row says otherwise.

| Check | Expected | Result | Interventions naming the issue | Time |
|---|---|---|---|---|
| 1 Setup | 36004c8 loads; handshake carries a process id; passes 10 s apart | **PASS.** Handshake `"process":"1629814:342374958"`; observe P1-P12 10.0 s apart, every v2 source ok | fleet: none in observe | load 8 s after the restart |
| 2 Companion disabled (#85), on 36004c8 | held from the first pass after the load; no agent; tell(workspace) once; resumes after the restore | **Hold PASS, tell FAIL (R5-F1).** Skip `workspace` from P1 (6.4 s after the load; old handshake 35 s old); 29 passes held, 0 agent steps; designer at attempt 1 after the restore. No tell and no loop workspace intervention: the session's tell key was spent in run 4 | none; fleet: person restart x2 | 11:17 (5:14 held) |
| 2' Same, on d9c358c (#92) | as above | **PASS.** Held from P1; tell keyed by session and process at 2:06 after the load; loop workspace once; designer after the restore | person op:resume; fleet: person restart x2, loop workspace | held 2:19 |
| 3 Background Bash and a leftover (#86, then #89) | the background call refused (companion line, foreground reason); the leftover ended at the next seq with its count | **PASS.** #86's builder refused the drill itself (its prompt rule). #89: `guard:command` "Bash in the background is refused: run it in the foreground ..."; `sleep 3600` ended by the reviewer's prepare 17 s after the answer: "1 process(es) ended" | #89: person op:note (setup), loop guard:command | #89 5:34 |
| 4 Resume #73 (fix cap, resumeTo fixing), on 36004c8 | `fix_requested` on the entry into fixing; then the normal path | **fix_requested PASS, resume note FAIL (R5-F2).** P1 in the op's pass; T1 -> fixing with `fix_requested review`, and one on each later entry. Parked again at the cap after 3 fix rounds: the reviewers followed run 4's note; my resume note reached no prompt | person op:resume, loop park | resume to park 11:20 |
| 4' Resume note, on d9c358c (#92) | the note in the resumed step's prompt | **PASS.** The designer's prompt carries the owner's answer; it designed option A without asking again; merged | person op:resume | resume to merge 7:26 |
| 5 The claim ends at the close | not live right away; no later sweep closes it | **PASS.** Each merge's sweep logged `closed` 15-28 s later, for that issue only; factory-state showed none of them live | - | 15-28 s |
| 6 Store wipe (#91 reviewing with evidence; #73, #92 parked) | PR body keeps Evidence; no `reviewed` or intervention twice; questions whole | **PASS.** PR #93's body unchanged (no `gh pr edit`); 5 old guard interventions and the review "already in the event log"; 46 records rebuilt, #73's question 924 = 924 and #92's 1245 = 1245 characters | fleet: person restart, person config-file | rebuild in the first act pass (11.1 s) |
| 7 Measured hour (#94-#97) | normal flow to merge; GitHub use per hour | **PASS.** Four merges, no touch; loop commands ~900/h busy, ~65/h idle | none | 6:14, 9:25, 8:25, 8:12 |

## Merges

9 loop merges, each by `callum-flow-merge` at the queue head, one PR and one branch per issue.

| Issue (PR) | Merged | Claim to merge | Interventions naming it |
|---|---|---|---|
| #85 (#87) | 08:42:03 | 11:17 (5:14 workspace hold) | none |
| #86 (#88) | 08:45:57 | 8:24 (an update after #85's merge) | person op:note |
| #89 (#90) | 08:51:51 | 5:34 | person op:note, loop guard:command |
| #91 (#93) | 09:02:47 | 6:28 (1:09 off for the wipe) | none |
| #94 (#98) | 09:11:23 | 6:14 | none |
| #95 (#99) | 09:14:41 | 9:25 (one queue turn) | none |
| #96 (#100) | 09:20:10 | 8:25 (an update) | none |
| #97 (#101) | 09:23:10 | 8:12 (one queue turn) | none |
| #92 (#102) | 10:12:24 | 1:15:58 (parked 1 h 7 min on purpose, 2:19 workspace hold) | loop park, person op:resume |

Not merged: #73, parked again at the fix cap by its run-4 reviewer note (check 4).

## Measurements

- **Stages, typical:** claimed to queued 8-16 s; designer starts 15-18 s after T1 and runs 19-27 s; builder starts
  11-20 s after the brief and runs 43-69 s; reviewer starts 22-35 s after T5 and runs 32-45 s; CI wait after the
  review 1.6-2.1 min; a head with nothing to update merges 16 s after T8; a head behind main is updated 6-14 s after
  main moved, then CI and merge, 2.8-3.5 min from T8.
- **PR read cadence (round 4):** per open PR, a read every 30-43 s, with 0-20 s gaps right after the loop's own
  action on it. Over 21 PR-minutes: 57 PR reads and 43 checks reads (2.7 and 2.0 a minute; at a read every pass
  they would be 6 and 6).
- **GitHub-touching commands the loop logged (the hour 09:03-10:03):** 357 (294 without `git ls-remote`, a git
  request, not REST quota), about 89 per merge. Busy 09:03-09:24 (4 merges): ~900/h (~720/h without ls-remote),
  79 per merge. Run 4 part A busy, on f6f8728 with a PR read every pass: ~1110/h (~1030/h), 92 per merge, at a
  similar merge rate. The PR read commands fell from ~750/h to ~430/h busy. Idle 09:24-10:03: ~65/h (run 4 ~49/h).
- **GitHub API, core** (cbundy's one per-user quota, shared with both live loops in observe and this operator):
  09:15:57-09:33:00 (7.5 of 17 min busy) ~725/h; idle 09:33-10:03 ~425-447/h, all of it other users of the quota
  but ~65/h. The busy part 09:03-09:15:56 is hidden by the hourly reset. The drill part 08:38-08:55 (busy, with the
  operator's own GitHub reads) ran ~1320/h. Run 3: ~1330/h; run 4: ~1250/h busy. graphql ~50/h.
- **Passes:** in the hour 376 (busy median 2.7 s, p90 7.8 s, max 18.8 s; idle median 1.0 s). Decision log 386
  lines, 0.60 MB in the hour. In the whole run 651 act passes, 0 pass errors, 0 source failures, 0 failed outcomes,
  no attempt above 1, no `unknown` event.

## Findings, most severe first

1. **R5-F2 (seam bug, high; fixed in 87fe5aa, verified on d9c358c): the owner's resume note was dropped before the
   resumed step ran.** P1 put the note on the queued record (table.ts:346; SPEC 4.3 P1 "notes += the op's note, or
   the trusted comments posted after the park comment"), and the next row, T1 queued -> resumeTo, entered a state,
   which takes "the row's notes alone" (SPEC.md:677; table.ts:429), while T1's change added none (table.ts:175-178).
   #73's transitions show it: P1 08:38:13 `notes=The%20earlier%20note...`, T1 08:42:24 `notes=none`. No prompt of
   the resumed life carried the note (spawns/i73_ltmzlvt_s13_fix_a1.json and the reviews of rounds 5-7), so the
   reviewers kept following run 4's note and #73 parked again at the cap. By the code, a label resume's owner
   comments (the answer to a parked question) took the same path. The fix makes T1 carry queued's notes. On
   d9c358c, #92's resumed designer had the owner's answer in its prompt and designed option A without asking again.
2. **R5-F1 (seam bug, medium; fixed in c924160, verified on d9c358c): a second loss of the companion in the same
   conversation was held but never told or counted.** The rail is judged per process, but the tell was keyed per
   session (workspace.ts:73), and its ledger entry outlives restarts and wipes (a `loop` event the ledger is rebuilt
   from). The supervisor resumes the same conversation on every restart, so after run 4's tell (06:44) the outage in
   check 2 held every agent step with no tell, no `workspace` intervention (rules-interventions.ts:173, :205-206) and
   only "owner 1" in the title. On the live loop, which keeps one conversation for days, that is a silent stall. On
   d9c358c the tell is keyed by session and process (`tell:workspace:33faa122-..._1910863_342972737`) and the
   intervention is logged once.
3. **R5-O3 (special case, low; not recommended): a stale `/factory note` cannot be withdrawn, and a resume note
   reaches only the resumed step.** #73's run-4 note ("never approve this PR") sits in every later reviewer's prompt.
   A resume note goes to the fixer, not to the later reviewer. A new `/factory note` reaches every later step, so the
   owner has a lever; a withdraw op would be a special case. #73 stays parked: it needs a drop or a new note.
4. **R5-O2 (low): a re-made ledger entry's `loop` event is logged again after a wipe.** #91's review step:
   `kind=agent-step ... status=done` at 09:00:17 and again at 09:01:58. Reviews are counted from `reviewed`, which is
   logged once, but a reader that counts agent steps from `loop` events counts this one twice. A root fix, if wanted,
   is the same owner as R4-F5's fix (the event log decides "already logged"). No new rule.
5. **R5-O4 (latency, by design): an idle loop saw four new `ready` issues 2 min after creation** (the queue read's
   idle cadence), against 38-51 s in run 4 while busy. Cheap; a shorter idle cadence costs reads.
6. **R5-O1 (reader, expected): the released callum-flow-factory-state (v0.38, /usr/local/bin) misreads v2 states**:
   #73 showed as "implementing ... STUCK S2" while queued and while parked. The branch's tool shows "parked, v2
   parked". It goes away with the release that carries U4. Drills should use the branch's tool.
7. **Cosmetic.** A park question collapses runs of whitespace, which changed a code example in #73's question
   (`"  dog   dog\tcat\n dog  "` became `" dog dog\tcat\n dog "`). The judge's workspace tell suggests "make sure
   only one Claude Code process is running this session" for a plugin that is not loaded. A typed `\"` stays in an
   op's note.
8. **Agent behaviour, good:** told by an owner note to make a background call and leave a process, #86's builder
   refused both, quoting its operating rules (cc9cdcf). The guard was exercised only when the note said the owner
   was testing the guard (#89).

## Confirmed fixed in this run

R4-F3 (the rail accepts only this process's handshake; held from the first pass after the load), R4-O4 (a
background Bash call is refused with the foreground reason, logged as guard:command), R4-F2 (the leftover's count
in the decision log: "1 process(es) ended"), R4-F1 (`fix_requested` on every entry into fixing, a resume's T1
included), R4-O1 (the claim ends at the close: sweep 15-28 s after each merge, nothing closed twice), R4-F4 (the PR
body keeps the builder's evidence after a rebuild), R4-F5 (interventions and reviews logged once across a wipe),
R4-O5 (questions of 924 and 1245 characters kept whole through the rebuild), round 4's PR read cadence, and on
d9c358c R5-F1 and R5-F2.

Not exercised: a triage (none arose), a GitHub blip inside an attempt, a PR read that keeps failing, two loops on
two devices.

## Environment changes (verify tooling and the scratch repo only; no loop code changed)

- Testbed: /persist/claude/loop/dev-system-v2 at d9c358c. `/persist/claude/settings.json` was changed and restored
  twice (checks 2 and 2'); it equals its backup `settings.json.before-run5` (sha256 4d94c2a9...), which stays beside
  it. The pre-wipe store is kept at
  `/persist/claude/plugins/store/factory-loop_inline-25b28b09a45e.json.run5-aside` (and a copy,
  `.run5-before-wipe-copy`). The live store is the rebuilt one.
- Scratch repo: no push to main by hand. Open: #73 parked with PR #74. Merged branches stay on origin.
- Operator helpers for this run are in the operator's scratchpad (`r5/`): the run 4 helpers plus a session restart,
  a companion off and on with its own backup name, and a counter of the loop's GitHub-touching commands per window
  from the decision log. The counter is worth adding to the kit, with the 2 s waits on facts the loop logs.
