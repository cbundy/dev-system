# Factory loop v2: spike findings

Three spikes ran on 2026-10-15 (11:27 to 11:45 UTC), on Claude Code 2.1.300 in the 16-CPU dev
container. They answered the questions the v2 workspace design depended on (OWNER-BRIEF decision
6). This page gives each question, its answer, the mechanism and the evidence in plain language.
The full working reports, with every command, log and probe file, are outside the repo:

| Spike | Report | Probe files |
|---|---|---|
| Agent folder | `/persist/claude/factory-loop-v2-build/w1/spikes/agent-folder.md` | `/persist/claude/factory-loop-v2-build/w1/spikes/agent-folder/` |
| Hooks | `/persist/claude/factory-loop-v2-build/w1/spikes/hooks.md` | `/persist/claude/factory-loop-v2-build/w1/spikes/hooks/` |
| Timeout and stop gate | `/persist/claude/factory-loop-v2-build/w1/spikes/timeout-and-stop-gate.md` | `/persist/claude/factory-loop-v2-build/w1/spikes/timeout-and-stop-gate/` |

[SPEC.md](SPEC.md) section 10 is the design built on these answers.

## The short version

- **An agent can be started in its slot,** but only by a second plugin. The loop's own plugin
  cannot do it for agents it starts from its timer.
- **Hooks do fire for agents the loop starts,** and can block a write or a finish, but again not
  the loop's own hooks. Settings hooks, command hooks shipped in a plugin, and a second plugin's
  hooks all work.
- **The 10-minute Bash timeout works,** and the gates take about a minute.
- **One engine rule explains both "not the loop's own" results.** The engine never runs a plugin's
  hooks for anything that plugin's own code started, including everything an agent it spawned
  then does. The loop spawns from its own timer, so its own hooks never see its agents.
- **So v2 ships a small companion plugin,** `factory-loop-workspace`. It starts each agent in its
  slot, confines its writes, sets its Bash timeout and runs the stop gate.

## Spike 1: start an agent in its slot

**Question.** Can the loop start an agent with its working directory set to a worktree slot, so
that its Bash tool, its file tools and relative paths all resolve there?

**Answer: yes, through a second plugin.**

- The obvious route does not work. `$.agent.spawn({ cwd })` is in the types, but on 2.1.300 the
  engine drops it: the agent ran in the session's folder in every case (runs 1 to 5;
  `run4/run4-debug.log:319`).
- An agent definition has no folder field, and the `SubagentStart` and `SessionStart` hooks
  cannot change the folder (types, `claude-code.d.ts:470-556` and `:1396-1400`).
- The Agent tool's `isolation: "worktree"` makes a new worktree of its own, not the leased slot
  (run 2).
- The loop plugin's own `agent.spawn` hook can rewrite the folder only for agents the model starts.
  For the loop's own timer spawns it is skipped: `agent.spawn skipped: re-entry (the plugin's own
  code raised it)` (`run4/run4-debug.log:323`). An early result that seemed to show otherwise was
  an artifact of an open hook frame (runs 1 and 3).
- **What works:** an `agent.spawn` hook in a second plugin. It reads a `factory-slot: <path>` line
  from the prompt and calls `next({ ...e, cwd: path })`. It worked for a spawn from a frameless
  timer, headless (run 5) and in an idle interactive session (run 7). Inside the slot:
  - `pwd`, relative Bash writes, Write and Read all resolved to the slot;
  - a `cd /tmp` was reset to the slot on the next call;
  - `git` saw the slot's branch, and the agent's system prompt named the slot as its working
    directory;
  - a child agent it started inherited the slot (run 8);
  - the session's own checkout stayed clean.
- **A separate `claude -p` process** started in the slot also works (run 0). It loses what the loop
  relies on, though: the agent id, `turn.complete` and TaskStop.

**For the guard:** the second plugin's `tool.call` hook saw every Bash, Write and Read call of
these agents, while the loop plugin's own `tool.call` hook was skipped for all of them (54
re-entry lines in `run3/run3-debug.log`). Write's `file_path` can arrive relative, so a guard must
resolve it against the slot. A child agent has a new id, so a guard maps children through
`parentAgentId`.

**Not tested:** `--remote-control` hosts, and the `WorktreeCreate` hook's `worktreePath` route.

## Spike 2: do hooks fire for agents the loop starts?

**Question.** Do settings hooks (PreToolUse on Write, Edit and Bash; Stop; SubagentStop) and the
mod's own `tool.call` hook fire for an agent a mod spawns from a timer, and from a command handler?
Can a PreToolUse hook see the slot and the target path, and block a write outside the slot, with
the reason fed back to the agent?

**Answer: partial.** Everything fires except the spawning plugin's own hooks.

| Hook | Agent spawned from a command | Agent spawned from the timer |
|---|---|---|
| settings PreToolUse, SubagentStart, SubagentStop | fires | fires |
| PreToolUse exit 2, or a JSON deny | blocks; the agent quotes the reason | blocks; the agent quotes the reason |
| SubagentStop exit 2 | holds the finish; the agent does what the reason asks | same |
| command hooks in the spawning plugin's own `hooks/hooks.json` | fire and block | fire and block |
| the spawning plugin's own `tool.call`, `classic.PreToolUse`, `classic.SubagentStop` | fire | **never fire** |
| the spawning plugin's own registered tool | answers | **fails** |
| a second plugin's `agent.spawn`, `tool.call`, `classic.SubagentStop` | fire and block | fire and block |
| the hook input's `cwd` is the slot | no: always the session folder | no |

Evidence: `run-settings/settings.jsonl` and `mod.jsonl`; `run-settings/debug.log:266-268`
(`hookprobe@inline tool.call skipped: re-entry`) and `:634` (the registered tool unanswered);
`run-plugincmd/plugin.jsonl`; `run-guard/guard.jsonl`, with 0 re-entry skips for the second plugin
in every run. In `run-spawner` the timer agent's escape write landed (`outside/escape-timer.txt`),
while the command agent's was refused.

**What decides it** is whether a hook frame of the spawning plugin is open when it spawns, not the
timer as such. In the control run `run-spawner-timerfirst`, the timer fired while the command
handler was still running, the spawn was counted inside that frame (`debug.log:223`), and the
spawner's hooks did see both agents. The loop spawns from passes that its `$.clock.every` timer
starts, outside any frame (`plugins/factory-loop/hooks/register.ts:659`, spawn at `:351`), so it is
in the failing case. This also confirms the earlier finding that loop agents cannot reach the
loop's registered answer tools: `answerChannel` must stay `script`.

**Two more findings:**

- A Write and Edit hook does not see Bash writes: `outside/bash-*.txt` landed in every run.
- callum-flow's settings-level PreToolUse hooks, including the main-checkout write guard, ran for
  these agents (`spikes/agent-folder/run3/run3-debug.log:278-286`).

## Spike 3: the Bash timeout and the stop gate

**Questions.** (1) Does an agent the loop starts honour `BASH_DEFAULT_TIMEOUT_MS=600000` and
`BASH_MAX_TIMEOUT_MS`, so a `sleep 150` with no timeout argument finishes in the foreground? (2) How
long do `npm run lint` and `npm test` take? (3) Can a SubagentStop hook run a gate that long, block
the finish while it fails, and hand the failure to the agent?

**Answers: yes, about a minute, and yes.**

1. **Timeout.** With nothing set, the command was moved to the background at exactly 120 s, which
   is last night's failure (run A0, `ms:120077`). With the 10-minute value set by any of four
   routes, it finished in the foreground in about 150 s:
   - A1, the process environment;
   - A2, a `--settings` `env` block;
   - A3, the mod's `$.env.set` in `session.start`;
   - A4, the mod's `tool.call` hook adding `timeout: 600000`.
2. **Gates.** `npm run lint` took about 21 s and `npm test` about 37 s, so about 58 s serially.
   During the test run the 1-minute load average went from 1.8 to 7.0, so several slots gating at
   once will be slower (`out/gates-summary.txt`).
3. **Stop gate.** A settings SubagentStop command hook with `timeout: 900` (run B) and a mod
   `classic.SubagentStop` hook running the gate through `$.process.run` (run C) each ran a 75 s
   gate. Each blocked the first finish, the agent read the failure and fixed the file, and the
   gate passed on the second try. **Caveat (run D):** a hook killed by its own timeout lets the agent finish as
   if the gate passed, with no trace in the session output.

**One more finding:** the classic hook input's `cwd` is the session's folder, not the spawn's, so a
gate must find the slot from the agent id.

**A caveat on runs A4 and C.** The probe's `/tsg` command kept its hook frame open until the
agent's turn ended (`plugin/hooks/register.ts:59-65`), and the timer spawned the agent inside
that frame. That is the control shape of spike 2, where the spawner's own hooks do see its agents.
So A4 (the mod's `tool.call` rewrite) and C (the mod's own SubagentStop) do not show that the
**loop's own** hooks can do this for its frameless timer spawns. Spike 2 shows they cannot. The
same hooks in the companion plugin are a different matter: a second plugin's hooks fire either
way.

## What the spec does with these answers

| Need | v2 mechanism (SPEC.md) | Status |
|---|---|---|
| Start the agent in its slot | the companion's `agent.spawn` hook sets `cwd` from the prompt's `factory-slot:` line, checked against the slot's step marker (10.3) | proven: spike 1, runs 5, 7 and 8 |
| Confine its file writes | the companion's `tool.call` hook, by agent id, with paths resolved against the slot (10.4) | proven: spike 2, run-guard |
| Keep it off the main checkout | callum-flow's existing guard, which already fires for these agents, plus a tell-only tripwire (10.4, 10.7) | proven: spike 1, run 3 |
| 10-minute Bash timeout | `$.env.set` in the loop's `session.start`, and the companion's `tool.call` adding the timeout (10.5) | proven: the workspace probe (U9), cases `envset-start`, `envset-timer` and `companion` |
| Stop gate | the companion's `classic.SubagentStop` with `$.process.run` and one 10-minute budget; no cap; a gate that cannot run lets CI decide (10.6) | proven: the workspace probe (U9), cases `gate` and `companion` |
| Answers | the answer script only (`answerChannel: script`) | proven: spike 2 |
| Know the companion is loaded | a handshake file and a rail that holds agent steps without it (10.9) | built (U9); the handshake shown in the probe's `companion` case |

**Before workflow 3 built it,** U9 re-ran the frameless probe for the two points not yet seen in
the loop's exact shape: the long gate inside the companion's SubagentStop, and `$.env.set` with
no frame open. Both passed on 2.1.300 (2026-10-15), so no fallback was built; the results are in
the probe's [README](../probes/workspace-probe/README.md). Had either failed, U9 would have used
the stated fallback:

- **For the gate:** a command hook in the companion's own `hooks/hooks.json`, with `timeout` 900
  and the gate's own budget 600 s, keyed by agent id. This is proven by run B and run-plugincmd.
- **For the timeout:** the companion's per-call rewrite alone.

**Fallbacks kept in the spec and not built** (SPEC.md 10.9):

- If a future engine stops applying a `cwd` set by a hook: a separate `claude -p` process per
  agent (spike 1, run 0). It is a large change, for the owner to decide.
- If no hook route fires at all: the owner's fallback, OWNER-BRIEF decision 6. The loop runs the
  gates after the answer, resumes the agent with the failures, and fails a step that leaves the
  main checkout dirty.
- If the engine starts honouring `$.agent.spawn({ cwd })`: drop the prompt line and the
  companion's folder role, and keep the companion for the guard.

**Re-probe on every Claude Code upgrade.** Each of these results is a fact about 2.1.300, so U9
keeps the probe in `docs/factory-loop/probes/workspace-probe/` and the upgrade checklist runs it.
