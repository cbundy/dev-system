# Reconcile-mod spike: findings

Investigation of 2026-10-12 (all times UTC), Claude Code 2.1.296, Coder workspaces. Throwaway
work on branch `spike/reconcile-mod`, never to be merged. The raw log of every check is in
[`evidence/log.jsonl`](evidence/log.jsonl) (353 lines).

## Summary

The questions:

1. How can orchestrator ticks be made more deterministic?
2. Can the orchestrator show status on the phone and desktop clients without it counting
   toward the model's context?

The answers:

- **Hooks cannot show anything on the phone** in a Remote Control session. Hook messages,
  hook-set titles and rewritten tool output either stay local or are hidden. Hooks are still
  a good fit for making ticks deterministic: gates and guards around a model-driven loop.
- **A mod (hooks module plugin) works in the orchestrators' exact launch mode** (one
  CLI-started Remote Control session, permission bypass, resumed on start). It loads, runs a
  timer forever, survives `dev-restart-self`, and reloads live when its folder changes.
- **The phone can follow a mod through the session title.** The mod runs the built-in
  `/rename`, and the cloud title follows. Each update leaves a note for the model, which the
  mod blanks to about 3 tokens. It never wakes the model.
- **A mod can run agents with zero cost to the main context in bypass mode.** Agents the
  mod spawns answer only to the mod. In auto mode they hand their report to the main
  conversation and wake the model instead. Orchestrators run in bypass mode.
- **Ticks themselves cost nothing.** A timer tick adds no row to the conversation.

So Option B below (code drives the loop, the model only judges) is feasible on the current
setup. The open risks are listed at the end.

## 1. What reaches the phone

Tested in an app-started Remote Control session (server mode) with a temporary
`PostToolUse` and `UserPromptSubmit` hook in a gitignored `.claude/settings.local.json`,
then removed. The owner checked the phone; the cloud events were read with the
`claude-code-remote` MCP tools.

| Channel | On the phone | In the model's context | Evidence |
|---|---|---|---|
| Hook `systemMessage` | no | no | Synced as a hidden system event (`subtype: informational`, "PostToolUse:Bash says: ..."); the owner saw nothing |
| Hook `updatedToolOutput` (PostToolUse) | rewritten version only | rewritten version only | The cloud event's `tool_result` and `tool_use_result` both held the stand-in text; the original output was gone everywhere |
| Hook `sessionTitle` (UserPromptSubmit) | no | no | The hook fired (19:04:36) but the cloud title did not change: it renames the local CLI session only |
| Hook `additionalContext` (SessionStart) | no | yes | Synced as a hidden `hook_response` event |
| MCP `set_session_title` (model calls it) | yes | about 100 tokens per call | The cloud title changed and the owner saw it; it needed a permission approval |
| Mod `/rename` (see section 3) | yes | about 3 tokens per update | Verified in the spike |
| Mod panes, status line, toasts, band above the prompt | no | no | An earlier attempt by the owner showed nothing on the phone; the band is terminal and desktop only by the API's own docs |

What the phone shows of a Remote Control session: the conversation, the session title and
push notifications.

## 2. The spike setup

- **Mod:** `spikes/reconcile-mod/` (manifest, `hooks/hooks.json`, `hooks/register.ts`). It
  writes one JSON line per observation to `/persist/claude/spike/log.jsonl` and never
  touches a repository. Checked with `claude plugin validate` and a strict `tsc` against the
  engine's own type declarations before every push.
- **Workspace:** `spike-reconcile-mod`, from the normal `dev-system` template (no template
  change): image `ghcr.io/cbundy/dev-system/base:2`, repo `cbundy/dev-system-testbed`,
  `remote_control_mode=session`, `remote_control_resume=true`, `ring=testbed`, 2 CPUs, 8 GB,
  `template_testing=false`. `remote_control_skip_permissions` was `false` at first and
  switched to `true` at the restart (section 4).
- **Loading:** the branch is cloned to `/persist/claude/spike/dev-system`, and
  `/persist/claude/settings.json` (the workspace's `CLAUDE_CONFIG_DIR`) carries
  `"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/persist/claude/spike/dev-system/spikes/reconcile-mod" }`.
  A `git pull` in that folder reloads the module in the running session.
- **Testbed safety:** `dev-system-testbed` has no `ready` label and one unrelated open issue,
  so no orchestrator is woken by it. The spike made no GitHub writes.

## 3. Checks and results

### Check 1: the mod loads - pass

The mod logged `loaded` at 19:53:26, one second after the supervisor started
`claude --remote-control dev-system-testbed`. It loaded again on each of four live reloads
(20:03:10, 20:08:56, 20:10:11, 20:41:45) and after the restart (20:31:35).

### Check 2: the timer - pass so far

`$.clock.every(60_000)` fired 54 times between 19:54:26 and 20:49:45, every interval 60.0
seconds except five, each across a reload or the restart (the timer starts again 60 seconds
after each load). A tick adds no row to the conversation: from 19:54 to 20:03 the ticks ran
while every title update failed, and the conversation got nothing. The multi-hour idle run
is still going.

### Check 3: the session title - pass, through `/rename`

- `$.mcp.call('claude-code-remote', ...)` failed every time: `no connected MCP tool
  "get_session" on a server named "claude-code-remote"`. The session's startup event lists
  `mcp_servers: []`. Only sessions started from the claude.ai app (server mode) get that
  server; CLI-started session-mode sessions, which is how orchestrators run, get none.
- Fallback: `$.command.run({ command: 'rename', args: title })`. The cloud title followed
  within a second (`spike · tick 5 · 20:08 UTC · ctx 33474`, read back with `get_session`),
  and the owner saw it update on the phone.
- Cost per rename: two `local_command` system rows (the command and its "Session renamed
  to" output, 130 to 212 characters; transcript only, the model never reads them) and one
  user note the model reads ("The user named this session ...", 172 to 199 characters). The
  mod's `session.append` hook blanks that note as it is stored, leaving "(no content)",
  about 3 tokens. No rename ever started a model turn.
- Renaming only when the status text changes keeps even that close to zero.

### Check 4: spawning agents - pass in bypass mode

Six agents were spawned by the mod with `$.agent.spawn` and answered through the mod's
`turn.complete` hook.

| Run | Started | Permission mode | Agent | Answered in | Reached the main conversation | Model woken | Context after |
|---|---|---|---|---|---|---|---|
| 1 | 19:56:26 | auto | Explore | 8.2 s | yes: handback message, 2,353 chars | yes, 5.0 s turn | 31,623 (from 30,535) |
| 2 | 20:06:10 | auto | Explore | 11.7 s | yes: handback message, 2,322 chars | yes, 3.2 s turn | 33,474 |
| 3 | 20:13:11 | auto | Explore | 7.6 s | yes: handback message, 1,879 chars | yes, 5.6 s turn | 35,427 |
| 4 | 20:34:35 | bypass | Explore | 7.0 s | no | no | 48,799 (unchanged) |
| 5 | 20:43:45 | bypass | Explore on Haiku | 1.0 s | no | no | 48,799 (unchanged) |
| 6 | 20:43:45 | bypass | `callum-flow:explorer` on Haiku | 0.9 s | no | no | 48,799 (unchanged) |

- In auto mode the subagent ends with the `SubagentHandback` tool. The engine's own type
  declarations describe it as auto mode's review path ("'send' = delivered, passed by auto
  mode's review"). The cloud recorded `handback: send` for those runs, the report arrived as
  a message from the agent, and the model took a turn to read it.
- In bypass mode there is no handback. The report stays in a hidden task notification event
  and reaches only the mod. Runs 5 and 6 were the deliberate test: two agents at once, one
  built-in and one of the factory's own types; two minutes later the mod's tally showed
  `mainRows: []` and `mainTurns: 0`.
- Context rose from 35,427 to 48,799 across the restart. That is the resumed session's first
  measurement, not a tick or an agent: nothing was appended in between.

### Check 5: restart and resume - pass

The workspace was restarted from inside with
`dev-restart-self --parameter remote_control_skip_permissions=true`, the orchestrators' own
restart path. It came back as
`claude --remote-control dev-system-testbed --dangerously-skip-permissions --settings {"skipDangerousModePermissionPrompt":true} --resume 7fac4840-...`:
the same conversation and the same cloud session. `CLAUDE_CODE_PLUGIN_DIRS` survived in the
settings, the mod logged `loaded` at 20:31:35, set the title a second later, and ticked from
20:32:35 on.

## 4. Parity with the orchestrators

The two live orchestrators (`plant-console-orchestrator`, `dev-system-orchestrator`) were
inspected read-only (`/proc/<pid>/cmdline` and the remote-control environment):

```text
claude --remote-control 🔄 plant-console orchestrator --dangerously-skip-permissions
  --settings {"skipDangerousModePermissionPrompt":true} --resume <id>
  "The workspace restarted and this conversation was resumed. Re-read .claude/orchestrator-memory.md, re-arm the watcher and continue the issue-orchestrator loop."
DEV_REMOTE_CONTROL_MODE=session  DEV_REMOTE_CONTROL_RESUME=1  DEV_REMOTE_CONTROL_SKIP_PERMISSIONS=1
DEV_REMOTE_CONTROL_PROMPT=/callum-flow:issue-orchestrator  DEV_ROLE=orchestrator
```

After the restart the spike matches this except for the resume prompt (and the session
name). `DEV_ROLE` only labels the workspace in fleet reports (`dev-version`, the heartbeat).
The resume prompt starts the orchestrator's turn at boot; it does not change how a mod loads
or how subagents report. The Orchestrator template is the same Terraform published with
`role=orchestrator` (`coder/push.sh`).

## 5. Design implications

**Determinism with hooks (works today, model still drives the loop):**

- A `callum-flow-tick` script does the bookkeeping (usage tier, queue and PR listing, sweep,
  heartbeat, watcher re-arm arguments) and prints a fixed-shape plan.
- A `Stop` hook refuses to end a turn while the watcher is missing, usage was not read, or
  the plan is not done, naming the fix.
- More `PreToolUse` guards turn the skill's prose rules into hard ones (no TaskStop on the
  watcher, no sleep or polling, no spawn in the stop tiers, no merge without guard PASS).
- `PostToolUse` and `SubagentStop` hooks log `delegated`, verdicts and `fix_requested`
  automatically.
- No hook fires when a watcher line arrives, so hooks cannot keep the model out of the wake.

**Option B, a mod (code drives the loop, the model only judges):**

- The watcher is replaced by a reconcile loop: every minute (or when pinged) read the whole
  state (`callum-flow-factory-state --format json` plus the per-run checks from
  `pipeline-watch.sh`), compute actions with a pure `plan()` function, and do each action not
  already in flight. Nothing can be missed, restarts are free, and `plan()` is unit-testable.
- Bookkeeping runs in code; agents (designer, implementer, adjudicator, fixer) are spawned
  by the mod; the model is woken only for judgment (pre-merge reading of fix commits,
  test-weakening warnings, owner decisions).
- The spike proved the platform pieces this needs in the orchestrators' launch mode: load,
  timer, restart, title, and agents that cost the main context nothing.

## 6. Open questions and risks

Not yet tested:

- **Hours of idle ticking.** The run continues; read the log for gaps.
- **Waking the model on purpose.** `$.prompt.submit` with a fixed-format line, Option B's
  judgment wake.
- **Real agents.** Long-running designer and implementer runs, several at once, and agents
  that fail.
- **Shipping.** Loading the mod from the installed callum-flow plugin rather than
  `CLAUDE_CODE_PLUGIN_DIRS`, next to callum-flow's existing classic `hooks.json`.
- **The exact start.** The resume prompt and the issue-orchestrator skill running in the
  same session as the mod. That needs a workspace from the Orchestrator template.
- **Long-lived processes.** `$.process.spawn` for anything long-running.

Risks:

- **Auto mode.** If orchestrators move from bypass to auto mode, agent handback returns and
  every agent result wakes the model.
- **Early access API.** The mod API may change between Claude Code releases. Pin the version
  in the image and rerun this spike before each upgrade.

## 7. Problems hit along the way

- `/persist` is root-owned in a workspace; only per-tool folders are writable. The spike's
  files live under `/persist/claude/spike/`.
- The `claude-code-remote` server is absent in CLI-started sessions (check 3), hence the
  `/rename` fallback.
- The first version spawned its agent three minutes after every load, so each live reload
  ran another agent (runs 2 and 3). The test now runs only on request
  (`touch /persist/claude/spike/handback-test.request`).
- The spike workspace has no Coder token, which `dev-restart-self` needs. The session token
  was copied in over stdin for the restart; the container replacement removed it.
- One push carried a type error because the check did not stop the command chain. Fixed in
  the next commit; at runtime it could only have lost a log line.

## 8. Reproducing

```bash
# results so far
coder ssh spike-reconcile-mod -- cat /persist/claude/spike/log.jsonl
# run the handback test again (result two to three minutes later)
coder ssh spike-reconcile-mod -- touch /persist/claude/spike/handback-test.request
# load a change to the mod into the running session
coder ssh spike-reconcile-mod -- git -C /persist/claude/spike/dev-system pull --ff-only
```

## 9. Cleanup

When done: delete the `spike-reconcile-mod` workspace, leave this branch unmerged, and
rotate the Coder token used for the setup (it appears in the session that ran the spike).
