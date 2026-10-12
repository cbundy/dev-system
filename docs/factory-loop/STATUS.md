# Factory loop conversion: status

Tracking issue: [Convert the issue orchestrator into a deterministic mod loop (#521)](https://github.com/cbundy/dev-system/issues/521).
Plan: [CONVERSION-BRIEF.md](https://github.com/cbundy/dev-system/blob/spike/reconcile-mod/spikes/reconcile-mod/CONVERSION-BRIEF.md).

## What needs to happen next (owner)

Choose when the conversion runs. It stopped before Phase 0 because the weekly usage window was
already at the brief's stop line. Three ways forward:

1. **Wait for the weekly reset** (Thursday 2026-10-16, 11:00 UTC), then run the brief again
   unchanged. This is the safe default.
2. **Run past the line now** by telling the session to ignore the 85% rule. The live
   orchestrators share the same weekly window: they are already in their Slow tier (85%) and stop
   taking new work at 90%. A full night of this brief would probably use up most of that margin
   and stall the factory until Thursday.
3. **Run a cheaper slice now**: Phases 0 and 1 only (inventory, spec, decisions). The brief ranks
   that first anyway ("a reviewed spec plus a tested `plan()` is worth more than an untested full
   build"). It still uses the shared weekly window, just less of it.

Nothing is blocked on anyone but the owner.

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
- **Live factory:** untouched. No workspace was modified or restarted, no labels were added,
  and no pipeline run, agent or shadow run was started.

## Decisions made without the owner

- **Stopped at exactly 85%.** The rule says "85% or more", and the bucket read 85.0, not a
  rounded-up 84.x. Carrying on would have broken the brief's own budget rule.
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
