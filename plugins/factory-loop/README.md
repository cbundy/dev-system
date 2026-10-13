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

This build runs the **observe half**: every minute it reads the factory, plans, logs its
decisions and shows its status in the session title. It has **no executors**, so it changes
nothing in any mode (act mode says so in its log). The plugin is not listed in the marketplace
(DECISIONS D-02).

| Piece | File | State |
|---|---|---|
| The decision table | `hooks/plan.ts` | done, pure |
| Parsers, event derivation, state assembly | `hooks/parse.ts`, `hooks/derive.ts`, `hooks/state.ts` | done, pure |
| Observe adapters and the pass driver | `hooks/observe.ts`, `hooks/register.ts` | done; running as a shadow in `spike-reconcile-mod` |
| Tests | `tests/plan.test.ts`, `tests/observe.test.ts`, `tests/driver.test.ts` | 93 scenario, property, parser and driver tests |
| Replay harness | `scripts/factory-loop-replay.js` (repo root) | done; results in `docs/factory-loop/REPLAY-REPORT.md` |
| Executors, `--once` watcher modes, `/factory`, judge skill | | next (the act half) |

## Run it in observe mode

Load the folder with `claude --plugin-dir plugins/factory-loop`, or name it in
`CLAUDE_CODE_PLUGIN_DIRS`, and set `${CLAUDE_CONFIG_DIR:-~/.claude}/factory-loop/config.json`:

```json
{ "mode": "observe", "repo": "cbundy/dev-system", "runSource": "events",
  "shadowDevice": "coder-dev-system-orchestrator", "checkout": "/path/to/dev-system" }
```

Decisions go to `${CLAUDE_CONFIG_DIR}/factory-loop/<owner>__<repo>/decisions-YYYY-MM-DD.jsonl`.
Owner directives go in `control.json` beside them (for example `{"noNewWork": true}`). Create
`${CLAUDE_CONFIG_DIR}/factory-loop/OFF` to stop it within a minute.

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
   `/rename`, agents in bypass mode, restart), as its README describes, and the wake probe
   (`docs/factory-loop/probes/wake-probe/`), which proves the judgment wake and its answers.

## Develop it

`npm test` runs the plugin's tests through `claude plugin test`, and
`tests/factory-loop-plan.test.js` (repo root) checks that `plan.ts` stays pure. `plan.ts` also
imports under plain Node, which the replay harness uses.
