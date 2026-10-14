# factory-loop (draft, not shipped)

The issue orchestrator as one deterministic code loop inside its Claude Code session. Every
minute it reads the factory's whole state, computes what to do with a pure `plan()` function,
and does it: claims, heartbeats, sweeps, agents, gate responses, guards, merges and the status
title. The model is woken only for judgment (sequencing a flagged merge into a release, a
re-drive, a release) and to talk to the owner; agents read the code.

- Design: [docs/factory-loop/SPEC.md](../../docs/factory-loop/SPEC.md), with the inventory of
  what it replaces ([INVENTORY.md](../../docs/factory-loop/INVENTORY.md)), the choices made
  ([DECISIONS.md](../../docs/factory-loop/DECISIONS.md)) and progress
  ([STATUS.md](../../docs/factory-loop/STATUS.md)).
- Tracking: [cbundy/dev-system#521](https://github.com/cbundy/dev-system/issues/521).

## State of this build

Both halves are built. In **observe mode** (the default) every pass reads the factory, plans,
logs its decisions and shows its status in the session title, and executes nothing: every event
its commands cause goes to a local sink. In **act mode**, once every safety rail passes (SPEC
11.2), it also carries the plan out: it keeps a ledger of what it started, runs each action
through its executor, spawns its agents (its own copies of the callum-flow adjudicator and
designer, and callum-flow's implementer and fixer), and wakes the model for judgment. Act
mode has run only in tests so far; its first real run is on `dev-system-testbed` (PLAN stage
D). The plugin is not listed in the marketplace (DECISIONS D-02).

| Piece | File | State |
|---|---|---|
| The decision table | `hooks/plan.ts` | done, pure |
| Parsers, event derivation, state assembly | `hooks/parse.ts`, `hooks/derive.ts`, `hooks/state.ts` | done, pure |
| Observe adapters | `hooks/observe.ts` | done; running as a shadow in `spike-reconcile-mod` |
| The pass driver: the store, the scheduler, the decision log, the hooks | `hooks/register.ts` | done |
| The act step and the ledger | `hooks/act.ts`, `hooks/ledger.ts`, `hooks/exec.ts` | done |
| Executors: commands, guard and merge, respond, agent spawns, prompts and reply parsers | `hooks/act-cli.ts`, `hooks/act-merge.ts`, `hooks/act-agents.ts`, `hooks/prompts.ts`, `hooks/replies.ts` | done; not yet run against real agents |
| Wakes and the answer tool | `hooks/wake.ts` | done |
| The agents' answer tools and the repair message | `hooks/agent-tools.ts`, `agents/` (the loop's adjudicator and designer, D-70) | done; no agent can reach the tools yet (SPEC 13) |
| The answer script and the contract it shares with the loop (a temporary workaround, D-74) | `bin/factory-answer`, `hooks/contract.mjs` | done; not yet run by real agents |
| Safety rails | `hooks/rails.ts` | done |
| `/factory` and the control tool | `hooks/control.ts` | done |
| The judge skill | `skills/judge/SKILL.md` | drafted; not yet tried on a real wake |
| `--once` watcher modes, the `loop` event state | `features/src/callum-tools/`, `images/base/callum-flow-event` (repo root) | done; ship in the next base image release |
| Tests | `tests/*.test.ts` (17 files) | 753 tests: scenarios with the plan's properties on every plan, parsers, each executor, the rails, the driver in the engine's test host, the answer contract the script shares, and one issue from claim to merge |
| Replay harness | `scripts/factory-loop-replay.js` (repo root) | done; results in `docs/factory-loop/REPLAY-REPORT.md` |

## Run it in observe mode

Load the folder with `claude --plugin-dir plugins/factory-loop`, or name it in
`CLAUDE_CODE_PLUGIN_DIRS`, and set `${CLAUDE_CONFIG_DIR:-~/.claude}/factory-loop/config.json`:

```json
{ "mode": "observe", "repo": "cbundy/dev-system", "runSource": "events",
  "shadowDevice": "coder-dev-system-orchestrator", "checkout": "/path/to/dev-system" }
```

Decisions go to `${CLAUDE_CONFIG_DIR}/factory-loop/<owner>__<repo>/decisions-YYYY-MM-DD.jsonl`.
Owner directives go in `control.json` beside them, best set with `/factory` (below). Create
`${CLAUDE_CONFIG_DIR}/factory-loop/OFF` to stop it within a minute.

## Run it in act mode

Act mode replaces the released orchestrator; never run both on one repo. Load the plugin as
above and set the workspace file:

```json
{ "mode": "act", "repo": "<owner>/<repo>", "checkout": "/path/to/the/repo",
  "toolsDir": "/path/to/dev-system/features/src/callum-tools",
  "binDir": "/path/to/dev-system/images/base" }
```

`toolsDir` and `binDir` point at a checkout of this branch until a base image release carries the
`--once` modes and the `loop` event state; without them the loop uses the image's tools. Then
every pass checks, before it acts:

- the checkout's `origin` is `repo`;
- `DEV_ROLE=orchestrator`, or `"allowActOutsideOrchestrator": true` in the repo's
  `.claude/factory-loop.json` (for a testbed);
- no `orchestrator-watch.sh` is armed for the repo, and none has been for 10 minutes;
- no other orchestrator workspace on the repo has sent a heartbeat in the last 2 minutes, and
  this one has a `DEV_MACHINE_NAME`;
- no other session in this workspace holds the act lock.

While any fails, the pass runs as observe mode does, the title says `observe`, and the decision
log's `rails` field says why (`executed` says whether a pass acted). An armed old watcher or
another orchestrator's heartbeat is also told to you, once each time it starts. `/factory mode
observe` or the `OFF` file stops act mode at the next pass.

## The `/factory` command

`/factory <op>` sets the loop's owner directives from any client, at once, even during a long
wake turn; in chat, the model does the same through `mcp__factory-loop__control` when you ask.
Each change is logged and asks for a pass at once. The ops:

- `status` (or no op): the last pass and the directives in force; `help` lists the ops;
- `pause <N>` / `unpause <N>`: no action at all on N, though its claim still renews;
- `skip <N>` / `noskip <N>`: never claim N;
- `priority <N...>|off`: set or clear the owner list used in [claim ordering](#claim-ordering);
- `only <N...>|off`: claim only these, in order (a tracker stands for its open sub-issues);
- `serial on|off`: one issue in flight at a time;
- `new on|off`: off starts no new claims, designs or implementations;
- `override <pct> <hours>|off`: run past the usage tiers up to pct, for up to 168 hours;
- `resume <N|run id>`: release a hold on an issue (a pending decision) or a run (an escalation,
  a merge hold, the review cap);
- `retry <N>`: let N's exhausted actions run again;
- `update [<reason>]|off`: drain, then restart this workspace once nothing is in flight;
- `drop <N>`: abandon N and stop its agents;
- `note [<N>] <text>`: an instruction the next agent prompts carry, for N or for all;
- `mode off|observe|act`: written to the workspace file, from the next pass;
- `trace on|off`: trace mode (below), written to the workspace file, from the next pass.

A malformed op changes nothing and answers with its usage.

### Claim ordering

A non-empty owner `only` list limits claims to that list, in its order. Otherwise, eligible
issues in the owner `/factory priority` list come first, in its order, followed by issues
carrying `priorityLabel` in ascending issue-number order, then the rest ascending. Issues
whose labels are unknown sort with the rest.

The label is distinct from the owner `/factory priority` command. Set `priorityLabel` in
the repo's `.claude/factory-loop.json`. See [SPEC 4.2](../../docs/factory-loop/SPEC.md#42-settings-and-defaults)
for its default and case-insensitive matching.
The label only orders eligible ready issues: blocked issues, trackers, `skipLabels`, owner
skip/pause/drop and trust checks still exclude issues. It never overrides `only`, `noNewWork`,
usage tiers or capacity. [SPEC D1](../../docs/factory-loop/SPEC.md#56-design-and-delegation-d)
defines the detailed claim guards.

## Trace mode

Every decision-log line says what triggered its pass and how long it took (`trigger`, `ms`).
For more, turn trace mode on: `/factory trace on`, `"trace": true` in the workspace file, or
`"trace": true` in the repo's `.claude/factory-loop.json` (the workspace file wins). Each pass
then writes one record to `trace-YYYY-MM-DD.jsonl` beside the decision log: each phase's time,
every command with its time, exit and bytes, which sources came from the cache, each action's
times, the wakes' latencies, and what each issue waits on and since when. The trace files are
kept under `traceMaxBytes` (100 MiB) in all: the oldest go first, and a day's file that alone
fills the cap is cut short. SPEC 12.1 explains each field, with `jq` examples.

## How agents answer

The intended design is that the loop's agents answer through validated tools
(`mcp__factory-loop__verdict`, `design` and `handoff`). But on Claude Code 2.1.296 and 2.1.299
an agent the loop spawns from its timer never reaches them (SPEC 13). So, as a **temporary
workaround**, agents record their answer with a checked script, `bin/factory-answer`: each
prompt names the script and an answer file for that one attempt, the script checks the JSON
against the same contract the tools use (`hooks/contract.mjs`) and names every problem, and the
loop reads the file when the agent's turn ends (SPEC 7.3a, DECISIONS D-74). Text stays the
fallback, and the decision log says which way each answer came (`script`, `tool`, `text`,
`repair`).

`answerChannel` picks the channel, in the repo's `.claude/factory-loop.json` or in the
workspace file (which wins): `script` (the default, the workaround), `tool` (the tools), or
`text` (the text contract alone). The tools stay registered and served whatever it says. Run the
timer-spawn probe (`docs/factory-loop/probes/timer-spawn-probe`) on each Claude Code upgrade;
once its timer-spawned agent reaches the tool, set `answerChannel` to `tool` and retire the
script. `answerTools`, the setting it replaced, is no longer read.

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
4. Run the timer-spawn probe (`docs/factory-loop/probes/timer-spawn-probe/`, its header says
   how): once an agent spawned from a timer reaches the probe's tool, the answer script can give
   way to the tools (above).

## Develop it

`npm test` runs the plugin's tests through `claude plugin test`, and ten node tests at the repo
root: `tests/factory-loop-plan.test.js` checks that `plan.ts` stays pure;
`factory-loop-agents.test.js` checks that every agent the loop spawns lists its answer tool, and
that the loop's adjudicator and designer stay the callum-flow definitions but for `tools:` and
the one sentence that lets the adjudicator run the answer script;
`factory-loop-safety.test.js` scans every string in `hooks/` and the answer script for a
forbidden command, and the script's source for any write but its one answer file;
`factory-loop-answer.test.js` runs the answer script for real: its exit codes, every problem it
names (held to the same table of cases as the loop's own reading, `tests/answer-cases.mjs`), its
atomic write and every path it must refuse, and runs the answer block of a rendered prompt
through bash as an agent copies it;
`factory-loop-judge-skill.test.js` checks the judge skill covers every wake, TELL kind and op;
and `factory-loop-respond-launch.test.js`, `factory-loop-fast-forward.test.js`,
`factory-loop-update-checkout.test.js`, `factory-loop-prune.test.js` and
`factory-loop-loop-events.test.js` run the respond launch, the fast-forward, the main checkout's
update, the daily prune and every `loop` note for real, against scratch directories. `plan.ts` also imports under plain Node, which the replay harness uses.
