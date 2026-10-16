# Factory loop v2 verification

The tools and records used to verify the v2 factory loop before cutover (docs/factory-loop/v2/SPEC.md,
section 17): fault drills run against a throwaway repo by a real loop in its own Coder workspace, and a
simulation of the recorded night of 2026-10-14/15.

Nothing here runs in CI or in `npm test`. The shell scripts and the JavaScript are checked by `npm run lint`.

## The setup

- **Scratch repo** `cbundy/dev-system-scratch` (public, throwaway). A small consumer repo seeded from
  the testbed, with a `ci` check (lint and tests, about 2 minutes on purpose so the merge queue sees a
  real wait), branch protection with "up to date before merging", the v2 labels, and
  `.claude/factory-loop.json` (gate commands, K = 2). Its clean state is the tag `drill-base`.
- **Test loop** in the Coder workspace `dev-system-testbed-loop`. The session runs the branch build
  from a dedicated checkout `/persist/claude/loop/dev-system-v2` (plugins `factory-loop`,
  `factory-loop-workspace` and `callum-flow` loaded from there with `CLAUDE_CODE_PLUGIN_DIRS`),
  in the scratch repo's checkout `/workspaces/dev-system-scratch`, with planner v2. Its loop dir is
  `/persist/claude/factory-loop/cbundy__dev-system-scratch` (decision log, companion log), its
  config is `/persist/claude/factory-loop/config.json`, its events go to
  `/persist/events/cbundy__dev-system-scratch.jsonl`, and `/persist/claude/factory-loop/OFF` is the
  kill switch. How it was built is in `results/2026-10-15-testbed-setup.md`.
- The live loops (`dev-system-loop`, `plant-console-loop`) are never touched by any of this.

You need the `coder` CLI logged in and `gh` logged in as the repo owner.

## Files

| File | What it does |
|---|---|
| `scratch-reset.sh` | Puts the scratch repo back to `drill-base`: closes PRs, strips labels and closes issues, deletes branches, force-moves main, restores protection from `scratch-protection.json`. `--dry-run` previews. Run only while the test loop is off. |
| `testbed-check.sh` | Read-only health check of the test loop: logins, session, plugin handshake, config, last passes. `testbed-check.sh observe N` switches to observe for N seconds, shows the passes, then back to off. |
| `drills/setmode.sh` | Sets the test loop's mode (`off`, `observe`, `act`). |
| `drills/setpace.sh` | Sets the test loop's pass timer (`10s`, or `default`). |
| `drills/outside-push.sh` | A person's unrelated push to the scratch repo's main, for the outside-merge drills. |
| `drills/obs.sh` | Snapshot: last passes, recent events, companion log, leased slots, GitHub issues, PRs and branches. |
| `drills/passes.sh` | Decision-log passes by number, with actions, skips, transitions and commands. |
| `drills/timeline.sh` | Events for given issues since a time, one line each. |
| `drills/waitev.sh` | Waits (bounded) for an event or companion line matching a pattern. |
| `drills/agentcalls.sh` | An agent's tool calls from its transcript, with errors and refusals. |
| `drills-workflow.js.txt` | The workflow script (kept as text: a workflow body is not a standalone module, so `node --check` cannot parse it) that ran the 2026-10-15 drills: setup agents, then one operator agent (Opus, xhigh) that runs the drills from its prompt. |
| `replay/v2-sim.mjs` | Drives the real v2 planner pass by pass over the recorded night against a simulated world and checks invariants. Usage in its header. |
| `results/` | What each run found: drill notes and summary, replay report, setup logs, state snapshots. |

## Running the drills again

1. Turn the test loop off: `drills/setmode.sh off`.
2. Update the build: on the workspace, fast-forward `/persist/claude/loop/dev-system-v2` to the
   commit under test (`coder ssh dev-system-testbed-loop -- 'git -C /persist/claude/loop/dev-system-v2 pull --ff-only'`).
3. Restart the loop session so it loads the build (see `results/2026-10-15-testbed-setup.md`), then
   `testbed-check.sh observe 120` and confirm planner v2, all v2 sources ok, the companion handshake
   and the expected commit.
4. Reset the scratch repo: `scratch-reset.sh`. It closes every issue, so records left in the loop's
   store by an earlier run are closed through the loop's own path: run a short act window with no
   `ready` issue (`drills/setmode.sh act`, a few passes, then `off`); each closed issue's record closes
   and its slot is freed.
5. Run the drills. Either start `drills-workflow.js.txt` as a workflow script (update the paths at its top first:
   the integration worktree, the build folder and the notes folder), or run them by hand: create the
   drill's issue on the scratch repo, `drills/setmode.sh act`, provoke the fault, and follow it with
   `obs.sh`, `timeline.sh` and `passes.sh`.
6. Record each drill in a new dated file under `results/`, and end with `drills/setmode.sh off`.

The drill list and the expected outcome of each is section 17.3 of the spec. A drill passes when its
expected events and interventions appear in the events, and no other intervention does.

## How faults are provoked

| Drill | How |
|---|---|
| Restart mid-step | A few seconds into a build, send SIGTERM to the process group of the loop session's tmux pane on the workspace (as `dev-remote-control` stops Claude); the supervisor resumes the conversation. |
| Outside merge | `drills/outside-push.sh <label>` while a PR is in review, or while the queue head waits on CI. |
| Conflict pair | Two issues that edit the same lines of the same file. |
| Parked question | An issue whose body tells the designer to ask the owner a decision; then answer on the issue and remove `factory:parked`. |
| Ghost | `callum-flow-claim <N>` on the workspace for an issue without `ready`, then add a `factory:*` label by hand. |
| Stop gate | An issue that asks the builder to commit failing tests and end its turn before implementing. |
| Usage tier | Lower `usageSlowPct`, `usageStopNewPct` and `usageStopAllPct` in the config below current usage during a step, then remove them. |
| Breaker | Set `reviewerModel` to a model that does not exist, with two issues heading for review. |

## What is not scripted yet

- The issue texts live only as summaries in the results, and pass or fail is judged by reading the
  events and decision log. The next step is one folder per drill with its issue text, its fault as a
  script, and its expected events and interventions as data, plus a checker that reads the events
  and says pass or fail. The operator agent then only starts drills and looks into failures.
- 11 of the 20 drills in the spec have not been run: a flaky check, a store wipe, new work off for
  2 hours, a PR closed by hand, an issue closed mid-build, a hand push to a branch, a leftover
  background process, the guard refusing a write or push, the companion disabled, two loops on two
  devices, a reviewer that always asks for changes, and a triage that times out.
