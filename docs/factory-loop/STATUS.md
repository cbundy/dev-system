# Factory loop conversion: status

Tracking issue: [Convert the issue orchestrator into a deterministic mod loop (#521)](https://github.com/cbundy/dev-system/issues/521).
Plan: [CONVERSION-BRIEF.md](https://github.com/cbundy/dev-system/blob/spike/reconcile-mod/spikes/reconcile-mod/CONVERSION-BRIEF.md).

## What needs to happen next

The full continuation plan, stage by stage, is [PLAN.md](PLAN.md).

1. **You review the draft PR** ([#528](https://github.com/cbundy/dev-system/pull/528)). The act
   half (stage C) is built on `feat/factory-loop`: the loop can now act, but only in a session
   whose safety rails all pass, and it has not acted anywhere yet. The choices the build made
   without you are [DECISIONS.md](DECISIONS.md) D-40 to D-60. The ones most worth a look: the
   ledger kept in memory with one writer under a renewed lease (D-40), the rails failing safe
   (D-43), the update drain ending only at the next load (D-53), and merges following through
   on the loop's own bookkeeping (D-50).
2. **Then act mode on `dev-system-testbed`** (stage D). The test issues are filed, one path
   each, as sub-issues of a tracker
   ([dev-system-testbed#12](https://github.com/cbundy/dev-system-testbed/issues/12)), and none
   is labelled `ready` yet. Nothing orchestrates the testbed today: its only worker is
   `spike-reconcile-mod`, which already loads the plugin, so it is the natural place to run
   them. It waits on your go-ahead, and nothing in it touches the live factory.
3. **The shadow runs this build.** Pulled into `spike-reconcile-mod` on 2026-10-13 at 20:28, its
   first pass planned exactly what the observe-only build planned (a sweep and the release task
   after #522), with every source reading and nothing executed. A rebuilt merge had first been
   taken for an unread rollout; that was fixed (1297e9b) before this run. Its session is logged
   out of claude.ai, so Remote Control is offline there until you sign it in again.
4. **Merge two small test fixes** when convenient. Both are still open, cherry-picked onto this
   branch, and drop out of its diff once merged: the heartbeat-loop flake
   ([PR #524](https://github.com/cbundy/dev-system/pull/524)) and the leaked test processes
   ([PR #527](https://github.com/cbundy/dev-system/pull/527)).
5. **Say whether two waiting issues should be worked**: the heartbeat clean-stop beat
   ([#467](https://github.com/cbundy/dev-system/issues/467)) and its follow-up
   ([#468](https://github.com/cbundy/dev-system/issues/468)) are still open and ready, and the
   live orchestrator has not picked them up.

Nothing is blocked on anyone else. The shadow in `spike-reconcile-mod` stops with
`coder ssh spike-reconcile-mod -- touch /persist/claude/factory-loop/OFF`.

## Release v0.1, wave 1 (2026-10-14)

The first wave of the "loop rewrite v0.1" fixes, from the two testbed runs
([TESTBED-RUN2.md](TESTBED-RUN2.md)), integrated on `v01/wave1`:

- A claim that has finished but that the factory state does not show yet holds its issue (no
  second claim) and its place under the in-flight cap, `serial` and the worktree reserve, for at
  most one heartbeat interval (#538, #547).
- One `loop` event per ledger transition: a wake's turn taking its id no longer logs it twice
  (#536).
- The loop waits for an agent's final answer: a turn with no machine line from an agent still
  holding background work is interim (#545, D-67).
- A wake left open by an earlier session is lost at once and asked again, instead of blocking
  every other wake until its timeout (#549).
- A main checkout an agent moved holds new claims, agents and tasks and tells the owner once
  (rule `G5`, #544); the PR of a superseded run is closed with a link to its successor (rule
  `M8`, #553).
- A resumed escalation whose verdicts were all `ENV` reruns the same head once (`env-retry`,
  rule `P2a`, #537, D-64).
- A repair re-guards at once, a guard failure is judged once rather than at every re-check, and
  the guard expires after 5 minutes, not 30 (#550, D-65); a worktree the pipeline's own commits
  left behind is fast-forwarded rather than judged (#551, D-66). The fast-forward never moves
  the main checkout, which rule `G5` promises the loop leaves alone.

The choices made without you are D-64 (your option B, with two guards of the agent's) to D-67.
Gates on `v01/wave1`: `npm run lint` (151 files), `npm test` (633 node tests, 48 shell suites,
2 mods) and the plugin's own suite (609 tests across 14 files) all pass, with the strict type
check clean. None of it has run on the testbed yet.

## Stage C: the act half (2026-10-13)

Built in three waves, each committed with its tests, then reviewed:

- **The owner's review in the pure plan, the watchers and the judge skill**
  ([a170cb4](https://github.com/cbundy/dev-system/commit/a170cb4)): the counts-only title, the
  merge adjudicator with `judge(sequence)`, self-restart for an update with its drain,
  follow-ups for hand merges, trackers inside `only`, `task(respond-stuck)`, visible rate caps
  with no merge cap, the in-flight cap of 10 (5 since the testbed run), duration strings in the config, labels compared
  without regard to case. `pipeline-watch.sh` and `queue-watch.sh` gained their `--once` modes,
  `callum-flow-event` gained the `loop` state, and every reader of the event log now treats it
  as bookkeeping. The judge skill is drafted.
- **The act half's modules** ([9519a5f](https://github.com/cbundy/dev-system/commit/9519a5f)):
  the ledger in the store, the executors (commands, guard, merge and respond, agent spawns with
  their prompts and reply parsers), wakes and the answer tool, the safety rails, and `/factory`
  with the control tool, each tested on its own.
- **Act mode wired into the driver** ([804dbed](https://github.com/cbundy/dev-system/commit/804dbed)):
  a pass now checks the rails, keeps the ledger under the act lease, runs plan's actions through
  their executors and logs every agent and wake as a `loop` event. Three reviewers raised 50
  findings: 49 are fixed, each with a test that fails without the fix, and the last leaves only
  the observe-mode event sink unpruned. Among them: a PR that stalled after a behind-only
  update, a restart that ended its drain too early or failed in silence, heartbeats that could
  be used up, and a second agent started beside one a failed stop left running.
- **A rebuilt merge counts as read** ([1297e9b](https://github.com/cbundy/dev-system/commit/1297e9b)):
  a ledger rebuilt from the event log no longer reads every recent merge as one whose rollout
  read failed.

SPEC, DECISIONS, PLAN and the plugin README now describe the build as it is. Observe mode is
unchanged: it still executes nothing, and every event it causes goes to a sink.

**Gates**, on the branch as committed:

- `npm run lint`: `lint: 151 file(s) ok`;
- `npm test`: `test: 626 node tests, 48 shell suites, 2 mods ok`;
- the plugin's own suite (`claude plugin test plugins/factory-loop`): 546 tests across 14 files,
  all passing (93 before stage C);
- the image and feature changes (the `--once` modes, `callum-flow-event` and its readers) run in
  a container only in the PR's CI (`publish-base-image.yml`, `test-features.yml`): there is no
  Docker here.

## Not yet proven

Only a real session can show these; stage D on the testbed is where each gets proven.

- **Agents from a mod**: that `$.agent.spawn` returns an agent id (the engine's test host never
  does), that each agent's `turn.complete` carries it, and how the agent list shows an agent
  before and after its answer; and that an agent with a background sub-agent is listed
  `waiting` (or its child listed with its `parentId`) at its interim `turn.complete`, and runs
  another turn with its final answer once the child ends (#545).
- **Long-running agents** (implementers for an hour or more) and several at once, with answers
  arriving while a pass runs.
- **Stopping an agent** with `TaskStop` from a mod: its 30-second bound, the failed-stop path and
  the wait for the agent list, and what a stopped agent's late `turn.complete` looks like.
- **A restart for an update**: the ledger saved before it, running entries lost on load,
  `updateDue` cleared only once the new session loads, the first-pass heartbeat, and agents
  reconciled against a fresh list.
- **Wakes in a busy session**: a prompt taken as queued after the 5-second grace, drops inside
  and after it, the resend of a dropped wake or notice, and whether a wake's turn text carries an
  engine frame before its first line.
- **The act lease across two real sessions**: the `flock` compare-and-set on the real engine, a
  second session staying in observe, and a takeover once a lease expires.
- **The rails against the real thing**: the heartbeat guard against real `factory.workers` rows,
  the old-watcher check and its 10-minute quiet window against an armed `orchestrator-watch.sh`
  re-arming between turns, and the checkout check in a real consumer checkout.
- **The respond launch** in a real treehouse slot with the real `no-mistakes axi respond` (tested
  with a stub in a scratch worktree), and the same launch of `env-retry`'s `no-mistakes rerun`
  (#537).
- **The fast-forward** against real pool worktrees behind a real pipeline (tested against
  scratch git repos, #551), and the main checkout read of rule `G5` in a consumer's real
  checkout (#544).
- **The judge skill** against real wakes, including the new `pass-error` and `old-watcher`
  notices, and those notices reaching the phone.
- **Engine details**: a hot reload while a pass or command is in flight (whether the old
  module's pending work can save a stale ledger); timers, pings and `$.clock.after` from a `$`
  captured at load over a long session; the title under a real `/rename`, and how the engine
  stores the blanked rename note.
- **Commands live**: `gh` removing a label whose case differs from the config, `treehouse
  return` meeting end of input at a discard prompt, and the daily prune of a real loop dir on
  `/persist`.

Known gaps, small: the observe-mode event sink is never pruned; the cap of 288 recorded states a
day has no test; `/factory status` does not say why act mode is held back (the decision log's
`rails` does); the designer's `RESULT` line moves into its agent definition at cutover (D-14),
and until then the loop's prompt asks for it.

## Done before stage C

**Step 1, design** (2026-10-12):
- [INVENTORY.md](INVENTORY.md): 98 orchestrator responsibilities, each with its new home. Every
  skill line maps to a row.
- [SPEC.md](SPEC.md): the decision table and everything around it.
- [DECISIONS.md](DECISIONS.md): the choices made without the owner, with their alternatives
  (39 then, 60 now).
- `plan.ts`: one pure function, tested.

**Then your steps 1 to 3:**

- **Judgment wake proven** ([probe](probes/wake-probe/README.md)). In the orchestrators' launch
  mode a mod wakes the model in under 70 ms. A text `ANSWER` line came back three times out of
  three (2 s, about 400 tokens), and a tool answer works while the mod is stable. Hidden context
  is impossible (a mod's own hooks never see its own prompts), so wake details go in the visible
  text.
- **Observe half and replay** ([REPLAY-REPORT.md](REPLAY-REPORT.md)). Parsers, event derivation
  and state assembly, all pure, plus a harness that rebuilds past states from the database and
  GitHub's timeline. On a normal evening the loop matched every adjudication, heartbeat and merge
  flow the live orchestrator ran, and 5 of 7 claims. It proposed nothing else but quiet sweeps,
  and every other difference has a named cause. The replay drove six fixes, all tested.
- **Shadow run live** ([SHADOW-REPORT.md](SHADOW-REPORT.md)). The loop runs in observe mode in
  `spike-reconcile-mod`, shadowing the dev-system orchestrator. It runs a pass a minute with all
  sources reading and only reads executed. The live event log holds nothing from it.
- **The first real work shadowed** (2026-10-13,
  [SHADOW-REPORT.md](SHADOW-REPORT.md#522-the-first-real-work-2026-10-13)). On #522 the shadow
  matched the adjudication and the merge flow, each within a minute. Its two differences were
  gaps in the loop's rules, now fixed: "only these issues" is its own directive (D-35), and a
  claim counts as its lease's renewal (D-36). A second look at the replay found three faults in
  the harness and one more gap in the plan (two parks on one head were one gate), all fixed. The
  replays were re-run; the evening still matches 24 of 35, now on stricter terms
  ([REPLAY-REPORT.md](REPLAY-REPORT.md#corrections-2026-10-13)).
- **Your review of the decisions** (2026-10-13): every owner call settled, each verdict in
  [DECISIONS.md](DECISIONS.md). Two follow-ups are filed: a `stuck` label
  ([#531](https://github.com/cbundy/dev-system/issues/531)) and an `in design` label
  ([#532](https://github.com/cbundy/dev-system/issues/532)).

## Found along the way

- **The live orchestrator renewed no claim between about 05:00 and 13:20 UTC on 2026-10-12**
  (replay, window 2). The loop renews every 20 minutes.
- **The watcher does not log a second park on the same head** at the next gate, and a review
  with zero findings is approved without verdict lines. Neither is visible in the event log,
  which limits shadowing, not the loop. A watcher fix to log every park would help the factory's
  metrics too.
- **The orchestrator's idle mode misses unblocked issues.** With only the label watcher armed, an
  issue labelled `ready` while blocked is never picked up once its blocker closes (#467 and #468,
  since 14:04 on 2026-10-12).
- **Owner directives live as free text** in the memory file. The loop makes them a control
  file (`noNewWork`, `paused`, `serial`, `priority`, `only`, `skip` and the rest).
- **A `loop` event would have made the sweep log a second `closed`** for an issue it had closed:
  the sweep took the bookkeeping line for the issue's latest event. The sweep now ignores it,
  with a test.
- **Checking the plan's properties on every plan call**, not only on chosen scenarios, found two
  claiming bugs: planning again while a claim ran claimed again. Both are fixed.
- **Test hygiene**: the heartbeat-loop test flaked under load (a `mawk` scan aborted on a vanished
  `/proc` file), and the orchestrator-watch tests leaked a dozen `sleep 300` processes per run.
  Each has its own issue and PR. TypeScript is missing from the dev image
  ([#525](https://github.com/cbundy/dev-system/issues/525)).

## Cutover plan (not executed)

SPEC section 14:
1. The shadow, running since 2026-10-12.
2. Act mode on `dev-system-testbed` with a few test issues you make.
3. One real repo, with the released skill as the fallback (kill switch plus
   `/callum-flow:issue-orchestrator`).
4. The rest, each step through the normal release process.

## History

- **21:08 UTC**: stopped before Phase 0, the weekly window at the brief's 85% stop line.
- **21:20**: you allowed up to 100% usage and turned off no-mistakes for this run. Setup and
  checks.
- **21:30 to 22:25**: inventory, spec, decisions, the tested plan.
- **22:30**: you approved the spike workspace's GitHub login and asked for steps 1 to 3.
- **22:43 to 22:58**: the wake probe.
- **23:00 to 23:35**: the observe half and two replays.
- **23:41**: the shadow went live.
- **2026-10-13, 08:52 to 09:47**: the shadow followed #522 to its merge at 09:17; the comparison,
  two rule fixes, three harness fixes and one more plan fix.
- **13:32 to 15:18**: your review of the decisions, recorded and settled in the documents.
- **16:15**: stage C, wave 1: the owner's review in the pure plan, the `--once` watcher modes,
  the `loop` event state and the judge skill draft.
- **17:22**: wave 2: the ledger, the executors, wakes, the safety rails and the owner controls.
- **20:16**: wave 3: act mode wired into the driver, then 49 of 50 review findings fixed.
- **20:28**: a ledger rebuilt from the event log now counts its merges' rollouts as read.
- **Usage**: overnight the five-hour window went from 60% to 84%, the weekly one from 86% to 88%.
- **Live factory**: untouched throughout. No orchestrator workspace was modified or restarted,
  no `ready` label was added, and no pipeline run or agent was started. The orchestrator's memory
  file was read once, read-only. The spike workspace (the brief's throwaway) was restarted twice
  to change its plugin folders, and its GitHub login was your approval. Stage C ran tests and
  read-only checks only: one sandboxed `pipeline-watch.sh --once` against the main checkout's
  real runs (its event went to a sandbox; it also made one read-only `gh pr view` and one
  `git fetch`) and a read-only replay of the #522 morning.
