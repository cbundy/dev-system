# Factory loop conversion: status

Tracking issue: [Convert the issue orchestrator into a deterministic mod loop (#521)](https://github.com/cbundy/dev-system/issues/521).
Plan: [CONVERSION-BRIEF.md](https://github.com/cbundy/dev-system/blob/spike/reconcile-mod/spikes/reconcile-mod/CONVERSION-BRIEF.md).

## What needs to happen next

The full continuation plan, stage by stage, is [PLAN.md](PLAN.md). Stage D is done: the "loop
rewrite v0.1" build is ready to merge, and cutover is next.

1. **You merge the PR** ([#528](https://github.com/cbundy/dev-system/pull/528)). It is up to date
   with main and its CI is green. Merging changes nothing live: the factory-loop plugin is not in
   the marketplace, and the live factory keeps running the released orchestrator until cutover.
2. **You release 0.36.0 with base image 2.31.0** (your decision, 2026-10-14). The image carries
   the watcher `--once` modes and the `loop` event state the loop reads. 1.0.0 waits for the
   cutover, because every consumer's `semver:0.x` range must change for it.
3. **Then cutover** (stage E in [PLAN.md](PLAN.md)), one step at a time, each with your go-ahead.

Nothing is blocked on anyone else. The testbed loop in `spike-reconcile-mod` is stopped with its
kill switch (`/persist/claude/factory-loop/OFF`), set at 13:28 UTC on 2026-10-14.

Two older asks are still open, and nothing waits on them: the two small test fixes
([PR #524](https://github.com/cbundy/dev-system/pull/524) and
[PR #527](https://github.com/cbundy/dev-system/pull/527), cherry-picked onto this branch), and
whether to work the heartbeat clean-stop beat
([#467](https://github.com/cbundy/dev-system/issues/467)) and its follow-up
([#468](https://github.com/cbundy/dev-system/issues/468)).

## Stage D: act mode on the testbed (2026-10-13 and 14, done)

Six runs on `cbundy/dev-system-testbed`, each a set of conflict pairs and throughput issues, each
run's findings fixed before the next:

- **Run 1** (stage C build): 5 of 8 merged in 75 minutes.
- **Run 2** ([TESTBED-RUN2.md](TESTBED-RUN2.md)): 9 of 12 in 67 minutes; six bugs filed in the
  "loop rewrite v0.1" milestone.
- **Run 3** ([TESTBED-RUN3.md](TESTBED-RUN3.md)): 12 of 12, 10 in the first 47 minutes; six more
  bugs found and fixed, among them the Claude Code engine bug behind the answer script.
- **Runs 4 and 5** ([TESTBED-RUN5.md](TESTBED-RUN5.md)): run 4 stopped on the testbed's Codex
  pin; run 5 merged 12 of 12 in 45 minutes, 10 of them in 13, with every answer through the
  script, an environment re-run and an owner decision end to end.
- **Run 6** ([TESTBED-RUN6.md](TESTBED-RUN6.md)), on a testbed updated to the 0.35.0 templates:
  9 of 12; the last three were escalated to the owner and none is a loop bug. Usage tiering
  paused and resumed the loop by itself.

The release ([milestone "loop rewrite v0.1"](https://github.com/cbundy/dev-system/milestone/47))
holds 21 issues: 20 built and proven, and the registered answer tools
([#548](https://github.com/cbundy/dev-system/issues/548)) built but off until Claude Code lets a
timer-spawned agent reach a plugin's own tools
([#560](https://github.com/cbundy/dev-system/issues/560)). The scripted testbed reset
([#565](https://github.com/cbundy/dev-system/issues/565)) moved out of the release. The owner
approved every choice made without them, D-40 to D-74 ([DECISIONS.md](DECISIONS.md)).

Filed for after the release: the watcher's 8 seconds a pass
([#562](https://github.com/cbundy/dev-system/issues/562)), a factory janitor
([#564](https://github.com/cbundy/dev-system/issues/564)), an orchestrator end-to-end suite
([#566](https://github.com/cbundy/dev-system/issues/566)), traceability
([#567](https://github.com/cbundy/dev-system/issues/567)), issue selection
([#568](https://github.com/cbundy/dev-system/issues/568)), release issues that wait on the owner
([#569](https://github.com/cbundy/dev-system/issues/569)), moving a rebased worktree without a
fixer ([#570](https://github.com/cbundy/dev-system/issues/570)), the `Co-Authored-By` and
no-mistakes amend abort ([#571](https://github.com/cbundy/dev-system/issues/571)) and moving the
fleet to no-mistakes 1.95 ([#572](https://github.com/cbundy/dev-system/issues/572)).

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
- Environment escalation retry was introduced (#537, D-64); current resume routing is defined
  in [SPEC 5.4](SPEC.md#54-pipeline-gates-p), as amended by D-76.
- A repair re-guards at once, a guard failure is judged once rather than at every re-check, and
  the guard expires after 5 minutes, not 30 (#550, D-65); a worktree the pipeline's own commits
  left behind is fast-forwarded rather than judged (#551, D-66). The fast-forward never moves
  the main checkout, which rule `G5` promises the loop leaves alone.

The choices made without you are D-64 (your option B, with two guards of the agent's) to D-67.
Gates on `v01/wave1`: `npm run lint` (151 files), `npm test` (633 node tests, 48 shell suites,
2 mods) and the plugin's own suite (609 tests across 14 files) all pass, with the strict type
check clean. None of it has run on the testbed yet.

## Release v0.1, wave 2 (2026-10-14)

Integrated on `v01/wave2`, on top of wave 1:

- The loop's agents answer through tools the loop checks: the adjudicator through
  `mcp__factory-loop__verdict`, the designer through `mcp__factory-loop__design`, the
  implementer and fixer through `mcp__factory-loop__handoff`. A call that breaks the contract is
  refused with every problem named, so the agent corrects it in the same turn; an accepted one
  records the answer at once. Text stays the fallback, and an answer the loop cannot read gets
  one repair message to the same agent before an attempt is spent (#548, SPEC 7.3a, D-68). Run 2
  spent four adjudicators on one gate over a line of prose; this is the fix.
- Every decision-log line says what triggered its pass and how long it took (`trigger`, `ms`).
  Trace mode, off by default and switched with `/factory trace on|off` or `trace` in the config,
  writes one timing record per pass: phases, every command, cache use, actions, wake latencies
  and what each issue waits on and since when, under a 100 MiB cap (#552, SPEC 12.1, D-69).

The adjudicator and designer reach their tools through the loop's own copies of their
definitions (plugins/factory-loop/agents/, D-70); callum-flow is unchanged.

Fixed after review:

- The reply to a repair message is kept beside the report it repairs, not written over it.
- A handoff that says gated with no run is refused.
- An agent that works on after its answer is still timed out and stopped (D-71).
- A trace file the cap cut short stays closed across reloads.
- An agent sent the repair message gets 5 minutes to resume before it counts as lost (D-71).

The choices made without you are D-68 to D-71. Gates on `v01/release`, with both waves and
their review fixes: `npm run lint` (151 files), `npm test` (637 node tests, 48 shell suites, 2
mods) and the plugin's own suite (680 tests across 16 files) all pass; the strict type check was
clean on `v01/wave2`. None of it has run on the testbed yet.

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

Written before stage D. The testbed runs proved most of this list in practice: agents spawned
from the mod, long-running agents several at once, wakes in a busy session, claims and guards on
live timing, the respond launch and the environment re-run, the fast-forward, superseded PRs, the
answer script, trace mode and the judge skill's notices. Still unproven: the registered answer
tools (off, #560), the act lease across two live sessions, and a restart for an update during a
run; none came up in the six runs. The paths stage D listed but no run exercised (a split into
sub-issues, a test-weakening WARN, the review-fix cap, a cancelled run, a restart mid-run) go to
the first real repo at cutover, with the released skill as the fallback.

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
  reconciled against a fresh list. On a ledger rebuilt from the event log across a session
  restart, a lost orphaned wake is logged once and no `loop` event is logged twice (#549, #536).
- **Wakes in a busy session**: a prompt taken as queued after the 5-second grace, drops inside
  and after it, the resend of a dropped wake or notice, and whether a wake's turn text carries an
  engine frame before its first line.
- **The act lease across two real sessions**: the `flock` compare-and-set on the real engine, a
  second session staying in observe, and a takeover once a lease expires.
- **The rails against the real thing**: the heartbeat guard against real `factory.workers` rows,
  the old-watcher check and its 10-minute quiet window against an armed `orchestrator-watch.sh`
  re-arming between turns, and the checkout check in a real consumer checkout.
- **Claims and guards on live timing**: a finished claim held against the real factory state's
  lag (#538, #547); on a live merge-ready PR, the 5-minute guard expiry, one judge per failure and
  the 30-minute reminder (#550); and guard re-checks folded over a real PR held for days: the
  store's size, that nothing outside plan, the ledger and act-merge relied on the older guard
  entries, and the replay harness against a real recorded ledger.
- **The respond launch** in a real treehouse slot with the real `no-mistakes axi respond` (tested
  with a stub in a scratch worktree), and the same launch of `env-retry`'s `no-mistakes rerun`
  with a real escalated run (#537). The `env-retry` escalate notice as the judge skill renders it
  to the owner, and the owner's resume then launching the next round (`env-retry:...:r2`).
- **The fast-forward** against real pool worktrees behind a real pipeline push (tested against
  scratch git repos, #551), including its refusal of the main worktree in a consumer's real
  layout; an `M2` fast-forward that answers `CURRENT` after a real slot was reused or switched
  between the guard and the fast-forward, then the re-guard passing; and the main checkout read
  of rule `G5` (`git symbolic-ref` and `git --no-optional-locks status`) in a consumer's real
  checkout, with its owner notice reaching the phone (#544).
- **Superseded PRs** (rule `M8`, #553): `pr-close` against a real superseded PR; on the redrive
  path end to end, that the watcher keeps listing the superseded run with its old PR beside the
  regated `<branch>-v2` run and its new PR, and that the real `gh pr view` of the replacement
  reads as the executor expects; and that in the events-only runs view, where every run shows the
  issue's current PR, it never closes anything.
- **The agents' answer tools and the repair message** (#548): that the engine loads
  `plugins/factory-loop/agents/*.md` for a plugin loaded with `--plugin-dir` and resolves
  `factory-loop:adjudicator` and `factory-loop:designer` for `$.agent.spawn`; that an agent whose
  `tools:` line names a mod tool and ToolSearch can load the deferred tool and call it, and that
  the call carries its `agentId`; that `agent.offer` hides the loop's types from the model without
  blocking the loop's own spawn of them, and that the designer copy can still spawn
  `callum-flow:explorer`; whether the engine checks a tool's input against its schema; that
  `$.session.send` at an agent's own `turn.complete` reaches it and resumes it with its
  transcript, how soon the list shows it resumed (so whether the 5-minute grace is ample), and
  how its next `turn.complete` and `completed` listing look; that `TaskStop` stops an agent whose
  entry is already done, and the list then shows it killed so its branch frees up; that a pass
  started by an accepted call (trigger `agent <id>`) behaves as in the test host; and what
  `no-mistakes axi respond` does with a finding id the gate does not have.
- **The answer script** (#561, a temporary workaround for the tools above): that adjudicators
  (gate, weakening and merge), designers, implementers and fixers run `bin/factory-answer` as
  their prompts ask, the read-only adjudicator included, and correct their JSON when it names a
  problem; that the `CLAUDE_CONFIG_DIR` their Bash sees is the one the loop's engine reads, and
  the script's path under `$.plugin.root` runs where the plugin is loaded; and that the decision
  log then shows `answer: "script"` for each, with no "reply does not parse" failures.
- **Trace mode with a real clock** (#552): action and wake times line up only off the test
  host, whose clock is frozen; the 100 MiB cap and the cut line against a real loop dir on
  `/persist`, including the `tail -c` read of a file near the cap across a real module reload;
  and the trigger merging across real timer and ping races.
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
`rails` does); the designer's `RESULT` line moves into its agent definition, and the loop's
copy of it, at cutover (D-14); until then the loop's prompt asks for it.

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
- **2026-10-13, 22:44 to 2026-10-14, 13:28**: stage D, testbed runs 1 to 6, with the "loop
  rewrite v0.1" fixes built between runs. The owner approved D-40 to D-74 at 11:53.
- **Usage**: overnight the five-hour window went from 60% to 84%, the weekly one from 86% to 88%.
- **Live factory**: untouched throughout. No orchestrator workspace was modified or restarted,
  no `ready` label was added, and no pipeline run or agent was started. The orchestrator's memory
  file was read once, read-only. The spike workspace (the brief's throwaway) was restarted twice
  to change its plugin folders, and its GitHub login was your approval. Stage C ran tests and
  read-only checks only: one sandboxed `pipeline-watch.sh --once` against the main checkout's
  real runs (its event went to a sandbox; it also made one read-only `gh pr view` and one
  `git fetch`) and a read-only replay of the #522 morning.
