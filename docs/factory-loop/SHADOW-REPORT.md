# Factory loop: shadow run

Phase 4 of the [conversion brief](https://github.com/cbundy/dev-system/blob/spike/reconcile-mod/spikes/reconcile-mod/CONVERSION-BRIEF.md).
The loop runs in observe mode in the throwaway `spike-reconcile-mod` workspace, in the
orchestrators' exact launch mode. It shadows the live dev-system orchestrator, planning as that
device from the same database and GitHub. This report covers the start, on 2026-10-12 from
23:41 UTC, and the first real work it shadowed: [#522](https://github.com/cbundy/dev-system/issues/522)
on 2026-10-13 ([below](#522-the-first-real-work-2026-10-13)).

## Headline

The shadow is live and safe:
- **Running:** a pass every minute, all eight sources reading, the status in the session title.
- **Nothing executed:** every command it ran is a read, and the live event log holds no event
  from the spike workspace.
- **Agrees:** in its first hour it planned exactly what the live orchestrator needed, which was
  nothing but a sweep. The orchestrator is wound down on your instruction, and the shadow runs
  with the same "no new work" directive.

On the first real work, #522 the next morning, it matched the adjudication and the merge flow,
and its two differences led to two rule fixes ([below](#522-the-first-real-work-2026-10-13)).
The wider evidence about decisions is the [replay](REPLAY-REPORT.md).

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

## #522: the first real work (2026-10-13)

The owner labelled [#522](https://github.com/cbundy/dev-system/issues/522) (implementer routing
help exits 2) `ready` at 08:44 UTC and told the live orchestrator to work "522 only". It was
claimed at 08:53, parked once, and merged as [PR #529](https://github.com/cbundy/dev-system/pull/529)
at 09:17. The shadow matched both decisions it can see, the adjudication and the merge flow,
within a minute each. Its two differences were real gaps in the loop's rules, both now fixed:
the owner's "522 only" could not be said in control state, and a fresh claim set off a heartbeat.
The one park was the flaky heartbeat-loop test that
[PR #524](https://github.com/cbundy/dev-system/pull/524) fixes.

| Live (UTC) | Shadow | Verdict |
|---|---|---|
| 08:53:18 claim | 08:53:01 proposed #467 | directive lag, and a gap in control state (below) |
| 08:54:23 delegate (brief at 08:54:11) | 08:54:01 waited on the designer it counts in flight | not comparable: a designer's return is not logged, and this one came between two passes |
| 08:59:30 park, 09:02:04 verdict (`FLAKY: heartbeat-loop.test.sh ... rerun passed`) | 09:00:01 to 09:02:01 adjudicator for run `01M4T7J9`, head `b5df2ed4`; dropped at 09:03:01 | matched, the first pass after the park |
| gate answered, run pushed 09:03:15 | | not comparable: observe mode cannot see an adjudicator's answer |
| 09:17:43 merge (watcher `merge_ready` 09:17:13) | 09:17:01 guard for PR #529 at `813dd499` | matched, 42 s ahead |
| no heartbeat | heartbeat from 08:54:01 | a rule gap, fixed (below) |
| no release by 09:50 | from 09:20:01, wake the model to run the release (rule `O3`) | open (below) |

Raw data: [`replay/shadow-522/`](replay/shadow-522/) (the comparison and the shadow's decision
lines from 08:45 to 09:25) and [`replay/morning-522/`](replay/morning-522/) (the window replayed
with the fixed rules).

**The claim.** At 08:52 the owner had lifted "no new work" on the shadow, and the "522 only"
directive reached it only at 09:00. So at 08:53 it had no directive and proposed the
lowest-numbered ready, unblocked issue, #467, as rule `D1` should. The directive it then got was
wrong as well. Re-planning the shadow's own 08:53 state under three directives:

- **No directive**: claim #467 (what it did).
- **No new work plus priority 522** (how it was mirrored at 09:00): claim nothing. "No new work"
  blocks #522 too.
- **`only: [522]`**, new: claim #522, as the live orchestrator did.

"Work only these" is now its own directive (DECISIONS D-35), and the shadow runs with
`{"only": [522]}`.

**The heartbeat.** The live orchestrator's last renewal was at 21:00 the night before, so the
first rule asked for one on the pass after the claim, a minute into a fresh two-hour lease. A
claim now counts as its own lease's renewal (D-36). Replayed, the loop's first heartbeat falls at
09:14, 20 minutes after the claim. The live orchestrator renewed nothing: its audit tick has been
off since the wind-down, and #522's claim would have lapsed at 10:53 had the work run long.

**The park.** The adjudicator found the heartbeat-loop test failing, unrelated, and passing on a
rerun. Its note ("SIGUSR1 sleep race") matches the flake
[#523](https://github.com/cbundy/dev-system/issues/523) records, the interrupted-sleep check
after `SIGUSR1`, which PR #524 fixes. It cost this issue a park, an adjudicator and about three
minutes.

**The release.** After the merge, the `Next release` milestone held only #522 and PR #529, both
closed, with no bump set. The skill says a release is ready then: tell the owner and follow the
release process (SKILL "Releases"). The live orchestrator has not, perhaps because "522 only"
meant nothing further. The loop leaves that judgment where it is today: it wakes the model with
`TASK release`, and the model weighs the owner's directive.

**Also seen.** In the shadow's view, #467 and #468 have been ready and unblocked since their
blocker closed at 14:04 on 2026-10-12. The live orchestrator has not picked them up: in its idle
mode only the label watcher runs, and nothing re-reads the queue when a blocker closes
([REPLAY-REPORT](REPLAY-REPORT.md#corrections-2026-10-13)). The loop reads the queue every two
minutes.

**Limit of this run.** `usage-check.sh` has no token in the spike workspace
(`oauth:no-token`), so the shadow uses its session's own reading: weekly 88%, Slow, the tier the
live orchestrator was in (89%).

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
