# Factory loop v2: workflow 1 build notes

Workflow 1 of the v2 build, 2026-10-15: the spec, three spikes, three critics and a revision. This
page records what the critics found, what the revision did with each finding, the rule count, the
workspace design the spec now uses, and the questions only the owner can answer.

## What happens next

- **The owner** answers the open questions below. Workflow 2 can start without them, because none
  changes the state model it builds. Three are needed earlier:
  - question 2 (run the reconcile migration now) decides whether the migration tool's first report
    comes to the owner during workflow 2;
  - question 4 (a red main) must be settled before workflow 3 builds the merge queue;
  - question 5 (what counts as a manual touch) must be settled before workflow 2's events unit
    lands.
- **Workflow 2** builds U1 first, then U2 (the state model, table and triage), U3 (reconcile and
  the migration tool) and U4 (events and manual touches), from [SPEC.md](SPEC.md) section 16.
- **Workflow 3** starts U9 with the frameless re-probe described in [SPIKES.md](SPIKES.md), before
  building the companion plugin.

## The documents

- [SPEC.md](SPEC.md): the revised spec. Section 15 records each choice it makes and the
  alternatives.
- [SPIKES.md](SPIKES.md): the three spikes in plain language.
- [FOUNDATION-MAP.md](FOUNDATION-MAP.md): what v2 builds on. Its notes on the reviewer, the triage
  and the agents' folder now point to the spec's choices.
- Working reports, outside the repo: `/persist/claude/factory-loop-v2-build/w1/critic-failures.md`,
  `critic-totality.md`, `critic-simplicity.md` and `spikes/`.

## What changed, in short

The critics agreed that the direction is right, and that the draft still charged the environment
and the loop's own failures to issues and to the owner. The revision fixes that with generic rules
or deletions, never with special cases:

- **A step's clock counts only running time.** A held step cannot time out, so `noNewWork`, a rate
  cap or a pause no longer push healthy work into triage and a park.
- **Free re-runs, once per attempt, for causes outside the issue** (a restart, a usage limit, an
  outage, a lost slot). A breaker on step failures across issues stops an outage from parking
  everything.
- **The ledger is the outbox.** A transition only stores the record, and every effect is a keyed
  action of the new state. Lost events, duplicate PRs and duplicate sub-issues cannot happen.
- **GitHub events are edges,** and rows that change nothing never block a resume.
- **Deleted:** the label mirror, the main-red hold, the reconcile mode with its approval sets and
  claim hold, inferred manual touches, five extra sources, and the second workspace design.
- **no-mistakes is fully out of the path:** out of the required factory source, the guard's
  `--patch` mode, the reviewer's definition, the agents' prompts, and the write guard's allowed
  commands.
- **The stop gate refuses while the gates fail,** as the owner decided.
- **The merge queue moves past a head that did not merge.** It updates once per outside merge,
  re-runs a flaky check once, and sends a conflict in review straight to a fixer.

## The rule count

21 rule ids, the verdict's estimate. The simplicity critic showed that the id count had stopped
measuring the layer, so SPEC.md section 14.2 now counts everything against C3's estimates:

| Measure | v1 | C3's estimate | Draft | Now |
|---|---|---|---|---|
| Rule ids | 46 | about 21 | 21 | 21 |
| Table rows | in rule code | the table as one mechanism | 47, plus 3 side events | 33, plus 2 side checks |
| Action kinds | 29 | about 15 | 23 | 23 (11 new, 12 reused) |
| Key families | about 62 | about 12 | 17 | 13 new, plus the foundation's 5 |
| Notice kinds of the new layer | about 24 in all | about 5 | 9 | 6 |
| Sources | 10 | fewer than 10 | about 15 | 10 |
| Detected touch kinds | 0 | - | 12 | 6 |
| New settings | - | - | 12 | 11 |

The spec gives the reason for each excess over C3's estimate. The text grew, from about 21,400 to
about 25,700 words, because it now cites the reason for each change. Every count of rules, rows,
kinds, families, notices and sources went down or stayed level.

## The workspace design

**One design: a companion plugin, `factory-loop-workspace`** (SPEC.md section 10).

- **Why a second plugin.** The spikes showed that the engine never runs the loop plugin's own hooks
  for agents it starts from its timer, and that a second plugin's hooks fire and can block.
- **What it does.** It starts each agent in its slot, confines its file writes and pushes, refuses
  no-mistakes and the loop's own GitHub writes, sets the 10-minute Bash timeout, and runs the stop
  gate.
- **Gone:** the draft's variant B (prompt `cd` and checks at the end of each step) and its mixed
  four-way table.
- **Fallbacks,** stated in the spec and not built:
  - a command hook in the companion's `hooks.json` for the gate, if U9's re-probe shows the long
    gate run unreliable in a second plugin's SubagentStop;
  - a separate `claude -p` process per agent, if a future engine stops applying a folder set by a
    hook;
  - the owner's fallback, if no hook route fires at all.

## Findings, one by one

59 findings: 17 from the failures critic, 28 from the totality critic and 14 from the simplicity
critic. 57 accepted, 11 of them in part; 2 rejected. "In part" names what was rejected and why.
Section numbers are SPEC.md's.

### Failures critic (`critic-failures.md`)

| Finding | Severity | Decision | Why, and where |
|---|---|---|---|
| failures/F1 Holds are not named waits; step clocks run while held | blocker | accepted | Clocks count only a step's running time, so a held step cannot time out or spend an attempt. Property 3 now reads "a running step, a planned action, or a skip line naming why it waits", with no fixed list (4.4, 17.1 properties 3 and 11) |
| failures/F2 Environment failures charged to the issue; a killed triage parks; U1 and U5 overlap | major | accepted | U1 is a free re-run once per attempt for four causes the loop holds as facts: a load, a usage limit, the breaker, a lost slot. The U rows were rewritten as four exclusive rows; triage gets one retry like any step. The park bucket was replaced by a breaker on step unknowns across issues (4.3, 5.1, 5.3) |
| failures/F3 Guard FAIL lines routed to triage when transient or loop-owned | major | accepted | In `--patch` mode the guard tags each FAIL line with a class, and each class has one outcome: `behind` goes back to Q1, `read` is unknown, `linkage` re-renders the body once, and only `policy` parks (9.3, 9.4) |
| failures/F4 Q1 cannot update twice in one seq; a failing head blocks the queue | major | accepted | `queue-update` is keyed by main's head and `queue-merge` by the PR head. The queue is ordered by the last transition, so a head that did not merge goes to the back (9.1, 9.2) |
| failures/F5 A red main holds the queue and K slots on the owner | major | accepted in part | The main-red hold is deleted (with simplicity/F5), and a failed check gets one re-run. Rejected: taking merge-queue records out of the in-flight count. With no owner wait left in merge-queue, holding capacity is the back-pressure that stops the loop building PRs that cannot merge (9.5) |
| failures/F6 CI flakes burn the fix cap; conflicting PRs get no CI | major | accepted | One re-run per failed check per round. A conflicting PR in reviewing is `not-ok(conflict)` at once and goes to a fixer (8.5, T9) |
| failures/F7 Agents can push to other branches | major | accepted | The write guard refuses a push to any ref but the record's branch on origin, any force push, branch creation and `git worktree` (10.4). The variant B part is moot |
| failures/F8 The main-checkout end-of-step check blames concurrent steps | major | accepted | No step outcome comes from the main checkout. callum-flow's guard already refuses those writes, and a tell-only tripwire names the paths and the steps in the window. Killing by agent id is not exposed by the engine, so the residue is documented (10.4, 10.7, 10.8) |
| failures/F9 Crashes, the loop's failures and the cutover's K change count as manual touches | major | accepted | Only person-sourced acts count. Operations and environment events are logged, not counted. A K change is an operation. Issues that change the loop are left out of the cutover's ten (7.2, 17.5) |
| failures/F10 Undoing a drop needs a hand edit of `control.json` | major | accepted | A drop applies only to the life it closed, so re-adding `ready` brings the issue back (4.1, 11) |
| failures/F11 Observe-mode reconcile stops every claim | major | accepted | R1 has no mode and never holds claims. Observe-first applies only to the one-shot migration (6) |
| failures/F12 The transition executor can lose its event or freeze a record | major | accepted | A transition only re-checks its trigger and stores the record. Stopping the old step (best effort) and the event are keyed entry actions of the new seq, and the next transition waits for the event. The mirror rewrite is gone (3.3, 4.5) |
| failures/F13 Designers ending on an async explorer have no rail | minor | accepted | The write guard refuses an Agent call with `run_in_background` (10.4) |
| failures/F14 A hand merge is recorded as closed without merge | minor | accepted | `pr-merged` comes before `issue-closed` in the event order (4.1) |
| failures/F15 An answer is seen only when the agent's turn ends | minor | accepted | Answer files are read every pass. A writer's `ok` is read at turn end, so the stop gate has its say first (10.8) |
| failures/F16 A re-claim of a lapsed claim reads as "a queued record" | minor | accepted | A re-claim keeps the record and its state. With no label mirror, the sweep's label edits are not touches (4.1) |
| failures/F17 The release task can hold owner tells for 6 hours | minor | accepted | The release task never waits on the owner inside its wake: a Run it that needs the owner becomes an owner item, and the task ends (11) |

### Totality critic (`critic-totality.md`)

| Finding | Severity | Decision | Why, and where |
|---|---|---|---|
| totality/T-01 Stale label and head reads give false unparks and false touches | blocker | accepted | No label mirror. Unpark comes only from a direct read made after the park label write. The loop's own heads are known from the ledger, and `queue-update` records its new head. New property 13 (3.4, 4.1, 9.2) |
| totality/T-02 Reconcile releases other devices' claims and fights their labels | blocker | accepted | R1 and the migration look only at this device's claims. `clear` leaves `In development` when another device holds a live claim. The every-pass label clean-up is deleted. New drill with two loops (3.4, 6.2, 17.3) |
| totality/T-03 GitHub events are neither edges nor conditions; one priority deadlocks resumes | blocker | accepted | GitHub events are edges: `pr-closed` compares GitHub's `closedAt` with the record. Rows that change nothing run beside the one that does. `pr-merged` ranks first. New property 12 (4.1, P1) |
| totality/T-04 The loop's PR never reaches the record; `gh pr create` is not idempotent | major | accepted | `pr` ensure lists PRs by head first, then adopts, reopens or creates. Plan sees the number in the done entry, and the row that ends reviewing writes it (8.1) |
| totality/T-05 Crash windows give false hand merges and lose events and follow-ups | major | accepted in part | Accepted: the ledger as outbox, merges attributed by head (lost entries included), a missing `merged` event logged, and comments made idempotent with a hidden key. Rejected: a tell when a person closes the issue while its PR is open. The owner closed it, and the transition note names the PR (3.3, 4.1, 4.5) |
| totality/T-06 An exhausted effect stalls a record silently | major | accepted in part | Accepted: stopping the old step is best effort, and an exhausted effect holds the record with an owner item (`stalled`) that `/factory retry N` clears. Rejected: sending it down the step's unknown path, because a retry of the step cannot fix a failing write (4.5) |
| totality/T-07 Holds do not stop timeouts; the list of holds is incomplete | major | accepted | As failures/F1: clocks count running time, with no list of holds (4.4) |
| totality/T-08 Main red counts every workflow; nothing clears it | major | accepted in part | The main-red signal is deleted with the hold, and a failed check gets one re-run. Rejected: gating PRs on required checks only. Non-required PR checks such as `publish-base-image.yml` run the image tests, and ignoring them would merge broken images (8.5, 9.5) |
| totality/T-09 Flaky CI cannot converge | major | accepted in part | One re-run per failed check per round. Rejected: a special path for a fixer's decline of a red check. The new round's re-run and reviewer cover it, with no extra rule (8.5, 8.6) |
| totality/T-10 The queue head blocks the queue for up to about 150 minutes | major | accepted | A head that did not merge goes to the back, and triage is out of the queue order. The head has no clock of its own: its waits on GitHub are bounded, which also covers `blocked`, `unknown` and `draft` (4.4, 9.1) |
| totality/T-11 Reviewing mixes the reviewer and CI | major | accepted | Review is keyed by patch and round, and reused across attempts and heads. A CI problem never re-runs the reviewer. A conflict is a not-ok. A review of a stale patch plans the new patch's review with no transition (8.4, 8.5) |
| totality/T-12 An outage parks everything in flight | major | accepted | As failures/F2: free re-runs for causes outside the issue, and the step-unknown breaker holds all agent steps and triage (5.1, 5.3) |
| totality/T-13 Free re-runs are unbounded and throw away finished work | major | accepted in part | Accepted: one free re-run per attempt; a recorded answer is read before a re-spawn; the retry's prompt names the leftovers. Rejected: R2 waiting for agent steps, because v1's drain held the factory for hours (D-15, D-53) and cut steps re-run free (5.1, 10.8) |
| totality/T-14 Record creation, claim lapse and life numbering sit outside the table | major | accepted | Row S0 makes the record from the done claim entry, so the ledger is the outbox. The life is the claim's time. A re-claim keeps the record. S1 skips issues with a record (3.3, 4.1, 14.1) |
| totality/T-15 Heartbeat, sweep and reconcile decide a ghost differently | major | accepted | One owner: R1 releases ghosts at once in act mode, so no ghost claim lapses while waiting. H1 renews records only, and the migration clears v1's ghosts before cutover (6.2) |
| totality/T-16 The reconcile digest changes every pass; one ghost freezes all claims | major | accepted | No approval sets in the loop. The migration tool approves by issue and checks each again (6.3) |
| totality/T-17 A transition can discard an answer that arrives in the same pass | major | accepted | A transition carries its trigger and re-checks it against the live ledger (3.3) |
| totality/T-18 The designer's GitHub writes repeat on retry; the guard blocks splits | major | accepted | The designer is a reader. The loop posts the brief and creates, links and labels the children in keyed effects (8.7) |
| totality/T-19 A lost slot and a branch held by another worktree have no event | major | accepted in part | Accepted: `git switch --ignore-other-worktrees` (checked locally, git 2.56.0), W2 before W1 for one issue, and a lost lease as a free re-run cause with W1 re-leasing. Rejected: a separate `slot-lost` event, because W1's rule already covers any slot-state record with no lease (10.1, 10.2) |
| totality/T-20 A writer's result is checked against stale or missing reads | major | accepted | Each writer answer is confirmed with a direct `git ls-remote`, and a failed read is unknown (10.8) |
| totality/T-21 An issue edited mid-flight has no path | minor | accepted in part | Accepted: a `linkage` FAIL re-renders the loop's body from the current Rollout. Rejected: detecting issue-body edits. The owner redirects work with `note` or a park, and detection would add a source rule (8.1, 9.3) |
| totality/T-22 An owner-added `factory:parked` is silently reverted | minor | rejected | The owner brief defines only removing the label as a signal (OB:42-44). Reading other label changes needs the mirror this revision deletes, and `/factory pause N` exists |
| totality/T-23 The grid maps a triage timeout in queued or merge-queue to a tell | minor | accepted | Timeouts belong to whichever step is running, triage included. Property 1 is over (state, step) (4.3, 4.4) |
| totality/T-24 `factory-slot kill` misses detached children | minor | accepted in part | TaskStop and the kill run at the next seq, and W2's `treehouse return` ends lingering processes. The limit is documented. Rejected: an environment marker on every Bash call. It is more mechanism than the case warrants, now that the 10-minute timeout removes the reason for pollers (10.8) |
| totality/T-25 The stop gate's timeouts can exceed the hook's, which passes silently | minor | accepted in part | Accepted: one 10-minute budget, below the hook's. A gate that cannot run is recorded as unknown, and CI decides. Rejected: the loop running the gate itself when a record is missing, because CI is the authority (OB:83) (10.6) |
| totality/T-26 The GitHub read budget has no priority | minor | accepted | Reads go in a stated order: the head, then reviewing and merge-queue, then parked, then the rest (2.4) |
| totality/T-27 Rollback with v2 in flight is undefined; the sweep misses `issue-<N>` | minor | accepted | A rollback runbook (17.5). U4 widens the sweep's merged-PR pattern to `(^\|/)issue-<N>(-\|$)` |
| totality/T-28 A previous life's pushed branch is abandoned | minor | accepted | The branch is `issue-<N>` in every life, continued from its origin head (3.5) |

### Simplicity critic (`critic-simplicity.md`)

| Finding | Severity | Decision | Why, and where |
|---|---|---|---|
| simplicity/F1 Reconcile gained an approval workflow, a claim hold and v1 inference | blocker | accepted | R1 runs every pass on v2's own facts, with no mode. v1's evidence lives only in the one-shot migration tool, deleted at the delete wave (6) |
| simplicity/F2 Agents the loop starts are still told to use no-mistakes | blocker | accepted | A v2 `COMMAND_RULE` without the exception. The prompts say the loop opens the PR. The guard refuses `no-mistakes`, `axi` and pushes to other remotes. CLAUDE.md and the template get a one-line carve-out, and a test checks that no v2 prompt names them (10.4, 10.5, U5) |
| simplicity/F3 The factory source needs the no-mistakes mirror; the guard calls no-mistakes | major | accepted | `nomistakes.runs` becomes optional in factory-state. The guard's `--patch` mode skips the run lookup, and its test asserts this (2.4, 7.3, 9.4) |
| simplicity/F4 The interim reviewer runs under the gate adjudicator's definition | major | accepted | New `agents/reviewer.md`, built from the merge adjudicator's judgement rules (8.3) |
| simplicity/F5 The main-red hold is a strict-off rule that holds capacity on a person | major | accepted | Deleted, with `mainChecks`. Open question 4 asks the owner to confirm (9.5) |
| simplicity/F6 Detected touches infer state; false touches can fail the bar | major | accepted | Six exact kinds, recorded rescues and work ops. `restart`, `agent-stop`, `slot` and `label` detection are gone (7.2) |
| simplicity/F7 Section 10 carries two designs, one resting on disproven mechanisms | major | accepted in part | Accepted: one design, a companion plugin keyed by agent id. The `gate` and `resume-agent` kinds, `act-gate.ts` and the agent map files are deleted, and callum-flow's `hooks.json` is left alone. Rejected: deleting the main-checkout tell. Both spikes recommend a backstop because Bash writes slip past file hooks (hooks spike, item 7), and it costs one existing source and one notice (10) |
| simplicity/F8 The stop gate weakens an explicit owner decision | major | accepted | It refuses while the gates fail, with no cap and one budget below the hook's (10.6) |
| simplicity/F9 The loop reads more sources than v1 | major | accepted | `labelled`, `openPrs`, `mainChecks` and `env` are dropped. Labels are read only for parked records, and open PRs once at claim. Ten sources, as v1 had (2.4) |
| simplicity/F10 The tripwire is met by moving conditions out of rule ids | major | accepted | A like-for-like table against C3's estimates, with rows counted from now on (14.2) |
| simplicity/F11 The Bash timeout goes through an image change | minor | accepted | `$.env.set` in the loop's `session.start`, plus the companion's per-call value. The image change, the `env` source, its notice and the open question are gone (10.5) |
| simplicity/F12 U1 is a special case; R2 lost the release task's protection | minor | rejected | Rejected: deleting U1. Two restarts and two usage windows in one night (G1:52, :56; V:523) would charge the environment to issues, as failures/F2 and totality/T-12 show. U1 is now bounded and covers every cause outside the issue, not one failure. Accepted: R2 waits for a running release task (14.1) |
| simplicity/F13 Dead or duplicate paths | minor | accepted | `shadow: v1`, the tool answer channel, `resume` as a note and `/factory touch` are gone (2.3, 5.2, appendix E) |
| simplicity/F14 Suffix branches recreate a branch sequence | minor | accepted | `issue-<N>` in every life (3.5) |

## Facts checked in this revision

- **Branch protection on main** requires only the `ci` context, with strict on:
  `gh api repos/cbundy/dev-system/branches/main/protection/required_status_checks` returned
  `"strict":true,"contexts":["ci"]`.
- **`noNewWork` holds designs and builds,** not only claims: "New work off: no new claims, designs
  or implementations" (`plugins/factory-loop/hooks/control.ts:300`).
- **The guard calls no-mistakes before any clause:** `pipeline-watch.sh --resolve` and
  `no-mistakes axi status` (`images/base/callum-flow-merge-guard:215-227`). Its FAIL reasons for
  read failures and `BLOCKED` are at `:360`, `:389`, `:418`, `:509`, `:526` and `:533`.
- **factory-state stops without the mirror:** "nomistakes.runs does not exist in the database"
  (`images/base/callum-flow-factory-state:532`).
- **The no-mistakes exception** is in `COMMAND_RULE` (`plugins/factory-loop/hooks/prompts.ts:148`)
  and in `agents/designer.md:22` and `agents/adjudicator.md:35`. CLAUDE.md still sends sub-agents
  to implement-issue and the pipeline (`CLAUDE.md`, "Implementation sub-agents").
- **The designer creates sub-issues and labels them `ready` itself**
  (`plugins/factory-loop/agents/designer.md:71-77`).
- **The sweep's merged-PR rule** matches `issue-<N>-` only (`images/base/callum-flow-sweep:194`).
- **The main-checkout guard** refuses any sub-agent's writes, Bash included
  (`plugins/callum-flow/hooks/forbid-main-checkout-write.sh:1-55`), and it fired for loop agents
  in the agent-folder spike.
- **The timeout spike's command held its hook frame open** while the timer spawned
  (`spikes/timeout-and-stop-gate/plugin/hooks/register.ts:59-65`). That is why SPIKES.md limits
  what its runs A4 and C show.
- **`git switch --ignore-other-worktrees -C <branch>`** succeeds where the plain switch fails with
  "already used by worktree", exit 128. This was checked in a scratch repo with git 2.56.0, and
  the repo was deleted afterwards.
- **v1's runaway protection** already has an executor breaker, three failures of a kind closing it
  for 30 minutes (`docs/factory-loop/SPEC.md` 11.4), which the step-unknown bucket extends.

## Open questions for the owner

The same ten as SPEC.md section 18, with options and a recommendation each.

1. **Does a drop close the GitHub issue?**
   - (a) No: the record closes and the labels go. The issue stays open, and re-adding `ready`
     brings it back.
   - (b) Close it as not planned.
   - *Recommend (a):* the issue is yours, and a drop is the factory stepping away.
2. **Run the reconcile migration now, before v2?**
   - (a) Build `factory-reconcile` in wave 1, show you its report, and run the releases you approve
     while both live loops stay in observe.
   - (b) Only at cutover.
   - *Recommend (a):* you called the ghosts a big gap now, and the tool needs nothing from later
     waves.
3. **Ghosts without `ready`.**
   - (a) They leave the factory, and the report names each open PR, so re-adding `ready` brings it
     back with the PR adopted.
   - (b) Adopt them into v2 records at cutover.
   - *Recommend (a):* it is your rule, and adoption keeps the work.
4. **A red main.**
   - (a) No hold: a failed check on the head gets one re-run, then a fixer, and the queue moves on,
     as your rule says.
   - (b) Hold the queue while main's required check is red, with held records leaving the
     in-flight count.
   - *Recommend (a):* with "up to date before merging" on, the head's own CI already carries
     main's state.
5. **What counts as a manual touch for the cutover bar.**
   - (a) Only what a person did to move work: work ops, recorded rescues, hand pushes, merges and
     closes, removing the parked label, and hand edits of `control.json`. Operations such as
     `mode`, `trace`, a K change or a restart are logged but not counted, and issues that change
     the loop itself are left out of the ten.
   - (b) Everything the loop did not do itself.
   - *Recommend (a):* it matches the definition in
     [#632](https://github.com/cbundy/dev-system/issues/632), and (b) fails the bar for issues
     nobody touched.
6. **Enabling the companion plugin.**
   - (a) Add `factory-loop-workspace` to the orchestrator-loop Coder template's plugin list,
     pushed by you at cutover.
   - (b) Enable it in each consumer repo's settings.
   - *Recommend (a):* one place, and the loop holds agent steps and tells you if the plugin is
     missing.
7. **Capacity.** K = 2 at cutover, then 3, and 3 as v2's default (v1's is 5).
   - *Recommend this:* C3's model meets the 12 to 22 merges a day baseline from K = 2.
8. **The release task.**
   - (a) Keep it, with the Run its folded in, never waiting on you inside its wake.
   - (b) Take releases out of the loop.
   - *Recommend (a):* your standing release authority lets the judge finish them, and no merge
     waits.
9. **Caps.** `fixCap` 3 and `maxTriages` 2 per life.
   - *Recommend both:* 3 is today's review cap, and 2 is C3's.
10. **`In development` beside the `factory:*` labels.**
    - (a) Keep it until the old orchestrator is retired.
    - (b) Drop it now.
    - *Recommend (a):* the claim, heartbeat and sweep tools rely on it.
