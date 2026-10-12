# Factory loop: shadow run, first report

Phase 4 of the [conversion brief](https://github.com/cbundy/dev-system/blob/spike/reconcile-mod/spikes/reconcile-mod/CONVERSION-BRIEF.md).
The loop runs in observe mode in the throwaway `spike-reconcile-mod` workspace, in the
orchestrators' exact launch mode. It shadows the live dev-system orchestrator, planning as that
device from the same database and GitHub. This first report covers the start, on 2026-10-12 from
23:41 UTC.

## Headline

The shadow is live and safe:
- **Running:** a pass every minute, all eight sources reading, the status in the session title.
- **Nothing executed:** every command it ran is a read, and the live event log holds no event
  from the spike workspace.
- **Agrees:** in its first hour it planned exactly what the live orchestrator needed, which was
  nothing but a sweep. The orchestrator is wound down on your instruction, and the shadow runs
  with the same "no new work" directive.

The comparison with real work comes when you resume the factory. The evidence about decisions so
far is the [replay](REPLAY-REPORT.md).

## Setup

| What | Value |
|---|---|
| Workspace | `spike-reconcile-mod`: `claude --remote-control ... --dangerously-skip-permissions --resume ...`, Claude Code 2.1.296 |
| Loaded from | `CLAUDE_CODE_PLUGIN_DIRS=/persist/claude/loop/dev-system/plugins/factory-loop` (a clone of `feat/factory-loop`; the spike mod and the wake probe were removed, and the workspace restarted to apply it) |
| `/persist/claude/factory-loop/config.json` | `mode: observe`, `repo: cbundy/dev-system`, `shadowDevice: coder-dev-system-orchestrator`, `runSource: events`, `checkout: /persist/claude/loop/dev-system`, `poolSize: 16` |
| Control (`.../cbundy__dev-system/control.json`) | `noNewWork: true`, matching your wind-down instruction to the live orchestrator (memory file, 2026-10-12) |
| Repo setting (`.claude/factory-loop.json` in the clone) | `skipLabels: ["parked"]` |
| GitHub | logged in as `cbundy` for this run (device login approved at 22:32 UTC), so labels, blockers and sub-issues are read live through `callum-flow-issue-read` |

## Checks the brief asks for

**Observe mode makes no GitHub writes, no claims, no labels, no agent spawns and no model wakes.**
Verified from its own log and from outside:

- Each decision line lists every command the pass ran. Over the first passes they are all reads:
  `callum-flow-factory-state`, `dev-query`, `callum-flow-issue-read` (`--list`, `<N>`),
  `usage-check.sh` and `callum-flow-milestone show next`. The driver has no executor code, and its
  test asserts that only reads run.
- `usage-check.sh` logs a `usage` event as a side effect. It went to the shadow's sink
  (`.../cbundy__dev-system/sink-events/`), and `factory.events` holds no event from any spike
  device since 22:00 UTC.
- No agent was spawned, and no prompt was submitted: the conversation gained only the `/rename`
  rows, with the model's note blanked.

**Every line carries `executed: false`**, and the title reads `observe`:

```text
🔄 dev-system · observe · slow 5h 80% 7d 85% · q 12 dev 0 pipe 0 merge 0
```

## What it saw and planned (23:41 to 23:47 UTC)

- **Sources**: factory, facts, runs, queue, github, usage, pool and milestone all `ok` on every pass.
- **Queue**: 12 issues labelled `ready`. None is actionable, each for a stated reason:
  - trackers, by sub-issues: #114, #223, #402;
  - a tracker, by its "Epic:" title: #340;
  - blocked by open issues: #398, #431, #432, #469, #470;
  - stage `merged` (a run-it issue still labelled `ready`): #395;
  - held only by your "no new work" directive: #467, #468. These would be claimed once new work
    resumes.
- **Planned**: one `sweep`, because the event log shows no sweep since 21:20. A quiet sweep
  leaves no trace, so this can't be compared.
- **Live orchestrator over the same window**: no decision events since 21:30 UTC (wound down).
- **Comparison** (`scripts/factory-loop-replay.js --decisions`): 0 live decisions, 1 planned action
  (the sweep): no disagreement.

## Known limits of shadowing

From the [replay](REPLAY-REPORT.md):
- **Silent approvals:** a review with zero findings is approved without verdict lines, and a park
  at the next gate on the same head is not logged. So the shadow can briefly plan an adjudication
  the live orchestrator handled silently, until the run moves on.
- **Merge flows:** guard and merge-review outcomes are not logged. The shadow shows when the
  loop would start a merge flow, not when it would finish one.

## Read it again in the morning

```sh
# the decision log so far
coder ssh spike-reconcile-mod -- 'cat /persist/claude/factory-loop/cbundy__dev-system/decisions-*.jsonl' > /tmp/shadow.jsonl
# compare it with the live orchestrator over the same window
node scripts/factory-loop-replay.js --repo cbundy/dev-system --device coder-dev-system-orchestrator \
  --from 2026-10-12T23:40:00Z --to <now, ISO> --decisions /tmp/shadow.jsonl --out /tmp/shadow-cmp
# stop it: either of these
coder ssh spike-reconcile-mod -- touch /persist/claude/factory-loop/OFF
coder ssh spike-reconcile-mod -- 'jq ".mode = \"off\"" /persist/claude/factory-loop/config.json > /tmp/c && mv /tmp/c /persist/claude/factory-loop/config.json'
```
