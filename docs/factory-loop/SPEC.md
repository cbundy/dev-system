# Factory loop: specification

Phase 1 of the [conversion brief](https://github.com/cbundy/dev-system/blob/spike/reconcile-mod/spikes/reconcile-mod/CONVERSION-BRIEF.md)
([tracking issue](https://github.com/cbundy/dev-system/issues/521)). It turns the issue
orchestrator into one code loop that runs as a mod in its Claude Code session. Every row of
[INVENTORY.md](INVENTORY.md) maps to something here. The choices made without the owner, with
their alternatives, are in [DECISIONS.md](DECISIONS.md).

Proven platform facts come from the spike's
[FINDINGS.md](https://github.com/cbundy/dev-system/blob/spike/reconcile-mod/spikes/reconcile-mod/FINDINGS.md)
on Claude Code 2.1.296: a mod loads in the orchestrators' launch mode, ticks on a timer at no
cost, survives `dev-restart-self`, sets the session title through `/rename` (with the model's
note blanked), and spawns agents whose reports reach only the mod in bypass mode.

## 1. Scope

The loop does every piece of bookkeeping the orchestrator does today: watching, usage tiers,
claims, heartbeats, sweeps, dispatching agents, driving pipeline gates, guarding and merging,
rollout follow-ups and the status report. The main model keeps three jobs: answering judgment
lines (section 8), doing the few tasks that stay model work (re-drives, releases, Run its),
and talking to the owner.

Out of scope: changing the CLIs' logic (the loop calls them; two watchers get a one-shot mode,
section 3.4, and `callum-flow-event` one new state, section 7.4), changing the agents'
definitions, and releasing. Restarting the workspace is in scope only for an update, once
nothing is in flight (rule `H4`, DECISIONS D-15).

## 2. Architecture

```text
every passEveryMs (60 s), or at once when pinged:
    if mode is off or the kill switch exists: stop (title "off")
    if mode is act: check the safety rails (11.2); act only when they all pass
    state   = observe()                  read-only: CLIs, the engine, the store
    if acting: apply what the agent list and the wake timeouts prove to the ledger
    result  = plan(state, config)        pure: no I/O, no clock, same input -> same output
    if acting:
        for each action in result.actions:
            renew the act lease; start its ledger entry and save it; act(action); finish it
    record(state, result, outcomes)      one decision-log line, the title
```

- **One pass at a time.** A ping or a timer tick that arrives during a pass sets a flag, and
  one more pass runs when the current one ends. Passes never overlap, and they start at least
  5 seconds apart. If pings drive more than 30 passes in 10 minutes, something keeps waking the
  loop without being handled: it ignores pings for 10 minutes and runs on the timer alone,
  logs a `loop` event and tells the owner once (section 11.4).
- **Start.** The loop starts from `session.start` and, as a fallback, from `session.append`
  (which fires every minute with the title), so it never depends on one event. The first pass
  runs 5 seconds after the module loads. It runs only in an interactive session: a session whose
  `session.start` says it is not (a `-p` run or the SDK, such as the pipeline's own review runs,
  which load the plugin from the workspace environment) never observes or acts (D-61).
- **Pings.** An agent of the loop finished (`turn.complete` with its `agentId`), the model
  answered a wake (the answer tool or the main loop's `turn.complete`), or an owner control
  arrived (`/factory` or the control tool). A detached respond does not ping: it settles by the
  run moving, which rule `P3a` checks after `respondSettleMs`.
- **Between passes.** Hooks feed the ledger as things happen: an agent's answer, a wake's turn
  starting and ending, the answer tool, `/factory retry`. They work only in act mode with no
  kill switch, one at a time and in the order their events came, on the same in-memory ledger
  the pass uses (section 7.1).
- **Plan is the heart.** `plan` lives in `plugins/factory-loop/hooks/plan.ts` and imports
  types only. Everything it needs, the time included, arrives in `State`. Actions already
  running or done are in the state's ledger, so re-planning an unchanged state yields no new
  action. Its result also carries the reasons it skipped candidates, for the decision log.
- **Observe and act are thin.** Adapters turn CLI output into typed values; executors turn
  actions into CLI calls, agent spawns or wakes, and record outcomes. Neither decides anything.
  `register.ts` is the only module that holds the engine (`$`); `act.ts` dispatches each action
  kind to its one executor (`act-cli.ts`, `act-merge.ts`, `act-agents.ts`, `wake.ts`).
- **Modes.** `off` (nothing runs), `observe` (observe, plan and log; execute nothing; the
  default) and `act`. A kill-switch file forces `off` within one pass (section 11). An act-mode
  pass that a rail holds back runs exactly as observe mode does.

## 3. Observe

### 3.1 State

```ts
type Ms = number                                   // epoch milliseconds
type Tier = 'normal' | 'slow' | 'stop-new' | 'stop-all'
type Stage = 'queued' | 'designing' | 'implementing' | 'in pipeline' | 'parked'
           | 'ready to merge' | 'merged' | 'closed without merge'
type SourceName = 'factory' | 'facts' | 'runs' | 'queue' | 'github' | 'usage' | 'pool' | 'milestone'

type State = {
  now: Ms                         // read once per pass by observe; plan never reads a clock
  repo: string                    // owner/name
  device: string                  // DEV_MACHINE_NAME, else the hostname: the claim identity
  loadedAt: Ms                    // when this module instance loaded (restart detection)
  sources: Record<SourceName, { ok: boolean; at: Ms | null; error?: string }>
  usage: Usage
  issues: IssueView[]             // one per issue the loop may act on (3.2)
  queue: number[]                 // open, trusted issues labelled readyLabel, ascending
  runs: RunView[]                 // newest pipeline run per branch
  pool: Pool | null               // the treehouse worktree pool
  agents: AgentView[]             // the session's agents that the loop spawned
  milestone: Milestone | null     // the Next release milestone, when the repo opted in
  ledger: LedgerEntry[]           // in-flight and recent actions (section 7)
  control: Control                // owner directives (section 4.3)
  lastTitle: string | null        // the title last set, so it is only set on change
  githubBackoffUntil: Ms | null   // act mode: GitHub writes wait until then (section 10.2)
}

type Usage = {
  fiveHour: number | null         // percent, rounded up, as usage-check.sh prints it
  sevenDay: number | null         // the binding weekly window
  fiveHourResetsAt: Ms | null     // a window whose reset has passed counts as zero until the
  sevenDayResetsAt: Ms | null     //   next read (the replay found minutes stuck in Stop all)
  unavailable: boolean            // usage=unavailable, or the reading is older than usageStaleMs
}

type IssueView = {
  number: number
  stage: Stage | null             // callum-flow-factory-state; null when the database never saw it
  stageSince: Ms | null           // entered_at of that stage
  holder: string | null           // device of the latest claim
  run: string | null
  pr: number | null
  stuck: string | null            // S1..S5 from factory-state, shown in the title only
  // GitHub, through callum-flow-issue-read --json (null when not read this life)
  open: boolean | null
  trusted: boolean | null         // false when the reader refused the author (exit 3)
  labels: string[] | null
  blockedBy: number | null        // issue_dependencies_summary.blocked_by: open blockers
  subIssues: number | null        // sub_issues_summary.total: more than 0 is a tracker
  epic: boolean | null            // the title matches trackerTitle ("Epic: ..."): also a tracker
  subIssueList: number[] | null   // a tracker named in `only`: its open sub-issues, nested ones
                                  //   included (3 levels), from its timeline; null when not read
  brief: { url: string; at: Ms } | null   // latest '## Design brief' comment by a trusted author
  // the event log (dev-query)
  delegatedBrief: string | null   // the latest 'delegated' event's 'brief <url>' note
}

type RunState = 'merge-ready' | 'head-mismatch' | 'conflict' | 'ci-stalled' | 'parked'
              | 'failed' | 'cancelled' | 'running' | 'pending'
type RunView = {
  branch: string
  issue: number | null            // from 'issue-<N>' in the branch name
  run: string                     // ULID, or 'unknown' for a run with no log directory
  state: RunState
  head: string | null
  step: string | null             // the gate a parked or failed run waits at
  detail: string | null           // ci-stalled reason, head-mismatch SHAs
  pr: number | null
  since: Ms | null                // when this state and head were first seen
  reviewFixRounds: number         // fix_requested --note review events for this run
  superseded: boolean             // a 'superseded' event names this run
  verdicts: string[]              // this run's verdict notes, newest last (for the review cap)
}

type Pool = { free: number; total: number; slots: Slot[] }
type Slot = { path: string; branch: string | null; state: string; dirty: boolean | null; busy: boolean }
type AgentView = { id: string; type: string; status: 'pending' | 'running' | 'waiting' | 'idle'
                   | 'completed' | 'failed' | 'killed' }
type Milestone = { open: number; closed: number; expected: 'patch' | 'minor' | 'major' | null }
```

### 3.2 Which issues are in `issues`

The union of: every issue `callum-flow-factory-state` lists for the repo; every issue in
`queue`; every issue a ledger entry names; every issue `only` names, with the sub-issues a
tracker among them stands for. GitHub fields are filled for the queue, the issues this device
holds and those `only` names, and stay `null` for the rest.

### 3.3 Sources

Each adapter runs a command with `$.process.run` (no shell), parses its output, and sets its
source status. A failed adapter keeps the previous value with its old `at`, so plan can see
how stale it is. `pipeline-watch.sh`, `queue-watch.sh` and `usage-check.sh` run from
`toolsDir` (section 4.1); every other command comes from `PATH`.

| Source | Command | Cadence | Required for |
|---|---|---|---|
| `factory` | `callum-flow-factory-state --repo <R> --format json --github off` | every pass | everything: a failure makes the pass blind (rule `G2`) |
| `facts` | one `dev-query --csv` call over 3 days of events (SQL in the adapter): per live issue the latest `delegated` note; per run the `fix_requested --note review` count and its `verdict` notes; per branch the latest watcher pipeline event (for `runSource: events`) | every pass | `P1` (the cap), `P2` on a review gate |
| `runs` | `runSource: local`: `pipeline-watch.sh --once` from the main checkout (3.4); a failed poll, or any line the parser cannot read, is a failed source, never "no runs". `runSource: events`: the mirror's stage refined by the watcher's events (`derive.ts`): the newest run the watcher saw for the issue, a park with no answer in the log, and merge-ready, head-mismatch, conflict, ci-stalled and cancelled | every pass | the `P` and `M` rules |
| `queue` | act mode: `queue-watch.sh --once --repo <R> --label <readyLabel> --known <last now>` (3.4), with `known` kept in the store. Observe mode: `callum-flow-issue-read --json --list --label <readyLabel>`, so a shadow logs no `ready` events of its own | every `queueEveryMs` (120 s); skipped during a GitHub backoff | rule `D1` |
| `github` | `callum-flow-issue-read --json <N>` per issue (labels, state, author trust, dependency and sub-issue summaries), plus `--comments` only for this device's designing issues, to find the latest `## Design brief` comment, and `--json --timeline <N>` for a tracker named in `only`, to list its sub-issues | per issue every `githubEveryMs` (5 min), at once for an issue not yet read, at most 12 reads a pass; skipped during a GitHub backoff | rule `D1`; `D2` (an existing brief) |
| `usage` | `usage-check.sh`, merged with `$.session.usage().rateLimits` (free, from the session's own API responses): the higher reading of each window wins | `usage-check.sh` every `usageEveryMs` (5 min); the session figures every pass | rule `G3`; missing or stale is Normal, flagged |
| `pool` | `treehouse status --json` from the main checkout | every pass | rule `D1` capacity, rule `H3` |
| `agents` | `$.agent.list()`, read once per pass, filtered to the ids in the ledger | every pass | lost-agent detection (7.5) |
| `milestone` | `callum-flow-milestone show next` | every `milestoneEveryMs` (10 min) | rules `M7`, `O3`; absent means not opted in |
| ledger | act mode: the ledger the module keeps (7.1), from `$.store`; when the store holds none, rebuilt from 7 days of events (7.5). Observe mode: derived from the device's own events in the `facts` window | every pass | everything |
| control | `<loop dir>/control.json`, field by field (4.3) | every pass | rule `G4` |
| GitHub backoff | act mode: `$.store` (`backoff:<repo>`) | every pass | section 10.2 |

In act mode, before plan runs, the pass also applies the transitions that are facts rather than
decisions (section 7.5): what a successful agent-list read proves about the loop's running
agents, and wakes past their timeout (section 8.2).

### 3.4 Two new one-shot modes

Both live beside the watchers in `features/src/callum-tools/` (the image's source) with shell
tests beside the existing ones. The streaming and single-shot modes are unchanged.

**`pipeline-watch.sh [--branches a,b] [--worktree <branch>=<path>]... --once`**: one poll over
every watched branch, run from the repo's main checkout, then exit 0. It takes no other option
(any other is a usage error, exit 2). It prints one line per branch whose newest run is not
completed, and nothing for a branch whose newest run is (so a branch it does not print has no
run in flight):

```text
<state> <branch> <run-id>[ key=value...] head=<sha>
```

- `state` is one of today's actionable states (`merge-ready`, `head-mismatch`, `conflict`,
  `ci-stalled`, `parked`, `failed`, `cancelled`), or `running` (in flight, nothing to report)
  or `pending` (not yet known: green but GitHub's mergeability is `UNKNOWN` or `gh` failed, a
  probe failed, or no source knows the run's id). Pending is retried next pass.
- `run-id` is a ULID, or `unknown` when no source knows it. `head=` is always last; `unknown`
  means not read.
- The `key=value` pairs come in a fixed order: the state's own detail first (`head-mismatch`:
  `run=<sha> branch=<sha>[ worktree=<sha>]`; `ci-stalled`: `reason=no-workflow|no-checks`), then
  `step=<step>` for `parked` and `failed` (`step=unknown` when the run's status has no step
  table), then `pr=<n>` when the run has a PR. The loop's parser rejects any line that breaks
  this grammar, which fails the source.
- Actionable lines are logged as a first sight is today (`--if-changed`, with the note the watch
  modes log), so the event log keeps the same transitions; `cancelled` is logged as `failed
  --note cancelled`. `running` and `pending` log nothing.
- Exit 1, with the reason on stderr and nothing on stdout, when `no-mistakes` or `gh` is
  missing, the directory is not a git repository, or `no-mistakes runs` fails. It is a failed
  source and logs no `watcher_error` event (the loop reports the failure itself every pass).

**`queue-watch.sh --repo <R> --label <L> [--known <list>] --once`**: one read of the queue, with
the same reader and trust filter as the watch modes and no debounce, then exit 0, whether or not
the queue changed:

```text
queue known=<n1,n2|none> now=<n1,n2|none>
```

`--known` is the last line's `now=` (`none`, empty or left out is the empty set). Every member
of `now` that is not in `known` logs a `ready` event with `--if-changed`; an untrusted issue
never appears in `now`. A failed read (or `gh` or the reader missing) exits 1 with nothing on
stdout and no `watcher_error` event: a failed source, never an empty queue. A missing `--repo`
or `--label`, or any option but these three, is a usage error (exit 2).

Act mode keeps `known` in its store (`queue-known:<repo>`), so the `ready` events keep arriving
as they do today.

## 4. Configuration

### 4.1 Where it lives

- **Plugin options** (`userConfig`): `mode` (`off`, `observe` default, `act`), `repo` (default:
  the session checkout's GitHub `origin`), `shadowDevice` (observe mode only: plan as this device,
  the live orchestrator's, so a shadow can be compared with it; ignored in act mode) and
  `runSource` (`local`, the pipeline watcher, or `events`, the event log, for a shadow).
- **The workspace file** `${CLAUDE_CONFIG_DIR:-~/.claude}/factory-loop/config.json` overrides the
  options and adds `checkout` (the consumer's main checkout, when it is not the session's
  directory), `poolSize` (default 16), `toolsDir` (where `pipeline-watch.sh`, `queue-watch.sh`
  and `usage-check.sh` live; default `/usr/local/share/callum-tools`, the base image's copy) and
  `binDir` (put ahead of `PATH` for every command, so the loop runs a checkout's own CLIs before
  a base image release carries them). It is plain JSON, easy to read and set from a shell, which
  the shadow run uses (DECISIONS D-33). A testbed points `toolsDir` at a checkout's
  `features/src/callum-tools` and `binDir` at its `images/base` (DECISIONS D-42).
- **Repo-local** `.claude/factory-loop.json` in the consumer's main checkout: everything in 4.2.
  The plugin ships no repo-specific values (CLAUDE.md: shared plugins stay generic). An unknown
  key or a bad value is left out and named in the decision log (`config`).
- **Control state** in `<loop dir>/control.json` (4.3): owner directives that change at runtime.

Every command the loop runs gets `CALLUM_FLOW_REPO`, `CALLUM_FLOW_READY_LABEL` and
`CALLUM_FLOW_IN_DEV_LABEL` from the settings (`callum-flow-claim` and `callum-flow-sweep` read
the labels), and, when the pass does not act, `CALLUM_EVENTS_DIR` (section 11.1).

### 4.2 Settings and defaults

| Key | Default | Meaning |
|---|---|---|
| `readyLabel`, `inDevLabel` | `ready`, `in development` | the queue and claim labels (I-03). Labels are lower case for now, and every label comparison ignores case, so `in development` matches GitHub's existing `In development` (owner, 2026-10-13) |
| `skipLabels` | `[]` | labels that keep an issue out of `D1` (I-92) |
| `trackerTitle` | `^(Epic\|Tracker)\b` | a title that marks a tracker, like sub-issues do (I-91) |
| `usageSlowPct`, `usageStopNewPct`, `usageStopAllPct` | 85, 90, 95 | the tiers (I-12 to I-16) |
| `allowActOutsideOrchestrator` | `false` | act mode without `DEV_ROLE=orchestrator`, for a testbed (11.2) |
| `passEveryMs` | `60s` | the timer |
| `queueEveryMs`, `githubEveryMs`, `usageEveryMs`, `milestoneEveryMs` | `2m`, `5m`, `5m`, `10m` | observe cadences |
| `usageStaleMs` | `15m` | an older reading counts as unavailable |
| `heartbeatEveryMs`, `sweepEveryMs` | `20m`, `30m` | rules `H1`, `H2` |
| `slowGapMs` | `10m` | Slow: the least time between two claims |
| `maxStartsPerPass` | 4 | claims per pass in Normal |
| `maxInFlightIssues` | 5 | a cap on this device's live issues (owner, 2026-10-13; lowered from 10 after the testbed run). Reaching it shows: the decision log names each claim it holds back, the title adds `at cap`, a `loop` event records it, and the owner is told once each time it is reached |
| `worktreeReserve` | 2 | free slots kept for fixers and re-drives |
| `reviewFixCap` | 3 | review fix rounds per run (I-48) |
| `guardRecheckMs`, `guardTtlMs` | `3m`, `30m` | guard freshness (rule `M1`) |
| `respondSettleMs` | `15m` | a respond that leaves the gate unmoved this long is retried once |
| `updateBehindRetryMs`, `updateBehindRetries` | `5m`, 3 | `UPDATE-BEHIND SKIP` handling |
| `ciStallRecheckMs` | `15m` | how long after a reopen a second stall counts |
| `blindNoticeAfterMs` | `15m` | blind this long tells the owner |
| `agentTimeoutMs` | designer `1h`, implementer `2h`, adjudicator `30m`, fixer `2h` | then `stop-agent` (rule `A1`) |
| `maxAttempts` | claim 3, designer 2, implementer 2, adjudicator 2, fixer 2, respond 2, merge 2, fix-linkage 2, guard 3, release-worktree 2, pr-reopen 1, stop-agent 1, restart-self 1, judge, task and tell 1 (one reminder inside the attempt); heartbeat 3 and sweep 3; any other kind 3; `update-behind` runs `updateBehindRetries` + 1 times | then the owner hears of it (`tell(agent-failed)`, `tell(task-timeout)` for a task). Heartbeat and sweep are never used up: that many failures in a row tells the owner once, and they keep trying at their cadence (DECISIONS D-47) |
| `retryBackoffMs` | `2m` | doubled per attempt; for heartbeat and sweep at most their cadence. A `lost` entry is retried at once |
| `wakeTimeoutMs` | judge `30m`, task `6h`, tell `30m` | section 8 |
| `rateCaps` | starts 30, spawns 120, wakes 20 per rolling hour, and 6 actions of one kind on one issue; no global cap on merges (DECISIONS D-24) | runaway protection (11.4) |

Time settings take a duration in the files: `60s`, `5m`, `2h`, with the key's `Ms` dropped
(`passEvery: "60s"`). A plain number still reads as milliseconds. The loader converts them, so
the code keeps the `Ms` names and works in milliseconds (owner, 2026-10-13). A duration string
under the `Ms` spelling is a bad value. Recorded states for the replay are not a setting: they
are written in observe mode only (section 11.6).

### 4.3 Control state (owner directives)

```ts
type Control = {
  paused: number[]                // no action at all on these issues (their claims still renew)
  noNewWork: boolean              // wind-down or drain: no start and no develop actions
  skip: number[]                  // never claim these
  priority: number[]              // claim these first, in this order
  only: number[]                  // claim only these, in this order (empty: no limit); a tracker stands for its
                                  //   open sub-issues; work in flight goes on
  serial: boolean                 // one issue in flight at a time (a drain in order)
  usageOverride: { untilPct: number; expiresAt: Ms } | null   // run past a threshold (I-19)
  updateDue: { reason: string; at: Ms } | null   // an update is due (rule H4): set by the reconciler or `/factory update`
  resumed: { subject: string; at: Ms }[]  // holds the owner released: 'issue:<N>' or 'run:<id>'
  dropped: { issue: number; at: Ms }[]     // issues the owner dropped: abandon them (rule D6)
  notes: { issue: number | null; text: string; at: Ms }[]     // owner instructions for agents
}
```

They live in `<loop dir>/control.json`, which observe reads field by field each pass: a missing
or malformed field takes its empty value, so one bad directive never voids the others. The model
sets them with the `mcp__factory-loop__control` tool (`{ "op": "<op>" }`) when the owner says so
in chat, and the owner can type `/factory <op>` from any client (named so to stay clear of Claude
Code's built-in `/loop`, which the released orchestrator uses as a cron for its ticks): `status`,
`pause <N>`, `unpause <N>`, `skip <N>`, `noskip <N>`, `priority <N...>|off`, `only <N...>|off`,
`serial on|off`, `new on|off`, `override <pct> <hours>|off`, `resume <N|run id>`, `retry <N>`,
`update [<reason>]|off`, `drop <N>`, `note [<N>] <text>`, `mode off|observe|act`. Each change
pings the loop and gets its own decision-log line (`control`). Today these directives are free
text in the memory file (I-90).

- An empty op is `status`: the last pass and the directives in force. `help` lists the ops and
  changes nothing.
- Issue numbers may take a `#`, and a list may use commas. `resume` also reads `issue:<N>` and
  `run:<id>`; a run id that is all digits needs the `run:` prefix.
- Limits, refused rather than cut: an override's percentage above 0 and at most 100 and its
  hours above 0 and at most 168; an update's reason at most 300 characters; a note at most
  2 000.
- `drop` of an issue already dropped does nothing (a second entry would plan a second abandon).
  `retry` works through the ledger (section 7.1). `mode` is written to the workspace file (4.1)
  and applies from the next pass.
- A malformed op changes nothing and answers with its usage. An op that changes nothing
  (pausing a paused issue) says so and writes nothing.
- A control.json that is not a JSON object is never overwritten: every changing op is refused
  with "fix or remove it", and `status` still answers, with a warning. A workspace file that is
  not a JSON object likewise refuses `mode`.
- The control tool refuses every op but `status` from inside an agent: only the main
  conversation sets directives.
- `/factory` is immediate, so a directive typed during a long wake turn applies at once. Ops run
  one at a time.

## 5. Plan: the decision table

`plan(state, config) -> { actions, title, skipped, tier, owner, capped, atCap }`. Rules run in
the order below; each emits zero or more actions, and the result keeps that order (finish
in-flight work before starting new work). The tier gate, the control filters and the caps apply
to every emitted action before it is kept. An ACTION or answer a rule does not expect (a gate
adjudicator answering `merge`, say) plans nothing and names itself in the skip reasons.

### 5.1 Helpers

- **mine(i)**: `i.holder === state.device`.
- **entry(key)**: the ledger entry with that key, if any.
- **blocked(key, kind)**: an entry exists and it is `running`; or it is `done` (and the kind is
  not refreshable, or it has not expired); or it is `failed`, `timed-out` or `lost` and its
  agent is still listed at work (it waits until the agent list shows the agent ended, so two
  agents never work one key); or it is `failed`, `timed-out` or `lost` with
  `attempts >= maxAttempts[kind]` (exhausted; never for heartbeat and sweep), or, unless it is
  `lost`, with its backoff (`retryBackoffMs * 2^(attempts-1)` after `endedAt`, at most the
  cadence for heartbeat and sweep, `updateBehindRetryMs` for update-behind) not yet elapsed. A
  rule emits an action only when its key is not blocked. A retry keeps the key and adds an
  attempt. An exhausted key is named in the skip reasons (`exhausted: <key>`), which is what
  `/factory retry` clears.
- **briefOf(i)**: the designer outcome's brief URL for the current life, else `i.brief.url`,
  else `i.delegatedBrief`, else null.
- **live stages**: `designing`, `implementing`, `in pipeline`, `parked`, `ready to merge`.
- **resumedSince(subject, t)**: the owner released this subject after time `t`.

### 5.2 Gates (G)

| Rule | When | Then |
|---|---|---|
| G1 | mode `off`, or the kill switch exists | The driver does not observe or plan. Title: `🔄 <name> · off`. (Driver, not plan.) |
| G2 | `sources.factory.ok` is false | Blind pass: no actions except `title`, and `tell(blind)` once the factory source has been failing for `blindNoticeAfterMs`. When `runs` failed, the `P` and `M` rules emit nothing; when `queue`, `github` or `pool` failed, `D1` emits nothing |
| G3 | always | `tier = tierOf(usage, config, control.usageOverride, now)`: the higher of `fiveHour` and `sevenDay` (a window whose reset has passed counting as zero) against the thresholds; Normal when unavailable (flagged); an unexpired override keeps the tier Normal below its `untilPct` |
| G4 | always | Control filters: an action on a `paused` issue is dropped (except `heartbeat` and `title`); an action on a `dropped` issue is dropped except `abandon`, `stop-agent` and `tell`; `noNewWork` drops the `start` and `develop` classes; while `updateDue` is set, the `start`, `develop` and `drive` classes are dropped (rule `H4`); `skip` removes issues from `D1`; `priority` orders `D1`; a non-empty `only` limits `D1` to its issues, in its order (`noNewWork` still wins); `serial` allows a claim only while this device has no live issue |

**Tier and class matrix** (each action kind has one class, section 6):

| Class | Normal | Slow | Stop new | Stop all |
|---|---|---|---|---|
| `free` (CLI work that spends no tokens) | yes | yes | yes | yes |
| `owner` (`tell`) | yes | yes | yes | yes |
| `drive` (adjudicator, fixer, respond, judge, task) | yes | yes | yes | no |
| `develop` (designer, implementer for a claimed issue) | yes | yes | no | no |
| `start` (claim) | up to `maxStartsPerPass` | one per pass, none within `slowGapMs` of the last claim, none while merge work is planned this pass or still running | no | no |

A claim still running counts as started: it takes its place under the per-pass limit, the
worktree reserve, `maxInFlightIssues` and `serial`, so planning again while it runs adds no
claim (property 2, section 5.9).

### 5.3 Housekeeping (H)

| Rule | When | Then | Key |
|---|---|---|---|
| H1 | this device holds a live-stage issue, and the stalest of their leases was last renewed before `loadedAt` (the first pass after any load) or at least `heartbeatEveryMs` ago. An issue's lease was last renewed by the later of its own claim and the last `heartbeat`, so a fresh claim does not trigger one | `heartbeat` | `heartbeat:<last done endedAt or 0>` |
| H2 | the last `sweep` ended at least `sweepEveryMs` ago, or never | `sweep` | `sweep:<last done endedAt or 0>` |
| H3 | a pool slot is not busy, is clean, sits on a branch whose issue is `merged` or `closed without merge`, and no running agent of the loop names that issue | `release-worktree` | `release:<path>:<branch>` |
| H4 | `control.updateDue` is set. While it is, the loop drains: `start`, `develop` and `drive` actions are dropped. Once the safe state holds (the `runs` source reads; no ledger entry running, so no loop agent, wake or command in flight; no pipeline run of any device `running`, `pending` or `ci-stalled`) and the pass plans nothing else | `restart-self`, last, after the title. A drain longer than 60 minutes gives `tell(drain-slow)` once, with what it still waits on. A restart that fails is not tried again (`maxAttempts` 1): the owner is told (`tell(agent-failed)`) and the drain holds until the update is set again or turned off. Nothing in a blind pass | `restart:<updateDue.at>`, `tell:drain-slow:<updateDue.at>` |

Once `dev-restart-self` returns, the module starts nothing more, sends no notice and no
reminder: Coder has accepted the build, and the container is replaced minutes later. The drain
ends only when a later module load finds the restart entry `lost` (the session restarted under
it) or `done` before that load; that pass clears `updateDue` from control.json and logs it
(DECISIONS D-53).

### 5.4 Pipeline gates (P)

The `P` and `M` rules act only on an issue's **current run**: the newest run of the issue's
branches (ULIDs sort by creation time; an `unknown` id counts only when it is the issue's only
run) that no `superseded` event names, on an issue that is still live. The issue must also be one this device holds: another device's run, or a run nobody claimed
(the owner's own), is not this loop's to drive. A run on a replaced
branch is history: 18 of the 21 cancelled runs on dev-system in the week to 2026-10-12 were
followed by a `superseded`, `merged` or `abandoned` event on their issue.

For each current run, issue not paused:

| Rule | When | Then | Key |
|---|---|---|---|
| P1 | `parked` or `failed`, `step = review`, and `reviewFixRounds >= reviewFixCap + resumes of run:<id>` | no adjudicator; `tell(review-cap)` with the brief URL and the run's verdict lines | `tell:review-cap:<run>:<rounds>` |
| P2 | `parked`, or `failed` with a known run id (the step when known: the adjudicator finds it otherwise); not `P1`; on a review gate only when `facts` is ok | `spawn(adjudicator, purpose gate)` with run, branch, step, brief URL and the issue's model label | `adjudicate:<run>:<step>:<head>[:r<n>]` |
| P3 | the `P2` entry is `done`, and the run is still at that step and head | by its `ACTION`: `approve`, `fix`, `skip` give `respond`; `escalate` gives `tell(escalate)` and a hold until resumed (then `P2` again with `:r<n>`) or the head moves; `fixer` gives `spawn(fixer, purpose gate)`; an unparseable reply counts as a failed attempt of `P2` | `respond:<run>:<step>:<head>:<action>`, `tell:escalate:<run>:<step>:<head>`, `fixer:gate:<run>:<step>:<head>` |
| P3a | a `respond` entry is `done`, the run is still at that step and head `respondSettleMs` after it ended | `respond` once more; after that `task(respond-stuck)`: the model reads the run's log and `daemon.log`, then re-drives or reports (DECISIONS D-37) | `respond:...:retry`, `task:respond-stuck:<run>:<step>:<head>` |
| P4 | `failed` with run id `unknown` | `task(redrive)` for the model (I-57) | `task:redrive:<branch>:<head>` |
| P4a | `failed` or `cancelled` while the loop's own fixer or re-drive for the issue runs or ended under 30 minutes ago | nothing: that work's handoff or new run comes next | none |
| P5 | `cancelled` | `judge(cancelled)`; answer `redrive` gives `task(redrive)`, `drop` gives `abandon` | `judge:cancelled:<run>:<head>` |
| P6 | `ci-stalled reason=no-workflow` | hold, `tell(no-ci)` | `tell:no-ci:<run>` |
| P6a | `ci-stalled reason=no-checks`, no reopen yet for this run | `pr-reopen` | `reopen:<pr>:<run>` |
| P6b | still `ci-stalled` `ciStallRecheckMs` after the reopen | hold, `tell(ci-triggers)` | `tell:ci-triggers:<run>` |

### 5.5 Merge (M)

For each current run in `merge-ready`, `head-mismatch` or `conflict` with a PR, issue not paused:

| Rule | When | Then | Key |
|---|---|---|---|
| M1 | no fresh guard outcome for this PR and head: none at all, or the last one ended before a repair on this PR (a `fix-linkage`, or an `update-behind` that pushed a new PR head), or it saw only transient failures and is older than `guardRecheckMs`, or it is older than `guardTtlMs`. A guard that failed or was lost runs again under its key | `guard` | `guard:<pr>:<head>:<n>`, n counting this PR and head's guard entries |
| M2 | the latest guard outcome for this PR and head has FAIL lines | the first match, in this order: `author` gives hold plus `tell(untrusted-pr)`; `rollout` gives `tell(rollout)`; `base` gives `tell(base)`; `gates` waits (the `P` rules own it); `mergeable` with "PR is merged/closed" waits for observe; `mergeable` conflict, or the run state `conflict`, gives `spawn(fixer, purpose conflict)`; `mergeable` behind gives `update-behind`; `linkage` gives `fix-linkage` once per head, and a second linkage FAIL after it tells the owner (`tell(linkage)`); `checks` where every bad check is `pending`, `mergeable` "not computed" or "branch rules" waits for the recheck; `checks` with a failed check, `head`, or any line no rule names gives `judge(guard-fail)`, whose `fixer` answer gives `spawn(fixer, purpose guard)` and whose `hold` holds until the owner resumes the run | `fixer:conflict:<pr>:<head>`, `update-behind:<pr>:<prhead>`, `fix-linkage:<pr>:<head>`, `tell:linkage:<pr>:<head>`, `judge:guard-fail:<pr>:<head>:<n>`, `fixer:guard:<pr>:<head>` |
| M2a | an `update-behind` outcome is `FAIL` | `spawn(fixer, purpose regate)` with the line's re-gate instruction | `fixer:regate:<pr>:<prhead>` |
| M2b | an `update-behind` outcome is `SKIP` (a failed attempt) | `update-behind` again after `updateBehindRetryMs`, at most `updateBehindRetries` times; then hold plus `tell(update-behind)` | `update-behind:<pr>:<prhead>` (its attempts) |
| M3 | the guard passed with `test-weakening WARN` lines and no `pr-comment` for this head yet | `spawn(adjudicator, purpose weakening)` with the lines; `approve` or `skip` gives `pr-comment` with the WARN and verdict lines, then `M4`; `fixer` or `fix` gives `spawn(fixer, purpose weakening)`; `escalate` (or `hold`) gives a hold plus `tell(escalate)` until the head moves or the owner resumes the run, which asks for a fresh review with `:r<n>` | `adjudicate-weakening:<pr>:<head>[:r<n>]`, `pr-comment:<pr>:<head>`, `tell:escalate:pr:<pr>:<head>[:r<n>]`, `fixer:weakening:<pr>:<head>[:r<n>]` |
| M4 | the guard passed, every WARN is resolved for this head, and no `merge` answer carries over (M5) | `spawn(adjudicator, purpose merge)`, seeded with ids and pointers only (DECISIONS D-05): the issue, brief URL, PR, run, head, the implementer's handoff head, this head's guard lines and the run's verdict lines. It checks the pipeline's fix commits after the handoff head against the brief, the PR body's linkage, and UI evidence for a visual change, and returns `ACTION merge`, `hold` (or `escalate`, read as a hold) or `fixer`, a one-line summary, the bump with a reason, and sequencing flags | `adjudicate-merge:<pr>:<head>[:r<n>]` |
| M5 | the merge adjudicator answered `merge` for this head, or, on a head's first round, for the head an `update-behind` of this PR rebased from (its patch is proven unchanged, so the answer carries over, with any `judge(sequence)` `merge` it got); the run is still mergeable at this head; and no sequencing rule holds it: a `run-it` PR waits while another merged `run-it` issue's Run it is not finished (its `task(run-it)` not answered `done`, the issue open, and the owner has not resumed that issue since), and a major bump or a `run-it`, `image` or `template` flag (not `restart` alone) first gets `judge(sequence)` with the report's lines, never the diff | `merge`, after `judge(sequence)` answers `merge` when one was needed | `merge:<pr>:<head>`, `judge:sequence:<pr>:<head>[:r<n>]` |
| M5a | the merge adjudicator answered `hold` or `escalate`, or `judge(sequence)` answered `hold` or timed out | hold until the head moves or the owner resumes the run, which asks for a fresh review with `:r<n>`; `tell(merge-hold)` with the reason | `tell:merge-hold:<pr>:<head>[:r<n>]` |
| M5b | the merge adjudicator answered `fixer` | `spawn(fixer, purpose review)` with its instructions | `fixer:review:<pr>:<head>[:r<n>]` |
| M6 | `merge` ended `done` with a refusal by GitHub or the harness (the head moved, a branch rule) | hold, `tell(merge-refused)` with the refusal line | `tell:merge-refused:<pr>:<head>` |
| M7 | a `merge` entry is `done` with its rollout; or an issue this device held reached `merged` in the last 24 hours with no merge of the loop's own running or merged (a hand merge, which the sweep logs); or a loop merge in the last 24 hours whose rollout read failed | a hand merge or an unread rollout gives `rollout` (`callum-flow-rollout`). Then by the merged issue's rollout: `merge` with `close_issue` gives `close-issue`, and so does a hand-merged `merge` rollout whose PR's latest guard failed `base` with "PR targets ..." (an epic base, where GitHub registers no closing reference); `run-it` gives `milestone-later` (when opted in) and `task(run-it)`; `keep-open` gives `milestone-later`. A `bump` in the PR's latest merge report above the milestone's `Expected` gives `milestone-expect` | `rollout:<issue>`, `close:<issue>`, `milestone-later:<issue>`, `task:run-it:<issue>`, `expect:<bump>:<pr>` |

`<prhead>` is the PR's head as this loop's own updates left it: an `update-behind` pushes a new
PR head but never moves the run's head, which the watcher keeps printing, so the next update
starts from the head the last `UPDATED` line pushed (DECISIONS D-50).

A guard FAIL that `merge` itself prints (the guard runs again inside it) is recorded as that
head's next guard outcome, so `M2` handles it on the next pass, and the merge counts as a failed
attempt: once `M2` clears the FAIL, `M5` merges again while attempts remain. Only a refusal by
GitHub or the harness is `M6`.

### 5.6 Design and delegation (D)

| Rule | When | Then | Key |
|---|---|---|---|
| D1 | for each queue member, in `only` order (or else `priority` order) and then ascending: open, trusted, has `readyLabel`, no `skipLabels`, `blockedBy = 0`, `subIssues = 0` and no tracker title (not a tracker, I-91), stage `queued` or unknown to the database, not skipped, paused or dropped, and the last claim attempt did not lose to a still-live claim; capacity: `pool.free`, minus this device's issues in design (each takes a worktree once its implementer starts) and the claims started (this pass's and those still running), above `worktreeReserve`, and under `maxInFlightIssues`. A claim the in-flight cap holds back adds `at cap` to the title and `tell(at-cap)` once each time the cap is reached. An issue `only` names that is not in the ready queue is named in the skip reasons; a tracker `only` names whose sub-issues are not read yet stands for nothing that pass | `claim`; `tell(at-cap)` | `claim:<N>:<stageSince or 'new'>`, `tell:at-cap:<endedAt of the last done claim, or 0>` |
| D2 | mine, stage `designing`, no brief newer than `stageSince`, no designer running or done for this life. A brief posted this life while no designer runs or answered (the loop restarted while it ran, or it failed, timed out or was lost after posting) goes to `judge(report)` instead of a new designer | `spawn(designer)` with the issue's model label and the owner's notes | `design:<N>:<stageSince>[:r<n>]`, `judge:report:brief:<N>:<url>` |
| D3 | the designer entry is `done` | by its `RESULT` line: `pending_decision=yes` gives a hold plus `tell(decision)` until resumed (then `D2` again with `:r<n>` and the owner's notes); `created=<list>` gives `release-parent` (and `A2` if an implementer is running); a brief with no pending decision goes to `D4`; no `RESULT` line gives `judge(report)` | `tell:decision:<N>:<brief>`, `release-parent:<N>`, `judge:report:<entry key>` |
| D4 | mine, stage `designing` (not yet delegated), a brief for this life (`briefOf`), no pending decision | `delegate` (route, `delegated` event, `spawn(implementer)`) | `delegate:<N>:<brief>` |
| D4b | mine, stage `implementing`, no run at all, and the last `delegate` entry `failed`, `timed-out` or `lost` | `delegate` again under the same key while attempts remain (then `tell(agent-failed)`) | `delegate:<N>:<brief>` |
| D5 | an implementer or fixer entry is `done`, its issue is live, and its handoff is not gated (it says `gated=no`, its head is not its commit, or it says `NOT GATED`) | `judge(handoff)`; a `fixer` answer gives `spawn(fixer, purpose handoff)` | `judge:handoff:<entry key>`, `fixer:handoff:<entry key>` |
| D6 | the owner dropped an issue (`control.dropped`) that is not `closed without merge` | `abandon` with its run and branch when known, then `A2` stops its agents | `abandon:<N>:<at>` |

### 5.7 Agents (A)

| Rule | When | Then | Key |
|---|---|---|---|
| A1 | a `running` agent entry is older than its `agentTimeoutMs` | `stop-agent`; when the stop ends, stopped or not, the agent's entry becomes `timed-out`. A stop that failed leaves the agent marked `timed-out` and tells the owner (`tell(agent-failed)` for its `stop:` key); its rule waits until the agent list shows the agent ended, so a second agent never starts beside it. A `failed`, `timed-out` or `lost` agent is retried by its own rule while attempts remain; once exhausted, `tell(agent-failed)` (`tell(task-timeout)` for a task) | `stop:<agentId>`, `tell:agent-failed:<key>`, `tell:task-timeout:<key>` |
| A2 | a running agent's issue is not paused, and it closed or ended (`merged`, `closed without merge`), was claimed by another device, was dropped by the owner, or was split while its implementer runs | `stop-agent`, and `tell(claim-lost)` for another device's claim, else `tell(stopped)` with why (`closed`, `merged`, `closed without merge`, `dropped` or `split`). The stopped agent's entry ends with its own `turn.complete` or the agent list | `stop:<agentId>`, `tell:claim-lost:<N>:<holder>`, `tell:stopped:<agentId>` |

### 5.8 Owner and report (O)

| Rule | When | Then | Key |
|---|---|---|---|
| O1 | always, last (before a `restart-self`) | `title` when `titleOf(state, tier)` differs from `lastTitle` (section 9.1) | none (compared, not keyed) |
| O2 | any wake (`judge`, `task`, `tell`) is planned | keep at most one wake per pass and none while another wake is `running`, picked in order: `tell` of an owner decision or action, `judge`, `task`, other `tell`. Notices from outside plan (a rail, the ping breaker, failing passes: section 9.2) go out through the same executor once no wake is open | the wake's own key |
| O3 | opted in, the milestone has no open items and at least one closed | `task(release)` once per milestone state | `task:release:<closed>:<expected>` |

### 5.9 Properties every plan must keep

The tests in `tests/plan.test.ts` check these on every call to `plan` they make, as well as the
expected actions:

1. **Determinism**: the same state and config give the same result.
2. **Idempotence**: starting every planned action in the ledger (as `ledger.ts` does, so
   `running`) and planning again yields no action except `title`.
3. **No I/O**: `plan.ts` imports types only and reads no clock (`tests/factory-loop-plan.test.js`
   reads its source, since plugin tests cannot read files).
4. **Tier safety**: no action of a class the tier forbids, whatever the state.
5. **Control safety**: no action names a paused issue except `heartbeat`; nothing is claimed
   with `noNewWork`.
6. **Bounded**: at most one wake per pass, at most `maxStartsPerPass` claims, and no rate-cap
   bucket, or kind on one issue, past its cap.

## 6. Actions

### 6.1 Catalogue

Every action carries `key`, `kind`, `class`, `rule` (the ID that emitted it) and `reason` (a few
words for the log). Commands run without a shell, from the main checkout unless noted, with the
mode's environment (sections 4.1, 11.1). Every `gh` command gets `--repo <R>`, so a write can
only reach the configured repo.

| Kind | Class | Executor | Timeout | Retries | Outcome recorded |
|---|---|---|---|---|---|
| `heartbeat` | free | `callum-flow-claim --heartbeat` | 120 s | never used up: next due time | exit code (the CLI logs `renewed`) |
| `sweep` | free | `callum-flow-sweep` | 300 s | never used up: next due time | exit code (the CLI logs `reclaimed`, `closed`) |
| `claim` | start | `callum-flow-claim <N>` | 120 s | 3, backoff | `claimed`, `lost` (exit 3) or `failed` |
| `spawn` designer | develop | `$.agent.spawn({ subagentType: 'callum-flow:designer', model?, description, name, prompt })` | start 60 s, agent `agentTimeoutMs` | 2 | parsed `RESULT` line (7.2) |
| `delegate` | develop | `callum-flow-implementer-route <N>`, then `callum-flow-event delegated --issue <N> --note "brief <url>"`, then spawn `callum-flow:implementer` with the routed model. A brief that is not a comment URL on the repo is refused | route 60 s, start 60 s, agent `agentTimeoutMs` | 2 | handoff fields (6.3) |
| `spawn` adjudicator | drive | spawn `callum-flow:adjudicator` (gate, weakening or merge purpose) | start 60 s, agent 30 min | 2 | verdict lines and one `ACTION` (7.3); the handler logs each verdict |
| `spawn` fixer | drive | spawn `callum-flow:fixer` with instructions and the brief URL | start 60 s, agent 120 min | 2 | handoff fields; `superseded` logged when it reports a branch other than the one it was sent to |
| `respond` | drive | `no-mistakes axi respond --action <a> [--step=<step>] [--findings=] [--instructions=] [--add-finding=] [--reason=]`, each value one argv entry, launched detached with `nohup` from the pool slot that has the run's branch checked out (else a slot leased with `treehouse get --lease --lease-holder factory-loop` and `git switch <branch>`, returned at once if the switch fails). `--step` is left out when the step is not known. The launch reads its log back after 5 s | launch 30 s | 2 (P3a) | done once launched cleanly: the slot and the log (`<loop dir>/respond/<key>-<attempt>.log`); failed when the log shows "no active run to respond to", respond already exited non-zero, or the slot is not on the branch. A review `fix` logs `fix_requested --note review` |
| `guard` | free | `callum-flow-merge-guard <pr> --run <id>` | 300 s | 3; refreshable (M1) | parsed `GUARD` lines (6.2) |
| `update-behind` | free | `callum-flow-merge-guard <pr> --update-behind --run <id>` | 300 s | M2b | `UPDATED` (the handler logs `rebased_behind --issue --run --branch --pr --head <to>`) and `FAIL` are done; `SKIP` is a failed attempt |
| `fix-linkage` | free | `callum-flow-fix-linkage <pr>` | 120 s | 2 | `MATCH`, `SKIP`, `REPAIRED` or still mismatched |
| `merge` | free | `callum-flow-merge <pr> --run <id>`, then `callum-flow-rollout <N>` | 600 s | 2 | merged with its rollout and `close_issue` (a rollout read that failed is recorded as unread, never a failed merge); a FAIL from its own guard is a failed attempt, with that guard outcome recorded beside it; a refusal by GitHub or the harness is done, `refused` |
| `rollout` | free | `callum-flow-rollout <N>`, for a hand merge or a merge whose rollout read failed (rule `M7`) | 60 s | 3 | the rollout |
| `close-issue` | free | `gh issue close <N> --repo <R> --reason completed` | 60 s | 3 | exit code |
| `release-parent` | free | `gh issue edit <N> --repo <R> --remove-label <inDevLabel>`, then `callum-flow-event abandoned --issue <N> --note "split into <list>"` | 60 s | 3 | exit codes |
| `abandon` | free | `gh issue edit <N> --repo <R> --remove-label <inDevLabel>`, then `callum-flow-event abandoned --issue <N> [--run] [--branch] --note <why>` | 60 s | 3 | exit codes |
| `milestone-later` | free | `callum-flow-milestone plan <N> later` | 60 s | 3 | exit code |
| `milestone-expect` | free | `callum-flow-milestone expect <bump> "<reason>"`, the reason on one line | 60 s | 3 | exit code |
| `pr-reopen` | free | `gh pr close <pr> --repo <R>`, then `gh pr reopen <pr> --repo <R>` | 60 s | 1 | exit codes |
| `pr-comment` | free | `gh pr comment <pr> --repo <R> --body-file -` (the WARN lines and the adjudicator's verdicts on stdin) | 60 s | 3 | exit code |
| `release-worktree` | free | `treehouse return <path>` with empty stdin and never `--force` (a slot that turned dirty keeps its work), then `treehouse status --json` | 120 s | 2 | done only when the slot shows `available` |
| `restart-self` | free | `dev-restart-self`, only from rule `H4` | 600 s | 1 | the session restarts, and the loop resumes on load (7.5) |
| `stop-agent` | free | `$.tool.call({ tool: 'TaskStop', task_id })`, only for an agent the ledger holds running | 30 s | 1 | stopped, or failed with the reason (section 13) |
| `judge` | drive | `$.prompt.submit` with a `JUDGE` line (section 8) | `wakeTimeoutMs.judge` | 1 reminder | the answer |
| `task` | drive | `$.prompt.submit` with a `TASK` line | `wakeTimeoutMs.task` | 1 reminder | `done`, `failed`, `hold` |
| `tell` | owner | `$.prompt.submit` with a `TELL` line | `wakeTimeoutMs.tell` | none | delivered when its turn says something |
| `title` | free | `$.command.run({ command: 'rename', args })` | 10 s | next pass | the text set |

A spawn is named `<type>-<N>[-<purpose>][-<attempt>]` (`adjudicator-470-merge`,
`fixer-470-regate-2`: the attempt from the second on, so a retry never shares a name with an
agent still winding down), and its description names the issue (D-11). A spawn denied, one that
throws, or one that starts with no agent id is a failed attempt. An agent's turn that ends in
`error`, `aborted` or `refusal` is a failed attempt too. Exit 2 is a usage error, never retried,
for the image's own CLIs (`callum-flow-*`, `dev-restart-self`); `gh` exits 2 when cancelled and `treehouse` 1 on bad
usage, so their exit 2 is retried like any failure.

Things no executor can do, by construction: pass `--yes`, run `no-mistakes rerun` or `abort`,
merge without the guard, edit a PR body, add the `ready` label, run any `coder` command, kill a
process by name, or stop an agent the loop did not spawn. `tests/safety.test.ts` runs every
action kind, spawn purpose and respond shape through the dispatcher with a recording fake and
checks every argv, and `tests/factory-loop-safety.test.js` scans every string in `hooks/*.ts`;
both fail on any of them. The one `kill` allowed is the old-watcher rail's `kill -0` probe,
which signals nothing (11.2).

### 6.2 Parsing guard output

Each `GUARD <name> FAIL <reason>` line becomes `{ name, reason }`, and each
`GUARD test-weakening WARN ...` line becomes a warning. The `mergeable` reason is classified by
its fixed prefixes: `conflicts with` is a conflict, `behind` is behind, `GitHub has not
computed`, `branch rules not met` and `cannot read` are transient, `PR is merged`, `PR is
closed` and `PR is a draft` are states. The `checks` reason is a list of `name=bucket` pairs:
only `pending` buckets is transient, any other bucket is a failure; `no checks reported` and a
`cannot ...` reason are transient. A line matching nothing is unknown (rule `M2` sends it to
`judge(guard-fail)`).

### 6.3 Agent prompts

Each spawn's prompt comes from a template in `hooks/prompts.ts`. Templates carry only issue
numbers, URLs, branch names, run ids, heads, step names, instructions from the adjudicator or
the model, owner notes, pointers (CLAUDE.md, the agent type's own memory file under
`.claude/agent-memory/`, the `implement-issue` skill), a per-issue scratch subdirectory (I-95),
and the closing `RESULT` line the loop parses. The designer's also lists other issues' branches
in flight (names only), and a prompt for an issue with a `model:` label says to pass that model
to the agent's own sub-agents.

- **No brief content.** A brief travels as its comment URL only; anything else in its place is
  dropped and the prompt says to read the issue instead.
- **No closing keyword.** The template text uses none of the words. In free text (owner notes,
  instructions, guard and verdict lines) a closing keyword before an issue reference (`#N`,
  `GH-N`, `owner/repo#N`, a URL), or at the end of the value, becomes its `-ing` form ("Fixes
  #12" reads "Fixing #12"), so an agent that copies it into a PR body closes nothing (I-33).
  Every id (branch, run, head, step, model, repo) must have its shape, or it shows as not known.
- **The lines the loop parses.** The designer ends with the `RESULT` line of section 7.2.
  The implementer and the fixer end their handoff with
  `RESULT run=<id|none> head=<sha|none> commit=<sha|none> gated=<yes|no> branch=<name> pr=<n|none>`.
  A handoff is not gated when it says `gated=no` or its head is not its commit (short and full
  SHAs compare by prefix); with no such line, the words `NOT GATED` still count; anything else
  is unparseable, a failed attempt. A designer's or a handoff's `RESULT` line wrapped in
  backticks reads the same; the adjudicator's reply stays strict (7.3).
- **Records.** Before each spawn the loop writes `<loop dir>/spawns/<key>.json` (the branch the
  spawn named, its purpose, model and the exact prompt); each answer is saved whole at
  `<loop dir>/answers/<key>.txt`, which `judge(report)` and `judge(handoff)` point the model at.

`tests/prompts.test.ts` renders every template with hostile inputs and checks for brief content
and closing keywords.

## 7. Ledger

### 7.1 Entries

```ts
type LedgerEntry = {
  key: string                     // the idempotency key: kind plus its subject's fingerprint
  kind: ActionKind
  class: ActionClass
  rule: string
  issue: number | null
  run: string | null
  pr: number | null
  head: string | null
  agent?: AgentType               // spawns; 'implementer' for a delegate
  wake?: string                   // judge, task, tell: the wake's name
  status: 'running' | 'done' | 'failed' | 'timed-out' | 'lost'
  attempts: number
  startedAt: Ms
  endedAt: Ms | null
  agentId?: string                // spawns and delegates
  wakeId?: string                 // judge, task, tell (section 8.1 `id=`)
  turnId?: string                 // the turn the wake started
  reminded?: boolean              // its one reminder went out
  session?: string                // the session that submitted the wake (7.5)
  outcome?: Outcome               // parsed result, per kind
  summary?: string                // the executor's last few words, for the decision log
}
```

**One attempt.** Before an action runs, `start` records its entry as `running`: a new key at
attempt 1, a key that failed, timed out or was lost at attempt n + 1 with its old outcome
cleared. The running entry reaches the store before the command, spawn or wake starts, so a
reload or a restart at any point finds it (and marks it `lost`, 7.5). `finish` then applies the
executor's result: its status, outcome (the last one kept when the result carries none) and
summary. A `skipped` result (the usage pre-check, a dropped prompt) counts no attempt: the entry
goes back as it stood, or goes when it was new. A usage error (exit 2) uses up the attempts at
once. An executor may record extra done entries beside its own (a guard outcome a merge
printed). A finished `stop-agent` of rule `A1` marks the agent's entry `timed-out`. Agents end
by their `turn.complete` (matched by agent id) and wakes by their answer, delivery or timeout,
outside the pass.

**In memory, one writer.** The module loads the ledger from the store once per load (and again
when it takes the act lease over from another session), keeps it in memory, and saves it after
every change, each before its `loop` event. It writes back only while the act lock names this
session or still stands as it did at the load (section 11.2): a lease another session wrote
since means that session kept the ledger, and this one reloads before it acts again. A store
that cannot be read leaves the ledger unloaded and the pass does not act; it never falls back to
the event log, which would overwrite the real ledger at the next save. A failed save is section
10.10.

**In the store.** The ledger lives in `$.store` under `ledger:<repo>` as
`{ v: 1, savedAt, entries }`. Entries are pruned 7 days after they end; running entries are
never pruned. The store holds 4 MiB for all of the plugin's keys, so the ledger keeps within
3 MiB: past it, the entries that ended longest ago go first, never a running one. A busy
synthetic week (over 3 500 entries, more than twice the 1 600 events dev-system's orchestrator
logged in 7 days) stays under 2 MiB with nothing dropped. The other keys are `backoff:<repo>`,
`queue-known:<repo>`, `rails:<repo>` (the rails' memory) and `notices:<repo>` (notices waiting
for a wake to close, 9.2).

**Retry.** `/factory retry <N>` (D-38) resets the attempts of the issue's exhausted entries to 0,
so their rules try again from the next pass: the entries stay, since a rule may need the failed
entry to act at all (`D4b` re-delegates from the last delegate entry). The owner notices they
raised (`agent-failed`, `task-timeout`, `update-behind`) go too, unless still open, so a retry
that runs out again is told again. The answer names the keys it cleared.

### 7.2 Designer `RESULT` line

The designer's definition ends its return with exactly one line (D-14; until that ships, the loop's prompt asks for it):

```text
RESULT brief=<comment URL|none> created=<n1,n2|none> pending_decision=<yes|no>
```

The parser reads the report's last line and accepts only that shape, with a brief URL on the
designed issue of this repo. Anything else is an unparseable report: `judge(report)` hands the
model the saved report's path and asks for the fields.

### 7.3 Adjudicator reply

Its agent definition already fixes the contract: verdict lines `<VERDICT>: <reason>` with
`VERDICT` one of `CORRECT`, `WRONG`, `NIT`, `ENV`, `DUP`, then exactly one `ACTION:` line. Prose
before the first contract line is skipped, unless a line there looks like a misshapen contract
line (a bulleted verdict, an all-caps `WORD:`, a code fence). From the first contract line on, the
parser rejects any other line, and it rejects any reply without exactly one `ACTION:` line (D-62). Each verdict
line is logged as `callum-flow-event verdict --issue --run --branch --note "<line>"` when the
outcome is recorded. For purpose `merge` (rule `M4`) the reply also carries three lines the
parser requires: `SUMMARY: <what changes for users, one line>`, `BUMP: <patch|minor|major>
<reason>` and `FLAGS: <image,template,restart,run-it, or none>`. A gate or test-weakening
review takes `approve`, `fix`, `skip`, `fixer` or `escalate`; a merge review takes `merge`,
`hold <reason>`, `fixer` or `escalate` (which plan reads as a hold). Any other `ACTION`, a flag
the loop does not know, or an option `respond` does not take (such as `--yes`) makes the reply
unparseable, a failed attempt of its rule.

### 7.4 Events the loop logs

Most transitions are already logged by the CLIs the executors call (`claimed`, `claim_lost`,
`renewed`, `reclaimed`, `closed`, `implementer_routed`, `merged`, `test_weakened`, and the
pipeline and queue states through the `--once` modes). The loop adds only what the model logs by
hand today: `delegated` (with the brief URL), `verdict`, `fix_requested --note review`,
`rebased_behind`, `abandoned` and `superseded`. And it logs one new state, `loop`, for its own
transitions (DECISIONS D-09):

- each agent and wake entry (`spawn`, `delegate`, `judge`, `task`, `tell`, owner notices
  included) when it starts and when it ends: an attempt's start and its executor's result are
  one transition, logged once;
- a rate-cap hold, once per capped bucket (or kind and issue) per hour:
  `kind=<bucket|kind> key=cap:<capped>:<hour> status=held`, with `--issue` for a per-issue cap;
- the ping-storm breaker opening:
  `kind=breaker key=breaker:pings:<since> status=open passes=<n> until=<ms>`.

An entry's note is `kind=<kind> key=<key> status=<status> attempts=<n> class=<class> rule=<rule>
started=<ms>[ ended=<ms>][ agent=<type>][ agentId=<id>][ wake=<name>]` and then its outcome's
tokens (`out=<kind>` and the fields plan reads), with `%` and whitespace percent-encoded and
`none` for an empty value. The issue, run, PR and head travel in the event's own columns. Free
text (reasons, instructions, verdict lines, summaries) is left out, a guard outcome is not
carried (a lost guard simply runs again), and a note over 500 characters keeps the entry without
its outcome. `callum-flow-event loop` requires `kind=`, `key=` and `status=` with values, or it
exits 2 and writes nothing; `--issue` is optional. `--if-changed` skips `loop` lines when it
looks for a subject's newest event, and every reader of the event log treats `loop` as
bookkeeping: it sets no stage, run or PR and counts as no progress, though it still counts for
coverage and for a device being alive.

### 7.5 Restart and re-derivation

The store survives a restart: `CLAUDE_CONFIG_DIR` is on `/persist`, which `dev-restart-self`
keeps (FINDINGS check 5). On load:

1. Every `running` CLI entry (no agent id, not a wake) becomes `lost`: its process died with
   the old session or module. A respond counts as CLI work here.
2. A `running` wake that another session submitted ends at once by its timeout's fallback
   (8.2): its prompt went with that session. A module reload within one session keeps its
   wakes, and a wake with no session recorded waits for its timeout.
3. A `running` agent is judged against the first successful agent-list read, and against every
   pass's after that: an id the list lacks is `lost`, one listed `failed` or `killed` is
   `failed`, and one listed `completed` while its entry still runs is `lost`, but only from the
   second pass that lists it so, since its `turn.complete` may still be on its way. An agent
   whose answer is being handled counts as running. A failed read changes nothing.
4. Plan then re-derives what to do from the state, not from the lost entries. This is safe
   because every write the loop can lose midway is either idempotent at the CLI (a claim this
   device already holds is kept and nothing is posted; the heartbeat, sweep, labels and
   milestone calls converge) or visible in the next observation (a merged PR, a new head, a
   posted brief, a delegation event). A `lost` entry is retried at once while attempts remain.
5. Rule `H1` heartbeats on the first pass (I-93).

If the store itself holds no ledger (a new device, a wiped config), act mode rebuilds it from 7
days of the event log, the ledger's own life: its own `loop` events give every agent, wake and
answer, including pending decisions, escalations and holds, and the CLIs' events give claims,
delegations and review rounds. Claims and stages also come from `callum-flow-factory-state`. A
device's own `merged` event becomes a done `merge` entry when it names a PR, and a done
`rollout:<issue>` entry for its issue either way: the device that merged (or noted an owner's hand merge) ran the
follow-ups then, so rule `M7` reads neither again. The rebuilt ledger becomes the one the module keeps, and the decision
log names its source (`store`, `events` or `none`). A rebuild that found nothing is not read
again every pass. A wake rebuilt from events has no wake id and ends by its timeout.

## 8. Waking the model

### 8.1 Lines

The loop submits a prompt (`$.prompt.submit`), which runs as its own turn once the session is
idle. Its first line is machine-shaped; any further lines carry the details the model needs, in
plain text:

```text
JUDGE sequence id=w41 repo=cbundy/dev-system pr=512 issue=507 head=03a35cd flags=image bump=minor
SUMMARY: the dev image gains a PostgreSQL 17 server
BUMP: minor a new server in the dev image
FLAGS: image
Answer with the factory-loop:judge skill.
```

```text
TELL review-cap id=w43 repo=cbundy/dev-system issue=470 run=01M4RW4A0G rounds=3 brief=https://github.com/cbundy/dev-system/issues/470#issuecomment-1
CORRECT: review-1 moved HEAD after recovery must not be accepted
WRONG: review-6 comma form of --accept-dropped is required
Answer with the factory-loop:judge skill.
```

The first line is `<JUDGE|TASK|TELL> <name> id=<id> repo=<owner/name>` and then plan's
`key=value` fields, with whitespace in a value percent-encoded. The id is `w` and the clock in
base 36, unique across restarts; `repo=` lets the model build issue and PR links. Plan's detail
lines follow, then the loop's own: the saved answer's path for `judge(report)` and
`judge(handoff)`, and every respond log of the run for `task(respond-stuck)`. The last line is
always `Answer with the factory-loop:judge skill.`, so a session that lost the skill
(`plugins/factory-loop/skills/judge/SKILL.md`) to compaction loads it again. The details are
visible, in the transcript and on the phone: a mod cannot attach hidden context to its own
prompt (the wake probe showed a plugin's own `prompt.submit` hooks do not see its own
submissions).

`$.prompt.submit` resolves once its turn starts, which waits for the session to be idle. The
executor gives it 5 seconds: a prompt still waiting then counts as queued and running, so a busy
session never holds a pass. A prompt the engine refuses or drops within the 5 seconds started
no turn: the action is skipped, no attempt counted, and plan asks again next pass. A drop after
the 5 seconds, before its turn started, marks the wake `lost` with its attempt given back, which
plan also asks again. A wake's turn is the turn whose text starts with its first line (the
engine's frame, if any, is skipped); a turn can start before the submit returns, and then takes
the one running wake of that kind and name with no id yet.

### 8.2 Answers

The model answers with a block in its final message, read in the main loop's `turn.complete`:

```text
ANSWER w41 merge
reason: nothing else waits for the next release, so the image change can join it
```

The first line is `ANSWER <id> <decision>` (backticks or bold around it read the same); each
following `key: value` line is a field (`reason`, `instructions`, or `fields` as one line of
JSON), and a blank line or any other line ends the block. An answer in any main-loop turn
counts, wherever the block sits; an agent's turn never answers a wake. The loop checks the id is
an open judge or task, the decision is allowed for its name, and the field the decision needs
is there (the table); `judge report`'s `parsed` needs all three fields, with a brief on the
wake's issue of this repo, or created issues. A refused answer leaves the wake open, and why goes
to the decision log and into the reminder. A judge or task name the table lacks may only `hold`,
with a reason. As an alternative the model may call `mcp__factory-loop__answer` with the same
fields, which the mod registers; the wake probe showed the tool works while the mod is stable,
but a turn that starts during a reload does not get it, so the text block is the primary
channel. The tool refuses a call from inside an agent.

| Wake | Allowed decisions | Timeout falls back to |
|---|---|---|
| `judge sequence` | `merge`; `hold` (reason) | hold |
| `judge guard-fail` | `fixer` (instructions); `wait`; `hold` (reason) | hold |
| `judge cancelled` | `redrive`; `drop` (reason) | hold |
| `judge handoff` | `ok`; `fixer` (instructions); `hold` (reason) | hold |
| `judge report` | `parsed` (`fields`: `brief`, `created`, `pendingDecision`); `hold` | hold |
| `task redrive`, `task run-it`, `task release`, `task respond-stuck` | `done`; `failed` (reason); `hold` | `tell(task-timeout)` |
| `tell <kind>` | none: delivered when its own turn ends having said something | dropped after the timeout |

A judge or task whose own turn ends without an answer, however it ended, gets exactly one
reminder: its first line again with ` reminder=1`, plus up to three lines saying why the answers
it got were refused. Then the timeout applies, counted from the submit: a judge ends `done`
with decision `hold` (plan holds), a task ends `timed-out` (plan tells the owner,
`task-timeout`), and a tell ends `timed-out` (dropped, never sent again). Reminders go out only
in act mode with no kill switch. Only one wake is open at a time (rule `O2`).

### 8.3 What stays model work

- **Release sequencing** for a flagged merge (D-05): from the merge adjudicator's summary, bump
  and flags, never the diff. The code reading itself is the adjudicator's (rule `M4`).
- **Guard FAIL lines no rule maps**, failed CI checks, and unparseable designer reports.
- **Re-drives** (I-57, I-61): `daemon.log`, rebase, `callum-flow-regate`, a fresh `axi run`.
- **Releases and Run its** (I-36, I-85), with the owner, through the `release` skill.
- **Owner chat**: relaying `tell` lines, answering questions, turning instructions into control
  calls, and keeping `.claude/orchestrator-memory.md` (I-81).

### 8.4 Proven by the wake probe

Tested on 2026-10-12 in the spike workspace, in the orchestrators' launch mode
([probes/wake-probe](probes/wake-probe/README.md)): `$.prompt.submit` starts a turn 20 to 70 ms
after the call; a text `ANSWER` line came back three times out of three (2 s, 12 output tokens,
370 to 630 tokens of context); the tool answer works while the mod is stable. The judge skill must
keep answers short: a model that cannot do what a wake asks explains at length.

## 9. Owner notices

### 9.1 The title

```text
🔄 dev-system (Q:3 - D:5 - M:9) · owner 1
```

The repo's short name and three counts (DECISIONS D-23): `Q` issues in the queue, `D` in
progress (designing through ready to merge), and `M` merged in the last 6 hours. Usage is not
shown. A word is added only when something needs attention, in this order: `observe` when the
pass does not act (observe mode, or act mode held back by a rail), `blind` (which replaces the
counts in a blind pass), a usage tier that holds work (`stop new`, `stop all`), `stuck <n>`
(not in a blind pass), `at cap`, `capped <bucket>` or `capped <kind>:<issue>` for each rate cap
tripped, `gh wait`, and `owner <n>` for open owner items. The driver sets `🔄 <name> · off` when
the mode is off or the kill switch exists, and adds `· error` after a pass that throws, until a
pass succeeds. The title is set with `/rename` only when the text changes, and the
`session.append` hook blanks the note the rename leaves for the model (FINDINGS check 3).

### 9.2 `tell`

A `tell` is a wake whose turn writes one line to the owner in the conversation, which the phone
shows, in the tick report's format: who acts first, what happens next, each issue or PR named by
its work with a markdown link (I-88, I-89). Kinds: `decision`, `escalate`, `review-cap`, `no-ci`,
`ci-triggers`, `untrusted-pr`, `rollout`, `base`, `update-behind`, `merge-refused`,
`merge-hold`, `drain-slow`, `heartbeat-other`, `old-watcher`, `at-cap`, `linkage`,
`agent-failed`, `claim-lost`, `stopped`, `blind`, `task-timeout`, `runaway`, `breaker`,
`pass-error`. Each is sent once per key. A `stopped` notice says why: closed, merged, closed
without merge, dropped or split. The owner items (`decision`, `escalate`, `review-cap`, `merge-refused`,
`merge-hold`, `untrusted-pr`, `rollout`, `base`, `no-ci`, `ci-triggers`, `update-behind`,
`linkage`) go out before any other wake, and the title counts the open ones.

Four notices come from outside plan: `heartbeat-other` and `old-watcher` (a rail holding act
mode back, 11.2), `breaker kind=ping` (the ping storm, 11.4) and `pass-error` (three passes in a
row that threw, section 10.9). Each is keyed by when its spell began, so it goes out once per
spell, through the wake executor, and only while no wake is open. A rail or breaker notice waits
in the store meanwhile; it is dropped once its spell ended before it could go out, and sent again
if the engine dropped the prompt. A pass-error notice is tried again at each failing pass. A
session the role check refuses sends no rail notice and no pass-error.

## 10. Failure handling

1. **A CLI fails.** The exit code and the first 2 000 characters of stderr go into the outcome.
   Exit 2 (usage) from the image's own CLIs is never retried and tells the owner (a loop bug);
   `gh` and `treehouse` exit 2 is retried like any failure (section 6.1). Other failures are
   retried by their rule with backoff while attempts remain, then `tell(agent-failed)` (the same
   kind covers CLIs). A CLI that times out is killed by `$.process.run` and counts as failed. An
   executor that throws is a failed attempt and never stops the pass.
2. **GitHub rate limits.** In act mode, an adapter or executor whose stderr shows a rate limit
   (`API rate limit exceeded`, a secondary rate limit, HTTP 403 or 429 with a rate-limit line)
   sets `githubBackoffUntil = now + 15 min` in the store. Until then the `github` and `queue`
   sources are skipped (their old values stay, with their age), and every action that writes to
   GitHub is held. Once an executor meets a limit, the pass's remaining GitHub-writing actions
   are skipped with no attempt counted. The title shows `gh wait`. Observe mode keeps no backoff.
3. **The database is down.** `callum-flow-factory-state` and `dev-query` fail: the pass is
   blind (rule `G2`). Running agents still report into the ledger, and nothing new is acted on
   until the factory source returns. After `blindNoticeAfterMs`, `tell(blind)`.
4. **An agent dies or hangs.** A `turn.complete` with reason `error`, `aborted` or `refusal`,
   or an agent list entry `failed` or `killed`, ends the entry as `failed`. A hang ends at
   `agentTimeoutMs` with `stop-agent` (rule `A1`). Retries follow `maxAttempts`, and each retry
   re-checks its rule's conditions, so an implementer whose run already started is not spawned
   again. An answer for an entry that no longer runs (a stop timed it out, a retry replaced it)
   is logged and dropped. A spawn that does not start within 60 seconds is a failed attempt.
5. **Two devices claim the same issue.** `callum-flow-claim` lets the earliest live claim win;
   the loser exits 3, and its outcome is `lost`. Rule `D1` skips the issue while the other
   device's claim is live. If another device takes an issue this device was working (a lapsed
   lease, reclaimed), the next observation shows the new holder and rule `A2` stops this
   device's agents for it and tells the owner.
6. **A restart lands mid-action.** Section 7.5.
7. **Usage crosses a tier mid-pass.** The tier is fixed for the pass from the observed reading.
   Before each `start`, `develop` or `drive` action the act step reads `$.session.usage()`
   (free) and skips the action, no attempt counted, if that reading puts it in a tier that
   forbids its class (the owner's override counts). A failed read leaves plan's tier standing.
   The next pass re-plans with the new tier.
8. **A wake is never answered.** Section 8.2: one reminder, then the timeout's fallback, which
   always holds rather than acts.
9. **A pass throws.** The error is logged with the pass number and how many passes in a row
   have thrown, the title shows `error`, and the next pass runs as normal. Three throwing passes
   in a row in act mode tell the owner once (`tell(pass-error)` with the last error), from a
   session the role check allows and with no kill switch.
10. **The store refuses a ledger save.** Nothing starts until a save succeeds: each action is
    skipped before it runs, no attempt counted, the decision log names the problem, and the
    pass ends by throwing, so the title shows `error`.

## 11. Safety rails

### 11.1 Observe mode writes nothing that matters

In observe mode no executor runs. The adapters still run read-only CLIs, and some of them log
events as a side effect (`usage-check.sh`, `pipeline-watch.sh --once`,
`callum-flow-issue-read`'s `untrusted_stripped`); the queue is read with the plain reader, which
logs no `ready` events. Every command a pass that does not act runs (observe mode, or act mode
held back by a rail) gets `CALLUM_EVENTS_DIR=<loop dir>/sink-events`, so those lines land in a
local file that `event-push-loop` never ships. The hooks between passes (agents' answers, wake
turns, the answer tool, `/factory retry`) do nothing outside act mode, so they log no real event
and keep no ledger. The live event log stays clean (the owner deleted 34 fake rows on
2026-10-12, MEM).

### 11.2 One acting loop per repo and device

Act mode needs all of the following, checked at the start of every act-mode pass, before any
action, in this order. Every refusal is named in the decision log (`rails`), and a pass that is
refused plans and records exactly as observe mode does (11.1).

- `mode: act` in the plugin options or the workspace file, and no kill switch.
- **The checkout is the repo.** The checkout's `origin` names the configured repo (ignoring
  case): the CLIs act on the checkout's origin and the `gh` executors on the configured repo,
  so a mismatch would merge in one and follow up in the other.
- **The role.** `DEV_ROLE=orchestrator`, unless the repo-local config sets
  `allowActOutsideOrchestrator`. A session this refuses can never act, so it tells nothing.
- **No old watcher.** No live `orchestrator-watch.sh` lock for the repo, found where the watcher
  puts it (`ORCHESTRATOR_WATCH_LOCK_DIR`, else `XDG_RUNTIME_DIR`, else `TMPDIR`, else `/tmp`),
  for the repo as given and lower-cased. A lock is live when `kill -0` reaches its pid and the
  process's command line names the watcher or cannot be read; a lock directory with no readable pid blocks too,
  and so does a probe that fails. If the old watcher is armed, the released skill is still
  driving: the loop stays in observe, tells the owner once per spell (`tell(old-watcher)`), and
  acts only after the lock has been gone 10 minutes, since the released skill's single-shot
  watcher comes and goes between its turns.
- **No other orchestrator.** No other device with role `orchestrator` and the same repo (ignoring
  case) has a heartbeat in `factory.workers_status` from the last 120 seconds, a stopping device
  included. While one does, the loop stays in observe, tells the owner once
  (`tell(heartbeat-other)`), and acts again after 120 seconds of quiet (DECISIONS D-28). A failed
  query blocks, and so does a device with no name (`DEV_MACHINE_NAME`), which cannot tell its
  own heartbeat from another's. It covers two workspaces on one repo, which the per-workspace
  act lock cannot see.
- **The act lock**, `<loop dir>/act.lock`, a JSON lease (`session`, `renewedAt`, `expiresAt`)
  taken only when every rail above passes. A lease lasts the longer of 5 passes and 15 minutes,
  longer than any single step (a merge is 600 seconds, then its rollout read), and an acting
  pass renews it before every action and on a timer while it runs. Every write is a
  compare-and-set under `flock`, landing by rename: of two sessions that both read the lock
  free, one writes and the other is refused. A second session on the same workspace finds a live
  lease and stays in observe. If another session holds the lease mid-pass, the pass runs nothing
  more and lets the ledger go (7.1). `session.end` expires this session's lease, so the next
  session acts at once.

Two more things hold act mode back for a pass: a ledger the store could not load (7.1), and a
`dev-restart-self` that already returned (rule `H4`), which holds it for the rest of the
module's life. The rails remember each blocking spell in the store, so a reload does not tell
it again.

### 11.3 The kill switch

`${CLAUDE_CONFIG_DIR:-~/.claude}/factory-loop/OFF` (any content) forces `off` at the start of
the next pass, with no restart, and keeps the hooks between passes quiet: no answer is recorded,
no reminder or notice goes out. Removing it resumes the configured mode.

### 11.4 Runaway protection

Plan counts the ledger's token-spending actions per bucket (claims; spawns and delegations;
wakes), and per kind and issue, in the last hour. An action past its `rateCaps` entry is
dropped, and the bucket stays closed until the window clears. A drop is visible in the pass
that makes it: the decision log names it (`rate cap: <bucket> <n>/<cap>`, or
`rate cap: <kind> on #<N> <n>/<cap>`) and lists it under `capped`, the title adds
`capped <bucket>`, a `loop` event records it once per hour, and `tell(runaway)` goes out once per
cap per hour. Three consecutive failures of one executor kind close that kind for 30 minutes
and tell the owner (`tell(breaker)`). A ping storm (more than 30 ping-driven passes in 10
minutes) switches the loop to its timer alone for 10 minutes, logs a `loop` event and tells the
owner once (`TELL breaker kind=ping`, section 2).

### 11.5 Scope of every action

The loop acts only on its configured repo (every `gh` command carries `--repo`, and act mode
needs the checkout's origin to be that repo, 11.2), only on issues and PRs by trusted authors
(`callum-flow-issue-read` filters them, and the guard's `author` check runs before any merge),
and only on branches named `issue-<N>`. Runs on other branches are owner work and are left
alone. It stops only agents it spawned, and only the main conversation can answer its wakes or
set its directives.

### 11.6 Where its files live

`<loop dir>` is `${CLAUDE_CONFIG_DIR:-~/.claude}/factory-loop/<owner>__<repo>/`:

- the decision logs (`decisions-YYYY-MM-DD.jsonl`) and `control.json`;
- recorded states (`states/YYYY-MM-DD/<pass>.json`): observe mode only, one per changed digest,
  at most 288 a day and each under 3.5 MB, for the replay harness;
- `spawns/` (each spawn's record and prompt), `answers/` (each agent's answer) and `respond/`
  (each detached respond's log);
- the observe-mode event sink (`sink-events/`);
- the act lock (`act.lock`, with its `act.lock.flock`).

Once a day the loop deletes the spawn records, answers, respond logs, recorded states and
decision logs older than 7 days (the ledger's own life), and the state day directories left
empty. The act lock, `control.json` and the event sink are never touched. Nothing goes in the
repository.

## 12. Observability

One JSON line per pass in the decision log:

```json
{"v":1,"at":"2026-10-13T03:12:00.000Z","pass":184,"loaded":"2026-10-13T00:01:12.000Z",
 "mode":"act","executed":true,"device":"coder-dev-system-orchestrator","tier":"slow",
 "digest":"9f2c41d0","sources":{"factory":"ok","runs":"ok","queue":"ok","github":"ok"},
 "counts":{"queued":3,"dev":2,"pipeline":1,"merge":0,"owner":1},
 "actions":[{"key":"claim:470:new","kind":"claim","class":"start","rule":"D1","issue":470,"reason":"ready and unblocked"}],
 "skipped":[{"rule":"D1","issue":340,"why":"tracker (has sub-issues)"}],
 "outcomes":[{"key":"claim:470:new","status":"done","ms":8123,"summary":"claimed #470"}],
 "ledgerSource":"store","commands":["callum-flow-factory-state --repo cbundy/dev-system ..."],
 "title":"🔄 dev-system (Q:3 - D:5 - M:9) · owner 1"}
```

`loaded` tells module loads apart, since pass numbers start over at each. `executed` says
whether the pass acted. Act mode adds, when they apply: `outcomes` (each action's status, time
and summary; the title's left out), `ledgerSource` (`store`, `events` or `none`), `rails` (why
act mode was held back), `capped` and `atCap`, `breaker` (the ping breaker opened), `told` (the
notices from outside plan sent this pass), `config` (what the repo-local settings got wrong) and
`problems` (a loop event not logged, a store write refused, the act lease lost mid-pass).
`commands` lists every command the pass ran, observe's and the executors'. Other lines share the
file: an owner op (`control`, with its answer), a turn's or an agent's answer problems, and a
pass that threw (`error`, with `failures` in a row).

`digest` is a hash of the canonical state without its timestamps, so unchanged passes are easy
to spot. Appends go through one `$.process.run` per pass (`sh -c 'cat >> "$1"'` with the lines on
stdin), because `$.fs.write` rewrites whole files. In observe mode each state whose digest
changed is also written in full under `states/` (11.6), which the replay harness reads. The last
pass's summary (mode, whether it acted, the rails, tier, title, action and owner counts) is also
kept in plugin state, for `/factory status`.

## 13. Known gaps and risks

- **Judgment wakes** are proven in the launch mode (8.4); a turn that starts while the mod
  reloads loses the answer tool, so deploys avoid open wakes and the text block is primary.
- **`stop-agent`** relies on the `TaskStop` tool through `$.tool.call`; untested from a mod. If
  it is unavailable, a timed-out agent is left running, marked `timed-out`, its rule waits for
  the agent list to show it ended, and the owner is told.
- **Agent ids from a mod**: the engine's test host never returns an agent id from
  `$.agent.spawn`, so spawning from a mod, and each agent's `turn.complete` carrying that id, is
  proven only once act mode runs on the testbed (cutover step 3). The claim-to-merge test drives
  the same act-step functions outside the host instead.
- **The observe-mode event sink** is one append-only file per repo that nothing prunes yet.
- **Per-agent OTEL attributes**: `agent.spawn` has no environment field, so the
  `OTEL_RESOURCE_ATTRIBUTES=issue=<N>` tagging in skill step 3 cannot be reproduced (DECISIONS D-11).
- **Long-running agents** (implementers for an hour or more, several at once) are untested from a
  mod (FINDINGS section 6). Phase 4 cannot test them either, since observe mode spawns nothing.
- **Auto mode**: if orchestrators move from bypass to auto mode, every agent report hands back to
  the main conversation and wakes the model (FINDINGS check 4). The loop must then stay in bypass.
- **The mod API is early access**: the plugin pins Claude Code 2.1.296 in its README, and the
  spike's checks are re-run before each upgrade.
- **GitHub reads in the shadow workspace**: since the owner approved a login on 2026-10-12, the
  shadow reads labels, blockers and sub-issues live, so it can judge claims (DECISIONS D-32 is
  superseded).

## 14. Cutover plan (not executed)

1. **Shadow** (phase 4): observe mode in the spike workspace, `runSource: events`, compared with
   the live dev-system orchestrator's events.
2. **Prerequisites to ship**: the two `--once` modes released in the base image; the `loop` event
   state (D-09), with the event-log readers that ignore it, in the same release; the designer's
   `RESULT` line in its agent definition (D-14); the plugin in the
   marketplace as a replacement for the released orchestrator (D-02); the judge skill reviewed; the Orchestrator template's start prompt changed from
   `/callum-flow:issue-orchestrator` to the judge skill, and its resume prompt from "re-arm the
   watcher" to "the loop resumes by itself".
3. **Act on `dev-system-testbed`** with a few owner-made test issues that walk every path: claim,
   design, a split, a pending decision, delegate, each gate `ACTION`, the review cap, a behind-only
   update, a conflict, a test-weakening WARN, a linkage FAIL, a merge and each rollout. Before a
   base image release carries the `--once` modes and the `loop` state, the workspace file points
   `toolsDir` and `binDir` at a checkout of this branch (4.1).
4. **One real repo**, with the released skill as the fallback: to roll back, create the kill
   switch and start `/callum-flow:issue-orchestrator` in the session.
5. **The rest**, one repo at a time, each step through the normal release process.
