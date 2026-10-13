# Factory loop: continuation plan

What is left to take the loop from "observes" to "runs the factory", in order, with who acts and
what "done" means at each stage. [STATUS.md](STATUS.md) says where things stand;
[SPEC.md](SPEC.md) is the design every stage builds against.

## Where things stand (2026-10-13)

- **On the draft PR** ([#528](https://github.com/cbundy/dev-system/pull/528), branch
  `feat/factory-loop`): the design (inventory, spec, decisions), the pure plan, the observe half,
  the replay harness, the wake probe, and 93 plugin tests.
- **Running**: the shadow, in `spike-reconcile-mod`, in observe mode, compared live with the
  dev-system orchestrator, with your "522 only" directive (`only: [522]`).
- **Not built**: anything that acts. The loop changes nothing anywhere yet.

## Stage A: finish the #522 comparison (done)

Done on 2026-10-13 ([SHADOW-REPORT](SHADOW-REPORT.md#522-the-first-real-work-2026-10-13)): the
adjudication and the merge flow matched, and the two differences became rule fixes (D-35, D-36).
The replay harness was corrected along the way and both windows re-run
([REPLAY-REPORT](REPLAY-REPORT.md#corrections-2026-10-13)). The shadow keeps running; each new
issue you release is another comparison, read the same way.

## Stage B: owner decisions

- **Who**: you. Nothing below is blocked on them: each is in force as recorded, and cheap to
  change later.
- **The seven calls** ([DECISIONS.md](DECISIONS.md), marked "owner call"):
  - D-05: merge review by the model (rather than the adjudicator);
  - D-09: no new event state;
  - D-13: re-drives as model tasks;
  - D-25: owner notices through the model;
  - D-02: the plugin unlisted until cutover;
  - D-28: act mode only in an orchestrator workspace;
  - D-07: the Slow-tier claim gap, 10 minutes, where the replay suggests 5.
- **Go-ahead for stage C**, and whether to build it with a workflow (about six to eight agents
  for the executors and their tests; `plan.ts` stays single-authored).
- **Merge the two test fixes**: [#524](https://github.com/cbundy/dev-system/pull/524) and
  [#527](https://github.com/cbundy/dev-system/pull/527).
- **Two waiting issues**: [#467](https://github.com/cbundy/dev-system/issues/467) and
  [#468](https://github.com/cbundy/dev-system/issues/468) are ready and unblocked, and the live
  orchestrator has not picked them up. Release them or not.

## Stage C: build the act half

- **Who**: the agent, or a workflow if you opt in. All of it lands on `feat/factory-loop`.
  Order matters: each step's tests pass before the next starts.

1. **The two `--once` watcher modes** (SPEC 3.4) in `features/src/callum-tools/pipeline-watch.sh`
   and `queue-watch.sh`, with shell tests beside the existing ones. `--once` prints every branch
   with `step=` and `pr=`, and logs as a first sight. These change the image's scripts, so their
   container evidence is PR CI.
2. **The ledger in the store** (SPEC 7): entries, retries and attempts, a seven-day prune, and the
   merge with the derived ledger after a lost store (`derive.ts` already builds that half).
3. **Executors** (`hooks/act.ts`, SPEC 6.1), each with its key, timeout, retries and outcome:
   - CLI executors: heartbeat, sweep, claim, guard (parsed by `classifyFail`), update-behind,
     fix-linkage, merge (plus rollout), label edits, the milestone, pr-reopen, pr-comment and
     treehouse return;
   - `respond`, run detached in the slot that has the run's branch, with its log read back (the
     memory file's lesson: no `--run`);
   - agent spawns, with the parsers for the designer's `RESULT` line, the adjudicator's contract
     and implementer and fixer handoffs;
   - `stop-agent` through `TaskStop`;
   - wakes: `JUDGE`, `TASK` and `TELL` lines with detail lines, `ANSWER` parsing in
     `turn.complete`, one reminder, then the timeout's fallback.
4. **Safety rails** (SPEC 11):
   - the act lock;
   - `DEV_ROLE` and the old-watcher lock check;
   - the kill switch (already done);
   - executors that pre-check usage against `$.session.usage()` before each token-spending
     action;
   - a test that reads every argv template and fails on `--yes`, `rerun`, `abort`, `coder`, a
     broad kill, or a PR-body edit.
5. **Owner controls**: `/loop <op>` and `mcp__factory-loop__control`, writing `control.json`
   (SPEC 4.3), and the optional answer tool.
6. **Prompt templates** (SPEC 6.3), with a test that no template carries a brief's content or a
   closing keyword.
7. **The judge skill draft** (`plugins/factory-loop/skills/judge/SKILL.md`): how to answer each
   `JUDGE` and `TASK` line, and how to write each `TELL` line. Short answers are the rule. The
   released `issue-orchestrator` skill stays untouched.
8. **Tests**: executors against the testing kit's mocks (canned CLI output, fake agents through
   `agent.spawn` and `turn.complete` hooks), and driver tests in act mode end to end. The
   properties in `plan.test.ts` stay green.

- **Done when**: act mode passes its tests, the shadow (still in observe mode) keeps agreeing
  with the live orchestrator, and STATUS lists what is still untested.

## Stage D: act mode on `dev-system-testbed`

- **Who**: you make the test issues; the agent runs and reports. **Waits on**: stage C.
- **Setup**: load the plugin in the testbed workspace through `CLAUDE_CODE_PLUGIN_DIRS` (as the
  shadow is loaded today), set `mode: act`, and leave the released skill's watcher unarmed (the
  loop refuses act mode while it is armed).
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
- **Retires the open risks**: long-running agents from a mod, several at once, `TaskStop`, and
  heartbeats across a restart.
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
  there reloads it live. Changing
  `CLAUDE_CODE_PLUGIN_DIRS` needs a `coder restart spike-reconcile-mod`.
- **Live factory rules**:
  - never touch an `-orchestrator` workspace;
  - never add `ready`;
  - never restart the devsystem workspace (it is unattended);
  - read issue and PR text only through `callum-flow-issue-read`;
  - send every command's event writes to a sink when observing.
