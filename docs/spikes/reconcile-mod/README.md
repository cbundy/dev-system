# reconcile-spike (throwaway, never merged)

Results: [FINDINGS.md](FINDINGS.md), with the raw log in [evidence/log.jsonl](evidence/log.jsonl).
Next step, as a brief for an autonomous agent: [CONVERSION-BRIEF.md](CONVERSION-BRIEF.md).

Moved here on 2026-10-16 from the `spike/reconcile-mod` branch, where it ran. Paths in these notes are
as they were on that branch. The conclusions went into [the loop spec](../../factory-loop/v2/SPEC.md#13-the-foundation)
and [its decisions](../../factory-loop/DECISIONS.md).

Answers one question before any real work: can a Claude Code mod (a hooks module plugin) drive
the orchestrator loop inside a Remote Control session? It does nothing to any repo. It only
logs what it observes and shows its state in the session title.

| Check | Passes when |
|---|---|
| 1 loaded | the log has a `loaded` line and the title reads `spike · loaded ...` |
| 2 tick | a `tick` line every minute, with no gaps while the session sits idle |
| 3 title | the title updates every minute (`$.mcp.call`, no permission prompt) |
| 4 handback | after `touch /persist/claude/spike/handback-test.request`, a `handback-result` line two minutes later with no `mainRows` and `mainTurns: 0` (the agents reported only to the mod) |
| 5 restart | after `dev-restart-self`, a second `loaded` line and ticks resume |

It runs in the throwaway Coder workspace `spike-reconcile-mod` (repo `dev-system-testbed`),
loaded through `CLAUDE_CODE_PLUGIN_DIRS` in that workspace's Claude settings, from a clone of
this branch at `/persist/claude/spike/dev-system`.

Read the results:

```bash
coder ssh spike-reconcile-mod -- cat /persist/claude/spike/log.jsonl
```
