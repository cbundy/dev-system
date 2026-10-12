# factory-loop (draft, not shipped)

The issue orchestrator as one deterministic code loop inside its Claude Code session. Every
minute it reads the factory's whole state, computes what to do with a pure `plan()` function,
and does it: claims, heartbeats, sweeps, agents, gate responses, guards, merges and the status
title. The model is woken only for judgment (reading a PR's fix commits before a merge, a
re-drive, a release) and to talk to the owner.

- Design: [docs/factory-loop/SPEC.md](../../docs/factory-loop/SPEC.md), with the inventory of
  what it replaces ([INVENTORY.md](../../docs/factory-loop/INVENTORY.md)), the choices made
  ([DECISIONS.md](../../docs/factory-loop/DECISIONS.md)) and progress
  ([STATUS.md](../../docs/factory-loop/STATUS.md)).
- Tracking: [cbundy/dev-system#521](https://github.com/cbundy/dev-system/issues/521).

## State of this build

This build has the plan and its tests only. `hooks/register.ts` registers nothing, so loading
the plugin changes no session. The plugin is not listed in the marketplace (DECISIONS D-02).

| Piece | File | State |
|---|---|---|
| The decision table | `hooks/plan.ts` | done, pure, 72 scenario and property tests |
| Types and defaults | `hooks/types.ts`, `hooks/config.ts` | done |
| Observe adapters, executors, pass driver | `hooks/observe.ts`, `hooks/act.ts`, `hooks/register.ts` | phase 3 |
| Judge skill draft | `skills/judge/SKILL.md` | phase 3 |

## Pinned Claude Code version

Proven on **Claude Code 2.1.296**, the version the
[spike](https://github.com/cbundy/dev-system/blob/spike/reconcile-mod/spikes/reconcile-mod/FINDINGS.md)
tested in the orchestrators' exact launch mode. The mod API is early access and may change
between releases. Before running the loop on a newer Claude Code:

1. Run `npm test`: `claude plugin validate` and `claude plugin test` check this plugin against
   the new build's engine.
2. Type-check against the new declarations: load the `plugin-authoring` skill, which writes
   them and names their path, then run `tsc` with the `tsconfig.json` from that file's header,
   including `hooks/`, `types/` and `tests/`.
3. Re-run the spike's five checks in a throwaway workspace (load, timer, title through
   `/rename`, agents in bypass mode, restart), as its README describes, and the
   `$.prompt.submit` judgment wake once phase 3 adds it.

## Develop it

`npm test` runs `tests/plan.test.ts` through `claude plugin test`, and
`tests/factory-loop-plan.test.js` (repo root) checks that `plan.ts` stays pure. `plan.ts` also
imports under plain Node, which the replay harness uses.
