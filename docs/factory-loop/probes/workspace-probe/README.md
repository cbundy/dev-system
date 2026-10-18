# Workspace probe: do the companion plugin's routes work for agents the loop starts?

The v2 workspace design ([SPEC](../../v2/SPEC.md) section 10) rests on engine behaviour that the
spikes ([SPIKES.md](../../v2/SPIKES.md)) showed on Claude Code 2.1.300. Two points were shown only
in nearby shapes, so build unit U9 re-probed them before building the companion
(v2 SPEC 10.9): a long `$.process.run` inside a second plugin's `classic.SubagentStop` for an agent
spawned from a frameless timer, and `$.env.set` with no hook frame open. The probe also re-runs
the folder and guard checks, and runs the real companion plugin beside a stand-in loop.

**Re-run it on every Claude Code upgrade.** Each result is a fact about one engine build.

## How to run it

```sh
docs/factory-loop/probes/workspace-probe/run.sh <out dir> [case ...]
```

Each case is one headless `claude -p` session on haiku, all at once, with only the probe's plugins
loaded (`--setting-sources project`, so no user plugin and no settings hook). The session's
main agent only sleeps; every spawn comes from a `$.clock` timer that `session.start` scheduled,
so no frame of the spawning plugin is open, as in the loop. Each case writes
`<out dir>/<case>/log.jsonl`, the session's stream and its debug log. About eight minutes.

| Case | Plugins | What it shows |
|---|---|---|
| `control` | `spawner`, `helper` | with nothing set, the agent's `sleep 150` (no timeout argument) is moved to the background at 120 s |
| `envset-start` | `spawner`, `helper` | `$.env.set` of `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` in `session.start` (the loop's shape) reaches an agent spawned later from a timer: the sleep finishes in the foreground |
| `envset-timer` | `spawner`, `helper` | the same, with `$.env.set` called from a timer, no frame open at all |
| `gate` | `spawner`, `helper` | the helper's `agent.spawn` starts the agent in its slot from the prompt's `factory-slot:` line, its `tool.call` refuses a write outside the slot, and its `classic.SubagentStop` runs a 75 s gate through `$.process.run`, refuses the first finish and passes the second; then a message resumes the agent, as the loop's repair message does, and the resumed agent is still in its slot and still guarded |
| `companion` | `loop` (a stand-in named `factory-loop`), `plugins/factory-loop-workspace` | the real companion: the stand-in prepares a git worktree slot with its step marker as `factory-slot prepare` does and spawns `factory-loop:builder` as an agent step; the companion starts it in the slot, gives its Bash call 10 minutes, refuses a write in the main checkout, a push to `main` and `gh pr create` (each logged to `loop/companion.jsonl`), holds the finish until the gate passes, writes `factory-gate.json`, and writes the session's handshake |

The `companion` case writes the handshake under the real `CLAUDE_CONFIG_DIR`
(`factory-loop/workspace/<session>.json`); delete it afterwards on a machine that runs no loop.

## Results on Claude Code 2.1.300 (2026-10-15)

Every point passed, so U9 built the design as specified and no fallback of v2 SPEC 10.9. Each case's
`log.jsonl` is kept in [`evidence/`](evidence/) as `runs-<n>-<case>.jsonl` (the engine's own text
quoted there with its dashes made plain); the sessions' streams and debug logs stayed in
`/persist/claude/factory-loop-v2-build/w3/u9-probe/`.

| Point | Result | Evidence |
|---|---|---|
| No timeout set | moved to the background at 120 s | `evidence/runs-2-control.jsonl`: `ms:120047`, "moved to the background" |
| `$.env.set` in `session.start`, timer spawn | foreground, 150 s | `evidence/runs-1-envset-start.jsonl`: `ms:150064`, `18:37:02` to `18:39:32`; the agent's Bash call carried no `timeout` |
| `$.env.set` from a timer, no frame open | foreground, 150 s | `evidence/runs-1-envset-timer.jsonl`: `ms:150073` |
| Slot from the prompt line, frameless spawn | the agent's `pwd` was the slot | `evidence/runs-1-gate.jsonl`; the run's `debug.log:234` "cwd rewritten by a hook" |
| Write outside the slot | refused, reason quoted back | `evidence/runs-1-gate.jsonl` `guard-deny` |
| Long gate in a second plugin's `SubagentStop` | 75 s gate refused the first finish (exit 2, reason handed to the agent), the agent fixed `done.txt`, the second 75 s gate passed, the turn ended | `evidence/runs-1-gate.jsonl` `gate-start`, `gate-end` (`secs:75`, twice) |
| A resumed agent (the repair message's route) | `agent.spawn` fired again with `resume` and the slot as its `cwd`; `pwd` was the slot; a write outside it was refused; the gate ran again on its finish | `evidence/runs-3-gate.jsonl` |
| The real companion | as the `companion` row above says: the spawn admitted with this session's handshake there, `sleep 130` in the foreground (`18:59:25` to `19:01:35`) with no timeout set but the companion's, three refusals logged, the first finish refused by the gate and the second passed | `evidence/runs-5-companion.jsonl`, `runs-5-companion-agent.jsonl` (the agent's tool results and the gate's refusal), `runs-5-companion-log.jsonl`, `runs-5-factory-gate.json` |

Seen on the way: a spawn made 4 s after a headless session starts can fail with "no session is
bound in this process" (`evidence/runs-1-control.jsonl`); the spawner retries it. The loop's first
pass comes later than that, but a loop agent step spawned that early would fail its attempt and
take the unknown path.

## What changes if a point fails

v2 SPEC 10.9 states the fallbacks: a classic command hook in the companion's `hooks/hooks.json` for
the gate (`timeout` 900, the gate's own budget 600 s, keyed by agent id through a map file), the
companion's per-call timeout alone for `$.env.set`, a `claude -p` process per agent if a `cwd` set
by a hook stops applying, and the owner's fallback (the loop runs the gates after the answer) if no
hook route fires at all.
