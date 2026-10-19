# factory-loop-workspace

The factory loop's companion plugin. It is enabled beside `factory-loop` in the orchestrator-loop
workspace, and does for each agent the loop starts what the loop cannot do itself
([v2 SPEC](../../docs/factory-loop/v2/SPEC.md) section 10).

The engine never runs a plugin's hooks for anything that plugin's own code started, and the loop
starts its agents from its timer, so its own hooks never see them
([the spike notes](../../docs/spikes/factory-loop-workspace/README.md)). A second plugin's hooks do. That is why this
is a plugin of its own.

## What it does

It acts only on a spawn whose prompt opens with `factory-slot: <absolute slot path>`, which the
loop gives every agent step. Every other agent is left alone.

| Hook | What it does |
|---|---|
| `agent.spawn` | Reads the slot line and the step marker `factory-step.json` that `factory-slot prepare` wrote into the slot's git dir. Starts the agent in the slot when the marker is the loop's agent's (its name `<step>-<N>-s<seq>-a<k>` and its type `factory-loop:*`); refuses the spawn when the marker is missing or names another step. Keeps the agent's id, and its children's, in `$.state`. |
| `tool.call` | The write guard. A writer writes only inside its slot (or outside the repository, such as its scratch folder); a reader writes nowhere in the repository. Every loop agent is refused GitHub writes (PRs, issues, labels, re-runs), `no-mistakes`, `axi`, a push to any remote but `origin`, any call in the background (Bash or `Agent`), and an isolated `Agent` call. A writer pushes only its branch, never by force, and creates no branch or worktree. A reader neither commits nor pushes. A Bash call with no timeout gets 10 minutes. A Bash call also runs with `TMPDIR`, `TMP` and `TEMP` set to the step marker's `scratch` folder (`<loop dir>/scratch/<N>-<life>-s<seq>`, made by `factory-slot prepare`), by an `export` line before the agent's own command; the guard judges the original command. A marker with no usable `scratch`, or a caller outside the map, leaves the command as it is. |
| `classic.SubagentStop` | The stop gate. When a writer finishes, it runs the repo's `gateCommands` in the slot, one after another, within `gateTimeoutMs`, after taking a turn: at most the marker's `gateConcurrency` gates run at once in the process, the rest wait in order (up to the marker's `gateWaitTimeoutMs`, then `gate-unknown`; the wait holds a host call, a short `sleep`, because the engine cuts a hook off after 10 s of its own budget, which host calls pause). While one fails, the finish is refused with the command, its exit code and the last 150 lines of its output. A gate that cannot run lets the agent finish and is logged. |
| `tool.check` | Prompts nobody answers (v2 SPEC 10.10). Calls `next(e)` once; when the call is from a mapped loop agent (or its child) and Claude Code answered `ask`, it returns a deny instead, saying the call would wait on a person nobody watches, quoting Claude Code's reason, and telling the agent to find another way or end its step saying what it needed. Any other result, and any caller not in the map (the owner's own session), is returned unchanged. |
| `classic.Notification` | A `permission_prompt` (or `worker_permission_prompt`) notification from a mapped agent is logged as a `prompt_waiting` event. Returns `next(e)` always. |
| `classic.SubagentStart` | Learns each agent's transcript path for the notes above. |
| `session.start` | The handshake: writes `<CLAUDE_CONFIG_DIR>/factory-loop/workspace/<session>.json` with the time and this process's id (its pid and start time, from `/proc/self/stat`), again every minute (the first row or turn starts the beat when a `/reload-plugins` added the plugin). The loop holds every agent step while this session's file is missing, names another process or is older than 3 minutes. The same beat writes the session's context window (`$.session.usage().context.window`) to `DEV_CONTEXT_WINDOW_DIR/<session>`, only when the session or the window changes; no window, or a failed read or write, writes nothing and never touches the handshake. |

## What it writes

- `<loop dir>/companion.jsonl`: one line per refusal (`guard:write`, `guard:push`,
  `guard:command`), per refused prompt (`prompt-denied`) and per gate run (`gate-pass`, `gate-fail`, `gate-unknown`, with the head, the
  duration, `waitMs`, `concurrency`, `startedAt` (when the gate asked for its turn, an ISO string),
  `queuedBehind` (how many held a turn or waited ahead of it; 0 when none), `clean` (the slot's tree was clean and its head did not move; null: not known) and, for a failing command, the command and `failedTests` (the failing test names parsed from its output, null for none); `gate-wait` when a gate waited for its turn), with the issue, life and seq. The loop logs each refusal, each `prompt-denied` and
  each `gate-unknown` as an intervention; a gate that passed, failed or waited is not one. It also
  reads every gate line to write one `gate_run` event per run; the companion writes no event itself.
- `callum-flow-event prompt_denied` (one per refused prompt) and `prompt_waiting` (one per prompt a
  mapped agent waits on), with the issue, branch and pr, and a note of `key=value` tokens (`life`,
  `seq`, `step`, `attempt`, `agent`, `agent_type`, `tool`, `input`, `why`, `slot`, `session`,
  `transcript`; `none` when unknown). An image whose `callum-flow-event` lacks the states still gets
  the deny and its `companion.jsonl` line. There is no `prompt_answered`: no hook shows the answer.
- `factory-gate.json` in the slot's git dir: the last gate result (pass, fail or unknown) with the
  slot's HEAD and `waitMs`.
- `${DEV_CONTEXT_WINDOW_DIR:-/tmp/dev-context-window}/<session>`: the session's context window size
  as `<integer>\n`, which the worker heartbeat pushes as `sessions[].context_window` (the
  [factory-hud](../factory-hud/README.md) mod writes the same file; sub-agents stay null).
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
`gateTimeoutMs`, `gateConcurrency` (a whole number or `auto`, one gate per 8 CPUs) and `gateWaitTimeoutMs` in the repo's `.claude/factory-loop.json` or the workspace config. Empty means no
gate.

## Develop it

`npm test` runs `claude plugin test` on this folder: `tests/rules.test.ts` holds the rules,
`tests/companion.test.ts` drives each hook as the engine does for an agent the loop starts.

Re-run the workspace probe (`docs/factory-loop/probes/workspace-probe/`) on each Claude Code
upgrade. Its `companion` case runs this plugin for real beside a stand-in loop.
