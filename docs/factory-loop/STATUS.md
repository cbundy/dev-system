# Factory loop conversion: status

Tracking issue: [Convert the issue orchestrator into a deterministic mod loop (#521)](https://github.com/cbundy/dev-system/issues/521).
Plan: [CONVERSION-BRIEF.md](https://github.com/cbundy/dev-system/blob/spike/reconcile-mod/spikes/reconcile-mod/CONVERSION-BRIEF.md).

## What needs to happen next (owner)

Say when to start the phases. At 21:20 UTC the owner allowed this session to use up to 100% of
usage and asked for setup and checks only for now. Both are finished (below), so Phase 0
(inventory) waits on the owner's go-ahead. Nothing else is blocked.

The weekly window is still at 85% (resets Thursday 2026-10-16, 11:00 UTC). The live orchestrators
share it: they are in their Slow tier now and stop taking new work at 90%.

## Setup and checks (2026-10-12, 21:20 UTC)

Everything the phases depend on is in place. Every check was read-only, except the clone on the
spike workspace.

- **Branch:** `feat/factory-loop`, cut from the latest `origin/main` (6b57542) in a treehouse
  worktree. Lint and tests pass.
- **Claude Code:** 2.1.296 here and on the spike workspace, the version the spike proved. Every
  mod API the brief needs is in this build's declarations: `prompt.submit` (judgment wakes),
  `agent.spawn` and `agent.list`, `store`, `clock`, `process`, `session.usage`, `command.run`
  (`/rename`), and the `turn.complete` and `session.append` hooks.
- **Factory data:** `dev-query` reads `factory.events`. Over the last 7 days the dev-system
  orchestrator logged about 1,600 events (`agent` and `watcher` actors), enough for the replay.
- **Replay:** `callum-flow-factory-state --at <time> --format json` gives byte-identical output
  on repeated runs (2.3 s per state).
- **Spike workspace (`spike-reconcile-mod`):** running and healthy; the spike mod is still loaded.
  Its timer has ticked 81 times since 19:54. The only off-beat gaps are the five reloads and
  restarts already in FINDINGS, and every interval since the last reload at 20:41 is 60 s. That settles the "hours of idle
  ticking" risk so far. It can read the factory database, and GitHub is logged out there
  (`gh: out`), so the shadow run will use `--github off`. The work branch is cloned to
  `/persist/claude/loop/dev-system` for Phase 4. Its Claude settings still point at the spike
  mod; they change only when the shadow run starts.
- **Container drift:** this workspace's image predates two CLIs on `main`
  (`callum-flow-regate`, `callum-flow-implementer-route`), and so does the spike workspace's.
  Local work runs them from the checkout. The shadow run must not depend on them, or must call
  them from the clone.

Found during the checks, to be handled in the spec:

- **Usage checks write factory events.** Every `usage-check.sh` run logs a `usage` event as
  `actor=watcher` against the current repo. Both checks tonight show up in the dev-system log
  from device `coder-devsystem`, next to the live orchestrator's own. The shadow comparison must
  filter by device (`coder-dev-system-orchestrator`), and observe mode must not write events that
  pass for real factory events. It reads usage through `$.session.usage()` or marks its events
  as the loop's.

## What happened

- **21:08 UTC, before Phase 0:** `usage-check.sh` reported `five_hour=56 seven_day=85`. The raw
  endpoint confirmed that the all-models weekly bucket was at exactly 85.0% and resets
  2026-10-16 11:00 UTC. The brief says: "If either window is at 85% or more, stop, write
  `STATUS.md` and push."
- **Done:** read the brief, FINDINGS.md and the spike mod; created this branch,
  `feat/factory-loop`, from `origin/main` (6b57542) in a treehouse worktree; created the
  tracking issue with the phase checklist and no `ready` label.
- **Not done:** all five phases. Nothing exists yet for inventory, spec, fixtures, plugin,
  shadow run or draft PR.
- **21:20 UTC:** the owner allowed usage up to 100% for this session, turned off no-mistakes for
  this run, and asked for setup and checks only for now.
- **Live factory:** untouched. No workspace was modified or restarted, no labels were added,
  and no pipeline run, agent or shadow run was started.

## Decisions made without the owner

- **Stopped at exactly 85%.** The rule says "85% or more", and the bucket read 85.0, not a
  rounded-up 84.x. Carrying on would have broken the brief's own budget rule. The owner has
  since raised this session's limit to 100%.
- **No draft PR.** The stop rule asks only for `STATUS.md` and a push, and a PR with only this
  file would have nothing to review. The PR opens when there is work in it.
- **Work docs go in `docs/factory-loop/`.** The brief names the files but not where they go.
  This keeps them out of the shipped plugin folder (`plugins/factory-loop/`), which the
  marketplace publishes and `npm test` validates as a mod.

## Gates

`npm run lint` and `npm test` pass on this commit. The owner turned off no-mistakes for this run
(2026-10-12). Testing and review are the agent's job, and nothing is pushed to the
`no-mistakes` remote.

## Unrelated

At session start, the dev container reported that its base and dev images are behind the
published ones (running 4535e27). The workspace is unattended, so it was not restarted.
