# Factory loop: continuation plan

What is left to take the loop from "observes" to "runs the factory", in order, with who acts and
what "done" means at each stage. [STATUS.md](STATUS.md) says where things stand;
[SPEC.md](SPEC.md) is the design every stage builds against.

## Where things stand (2026-10-13)

- **On the draft PR** ([#528](https://github.com/cbundy/dev-system/pull/528), branch
  `feat/factory-loop`): the design (inventory, spec, decisions), the pure plan, the observe half,
  the replay harness, the wake probe, and since stage C the act half, with 546 plugin tests.
- **Running**: the shadow, in `spike-reconcile-mod`, in observe mode, compared live with the
  dev-system orchestrator, with your "522 only" directive (`only: [522]`).
- **Not yet done**: acting anywhere. The act half is built and tested, but it has run only in
  tests; stage D is its first real run.

## Stage A: finish the #522 comparison (done)

Done on 2026-10-13 ([SHADOW-REPORT](SHADOW-REPORT.md#522-the-first-real-work-2026-10-13)): the
adjudication and the merge flow matched, and the two differences became rule fixes (D-35, D-36).
The replay harness was corrected along the way and both windows re-run
([REPLAY-REPORT](REPLAY-REPORT.md#corrections-2026-10-13)). The shadow keeps running; each new
issue you release is another comparison, read the same way.

## Stage B: owner decisions (done, two small asks left)

- **Who**: you. The owner calls and the go-ahead for stage C are settled; the two test fixes and
  the two waiting issues below are still yours, and nothing waits on them.
- **The owner calls** ([DECISIONS.md](DECISIONS.md)): all settled on 2026-10-13. The merge review
  moved to the adjudicator (D-05), the `loop` event state was added (D-09), D-28 gained a
  heartbeat guard, D-07 keeps its 10-minute gap, and D-02, D-13 and D-25 stand. Two follow-ups
  were filed: a `stuck` label for issues waiting on the owner
  ([#531](https://github.com/cbundy/dev-system/issues/531)) and an `in design` label
  ([#532](https://github.com/cbundy/dev-system/issues/532)).
- **Go-ahead for stage C**: given; it was built with a workflow of agents in three waves.
- **Merge the two test fixes**: [#524](https://github.com/cbundy/dev-system/pull/524) and
  [#527](https://github.com/cbundy/dev-system/pull/527).
- **Two waiting issues**: [#467](https://github.com/cbundy/dev-system/issues/467) and
  [#468](https://github.com/cbundy/dev-system/issues/468) are ready and unblocked, and the live
  orchestrator has not picked them up. Release them or not.

## Stage C: build the act half (done, 2026-10-13)

Built by a workflow of agents in three waves on `feat/factory-loop`, each wave committed with its
tests, then reviewed. What landed: the owner's review in the pure plan (the counts-only title,
the merge adjudicator with `judge(sequence)`, self-restart for updates, hand-merge follow-ups,
trackers inside `only` and the rest); the two `--once` watcher modes with shell tests; the
`loop` event state, with every reader of the event log treating it as bookkeeping; the ledger in
the store; every executor (commands, guard and merge, the detached respond, agent spawns with
their prompts and reply parsers, `stop-agent`, wakes and the answer tool); the safety rails;
`/factory` and the control tool; the judge skill draft; and act mode wired into the driver.
Three reviewers raised 50 findings; 49 are fixed with tests, and the last leaves only the
observe-mode event sink unpruned. The choices made without the owner are D-40 to D-60, and
[STATUS.md](STATUS.md) has the detail.

- **Done when**, checked:
  - act mode passes its tests: yes. The plugin's 546 tests, `npm test` and `npm run lint` all
    pass; the image changes get their container evidence only from the PR's CI, since there is no
    Docker here;
  - the shadow (still in observe mode) keeps agreeing with the live orchestrator: yes so far.
    On this build its first pass planned what the observe-only build planned (a sweep and the
    release task after #522), once a rebuilt merge stopped reading as an unread rollout
    (1297e9b). The live factory is idle, so the next real issue is the fuller comparison;
  - STATUS lists what is still untested: yes, under "Not yet proven".

## Stage D: act mode on `dev-system-testbed`

- **Who**: the agent filed the test issues (owner's go-ahead, 2026-10-13): one path each, as
  sub-issues of [dev-system-testbed#12](https://github.com/cbundy/dev-system-testbed/issues/12),
  none labelled `ready`. The agent sets up the workspace, runs and reports. Nothing orchestrates
  the testbed today; its only worker is `spike-reconcile-mod`, which already loads the plugin.
  **Waits on**: your review of the draft PR and your go-ahead (stage C is built).
- **Setup** in the testbed workspace:
  - load the plugin from a checkout of `feat/factory-loop` through `CLAUDE_CODE_PLUGIN_DIRS`, as
    the shadow is loaded today;
  - until a base image release carries the `--once` modes and the `loop` state, point the loop
    at that checkout's own tools in `${CLAUDE_CONFIG_DIR}/factory-loop/config.json`: `toolsDir` at
    its `features/src/callum-tools` and `binDir` at its `images/base` (SPEC 4.1, D-42). For
    example
    `{ "mode": "act", "repo": "<owner>/dev-system-testbed", "checkout": "<testbed checkout>",
    "toolsDir": "<branch checkout>/features/src/callum-tools", "binDir": "<branch checkout>/images/base" }`;
  - the role: run the session with `DEV_ROLE=orchestrator`, or set
    `"allowActOutsideOrchestrator": true` in the testbed checkout's `.claude/factory-loop.json`;
  - keep the released orchestrator's watcher unarmed: the loop stays in observe while an
    `orchestrator-watch.sh` lock for the repo is live, and for 10 minutes after it goes;
  - the rest the rails check: the checkout's `origin` is the testbed repo, the workspace has a
    `DEV_MACHINE_NAME`, and no other orchestrator workspace on the testbed repo is up. The
    decision log's `rails` field names whatever still holds act mode back.
- **Test issues**, one path each:
  - a plain merge;
  - a split into sub-issues;
  - a pending owner decision;
  - each adjudicator `ACTION` (approve, fix, skip, escalate, fixer);
  - the review-fix cap;
  - a behind-only update;
  - a conflict;
  - a test-weakening WARN;
  - a linkage FAIL;
  - each rollout (merge, run-it, keep-open);
  - a cancelled run;
  - a restart mid-run (`dev-restart-self`).
- **Retires the open risks**: agent ids from a mod's spawns, long-running agents, several at
  once, `TaskStop`, wakes in a busy session, the act lease across two sessions, and heartbeats
  across a restart: the "Not yet proven" list in [STATUS.md](STATUS.md).
- **Done when**: every path ran as SPEC 5 says, with the decision log and the factory events as
  evidence in a TESTBED-REPORT.

## Stage E: cutover, one step at a time

- **Who**: you approve each step; each ships through the normal release process (RELEASING.md).
- **Steps**:
  1. **Ship the pieces**: the `--once` modes in a base image release; the plugin listed in the
     marketplace; the judge skill; the Orchestrator template's start prompt changed from
     `/callum-flow:issue-orchestrator` to the judge skill, and its resume prompt from "re-arm
     the watcher" to "the loop resumes by itself".
  2. **One real repo** in act mode, with the released skill as the fallback: to roll back,
     create the kill switch and start `/callum-flow:issue-orchestrator` in the session.
  3. **The rest**, one repo at a time.
- **Then retire**: the watcher-arming half of the released skill, once no repo uses it.

## Housekeeping along the way

- **Fixes the comparisons found**: a watcher change so every park is logged, including a second
  park on the same head; the live orchestrator's claim-renewal gap while its audit is off; and
  its idle mode never re-reading the queue, so an issue whose blocker closes is not picked up.
  These are improvements to the released factory, each its own issue.
- **When the spike is done**: delete `spike-reconcile-mod` and revoke the GitHub token made for
  it; it holds the shadow, the clone and the device login.
- **Dev image**: TypeScript ([#525](https://github.com/cbundy/dev-system/issues/525)). Until then:
  `npm install --prefix <dir> typescript@5.6.3`, with the tsconfig from the engine declarations'
  header (plugin README, "Pinned Claude Code version").

## Picking this up in a new session

- **Branch** `feat/factory-loop`. In this workspace it is leased treehouse slot 1:
  `/workspaces/dev-system/.treehouse/dev-system-22f535/1/dev-system`.
- **Gates**: `npm run lint` and `npm test` before every push. Mods are tested by
  `claude plugin test plugins/factory-loop` inside `npm test`. No-mistakes was off for the
  2026-10-12 run, at your instruction.
- **The shadow**: config in `/persist/claude/factory-loop/config.json`, directives in
  `.../cbundy__dev-system/control.json` (now `{"only": [522]}`, matching "522 only"), decision
  logs beside them. It loads from the clone `/persist/claude/loop/dev-system`: a `git pull`
  there reloads it live, which is how it moves to the act-half build (it stays in observe mode).
  Changing
  `CLAUDE_CODE_PLUGIN_DIRS` needs a `coder restart spike-reconcile-mod`.
- **Live factory rules**:
  - never touch an `-orchestrator` workspace;
  - never add `ready`;
  - never restart the devsystem workspace (it is unattended);
  - read issue and PR text only through `callum-flow-issue-read`;
  - send every command's event writes to a sink when observing.
