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

Out of scope: changing the CLIs' logic (the loop calls them; two get a one-shot mode,
section 3.3), changing the agents' definitions, releasing, and restarting the workspace.

## 2. Architecture

```text
every passEveryMs (60 s), or at once when pinged:
    if mode is off or the kill switch exists: stop
    state   = observe()                  read-only: CLIs, the engine, the store
    result  = plan(state, config)        pure: no I/O, no clock, same input -> same output
    if mode is act and this session holds the act lock:
        for each action in result.actions: act(action)    one executor per kind
    record(state, result, outcomes)      one decision-log line, ledger updates, the title
```

- **One pass at a time.** A ping or a timer tick that arrives during a pass sets a flag, and
  one more pass runs when the current one ends. Passes never overlap.
- **Pings.** An agent of the loop finished (`turn.complete` with its `agentId`), the model
  answered a wake (the answer tool or the main loop's `turn.complete`), an owner control
  arrived (`/loop` or the control tool), or a detached command's log changed.
- **Plan is the heart.** `plan` lives in `plugins/factory-loop/hooks/plan.ts` and imports
  types only. Everything it needs, the time included, arrives in `State`. Actions already
  running or done are in the state's ledger, so re-planning an unchanged state yields no new
  action. Its result also carries the reasons it skipped candidates, for the decision log.
- **Observe and act are thin.** Adapters turn CLI output into typed values; executors turn
  actions into CLI calls, agent spawns or wakes, and record outcomes. Neither decides anything.
- **Modes.** `off` (nothing runs), `observe` (observe, plan and log; execute nothing; the
  default) and `act`. A kill-switch file forces `off` within one pass (section 11).

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
}

type Usage = {
  fiveHour: number | null         // percent, rounded up, as usage-check.sh prints it
  sevenDay: number | null         // the binding weekly window
  resetsAt: Ms | null             // the binding window's reset
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

The union of: every live issue in `callum-flow-factory-state` for the repo; every issue in
`queue`; every issue a ledger entry names. GitHub fields are filled for the queue and for the
issues this device holds, and stay `null` for the rest.

### 3.3 Sources

Each adapter runs a command with `$.process.run` (no shell), parses its output, and sets its
source status. A failed adapter keeps the previous value with its old `at`, so plan can see
how stale it is.

| Source | Command | Cadence | Required for |
|---|---|---|---|
| `factory` | `callum-flow-factory-state --repo <R> --format json --github off` | every pass | everything: a failure makes the pass blind (rule `G2`) |
| `facts` | one `dev-query --csv` call (SQL in the adapter): per live issue the latest `delegated` note; per run the `fix_requested --note review` count and its `verdict` notes; per branch the latest watcher pipeline event (for `runSource: events`) | every pass | `P1` (the cap), `P2` on a review gate |
| `runs` | `runSource: local`: `pipeline-watch.sh --once` from the main checkout (new mode, 3.4). `runSource: events`: built from `facts` plus the mirror's stage | every pass | the `P` and `M` rules |
| `queue` | `queue-watch.sh --once --repo <R> --label <readyLabel> --known <last now>` (new mode, 3.4) | every `queueEveryMs` (120 s) | rule `D1` |
| `github` | `callum-flow-issue-read --json <N>` per issue (labels, state, author trust, dependency and sub-issue summaries), plus `--comments` only for this device's designing issues, to find the latest `## Design brief` comment | per issue every `githubEveryMs` (5 min), and at once for a new queue member | rule `D1`; `D2` (an existing brief) |
| `usage` | `usage-check.sh`, merged with `$.session.usage().rateLimits` (free, from the session's own API responses): the higher reading of each window wins | `usage-check.sh` every `usageEveryMs` (5 min); the session figures every pass | rule `G3`; missing or stale is Normal, flagged |
| `pool` | `treehouse status --json` from the main checkout | every pass | rule `D1` capacity, rule `H3` |
| `agents` | `$.agent.list()`, filtered to the ids in the ledger | every pass | lost-agent detection (7.3) |
| `milestone` | `callum-flow-milestone show next` | every `milestoneEveryMs` (10 min) | rules `M7`, `O3`; absent means not opted in |
| ledger, control, last title | `$.store` | every pass | everything |

Observe also does the one time-based ledger transition that is a fact rather than a decision: a
`running` agent entry whose id `$.agent.list()` no longer has, and whose answer never came,
becomes `lost`.

### 3.4 Two new one-shot modes

Both live beside the watchers in `features/src/callum-tools/` (the image's source) with shell
tests beside the existing ones. The streaming and single-shot modes are unchanged.

**`pipeline-watch.sh --once`**: one poll over every watched branch, then exit 0. It prints one
line per branch whose newest run is not completed:

```text
<state> <branch> <run-id>[ <detail>] head=<sha>
```

`state` is one of today's actionable states, or `running` (in flight, nothing to report) or
`pending` (green, but mergeability is not yet known or a probe failed). For `parked` and
`failed` the detail carries `step=<step>`, and every line whose run has a PR carries `pr=<n>`
in the detail. Actionable lines are logged as a first sight is today (`--if-changed`), so the
event log keeps the same transitions. A fatal error (no `no-mistakes`, not in a git
repository) exits 1 with the reason on stderr.

**`queue-watch.sh --once --known <list>`**: one read of the queue, no debounce, then exit 0:

```text
queue known=<n1,n2|none> now=<n1,n2|none>
```

Every member of `now` that is not in `known` logs a `ready` event with `--if-changed`. A reader
failure exits 1 and is a failed source, never an empty queue.

The loop keeps `known` in its store, so the `ready` events keep arriving as they do today.

## 4. Configuration

### 4.1 Where it lives

- **Plugin options** (`userConfig`, settable with `/config factory-loop.<key>=<value>`, also from
  the phone): `mode` (`off`, `observe` default, `act`) and `repo` (default: the session
  checkout's GitHub `origin`).
- **Repo-local** `.claude/factory-loop.json` in the consumer's main checkout: everything in 4.2.
  The plugin ships no repo-specific values (CLAUDE.md: shared plugins stay generic).
- **Control state** in `$.store` (4.3): owner directives that change at runtime.

### 4.2 Settings and defaults

| Key | Default | Meaning |
|---|---|---|
| `readyLabel`, `inDevLabel` | `ready`, `In development` | the queue and claim labels (I-03) |
| `skipLabels` | `[]` | labels that keep an issue out of `D1` (I-92) |
| `usageSlowPct`, `usageStopNewPct`, `usageStopAllPct` | 85, 90, 95 | the tiers (I-12 to I-16) |
| `runSource` | `local` | `local` (pipeline-watch) or `events` (shadow and replay) |
| `passEveryMs` | 60 000 | the timer |
| `queueEveryMs`, `githubEveryMs`, `usageEveryMs`, `milestoneEveryMs` | 120 000, 300 000, 300 000, 600 000 | observe cadences |
| `usageStaleMs` | 900 000 | an older reading counts as unavailable |
| `heartbeatEveryMs`, `sweepEveryMs` | 1 200 000, 1 800 000 | rules `H1`, `H2` |
| `slowGapMs` | 600 000 | Slow: the least time between two claims |
| `maxStartsPerPass` | 4 | claims per pass in Normal |
| `maxInFlightIssues` | `null` | an optional cap on this device's live issues |
| `worktreeReserve` | 2 | free slots kept for fixers and re-drives |
| `reviewFixCap` | 3 | review fix rounds per run (I-48) |
| `guardRecheckMs`, `guardTtlMs` | 180 000, 1 800 000 | guard freshness (rule `M1`) |
| `respondSettleMs` | 900 000 | a respond that leaves the gate unmoved this long is retried once |
| `updateBehindRetryMs`, `updateBehindRetries` | 300 000, 3 | `UPDATE-BEHIND SKIP` handling |
| `ciStallRecheckMs` | 900 000 | how long after a reopen a second stall counts |
| `blindNoticeAfterMs` | 900 000 | blind this long tells the owner |
| `agentTimeoutMs` | designer 3 600 000, implementer 7 200 000, adjudicator 1 800 000, fixer 7 200 000 | then `stop-agent` (rule `A1`) |
| `maxAttempts` | claim 3, designer 2, implementer 2, adjudicator 2, fixer 2, respond 2, merge 2, fix-linkage 2, CLI writes 3 | then the owner hears of it |
| `retryBackoffMs` | 120 000 | doubled per attempt |
| `wakeTimeoutMs` | judge 1 800 000, task 21 600 000, tell 1 800 000 | section 8 |
| `rateCaps` | starts 30, spawns 40, merges 10, wakes 20 per rolling hour, and 6 actions of one kind on one issue | runaway protection (11.4) |
| `recordStates` | `true` in observe, `false` in act | write each changed `State` for replay |

### 4.3 Control state (owner directives)

```ts
type Control = {
  paused: number[]                // no action at all on these issues (their claims still renew)
  noNewWork: boolean              // wind-down or drain: no start and no develop actions
  skip: number[]                  // never claim these
  priority: number[]              // claim these first, in this order
  serial: boolean                 // one issue in flight at a time (a drain in order)
  usageOverride: { untilPct: number; expiresAt: Ms } | null   // run past a threshold (I-19)
  resumed: { subject: string; at: Ms }[]  // holds the owner released: 'issue:<N>' or 'run:<id>'
  dropped: { issue: number; at: Ms }[]     // issues the owner dropped: abandon them (rule D6)
  notes: { issue: number | null; text: string; at: Ms }[]     // owner instructions for agents
}
```

The model sets them with the `mcp__factory-loop__control` tool when the owner says so in chat,
and the owner can type `/loop <op>` from any client: `status`, `pause <N>`, `unpause <N>`,
`skip <N>`, `noskip <N>`, `priority <N...>`, `serial on|off`, `new on|off`, `override <pct>
<hours>`, `resume <N|run>`, `drop <N>`, `note [<N>] <text>`, `mode off|observe|act`. Each change pings the
loop and is logged. Today these directives are free text in the memory file (I-90).

## 5. Plan: the decision table

`plan(state, config) -> { actions, title, skipped, tier }`. Rules run in the order below; each
emits zero or more actions, and the result keeps that order (finish in-flight work before
starting new work). The tier gate, the control filters and the caps apply to every emitted
action before it is kept.

### 5.1 Helpers

- **mine(i)**: `i.holder === state.device`.
- **entry(key)**: the ledger entry with that key, if any.
- **blocked(key, kind)**: an entry exists and it is `running`; or it is `done` (and the kind is
  not refreshable, or it has not expired); or it is `failed`, `timed-out` or `lost` with
  `attempts >= maxAttempts[kind]` (exhausted), or with its backoff
  (`retryBackoffMs * 2^(attempts-1)` after `endedAt`) not yet elapsed. A rule emits an action
  only when its key is not blocked. A retry keeps the key and adds an attempt.
- **briefOf(i)**: the designer outcome's brief URL for the current life, else `i.brief.url`,
  else `i.delegatedBrief`, else null.
- **live stages**: `designing`, `implementing`, `in pipeline`, `parked`, `ready to merge`.
- **resumedSince(subject, t)**: the owner released this subject after time `t`.

### 5.2 Gates (G)

| Rule | When | Then |
|---|---|---|
| G1 | mode `off`, or the kill switch exists | The driver does not observe or plan. Title: `loop off`. (Driver, not plan.) |
| G2 | `sources.factory.ok` is false | Blind pass: no actions except `title`, and `tell(blind)` once the factory source has been failing for `blindNoticeAfterMs`. When `runs` failed, the `P` and `M` rules emit nothing; when `queue`, `github` or `pool` failed, `D1` emits nothing |
| G3 | always | `tier = tierOf(usage, config, control.usageOverride, now)`: the higher of `fiveHour` and `sevenDay` against the thresholds; Normal when unavailable (flagged); an unexpired override keeps the tier Normal below its `untilPct` |
| G4 | always | Control filters: an action on a `paused` issue is dropped (except `heartbeat` and `title`); `noNewWork` drops the `start` and `develop` classes; `skip` removes issues from `D1`; `priority` orders `D1`; `serial` allows a claim only while this device has no live issue |

**Tier and class matrix** (each action kind has one class, section 6):

| Class | Normal | Slow | Stop new | Stop all |
|---|---|---|---|---|
| `free` (CLI work that spends no tokens) | yes | yes | yes | yes |
| `owner` (`tell`) | yes | yes | yes | yes |
| `drive` (adjudicator, fixer, respond, judge, task) | yes | yes | yes | no |
| `develop` (designer, implementer for a claimed issue) | yes | yes | no | no |
| `start` (claim) | up to `maxStartsPerPass` | one per pass, none within `slowGapMs` of the last claim, none in a pass that plans merge work | no | no |

### 5.3 Housekeeping (H)

| Rule | When | Then | Key |
|---|---|---|---|
| H1 | this device holds a live-stage issue, and its last `heartbeat` ended before `loadedAt` (the first pass after any load) or at least `heartbeatEveryMs` ago | `heartbeat` | `heartbeat:<last done endedAt or 0>` |
| H2 | the last `sweep` ended at least `sweepEveryMs` ago, or never | `sweep` | `sweep:<last done endedAt or 0>` |
| H3 | a pool slot is not busy, is clean, sits on a branch whose issue is `merged` or `closed without merge`, and no running agent of the loop names that issue | `release-worktree` | `release:<path>:<branch>` |

### 5.4 Pipeline gates (P)

The `P` and `M` rules act only on an issue's **current run**: the newest run of the issue's
branches (ULIDs sort by creation time; an `unknown` id counts only when it is the issue's only
run) that no `superseded` event names, on an issue that is still live. A run on a replaced
branch is history: 18 of the 21 cancelled runs on dev-system in the week to 2026-10-12 were
followed by a `superseded`, `merged` or `abandoned` event on their issue.

For each current run, issue not paused:

| Rule | When | Then | Key |
|---|---|---|---|
| P1 | `parked` or `failed`, `step = review`, and `reviewFixRounds >= reviewFixCap + resumes of run:<id>` | no adjudicator; `tell(review-cap)` with the brief URL and the run's verdict lines | `tell:review-cap:<run>:<rounds>` |
| P2 | `parked`, or `failed` with a step and a known run id; not `P1`; on a review gate only when `facts` is ok | `spawn(adjudicator, purpose gate)` with run, branch, step, brief URL and the issue's model label | `adjudicate:<run>:<step>:<head>[:r<n>]` |
| P3 | the `P2` entry is `done`, and the run is still at that step and head | by its `ACTION`: `approve`, `fix`, `skip` give `respond`; `escalate` gives `tell(escalate)` and a hold until resumed (then `P2` again with `:r<n>`) or the head moves; `fixer` gives `spawn(fixer, purpose gate)`; an unparseable reply counts as a failed attempt of `P2` | `respond:<run>:<step>:<head>:<action>`, `tell:escalate:<run>:<step>:<head>`, `fixer:gate:<run>:<step>:<head>` |
| P3a | a `respond` entry is `done`, the run is still at that step and head `respondSettleMs` after it ended | `respond` once more; after that `tell(respond-stuck)` | `respond:...:retry`, `tell:respond-stuck:<run>:<step>:<head>` |
| P4 | `failed` with run id `unknown` | `task(redrive)` for the model (I-57) | `task:redrive:<branch>:<head>` |
| P5 | `cancelled` | `judge(cancelled)`; answer `redrive` gives `task(redrive)`, `drop` gives `abandon` | `judge:cancelled:<run>:<head>` |
| P6 | `ci-stalled reason=no-workflow` | hold, `tell(no-ci)` | `tell:no-ci:<run>` |
| P6a | `ci-stalled reason=no-checks`, no reopen yet for this run | `pr-reopen` | `reopen:<pr>:<run>` |
| P6b | still `ci-stalled` `ciStallRecheckMs` after the reopen | hold, `tell(ci-triggers)` | `tell:ci-triggers:<run>` |

### 5.5 Merge (M)

For each current run in `merge-ready`, `head-mismatch` or `conflict` with a PR, issue not paused:

| Rule | When | Then | Key |
|---|---|---|---|
| M1 | no fresh guard outcome for this PR and head: none at all, or the last one ended before a repair on this PR (`fix-linkage`, `pr-comment`), or it saw only transient failures and is older than `guardRecheckMs`, or it is older than `guardTtlMs` | `guard` | `guard:<pr>:<head>:<n>`, n counting this PR and head's guard entries |
| M2 | the latest guard outcome for this PR and head has FAIL lines | the first match, in this order: `author` gives hold plus `tell(untrusted-pr)`; `rollout` gives `tell(rollout)`; `base` gives `tell(base)`; `gates` waits (the `P` rules own it); `mergeable` with "PR is merged/closed" waits for observe; `mergeable` conflict, or the run state `conflict`, gives `spawn(fixer, purpose conflict)`; `mergeable` behind gives `update-behind`; `linkage` gives `fix-linkage`; `checks` where every bad check is `pending`, `mergeable` "not computed" or "branch rules" waits for the recheck; `checks` with a failed check, `head`, or any line no rule names gives `judge(guard-fail)` | `fixer:conflict:<pr>:<head>`, `update-behind:<pr>:<head>`, `fix-linkage:<pr>:<head>:<n>`, `judge:guard-fail:<pr>:<head>:<n>` |
| M2a | an `update-behind` outcome is `FAIL` | `spawn(fixer, purpose regate)` with the line's re-gate instruction | `fixer:regate:<pr>:<head>` |
| M2b | an `update-behind` outcome is `SKIP` | `update-behind` again after `updateBehindRetryMs`, at most `updateBehindRetries` times; then hold plus `tell(update-behind)` | `update-behind:<pr>:<head>` (its attempts) |
| M3 | the guard passed with `test-weakening WARN` lines | `spawn(adjudicator, purpose weakening)` with the lines; `approve` gives `pr-comment` with the justification, then `M4`; `fixer` gives `spawn(fixer, purpose weakening)`; `escalate` gives a hold plus `tell(escalate)` | `adjudicate-weakening:<pr>:<head>`, `pr-comment:<pr>:<head>` |
| M4 | the guard passed, every WARN is resolved for this head, and no `merge` answer carries over (M5) | `judge(merge-review)`: read the pipeline's fix commits against the brief, the PR body, and UI evidence when it applies | `judge:merge-review:<pr>:<head>` |
| M5 | the merge review answered `merge` for this head, or for the head an `update-behind` of this PR rebased from (its patch is proven unchanged, so the review carries over), and the run is still mergeable at this head | `merge` | `merge:<pr>:<head>` |
| M5a | the merge review answered `hold` | hold until resumed or the head moves, `tell(hold)` with the reason | `tell:hold:<pr>:<head>` |
| M5b | the merge review answered `fixer` | `spawn(fixer, purpose review)` with the instructions | `fixer:review:<pr>:<head>` |
| M6 | `merge` failed because GitHub or the harness refused it (not a guard FAIL) | hold, `tell(merge-refused)` with the PR link and the guard lines | `tell:merge-refused:<pr>:<head>` |
| M7 | a `merge` entry is `done` | by the merged issue's rollout (the merge executor reads `callum-flow-rollout`): `merge` with `close_issue` gives `close-issue`; `run-it` gives `milestone-later` (when opted in) and `task(run-it)`; `keep-open` gives `milestone-later`. A `bump` in the merge-review answer above the milestone's `Expected` gives `milestone-expect` | `close:<issue>`, `milestone-later:<issue>`, `task:run-it:<issue>`, `expect:<bump>:<pr>` |

A guard FAIL that `merge` itself prints (the guard runs again inside it) is recorded as a guard
outcome, so `M2` handles it on the next pass.

### 5.6 Design and delegation (D)

| Rule | When | Then | Key |
|---|---|---|---|
| D1 | for each queue member, in `priority` order and then ascending: open, trusted, has `readyLabel`, no `skipLabels`, `blockedBy = 0`, `subIssues = 0` (not a tracker, I-91), stage `queued` or unknown to the database, not skipped or paused, and the last claim attempt did not lose to a still-live claim; capacity: `pool.free` minus this pass's claims above `worktreeReserve`, and under `maxInFlightIssues` | `claim` | `claim:<N>:<stageSince or 'new'>` |
| D2 | mine, stage `designing`, no brief newer than `stageSince`, no designer entry for this life | `spawn(designer)` with the issue's model label | `design:<N>:<stageSince>[:r<n>]` |
| D3 | the designer entry is `done` | by its `RESULT` line: `pending_decision=yes` gives a hold plus `tell(decision)` until resumed (then `D2` again with `:r<n>` and the owner's notes); `created=<list>` gives `release-parent` (and `A2` if an implementer is running); a brief with no pending decision goes to `D4`; no `RESULT` line gives `judge(report)` | `tell:decision:<N>:<brief>`, `release-parent:<N>`, `judge:report:<entry key>` |
| D4 | mine, stage `designing` (not yet delegated), a brief for this life (`briefOf`), no pending decision | `delegate` (route, `delegated` event, `spawn(implementer)`) | `delegate:<N>:<brief>` |
| D5 | an implementer or fixer entry is `done` and its handoff says `NOT GATED` | `judge(handoff)` | `judge:handoff:<entry key>` |
| D6 | the owner dropped an issue (`control.dropped`) | `abandon` with its run and branch when known, then `A2` stops its agents | `abandon:<N>:<at>` |

### 5.7 Agents (A)

| Rule | When | Then | Key |
|---|---|---|---|
| A1 | a `running` agent entry is older than its `agentTimeoutMs` | `stop-agent`; the entry becomes `timed-out`. A `failed`, `timed-out` or `lost` agent is retried by its own rule while attempts remain; once exhausted, `tell(agent-failed)` | `stop:<agentId>`, `tell:agent-failed:<key>` |
| A2 | a running agent's issue was closed, abandoned or claimed by another device, or was split while its implementer runs | `stop-agent`, and `tell(claim-lost)` or `tell(stopped)` | `stop:<agentId>` |

### 5.8 Owner and report (O)

| Rule | When | Then | Key |
|---|---|---|---|
| O1 | always, last | `title` when `titleOf(state, tier)` differs from `lastTitle` (section 9.1) | none (compared, not keyed) |
| O2 | any wake (`judge`, `task`, `tell`) is planned | keep at most one wake per pass and none while another wake is `running`, picked in order: `tell` of an owner decision or action, `judge`, `task`, other `tell` | the wake's own key |
| O3 | opted in, the milestone has no open items and at least one closed | `task(release)` once per milestone state | `task:release:<closed>:<expected>` |

### 5.9 Properties every plan must keep

The tests in `tests/plan.test.ts` check these on every fixture as well as the expected actions:

1. **Determinism**: the same state and config give the same result.
2. **Idempotence**: adding every planned action to the ledger as `running` and planning again
   yields no action except `title`.
3. **No I/O**: `plan.ts` imports types only and reads no clock (a test greps its source).
4. **Tier safety**: no action of a class the tier forbids, whatever the state.
5. **Control safety**: no action names a paused issue except `heartbeat`; nothing is claimed
   with `noNewWork`.
6. **Bounded**: at most one wake per pass, at most `maxStartsPerPass` claims, and no class past
   its rate cap.

## 6. Actions

### 6.1 Catalogue

Every action carries `key`, `kind`, `class`, `rule` (the ID that emitted it) and `reason` (a few
words for the log). Commands run without a shell, from the main checkout unless noted, with the
mode's environment (section 11.1).

| Kind | Class | Executor | Timeout | Retries | Outcome recorded |
|---|---|---|---|---|---|
| `heartbeat` | free | `callum-flow-claim --heartbeat` | 120 s | next due time | exit code (the CLI logs `renewed`) |
| `sweep` | free | `callum-flow-sweep` | 300 s | next due time | exit code (the CLI logs `reclaimed`, `closed`) |
| `claim` | start | `callum-flow-claim <N>` | 120 s | 3, backoff | `claimed`, `lost` (exit 3) or `failed` |
| `spawn` designer | develop | `$.agent.spawn({ subagentType: 'callum-flow:designer', model?, description, name, prompt })` | `agentTimeoutMs` | 2 | parsed `RESULT` line (7.2) |
| `delegate` | develop | `callum-flow-implementer-route <N>`, then `callum-flow-event delegated --issue <N> --note "brief <url>"`, then spawn `callum-flow:implementer` with the routed model | route 60 s, agent `agentTimeoutMs` | 2 | handoff fields (run id, head, `NOT GATED`) |
| `spawn` adjudicator | drive | spawn `callum-flow:adjudicator` (gate or weakening purpose) | 30 min | 2 | verdict lines and one `ACTION` (7.3); the handler logs each verdict |
| `spawn` fixer | drive | spawn `callum-flow:fixer` with instructions and the brief URL | 120 min | 2 | handoff fields; `superseded` logged when it names a new branch |
| `respond` | drive | `no-mistakes axi respond --action <a> [--findings] [--instructions] [--add-finding] [--reason]`, detached, in the leased slot on the run's branch (a fresh slot is leased when none has it) | launch 30 s | 2 (P3a) | launched; settles by the run moving (P3a); a review `fix` logs `fix_requested --note review` |
| `guard` | free | `callum-flow-merge-guard <pr> --run <id>` | 300 s | refreshable (M1) | parsed `GUARD` lines (6.2) |
| `update-behind` | free | `callum-flow-merge-guard <pr> --update-behind --run <id>` | 300 s | M2b | `UPDATED` (the handler logs `rebased_behind --run --pr --head <to>`), `FAIL`, `SKIP` |
| `fix-linkage` | free | `callum-flow-fix-linkage <pr>` | 120 s | 2 | `MATCH`, `SKIP`, `REPAIRED` or still mismatched |
| `merge` | free | `callum-flow-merge <pr> --run <id>`, then `callum-flow-rollout <N>` | 600 s | 2 | merged with rollout and `close_issue`, guard FAIL lines, or refused |
| `close-issue` | free | `gh issue close <N> --reason completed` | 60 s | 3 | exit code |
| `release-parent` | free | `gh issue edit <N> --remove-label <inDevLabel>`, then `callum-flow-event abandoned --issue <N> --note "split into <list>"` | 60 s | 3 | exit codes |
| `abandon` | free | `callum-flow-event abandoned --issue <N> [--run] [--branch]` and remove `inDevLabel` | 60 s | 3 | exit codes |
| `milestone-later` | free | `callum-flow-milestone plan <N> later` | 60 s | 3 | exit code |
| `milestone-expect` | free | `callum-flow-milestone expect <bump> "<reason>"` | 60 s | 3 | exit code |
| `pr-reopen` | free | `gh pr close <pr>`, then `gh pr reopen <pr>` | 60 s | 1 | exit codes |
| `pr-comment` | free | `gh pr comment <pr> --body-file -` (text from the adjudicator's verdicts) | 60 s | 3 | exit code |
| `release-worktree` | free | `treehouse return <path>` | 120 s | 2 | exit code, then `treehouse status` shows it available |
| `stop-agent` | free | `$.tool.call({ tool: 'TaskStop', ... })` for one of the loop's own agents | 30 s | 1 | stopped or not supported (section 13) |
| `judge` | drive | `$.prompt.submit` with a `JUDGE` line (section 8) | `wakeTimeoutMs.judge` | 1 reminder | the answer |
| `task` | drive | `$.prompt.submit` with a `TASK` line | `wakeTimeoutMs.task` | none | `done`, `failed`, `hold` |
| `tell` | owner | `$.prompt.submit` with a `TELL` line | `wakeTimeoutMs.tell` | none | delivered when the main turn completes |
| `title` | free | `$.command.run({ command: 'rename', args })` | 10 s | next pass | the text set |

Things no executor can do, by construction: pass `--yes`, run `no-mistakes rerun` or `abort`,
merge without the guard, edit a PR body, add the `ready` label, run any `coder` command, kill a
process by name, or stop an agent the loop did not spawn. A test reads the executors' argv
templates and fails on any of them.

### 6.2 Parsing guard output

Each `GUARD <name> FAIL <reason>` line becomes `{ name, reason }`, and each
`GUARD test-weakening WARN ...` line becomes a warning. The `mergeable` reason is classified by
its fixed prefixes: `conflicts with` is a conflict, `behind` is behind, `GitHub has not
computed` and `branch rules not met` are transient, `PR is merged`, `PR is closed` and `PR is a
draft` are states. The `checks` reason is a list of `name=bucket` pairs: only `pending` buckets
is transient, any other bucket is a failure. A line matching nothing is unknown (rule `M2`
sends it to `judge(guard-fail)`).

### 6.3 Agent prompts

Each spawn's prompt comes from a template in `hooks/prompts.ts`. Templates carry only issue
numbers, URLs, branch names, run ids, step names, instructions from the adjudicator or the
model, owner notes, pointers (CLAUDE.md, the memory file, the `implement-issue` skill), a
per-issue scratch subdirectory (I-95), and the closing `RESULT` line the loop parses. They never
carry a brief's content or a closing keyword (I-33), and a test checks both.

## 7. Ledger

### 7.1 Entries

```ts
type LedgerEntry = {
  key: string                     // the idempotency key: kind plus its subject's fingerprint
  kind: ActionKind
  rule: string
  issue: number | null
  run: string | null
  pr: number | null
  status: 'running' | 'done' | 'failed' | 'timed-out' | 'lost'
  attempts: number
  startedAt: Ms
  endedAt: Ms | null
  agentId?: string                // spawns
  wakeId?: string                 // judge, task, tell
  outcome?: Outcome               // parsed result, per kind
}
```

The ledger lives in `$.store` under `ledger:<repo>`. Entries are pruned 7 days after they end;
running entries are never pruned. The store's 4 MiB limit holds about 10 000 entries, far above
a week of factory work (the dev-system orchestrator logged about 1 600 events in 7 days).

### 7.2 Designer `RESULT` line

The designer prompt asks it to end its return with exactly one line:

```text
RESULT brief=<comment URL|none> created=<n1,n2|none> pending_decision=<yes|no>
```

The parser accepts only that shape and a brief URL on the repo's own issue. Anything else is an
unparseable report: `judge(report)` hands the model the report's path and asks for the fields.

### 7.3 Adjudicator reply

Its agent definition already fixes the contract: verdict lines `<VERDICT>: <reason>` with
`VERDICT` one of `CORRECT`, `WRONG`, `NIT`, `ENV`, `DUP`, then exactly one `ACTION:` line. The
parser rejects any other line and any reply without exactly one `ACTION:` line. Each verdict
line is logged as `callum-flow-event verdict --issue --run --branch --note "<line>"` when the
outcome is recorded.

### 7.4 Events the loop logs

Most transitions are already logged by the CLIs the executors call (`claimed`, `claim_lost`,
`renewed`, `reclaimed`, `closed`, `implementer_routed`, `merged`, `test_weakened`, and the
pipeline and queue states through the `--once` modes). The loop adds only what the model logs by
hand today: `delegated` (with the brief URL), `verdict`, `fix_requested --note review`,
`rebased_behind`, `abandoned` and `superseded`. It adds no new event state (DECISIONS D-09).

### 7.5 Restart and re-derivation

The store survives a restart: `CLAUDE_CONFIG_DIR` is on `/persist`, which `dev-restart-self`
keeps (FINDINGS check 5). On load:

1. Every `running` CLI entry becomes `lost` (its process died with the old session), and every
   `running` agent or wake entry becomes `lost` once the first `$.agent.list()` lacks it.
2. Plan then re-derives what to do from the state, not from the lost entries. This is safe
   because every write the loop can lose midway is either idempotent at the CLI (a claim this
   device already holds is kept and nothing is posted; the heartbeat, sweep, labels and
   milestone calls converge) or visible in the next observation (a merged PR, a new head, a
   posted brief, a delegation event).
3. Rule `H1` heartbeats on the first pass (I-93).

If the store itself is lost (a new device, a wiped config), the loop rebuilds what matters
from observations: claims and stages from `callum-flow-factory-state`, briefs from the issue
comments, delegations and review rounds from the event log. Only cheap, harmless repeats remain
possible: a second adjudicator for a gate already judged, or a repeated owner notice.

## 8. Waking the model

### 8.1 Lines

The loop submits one line as a prompt (`$.prompt.submit`), which runs as its own turn once the
session is idle and goes through every other plugin's hooks:

```text
JUDGE merge-review id=w41 pr=512 issue=507 run=01M4RQ9K31 head=03a35cd brief=https://github.com/cbundy/dev-system/issues/507#issuecomment-6130415725
TASK run-it id=w42 issue=406
TELL decision id=w43 issue=470 brief=https://github.com/cbundy/dev-system/issues/470#issuecomment-1
```

The first word is the kind of wake, the second the subject, then `id=` and `key=value` fields
with no spaces. The line names the skill that says how to answer
(`plugins/factory-loop/skills/judge/SKILL.md`, a draft in phase 3), so a session that lost it to
compaction can load it again.

### 8.2 Answers

The model answers with one call to a tool the mod registers, `mcp__factory-loop__answer`:

```json
{ "id": "w41", "decision": "merge", "reason": "...", "instructions": "...", "bump": "minor", "bumpReason": "...", "fields": {} }
```

The tool checks the id is open and the decision is allowed for its kind, and returns an error
text the model can correct in the same turn. As a fallback, a line `ANSWER <id> <decision>
[reason]` in the turn's final answer counts, read in the main loop's `turn.complete`.

| Wake | Allowed decisions | Timeout falls back to |
|---|---|---|
| `judge merge-review` | `merge`; `hold` (reason); `fixer` (instructions); optional `bump` | hold plus the title's owner count |
| `judge guard-fail` | `fixer` (instructions); `wait`; `hold` (reason) | hold |
| `judge cancelled` | `redrive`; `drop` (reason) | hold |
| `judge handoff` | `ok`; `fixer` (instructions); `hold` (reason) | hold |
| `judge report` | `parsed` (`fields`: `brief`, `created`, `pendingDecision`); `hold` | hold |
| `task redrive`, `task run-it`, `task release` | `done`; `failed` (reason); `hold` | `tell(task-timeout)` |
| `tell <kind>` | none: delivered when the turn completes | dropped after the timeout |

A turn that ends without an answer gets one reminder line (`JUDGE ... reminder=1`); then the
timeout applies. Only one wake is open at a time (rule `O2`).

### 8.3 What stays model work

- **Merge review** (I-71, I-73, I-79): reading the pipeline's fix commits against the brief, the
  PR body, and UI evidence.
- **Guard FAIL lines no rule maps**, failed CI checks, and unparseable designer reports.
- **Re-drives** (I-57, I-61): `daemon.log`, rebase, `callum-flow-regate`, a fresh `axi run`.
- **Releases and Run its** (I-36, I-85), with the owner, through the `release` skill.
- **Owner chat**: relaying `tell` lines, answering questions, turning instructions into control
  calls, and keeping `.claude/orchestrator-memory.md` (I-81).

### 8.4 Untested

`$.prompt.submit` has not been tried in the orchestrators' launch mode (FINDINGS section 6). It
is the first thing phase 3 tests, in the spike workspace, before any judge rule relies on it.

## 9. Owner notices

### 9.1 The title

```text
🔄 dev-system · act · slow 5h 65% 7d 85% · q 3 dev 2 pipe 1 merge 0 · owner 1
```

The repo's short name, the mode, the tier with both windows rounded down to 5% (so the title does
not change every minute), the counts of queued, implementing, in-pipeline-or-parked and
ready-to-merge issues, and the number of open owner items. `blind` replaces the counts in a
blind pass, `usage n/a` replaces the windows when usage is unavailable, and a stuck issue adds
`stuck <n>`. It is set with `/rename` only when the text changes, and the `session.append` hook
blanks the note the rename leaves for the model (FINDINGS check 3).

### 9.2 `tell`

A `tell` is a wake whose turn writes one line to the owner in the conversation, which the phone
shows, in the tick report's format: who acts first, what happens next, each issue or PR named by
its work with a markdown link (I-88, I-89). Kinds: `decision`, `escalate`, `review-cap`, `no-ci`,
`ci-triggers`, `untrusted-pr`, `rollout`, `base`, `update-behind`, `merge-refused`, `hold`,
`respond-stuck`, `agent-failed`, `claim-lost`, `stopped`, `blind`, `task-timeout`, `runaway`.
Each is sent once per key, and the title counts the open ones.

## 10. Failure handling

1. **A CLI fails.** The exit code and the first 2 000 characters of stderr go into the outcome.
   Exit 2 (usage) is never retried and tells the owner (a loop bug). Other failures are retried
   by their rule with backoff while attempts remain, then `tell(agent-failed)` (the same kind
   covers CLIs). A CLI that times out is killed by `$.process.run` and counts as failed.
2. **GitHub rate limits.** An adapter or executor whose stderr shows a rate limit (`API rate
   limit exceeded`, HTTP 403 or 429 with a rate-limit header) sets
   `githubBackoffUntil = now + 15 min` in the store. Until then the `github` and `queue` sources
   are skipped (their old values stay, with their age), and every action that writes to GitHub
   is held. The title shows `gh wait`.
3. **The database is down.** `callum-flow-factory-state` and `dev-query` fail: the pass is
   blind (rule `G2`). Running agents still report into the ledger, and nothing new is acted on
   until the factory source returns. After `blindNoticeAfterMs`, `tell(blind)`.
4. **An agent dies or hangs.** A `turn.complete` with reason `error` or `aborted`, or an agent
   list entry `failed` or `killed`, ends the entry as `failed`. A hang ends at `agentTimeoutMs`
   with `stop-agent` (rule `A1`). Retries follow `maxAttempts`, and each retry re-checks its
   rule's conditions, so an implementer whose run already started is not spawned again.
5. **Two devices claim the same issue.** `callum-flow-claim` lets the earliest live claim win;
   the loser exits 3, and its outcome is `lost`. Rule `D1` skips the issue while the other
   device's claim is live. If another device takes an issue this device was working (a lapsed
   lease, reclaimed), the next observation shows the new holder and rule `A2` stops this
   device's agents for it and tells the owner.
6. **A restart lands mid-action.** Section 7.5.
7. **Usage crosses a tier mid-pass.** The tier is fixed for the pass from the observed reading.
   Before each `start`, `develop` or `drive` action the executor reads `$.session.usage()`
   (free) and skips the action if that reading puts it in a tier that forbids its class. The
   next pass re-plans with the new tier.
8. **A wake is never answered.** Section 8.2: one reminder, then the timeout's fallback, which
   always holds rather than acts.
9. **A pass throws.** The error is logged with the pass number, the title shows `error`, and the
   next pass runs as normal. Three throwing passes in a row tell the owner.

## 11. Safety rails

### 11.1 Observe mode writes nothing that matters

In observe mode no executor runs. The adapters still run read-only CLIs, and some of them log
events as a side effect (`usage-check.sh`, the `--once` modes, `callum-flow-issue-read`'s
`untrusted_stripped`). Every command the loop runs in observe mode gets
`CALLUM_EVENTS_DIR=<loop dir>/sink-events`, so those lines land in a local file that
`event-push-loop` never ships. The live event log stays clean (the owner deleted 34 fake rows on
2026-10-12, MEM).

### 11.2 One acting loop per repo and device

Act mode needs all of:

- `mode: act` in the plugin options, and no kill switch;
- the act lock, `<loop dir>/act.lock`, a JSON lease (`session`, `renewedAt`, `expiresAt`)
  renewed every pass and released at `session.end`. A second session on the same workspace
  finds a live lease and stays in observe;
- `DEV_ROLE=orchestrator`, unless the repo-local config sets `allowActOutsideOrchestrator`;
- no live `orchestrator-watch.sh` lock for the repo. If the old watcher is armed, the released
  skill is still driving: the loop stays in observe and tells the owner.

### 11.3 The kill switch

`${CLAUDE_CONFIG_DIR:-~/.claude}/factory-loop/OFF` (any content) forces `off` at the start of
the next pass, with no restart. Removing it resumes the configured mode.

### 11.4 Runaway protection

Plan counts the ledger's actions per class, and per kind and issue, in the last hour. An action
past its `rateCaps` entry is dropped, the class stays closed until the window clears, and `tell(runaway)` goes out
once. Three consecutive failures of one executor kind close that kind for 30 minutes and tell
the owner.

### 11.5 Scope of every action

The loop acts only on its configured repo, only on issues and PRs by trusted authors
(`callum-flow-issue-read` filters them, and the guard's `author` check runs before any merge),
and only on branches named `issue-<N>`. Runs on other branches are owner work and are left
alone.

### 11.6 Where its files live

`<loop dir>` is `${CLAUDE_CONFIG_DIR:-~/.claude}/factory-loop/<owner>__<repo>/`: the decision log
(`decisions-YYYY-MM-DD.jsonl`), recorded states (`states/YYYY-MM-DD/<pass>.json`), detached
respond logs, the observe-mode event sink and the act lock. Nothing goes in the repository.

## 12. Observability

One JSON line per pass in the decision log:

```json
{"v":1,"at":"2026-10-13T03:12:00.000Z","pass":184,"mode":"observe","tier":"slow",
 "digest":"9f2c41d0","sources":{"factory":"ok","runs":"ok","queue":"ok","github":"stale 7m"},
 "counts":{"queued":3,"implementing":2,"pipeline":1,"merge":0,"owner":1},
 "actions":[{"key":"claim:470:new","kind":"claim","class":"start","rule":"D1","issue":470,"reason":"ready, unblocked"}],
 "skipped":[{"rule":"D1","issue":340,"why":"tracker"}],
 "outcomes":[{"key":"guard:512:03a35cd:1","status":"done","ms":8123,"summary":"no FAIL"}],
 "title":"🔄 dev-system · observe · slow 5h 65% 7d 85% · q 3 dev 2 pipe 1 merge 0 · owner 1"}
```

`digest` is a hash of the canonical state without its timestamps, so unchanged passes are easy
to spot. Appends go through one `$.process.run` per pass (`sh -c 'cat >> "$1"'` with the lines on
stdin), because `$.fs.write` rewrites whole files. In observe mode each state whose digest
changed is also written in full under `states/`, which the replay harness reads.

## 13. Known gaps and risks

- **`$.prompt.submit` judgment wakes** are untested in the launch mode (8.4).
- **`stop-agent`** relies on the `TaskStop` tool through `$.tool.call`; untested from a mod. If
  it is unavailable, a timed-out agent is left running, marked `timed-out`, and the owner is told.
- **Per-agent OTEL attributes**: `agent.spawn` has no environment field, so the
  `OTEL_RESOURCE_ATTRIBUTES=issue=<N>` tagging in skill step 3 cannot be reproduced (DECISIONS D-11).
- **Long-running agents** (implementers for an hour or more, several at once) are untested from a
  mod (FINDINGS section 6). Phase 4 cannot test them either, since observe mode spawns nothing.
- **Auto mode**: if orchestrators move from bypass to auto mode, every agent report hands back to
  the main conversation and wakes the model (FINDINGS check 4). The loop must then stay in bypass.
- **The mod API is early access**: the plugin pins Claude Code 2.1.296 in its README, and the
  spike's checks are re-run before each upgrade.
- **GitHub reads in the shadow workspace**: it has no `gh` login, so shadow runs use
  `--github off` and cannot judge claims (`D1` needs labels and blockers).

## 14. Cutover plan (not executed)

1. **Shadow** (phase 4): observe mode in the spike workspace, `runSource: events`, compared with
   the live dev-system orchestrator's events.
2. **Prerequisites to ship**: the two `--once` modes released in the base image; the plugin in the
   marketplace; the judge skill reviewed; the Orchestrator template's start prompt changed from
   `/callum-flow:issue-orchestrator` to the judge skill, and its resume prompt from "re-arm the
   watcher" to "the loop resumes by itself".
3. **Act on `dev-system-testbed`** with a few owner-made test issues that walk every path: claim,
   design, a split, a pending decision, delegate, each gate `ACTION`, the review cap, a behind-only
   update, a conflict, a test-weakening WARN, a linkage FAIL, a merge and each rollout.
4. **One real repo**, with the released skill as the fallback: to roll back, create the kill
   switch and start `/callum-flow:issue-orchestrator` in the session.
5. **The rest**, one repo at a time, each step through the normal release process.
