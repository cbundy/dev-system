# Factory loop conversion: status

Tracking issue: [Convert the issue orchestrator into a deterministic mod loop (#521)](https://github.com/cbundy/dev-system/issues/521).
Plan: [CONVERSION-BRIEF.md](https://github.com/cbundy/dev-system/blob/spike/reconcile-mod/spikes/reconcile-mod/CONVERSION-BRIEF.md).

## What needs to happen next (owner)

1. **Review the spec and the six owner calls** in [DECISIONS.md](DECISIONS.md) (merge review by
   the model, no new event state, re-drives as model tasks, owner notices through the model,
   the plugin unlisted, act mode only for the orchestrator role). Nothing is blocked on them yet:
   each is in force as recorded and can be flipped cheaply.
2. **Say whether to continue** with the replay harness (phase 2), the observe and act layers
   (phase 3) and the shadow run (phase 4). For phase 3 the earlier proposal stands: about six to
   eight agents in a workflow for the adapters, executors and their tests, if you opt in to a
   workflow; the plan itself is done.
3. **Merge the flaky-test fix** when convenient:
   [PR #524](https://github.com/cbundy/dev-system/pull/524) (closes
   [#523](https://github.com/cbundy/dev-system/issues/523)). It is cherry-picked onto this branch
   so its gates are honest, and drops out of this diff once it merges.

## Done (step 1: inventory, spec, a tested plan)

- **[INVENTORY.md](INVENTORY.md)**: 98 rows, one per orchestrator responsibility, with its new
  home. Every line of the skill (v0.35.0) maps to a row, checked by script, and so do the
  owner rules and lessons that live only in the dev-system orchestrator's memory file.
- **[SPEC.md](SPEC.md)**: the State schema, observe sources (two new `--once` watcher modes),
  config and owner control state, the decision table (39 rules), the action catalogue with keys,
  timeouts, retries and outcomes, the ledger and restart re-derivation, the judgment-wake
  protocol, owner notices, failure handling, safety rails and the cutover plan.
- **[DECISIONS.md](DECISIONS.md)**: 32 decisions with their alternatives; six marked as owner calls.
- **`plugins/factory-loop/`**: `plan.ts`, the decision table as one pure function, with types,
  defaults and a README that pins Claude Code 2.1.296. `register.ts` registers nothing yet, so
  the plugin changes no session.
- **Tests**: 72 scenario and property tests under `claude plugin test`, each citing the skill
  line or rule its expectation comes from. The properties are determinism, idempotence (re-planning
  after every action started adds nothing), tier safety, control safety, and at most one wake
  per pass. A repo node test keeps `plan.ts` pure; a mutation check showed it catches a clock
  read, a value import, an engine call and randomness.
- **Gates**: `npm run lint` clean; `npm test` 606 node tests, 46 shell suites, 2 mods, all
  passing. A strict `tsc` against the engine's 2.1.296 declarations is clean.

## Found along the way

- **Owner directives live as free text** in the orchestrator's memory file (pause these issues,
  drain one at a time, wind down, never claim trackers). The spec makes them typed control state
  (SPEC 4.3). The live orchestrator is idle tonight because of your wind-down instruction, so a
  shadow run must start with `noNewWork` set, or every claim it plans would be a false
  disagreement.
- **Cancelled runs are common, but mostly history**: 21 in the week to 2026-10-12, 18 of them
  followed by a superseded, merged or abandoned issue. The plan acts only on an issue's current
  run.
- **Usage checks write factory events** that look like the live watcher's. Observe mode sends
  every command's events to a local sink (SPEC 11.1). Two such events from this session are in
  the live log (device `coder-devsystem`).
- **The heartbeat-loop test flaked** two full runs in six: it scanned `/proc` with one `mawk`
  call, which stops at the first file a finished process left behind. Fixed in PR #524.
- **No TypeScript compiler in the dev image**: installed by hand for the type-check; filed as
  [#525](https://github.com/cbundy/dev-system/issues/525) to bake it in.

## Not done yet

- **Phase 2**: recorded real states and the replay harness against `factory.events`. `plan.ts`
  already imports under Node, which the harness needs.
- **Phase 3**: observe adapters, executors, the pass driver, the two `--once` modes with shell
  tests, the control tool and `/loop`, prompt templates, and the judge skill draft.
- **Phase 4**: the shadow run in `spike-reconcile-mod`. The work branch is already cloned there
  at `/persist/claude/loop/dev-system`; its settings still point at the spike mod.
- **Phase 5**: the draft PR. It opens when there is code to review beyond the plan.

## Untested

- `$.prompt.submit` judgment wakes and the answer tool, in the orchestrators' launch mode
  (SPEC 8.4). This is the first thing phase 3 tests.
- `stop-agent` through the `TaskStop` tool from a mod.
- Long-running agents (implementers for an hour or more, several at once) spawned by a mod.
- Everything outside `plan()`: no adapter or executor exists yet.

## Cutover plan (not executed)

SPEC section 14: the shadow run first; then act mode on `dev-system-testbed` with a few test
issues you make; then one real repo, with the released skill as the fallback (kill switch plus
`/callum-flow:issue-orchestrator`); then the rest, each step through the normal release process.

## History

- **21:08 UTC**: stopped before Phase 0. `usage-check.sh` read the weekly window at 85.0%, the
  brief's stop line.
- **21:20 UTC**: you allowed this session up to 100% usage, turned off no-mistakes for the run
  (testing and review are the agent's), and asked for setup and checks. The setup checks all
  passed: Claude Code 2.1.296 here and on the spike workspace, byte-identical replay from the
  database, the spike mod's timer steady, the spike workspace able to read the database but
  logged out of GitHub.
- **21:30 to 22:25 UTC**: step 1 (inventory, spec, decisions, the tested plan), as you asked.
  Usage went from 60% to 73% of the five-hour window and from 86% to 87% of the weekly one.
- **Live factory**: untouched throughout. No orchestrator workspace modified or restarted, no
  `ready` label added, no pipeline run, agent or shadow run started. The orchestrator's memory
  file was read once, read-only.
