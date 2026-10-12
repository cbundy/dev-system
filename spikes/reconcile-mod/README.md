# reconcile-spike (throwaway, never merged)

Answers one question before any real work: can a Claude Code mod (a hooks module plugin) drive
the orchestrator loop inside a Remote Control session? It does nothing to any repo. It only
logs what it observes and shows its state in the session title.

| Check | Passes when |
|---|---|
| 1 loaded | the log has a `loaded` line and the title reads `spike · loaded ...` |
| 2 tick | a `tick` line every minute, with no gaps while the session sits idle |
| 3 title | the title updates every minute (`$.mcp.call`, no permission prompt) |
| 4 agent | `agent-spawned` then `agent-answered` lines; the `append` and `main-turn` lines after them show whether the result entered the main conversation or woke the model |
| 5 restart | after `dev-restart-self`, a second `loaded` line and ticks resume |

It runs in the throwaway Coder workspace `spike-reconcile-mod` (repo `dev-system-testbed`),
loaded through `CLAUDE_CODE_PLUGIN_DIRS` in that workspace's Claude settings, from a clone of
this branch at `/persist/spike/dev-system`.

Read the results:

```bash
coder ssh spike-reconcile-mod -- cat /persist/spike/log.jsonl
```
