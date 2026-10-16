# factory-loop-workspace

The factory loop's companion plugin. It is enabled beside `factory-loop` in the orchestrator-loop
workspace, and does for each agent the loop starts what the loop cannot do itself
([v2 SPEC](../../docs/factory-loop/v2/SPEC.md) section 10).

The engine never runs a plugin's hooks for anything that plugin's own code started, and the loop
starts its agents from its timer, so its own hooks never see them
([SPIKES.md](../../docs/factory-loop/v2/SPIKES.md)). A second plugin's hooks do. That is why this
is a plugin of its own.

## What it does

It acts only on a spawn whose prompt opens with `factory-slot: <absolute slot path>`, which the
loop gives every agent step under planner v2. Every other agent, the loop's v1 agents included,
is left alone.

| Hook | What it does |
|---|---|
| `agent.spawn` | Reads the slot line and the step marker `factory-step.json` that `factory-slot prepare` wrote into the slot's git dir. Starts the agent in the slot when the marker is the loop's agent's (its name `<step>-<N>-s<seq>-a<k>` and its type `factory-loop:*`); refuses the spawn when the marker is missing or names another step. Keeps the agent's id, and its children's, in `$.state`. |
| `tool.call` | The write guard. A writer writes only inside its slot (or outside the repository, such as `/tmp`); a reader writes nowhere in the repository. Every loop agent is refused GitHub writes (PRs, issues, labels, re-runs), `no-mistakes`, `axi`, a push to any remote but `origin`, and a background or isolated `Agent` call. A writer pushes only its branch, never by force, and creates no branch or worktree. A reader neither commits nor pushes. A Bash call with no timeout gets 10 minutes. |
| `classic.SubagentStop` | The stop gate. When a writer finishes, it runs the repo's `gateCommands` in the slot, one after another, within `gateTimeoutMs`. While one fails, the finish is refused with the command, its exit code and the last 150 lines of its output. A gate that cannot run lets the agent finish and is logged. |
| `session.start` | The handshake: writes `<CLAUDE_CONFIG_DIR>/factory-loop/workspace/<session>.json` with the time, again every minute (the first row or turn starts the beat when a `/reload-plugins` added the plugin). The loop holds every agent step while this session's file is missing or older than 3 minutes. |

## What it writes

- `<loop dir>/companion.jsonl`: one line per refusal (`guard:write`, `guard:push`,
  `guard:command`) and per gate run (`gate:pass`, `gate:fail`, `gate-unknown`, with the head, the
  duration and a failing command), with the issue, life and seq. The loop logs each refusal and
  each `gate-unknown` as an intervention; a gate that passed or failed is not one.
- `factory-gate.json` in the slot's git dir: the last gate result (pass, fail or unknown) with the
  slot's HEAD.
- The handshake file above. Files older than 7 days are pruned at session start.

The guard matches commands, not effects. A Bash write into another slot is not refused; each
slot is reset at its next prepare, and callum-flow's main-checkout guard covers the main
checkout.

## Enable it

The orchestrator-loop Coder template lists it beside `factory-loop` (`coder/push.sh`). On any
other machine:

```
/plugin install factory-loop-workspace@callum
```

From a shell instead: `claude plugin install factory-loop-workspace@callum --scope user`, then start
a new session.

Gate commands are repo settings: `gateCommands` (for example `["npm run lint", "npm test"]`) and
`gateTimeoutMs` in the repo's `.claude/factory-loop.json` or the workspace config. Empty means no
gate.

## Develop it

`npm test` runs `claude plugin test` on this folder: `tests/rules.test.ts` holds the rules,
`tests/companion.test.ts` drives each hook as the engine does for an agent the loop starts.

Re-run the workspace probe (`docs/factory-loop/probes/workspace-probe/`) on each Claude Code
upgrade. Its `companion` case runs this plugin for real beside a stand-in loop.
