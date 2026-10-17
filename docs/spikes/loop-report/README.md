# loop-report spike (throwaway, never merged as a plugin)

Part of the loop-report spike (#713), epic #684. Question: which quiet route puts a periodic loop
report ("In flight" and "Merged" tables) in front of the owner on the phone, in a Remote Control
session, and what does each route cost the model's context?

This folder holds the probe mod and the runbook for the live run. No live run has happened yet; the
log goes in [evidence/](evidence/README.md). The probe is modelled on
[../reconcile-mod/](../reconcile-mod/FINDINGS.md) and loads the same way (its section 2).

Claude Code version at design time: **2.1.302**. The version of the live run is what counts: write
`claude --version` at the top of the evidence folder's notes, and re-check the route list below if it
differs (the mod's `loaded` log line also records it).

## What the probe does

`probe/` is a mod (manifest, `hooks/hooks.json`, `hooks/register.ts`) named `loop-report-probe`.

- `/probe-report` is registered by the mod. Its `command.run` hook returns `{ text }` with a sample
  report: an "In flight" table and a "Merged" table (10 rows) and a timestamp in Europe/Amsterdam time.
- A `$.clock.every` timer (60 s) reads the phase (below) and, when no run is waiting for its next real
  model turn, runs that phase's route once: `$.command.run({ command: 'probe-report' })` for the
  report phases, the route's own call for the others. After a run the timer waits until a real main
  model turn has completed, so every run sits between two real turns.
- Log: one JSON line per observation, each with `at` and `phase`, appended to
  `/persist/claude/spike/loop-report.jsonl` (outside any repository). The mod never writes to GitHub
  or a repository.

| `kind` | When | Fields to read |
|---|---|---|
| `loaded` | session start (and each live reload) | `version`, `phases`, `defaultPhase` |
| `append` | every `session.append` row | `door`, `origin`, `type`, `name`, `chars`, `storedChars`, `trimmed`, `agentId`, `duringRun` |
| `run-start` | the timer starts a run | `runId`, `usageBefore` |
| `run-done` / `run-error` | the route's call returned / threw | `result` or `error` |
| `run-end` | after the call | `awaiting` |
| `turn-start` | every `turn.start` | `turnId`, `agentId`, `text` (first 60 characters), `duringRun` |
| `turn-end` | the first main `turn.complete` after a run | `runId`, `turnStartsSinceRun`, `usageBefore`, `usageAfter` |

`usageBefore` and `usageAfter` hold `contextTokens`, `percent` and `costUsd` from `$.session.usage()`.
The context cost of a route is `usageAfter.contextTokens - usageBefore.contextTokens` minus the same
difference in the control phase (the real turn's own cost).

## Phases and routes

The phase is the single word in `/persist/claude/spike/loop-report.phase`, read at every timer fire.
Change it with `echo report > /persist/claude/spike/loop-report.phase`; `off` (or a missing file with
`DEFAULT_PHASE` set to something else) pauses runs. With no file the phase is `DEFAULT_PHASE`
(`control`, a constant in `register.ts`; a `git pull` can change it).

| Phase | Route | Declaration |
|---|---|---|
| `control` | nothing; two real turns with no report between | - |
| `report` | `$.command.run({ command: 'probe-report' })`; its `{ text }` is stored as a row | `CommandRunResult.text`: "the command's output as a transcript line" |
| `report-trim` | as `report`, and a `session.append` hook blanks the stored row (content `[]`), as `plugins/factory-loop/hooks/register.ts:1617-1621` blanks the rename note | `session.append`: "next({ ...e, message }) rewrites content: stored and sent after. The screen, an SDK stream or Remote Control may show the row just before its rewrite" |
| `append-user` | `$.session.append({ message: { type: 'user', content: [text] } })` | `$.session.append`: "a user-role row the person does not see as typed ... the model reads it" |
| `append-system` | `$.session.append({ message: { type: 'system', ... } })` | `SessionAppendArgs`: "`system` for a notice the model never reads" |
| `ui-log` | `$.ui.log(text)` to the transcript | `$.ui.log`: dim row, not sent to the model; "a remote surface 10000" characters |
| `ui-toast` | `$.ui.toast(text)` | `$.ui.toast`: "leaves the transcript and the model untouched"; "10000 remotely" |
| `ui-status` | `$.ui.status(text)` | `$.ui.status`: pinned line under the prompt; "10000 remotely" |
| `ui-notify` | `$.ui.notify(text)` | `$.ui.notify`: native notification through the person's channel |

### Routes ruled out, with reasons (all from the 2.1.302 declarations)

| Route | Why not a phase |
|---|---|
| `CommandRunResult.context` | Hidden user messages "the person never sees": the opposite of what we want, and the model reads them |
| `$.prompt.submit` (and `$.prompt.fill`, `compose`, `suggest`) | Submits a prompt that starts a model turn ("a plugin's prompt runs once idle"); not quiet |
| `$.session.send` to this session | A peer message: queued as a delivery (`session.receive`) and read by the model; "Resolves once queued" |
| `$.agent.spawn` | Reconcile-mod finding: in bypass mode the agent answers only to the mod; nothing reaches the conversation. Auto mode hands the report back and wakes the model |
| `$.mcp.call` of `claude-code-remote` `set_session_title` | Title only (reconcile-mod FINDINGS section 1), not a report body |
| `$.ui.open`, `ui.view`, `ui.blit`, `ui.render` panes and sites | Panes and bands are terminal and desktop only (reconcile-mod FINDINGS section 1: "showed nothing on the phone") |
| `$.session.messages`, `usage`, `compact`, `turn.abort`, `$.telemetry.*`, `$.model.*`, `$.audio.*`, `$.tool.*`, `$.config.*`, `$.state`, `$.store` | Read, measure or act on something else; none puts text in the conversation |
| Hook `systemMessage`, `additionalContext`, `updatedToolOutput` | Not mod APIs; already tested in reconcile-mod FINDINGS section 1 (not shown on the phone, or only as rewritten tool output) |

The routes are the options of `$.command.run` (`command`, `args`; no output option), the members of
`$.session.*` and the `$.ui.*` calls above. No push or notification noun exists beyond `$.ui.notify`
(a search of the declarations for notification and push finds only `ui.notify`, `NotifyOptions`, the
`Notification` hook input and `task-notification` delivery rows).

## Runbook (for the live run)

### Setup

1. Create a scratch Coder workspace from the normal `dev-system` template (no template change),
   e.g. `spike-loop-report`, with the testbed repo `cbundy/dev-system-testbed`, which has no `ready`
   label so no orchestrator is woken, `remote_control_mode=session`, `remote_control_resume=true`,
   `remote_control_skip_permissions=true` (bypass mode), `ring=testbed`, `template_testing=false`.
   The CLI runs as `claude --remote-control` in bypass mode.
2. Clone this branch: `git clone https://github.com/cbundy/dev-system /persist/claude/spike/dev-system`
   (check out the spike branch or main once merged).
3. In `/persist/claude/settings.json` (the workspace's `CLAUDE_CONFIG_DIR`) add
   `"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/persist/claude/spike/dev-system/docs/spikes/loop-report/probe" }`.
4. `mkdir -p /persist/claude/spike && echo control > /persist/claude/spike/loop-report.phase`, then
   restart the session (`dev-restart-self`). The log gets a `loaded` line with the Claude Code version.
5. Open the session on the phone (claude.ai or the app) and keep the terminal (`coder ssh`, attach to
   the CLI) in view.

### Reload

A `git pull` in `/persist/claude/spike/dev-system` reloads the module in the running session (reconcile-mod
FINDINGS check 1); a new `loaded` line confirms it. To change a phase, write the phase file; no reload.

### Each phase

For each phase in order `control, report, report-trim, append-user, append-system, ui-log, ui-toast,
ui-status, ui-notify`, give each phase at least two runs, three if the first is odd:

1. `echo <phase> > /persist/claude/spike/loop-report.phase`.
2. Send a real turn from the phone: `reply with the single word pong`. Wait for the answer.
3. Within a minute the timer logs `run-start`, `run-done`, `run-end` for this phase. Note the time.
4. Send another real turn from the phone: `reply with the single word pong`. When it completes the log
   gets `turn-end` with the usage before and after.
5. Repeat from step 2 for the second run, then change phase.

Between phases, do nothing in the session for two minutes, so a stray run cannot spill into the
next phase. Write `off` into the phase file to pause.

### Per phase: log checks and phone check

Log checks, by name (`jq` over `/persist/claude/spike/loop-report.jsonl`, filter by `phase`):

| Phase | Log checks | Owner on the phone, at the `run-start` time | In the terminal |
|---|---|---|---|
| `control` | no `append` with `duringRun: true`; `turn-end.turnStartsSinceRun` is 1 (the real turn only); record the control context delta | Nothing between your two turns | Nothing |
| `report` | an `append` row with `door: command` (or similar) and `chars` of about 800+, `storedChars` equal to `chars`; `turnStartsSinceRun` 1 (no turn started by the run); context delta above control by about the report's size | Row shown or not; table rendered as a table or as raw `\| ... \|` text; push notification or not | Row shown; table drawn |
| `report-trim` | same `append` row with `trimmed: true`, `storedChars` 2 (`[]`); context delta equal to control | Row shown (before the rewrite) or not; shown after reload of the session or not; table rendered or raw; push or not | Row shown or not |
| `append-user` | `append` row with `door: note`, `type: user`; `turnStartsSinceRun` (a value above 1 means the route woke the model); context delta above control | Row shown or not; rendered or raw; push or not | Row shown or not |
| `append-system` | `append` row with `type: system`; context delta equal to control | Row shown or not (a notice); push or not | Row shown or not |
| `ui-log` | no `append` row (the route does not store one) or one with `type: system`; context delta equal to control | Row shown or not; rendered or raw | Dim row in the transcript |
| `ui-toast` | no `append` row; delta equal to control | Toast shown or not | Toast at the top right for 20 s |
| `ui-status` | no `append` row; delta equal to control | Status line shown or not (it stays pinned until the next call replaces it; note when it vanishes) | Pinned line under the prompt |
| `ui-notify` | `run-done.result` has `isSent` and `channel` (or `reason`); no `append` row | Push notification on the phone or not | Terminal notification or bell |

Always also check in `turn-start`: any line with `duringRun: true` or `text` that is not your `pong`
prompt means the route started a model turn by itself, which fails the "quiet" requirement.

### Finishing

1. Copy `/persist/claude/spike/loop-report.jsonl` into `docs/spikes/loop-report/evidence/` and write the
   owner's phone observations (phase, time, shown or not, rendered or raw, push or not) in a table
   beside it.
2. `echo off > /persist/claude/spike/loop-report.phase` and delete the scratch workspace.

## Checks of the probe itself

From the repo root:

```bash
claude plugin validate docs/spikes/loop-report/probe
```

Strict type check against the engine's own declarations. Load the `plugin-authoring` skill: it writes
the declarations (`types/claude-code.d.ts` in its folder) and gives the `tsconfig.json` in that file's
header. Then, with `TYPES` the declarations path it names and `tsc` TypeScript 5.4 or newer:

```bash
T=$(mktemp -d)
mkdir -p "$T/.claude-plugin/types/claude-code" "$T/hooks"
cp "$TYPES" "$T/.claude-plugin/types/claude-code/index.d.ts"
cp docs/spikes/loop-report/probe/hooks/register.ts "$T/hooks/"
cat > "$T/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": [".claude-plugin/types", "hooks", "types", "tests"]
}
JSON
tsc -p "$T"
```

This is the check `plugins/factory-loop/README.md` ("Pinned Claude Code version") describes.
