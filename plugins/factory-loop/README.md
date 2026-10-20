# factory-loop

The issue orchestrator as one deterministic code loop inside its Claude Code session. Every
minute it reads the factory's whole state, computes what to do with a pure `plan()` function,
and does it: claims, heartbeats, sweeps, agents, gate responses, guards, merges and the status
title. The model is woken only for judgment (the hourly release review) and to talk to the owner;
agents read the code.

- Design: [docs/factory-loop/v2/SPEC.md](../../docs/factory-loop/v2/SPEC.md) (its section 13 is the
  foundation), and the standing decisions
  behind it ([DECISIONS.md](../../docs/factory-loop/DECISIONS.md)).
- Tracking: [cbundy/dev-system#521](https://github.com/cbundy/dev-system/issues/521).

## State of this build

Both halves are built. In **observe mode** (the default) every pass reads the factory, plans,
logs its decisions and shows its status in the session title, and executes nothing: every event
its commands cause goes to a local sink. In **act mode**, once every safety rail passes (v2 SPEC
13.11.2), it also carries the plan out: it keeps a ledger of what it started, runs each action
through its executor, starts its agents (its own, `agents/`), and wakes the model for judgment. The plugin is listed in the marketplace.

| Piece | File | State |
|---|---|---|
| The decision table | `hooks/v2/` (the rules) and `hooks/foundation.ts` (what they share), pure | done |
| Parsers, event derivation, state assembly | `hooks/parse.ts`, `hooks/derive.ts`, `hooks/state.ts` | done, pure |
| Observe adapters | `hooks/observe.ts` | done; running as a shadow in `spike-reconcile-mod` |
| The pass driver: the store, the scheduler, the decision log, the hooks | `hooks/register.ts` | done |
| The act step and the ledger | `hooks/act.ts`, `hooks/ledger.ts`, `hooks/exec.ts` | done |
| Executors: commands, the rollout read, v2's effects and agent steps, prompts and reply parsers | `hooks/act-cli.ts`, `hooks/act-merge.ts`, `hooks/v2/act-*.ts`, `hooks/v2/steps*.ts`, `hooks/prompts.ts`, `hooks/replies.ts` | done |
| Wakes and the answer tool | `hooks/wake.ts` | done |
| The agents' answer tool definitions and the loop's agent definitions | `hooks/agent-tools.ts`, `agents/` | done; unused by the loop, which answers by script |
| The answer script and the contract it shares with the loop (a temporary workaround, D-74) | `bin/factory-answer`, `hooks/contract.mjs` | done; not yet run by real agents |
| Safety rails | `hooks/rails.ts` | done |
| `/factory` and the control tool | `hooks/control.ts` | done |
| The judge skill | `skills/judge/SKILL.md` | drafted; not yet tried on a real wake |
| `--once` watcher modes, the `loop` event state | `features/src/callum-tools/`, `images/base/callum-flow-event` (repo root) | done; ship in the next base image release |
| Tests | [tests/](tests/) | scenarios with the plan's properties on every plan, parsers, each executor, the rails, the driver in the engine's test host, the answer contract the script shares, and one issue from claim to merge |
| Replay harness | `scripts/factory-loop-replay.js` (repo root) | done; writes only to the `--out` folder it is given |

## Run it in observe mode

Load the folder with `claude --plugin-dir plugins/factory-loop`, or name it in
`CLAUDE_CODE_PLUGIN_DIRS`, and set `${CLAUDE_CONFIG_DIR:-~/.claude}/factory-loop/config.json`:

```json
{ "mode": "observe", "repo": "cbundy/dev-system", "runSource": "events",
  "shadowDevice": "coder-dev-system-orchestrator", "checkout": "/path/to/dev-system" }
```

Decisions go to `${CLAUDE_CONFIG_DIR}/factory-loop/<owner>__<repo>/decisions-YYYY-MM-DD.jsonl`.
Each pass also rewrites `settings.json` beside them: the settings in force and where each came from.
Owner directives go in `control.json`, best set with `/factory` (below). Create
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
- `config`: the settings the loop runs with, grouped, each with its source (default, repo, workspace,
  plugin or directive), read-only; "what is this factory's config?" is answered with it;
- `pause <N>` / `unpause <N>`: no action at all on N, though its claim still renews;
- `skip <N>` / `noskip <N>`: never claim N;
- `priority <N...>|off`: claim these first, in order; the rest go by score (highest first), where the `priorityLabel` label (default `priority`) is one factor among bug, what it unblocks, its epic, waiting time and earlier failed lives (weights: `queueScore`);
- `only <N...>|off`: claim only these, in order (a tracker stands for its open sub-issues);
- `serial on|off`: one issue in flight at a time;
- `new on|off`: off starts no new claims, designs or implementations;
- `override <pct> <hours>|off`: run past the usage tiers up to pct, for up to 168 hours;
- `resume <N...> ["note"]`: unpark issues that are parked, with an optional note for their next step;
  on an issue that is not parked it changes nothing. See
  [the owner ops](../../docs/factory-loop/v2/SPEC.md#appendix-e-owner-ops) for what each op does;
- `retry <N>`: let N's exhausted actions run again;
- `update [<reason>]|off`: winds down (up to windDownMinutes), then restarts this workspace;
- `drop <N>`: abandon N and stop its agents;
- `note [<N>] <text>`: an instruction the next agent prompts carry, for N or for all;
- `mode off|observe|act`: written to the workspace file, from the next pass;
- `trace on|off`: trace mode (below), written to the workspace file, from the next pass.

A malformed op changes nothing and answers with its usage.

## Trace mode

Every decision-log line says what triggered its pass and how long it took (`trigger`, `ms`).
For more, turn trace mode on: `/factory trace on`, `"trace": true` in the workspace file, or
`"trace": true` in the repo's `.claude/factory-loop.json` (the workspace file wins). Each pass
then writes one record to `trace-YYYY-MM-DD.jsonl` beside the decision log: each phase's time,
every command with its time, exit and bytes, which sources came from the cache, each action's
times, the wakes' latencies, and what each issue waits on and since when. The trace files are
kept under `traceMaxBytes` (100 MiB) in all: the oldest go first, and a day's file that alone
fills the cap is cut short. [v2 SPEC 13.12.1](../../docs/factory-loop/v2/SPEC.md#13121-trace-mode) explains each field, with `jq` examples.

## How agents answer

The intended design is that the loop's agents answer through validated tools
(`mcp__factory-loop__verdict`, `design` and `handoff`). But on Claude Code 2.1.296 and 2.1.299
an agent the loop spawns from its timer never reaches them ([v2 SPEC 13.13](../../docs/factory-loop/v2/SPEC.md#1313-known-gaps-and-risks)). So, as a **temporary
workaround**, agents record their answer with a checked script, `bin/factory-answer`: each
prompt names the script and an answer file for that one attempt, the script checks the JSON
against the same contract the tools use (`hooks/contract.mjs`) and names every problem (a design wait's
conditions are also checked on GitHub, `hooks/v2/wait-check.mjs`), and the
loop reads the file when the agent's turn ends (v2 SPEC 13.7.3a, DECISIONS D-74). Text stays the
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
[spike](../../docs/spikes/reconcile-mod/FINDINGS.md)
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

A test that drives the engine (`async ($, on) =>`) passes `ENGINE_TEST` from `tests/host.ts` as its second argument: the plugin loads afresh per test and the passes are CPU, so the kit's 5 s wall-clock default fails on a loaded machine. It is a budget, not a retry, and `tests/factory-loop-test-timeouts.test.js` fails `npm test` without it.

`npm test` runs the plugin's tests through `claude plugin test`, and ten node tests at the repo
root: `tests/factory-loop-plan.test.js` checks that `foundation.ts` and v2's planner stay pure;
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
and `factory-loop-prune.test.js` and `factory-loop-loop-events.test.js` run the daily prune and
every `loop` note for real, against scratch directories. `foundation.ts` also imports under plain
Node, which the replay harness uses.
