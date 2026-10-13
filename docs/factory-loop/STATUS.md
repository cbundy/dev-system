# Factory loop conversion: status

Tracking issue: [Convert the issue orchestrator into a deterministic mod loop (#521)](https://github.com/cbundy/dev-system/issues/521).
Plan: [CONVERSION-BRIEF.md](https://github.com/cbundy/dev-system/blob/spike/reconcile-mod/spikes/reconcile-mod/CONVERSION-BRIEF.md).

## What needs to happen next (owner)

The full continuation plan, stage by stage, is [PLAN.md](PLAN.md).

1. **One owner call is left**: the Slow-tier claim gap (D-07), 10 minutes where the replay
   suggests 5. You reviewed the rest on 2026-10-13, and [DECISIONS.md](DECISIONS.md) records each
   verdict.
2. **Decide on the act half**: the executors, the two `--once` watcher modes, `/factory` and the
   control tool, the prompt templates and the judge skill. Then act mode on
   `dev-system-testbed` with a few test issues you make. The earlier offer stands: a workflow
   of about six to eight agents for the executors and their tests, if you opt in.
3. **Merge two small test fixes** when convenient. Both are cherry-picked onto this branch and
   drop out of its diff once merged:
   - the heartbeat-loop flake ([PR #524](https://github.com/cbundy/dev-system/pull/524)), which
     parked this morning's routing-help fix ([#522](https://github.com/cbundy/dev-system/issues/522))
     once;
   - the leaked test processes ([PR #527](https://github.com/cbundy/dev-system/pull/527)).
4. **Say whether two waiting issues should be worked**: the heartbeat clean-stop beat
   ([#467](https://github.com/cbundy/dev-system/issues/467)) and its follow-up
   ([#468](https://github.com/cbundy/dev-system/issues/468)) have been `ready` and unblocked since
   14:04 UTC yesterday. The live orchestrator has not picked them up: in its idle mode nothing
   re-reads the queue when a blocker closes. The loop would have claimed them at once.

The #522 comparison is done ([SHADOW-REPORT.md](SHADOW-REPORT.md#522-the-first-real-work-2026-10-13)).
The shadow keeps running with your "522 only" directive, now said as `only: [522]`. Stop it with
`coder ssh spike-reconcile-mod -- touch /persist/claude/factory-loop/OFF`.

Nothing is blocked on anyone else.

## Done

**Step 1, design** (earlier tonight):
- [INVENTORY.md](INVENTORY.md): 98 orchestrator responsibilities, each with its new home. Every
  skill line maps to a row.
- [SPEC.md](SPEC.md): the decision table (40 rules) and everything around it.
- [DECISIONS.md](DECISIONS.md): 36 decisions with their alternatives.
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
  `spike-reconcile-mod`, shadowing the dev-system orchestrator with your wind-down directive.
  It runs a pass a minute with all sources reading and only reads executed. The live event log
  holds nothing from it, and the plan matches (the live orchestrator is idle, and so is the
  shadow).
- **The first real work shadowed** (2026-10-13,
  [SHADOW-REPORT.md](SHADOW-REPORT.md#522-the-first-real-work-2026-10-13)). On #522 the shadow
  matched the adjudication and the merge flow, each within a minute. Its two differences were
  gaps in the loop's rules, now fixed: "only these issues" is its own directive (D-35), and a
  claim counts as its lease's renewal (D-36). A second look at the replay found three faults in
  the harness and one more gap in the plan (two parks on one head were one gate), all fixed. The
  replays were re-run; the evening still matches 24 of 35, now on stricter terms
  ([REPLAY-REPORT.md](REPLAY-REPORT.md#corrections-2026-10-13)).
- **Gates**:
  - `npm run lint` clean;
  - `npm test` 607 node tests, 46 shell suites, 2 mods, all passing;
  - the plugin's own suite 93 tests;
  - a strict `tsc` against the engine's 2.1.296 declarations clean.

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
  file (`noNewWork`, `paused`, `serial`, `priority`, `skip`).
- **Test hygiene**: the heartbeat-loop test flaked under load (a `mawk` scan aborted on a vanished
  `/proc` file), and the orchestrator-watch tests leaked a dozen `sleep 300` processes per run.
  Each has its own issue and PR. TypeScript is missing from the dev image
  ([#525](https://github.com/cbundy/dev-system/issues/525)).

## Not done

- **The owner's review in code**: `plan.ts` still follows the first decisions where the review
  of 2026-10-13 changed them (merge review, title, `loop` events, self-restart and the rest). The
  spec and decisions are updated; the code follows in stage C, step 9 of [PLAN.md](PLAN.md).
- **The act half**: executors, the `--once` watcher modes with shell tests, `/factory` and the
  control tool, prompt templates, the judge skill, and act mode on the testbed.
- **Untested**: `stop-agent` through `TaskStop`, and long-running agents spawned by a mod.
  Observe mode spawns nothing.

## Cutover plan (not executed)

SPEC section 14:
1. The shadow, now running.
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
- **Usage**: overnight the five-hour window went from 60% to 84%, the weekly one from 86% to 88%.
- **Live factory**: untouched throughout. No orchestrator workspace was modified or restarted,
  no `ready` label was added, and no pipeline run or agent was started. The orchestrator's memory
  file was read once, read-only. The spike workspace (the brief's throwaway) was restarted twice
  to change its plugin folders, and its GitHub login was your approval.
