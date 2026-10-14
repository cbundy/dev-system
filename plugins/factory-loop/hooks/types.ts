// The factory loop's data: what observe builds (State), what plan returns (Action), and
// what the ledger keeps. docs/factory-loop/SPEC.md is the contract; section numbers below
// point into it. Types only: plan.ts imports nothing else, so it stays pure.

export type Ms = number

export type Tier = 'normal' | 'slow' | 'stop-new' | 'stop-all'

// Each action has one class; the tier decides which classes may run (SPEC 5.2).
export type ActionClass = 'free' | 'owner' | 'drive' | 'develop' | 'start'

export type Stage =
  | 'queued'
  | 'designing'
  | 'implementing'
  | 'in pipeline'
  | 'parked'
  | 'ready to merge'
  | 'merged'
  | 'closed without merge'

export type SourceName = 'factory' | 'facts' | 'runs' | 'queue' | 'github' | 'usage' | 'pool' | 'milestone'

// ok: the last read worked. at: when the data in State was read (null: never).
export type Source = { ok: boolean; at: Ms | null; error?: string }

// Each window's reading and when it resets: a reading taken before its window reset counts as
// zero once the reset has passed (the next read confirms it).
export type Usage = {
  fiveHour: number | null
  sevenDay: number | null
  fiveHourResetsAt: Ms | null
  sevenDayResetsAt: Ms | null
  unavailable: boolean
}

export type Brief = { url: string; at: Ms }

// A trusted comment that is neither a brief nor a claim comment: what the owner replied on the issue.
export type Reply = { id: string; url: string; at: Ms }

export type IssueView = {
  number: number
  stage: Stage | null
  stageSince: Ms | null
  holder: string | null
  run: string | null
  pr: number | null
  stuck: string | null
  open: boolean | null
  trusted: boolean | null
  labels: string[] | null
  blockedBy: number | null
  subIssues: number | null
  // the title marks it a tracker (config trackerTitle, e.g. 'Epic: ...'), or null if unread
  epic: boolean | null
  // a tracker's open sub-issues, nested ones included, ascending, from its timeline; read only
  // for trackers named in control.only (D-35). null: not read.
  subIssueList: number[] | null
  brief: Brief | null
  // the issue's replies from the designing --comments read; empty when unread
  replies: Reply[]
  delegatedBrief: string | null
}

export type RunState =
  | 'merge-ready'
  | 'head-mismatch'
  | 'conflict'
  | 'ci-stalled'
  | 'parked'
  | 'failed'
  | 'cancelled'
  | 'running'
  | 'pending'

export type RunView = {
  branch: string
  issue: number | null
  run: string
  state: RunState
  head: string | null
  step: string | null
  detail: string | null
  pr: number | null
  since: Ms | null
  reviewFixRounds: number
  verdicts: string[]
  superseded: boolean
}

// The main checkout, where every agent the loop starts begins and its own commands run (#544):
// the branch checked out (null when HEAD is detached), its commit, origin's default branch and
// the tracked paths with changes (untracked files are not the checkout moving). A read that
// failed is { error }.
export type Checkout = { branch: string | null; head: string | null; defaultBranch: string; dirty: string[] } | { error: string }

// A treehouse pool slot (#563): the branch checked out (null when detached), and the lease's
// id, start and branch: the branch it has checked out, else the newest issue branch its HEAD
// reflog shows checked out since the lease began (an implementer detaches its slot once the
// pipeline holds the branch). dirty: uncommitted changes, untracked files included, read only for
// a slot rule H3 might return (null: not read).
export type Slot = {
  path: string
  branch: string | null
  state: string
  dirty: boolean | null
  busy: boolean
  lease: string | null
  leasedAt: Ms | null
  leaseBranch: string | null
}
export type Pool = { free: number; total: number; slots: Slot[] }

export type AgentStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
export type AgentView = { id: string; type: string; status: AgentStatus }

export type Bump = 'patch' | 'minor' | 'major'
export type Milestone = { open: number; closed: number; expected: Bump | null }

export type Control = {
  paused: number[]
  noNewWork: boolean
  skip: number[]
  priority: number[]
  only: number[]
  serial: boolean
  usageOverride: { untilPct: number; expiresAt: Ms } | null
  // an update is due (rule H4, D-15): set by the reconciler or `/factory update`
  updateDue: { reason: string; at: Ms } | null
  resumed: { subject: string; at: Ms }[]
  dropped: { issue: number; at: Ms }[]
  notes: { issue: number | null; text: string; at: Ms }[]
}

export type AgentType = 'designer' | 'implementer' | 'adjudicator' | 'fixer'
export type AdjudicatorPurpose = 'gate' | 'weakening' | 'merge'
export type FixerPurpose = 'gate' | 'conflict' | 'regate' | 'weakening' | 'review' | 'guard' | 'handoff' | 'resume'
export type Rollout = 'merge' | 'run-it' | 'keep-open'

export type GuardFail = { name: string; reason: string }

// An adjudicator's one ACTION line, parsed (SPEC 7.3). `merge` and `hold` answer purpose
// merge only (rule M4, D-05).
export type AdjudicatorAction =
  | { type: 'approve'; reason: string | null }
  // ignore: the judged findings the fix leaves unselected, declined by name (respond --ignore,
  // which no-mistakes 1.90+ requires); null when none
  | { type: 'fix'; findings: string | null; instructions: string | null; addFinding: string | null; ignore: string | null }
  | { type: 'skip' }
  | { type: 'escalate'; why: string }
  | { type: 'fixer'; instructions: string }
  | { type: 'merge' }
  | { type: 'hold'; reason: string }

// The merge adjudicator's report lines (SPEC 7.3): SUMMARY, BUMP and FLAGS. A flag marks what
// release sequencing must know: a base image or template change, a restart, a run-it rollout.
export type MergeFlag = 'image' | 'template' | 'restart' | 'run-it'
export type MergeReport = { summary: string; bump: Bump; bumpReason: string; flags: MergeFlag[] }

// What an executor recorded about a finished action (SPEC 7). An agent reply the parser
// cannot read is recorded as a failed attempt, except the designer's, which goes to the
// model as `judge(report)` and is recorded as { unparsed: true }.
export type Outcome =
  // a CLI's exit code; on failure the first 2 000 characters of its stderr (SPEC 10.1)
  | { kind: 'cli'; exit: number; detail?: string }
  // a detached respond or env-retry (SPEC 6.1): the slot it runs in and the log its launch was
  // read back from
  | { kind: 'respond'; slot: string; log: string }
  | { kind: 'claim'; result: 'claimed' | 'lost' }
  | { kind: 'designer'; brief: string | null; created: number[]; pendingDecision: boolean }
  | { kind: 'designer'; unparsed: true }
  | { kind: 'adjudicator'; verdicts: string[]; action: AdjudicatorAction; report: MergeReport | null }
  | { kind: 'handoff'; notGated: boolean; run: string | null; head: string | null; newBranch: string | null }
  | { kind: 'guard'; fails: GuardFail[]; warns: string[] }
  | { kind: 'update-behind'; result: 'updated' | 'fail' | 'skip'; from: string | null; to: string | null; line: string }
  // a worktree the pipeline's own commits left behind its branch, fast-forwarded (rule M2,
  // #551): forwarded, current (nothing lagged) or refused (dirty, diverged, origin moved)
  | { kind: 'fast-forward'; result: 'forwarded' | 'current' | 'refused'; line: string }
  // the main checkout brought up to date with origin's default branch (rule H5, #555): updated
  // (the line names both commits), current, or refused (moved, dirty, or commits origin lacks)
  | { kind: 'update-checkout'; result: 'updated' | 'current' | 'refused'; line: string }
  | { kind: 'merge'; result: 'merged' | 'refused'; rollout: Rollout | null; closeIssue: number | null; line: string }
  // callum-flow-rollout for a merge the loop did not make (a hand merge, rule M7, D-29)
  | { kind: 'rollout'; rollout: Rollout | null; closeIssue: number | null }
  | {
      kind: 'wake'
      decision: string
      reason: string | null
      instructions: string | null
      bump: Bump | null
      bumpReason: string | null
      fields: Record<string, string | number | boolean | number[] | null>
    }

export type ActionKind =
  | 'heartbeat'
  | 'sweep'
  | 'claim'
  | 'spawn'
  | 'delegate'
  | 'respond'
  | 'env-retry'
  | 'guard'
  | 'update-behind'
  | 'fast-forward'
  | 'update-checkout'
  | 'fix-linkage'
  | 'merge'
  | 'close-issue'
  | 'release-parent'
  | 'owner-resume'
  | 'abandon'
  | 'milestone-later'
  | 'milestone-expect'
  | 'pr-reopen'
  | 'pr-comment'
  | 'pr-close'
  | 'release-worktree'
  | 'restart-self'
  | 'rollout'
  | 'stop-agent'
  | 'judge'
  | 'task'
  | 'tell'
  | 'title'

export type LedgerStatus = 'running' | 'done' | 'failed' | 'timed-out' | 'lost'

export type LedgerEntry = {
  key: string
  kind: ActionKind
  class: ActionClass
  rule: string
  issue: number | null
  run: string | null
  pr: number | null
  head: string | null
  agent?: AgentType
  wake?: string
  status: LedgerStatus
  attempts: number
  startedAt: Ms
  endedAt: Ms | null
  agentId?: string
  outcome?: Outcome
  // a wake's id (SPEC 8.1 `id=`), the turn it started, whether its reminder went out (for an
  // agent, its one repair message, #548), and the session that submitted it (a restart ends the
  // wakes of the session before, SPEC 7.5)
  wakeId?: string
  turnId?: string
  reminded?: boolean
  session?: string
  // the executor's last few words, for the decision log
  summary?: string
}

export type State = {
  now: Ms
  repo: string
  device: string
  loadedAt: Ms
  sources: Record<SourceName, Source>
  usage: Usage
  issues: IssueView[]
  queue: number[]
  runs: RunView[]
  pool: Pool | null
  agents: AgentView[]
  milestone: Milestone | null
  ledger: LedgerEntry[]
  control: Control
  lastTitle: string | null
  githubBackoffUntil: Ms | null
  // null: not read (the replay harness, a state built outside a pass)
  checkout: Checkout | null
}

export type Mode = 'off' | 'observe' | 'act'

export type Config = {
  mode: Mode
  // observe mode only: plan as this device (the live orchestrator's) to shadow its work
  shadowDevice: string | null
  readyLabel: string
  inDevLabel: string
  skipLabels: string[]
  // a title matching this pattern marks a tracker, like sub-issues do (MEM: trackers are never claimed)
  trackerTitle: string
  usageSlowPct: number
  usageStopNewPct: number
  usageStopAllPct: number
  passEveryMs: Ms
  queueEveryMs: Ms
  githubEveryMs: Ms
  usageEveryMs: Ms
  milestoneEveryMs: Ms
  // a usage reading older than this counts as unavailable
  usageStaleMs: Ms
  heartbeatEveryMs: Ms
  sweepEveryMs: Ms
  // the main checkout is brought up to date with origin at least this often (rule H5, #555)
  checkoutEveryMs: Ms
  slowGapMs: Ms
  maxStartsPerPass: number
  // null: no cap on this device's live issues
  maxInFlightIssues: number | null
  worktreeReserve: number
  reviewFixCap: number
  guardRecheckMs: Ms
  guardTtlMs: Ms
  respondSettleMs: Ms
  updateBehindRetryMs: Ms
  updateBehindRetries: number
  ciStallRecheckMs: Ms
  blindNoticeAfterMs: Ms
  agentTimeoutMs: Record<AgentType, Ms>
  wakeTimeoutMs: Record<WakeKind, Ms>
  maxAttempts: Partial<Record<ActionKind | AgentType, number>>
  retryBackoffMs: Ms
  // per rolling hour; merges are never capped (D-24)
  rateCaps: { start: number; spawn: number; wake: number; perIssueKind: number }
  // act mode without DEV_ROLE=orchestrator, for a testbed (SPEC 11.2)
  allowActOutsideOrchestrator: boolean
  // one timing record per pass in trace-YYYY-MM-DD.jsonl (#552); the workspace file's own
  // `trace`, which `/factory trace` writes, overrides the repo's
  trace: boolean
  // the trace files' total size: the oldest go first, and today's is cut short past it
  traceMaxBytes: number
  // how the prompts and the repair message ask agents to answer (SPEC 4.2): through the checked
  // answer script (script, the default: a workaround until a timer-spawned agent reaches the
  // loop's tool hook, #560, #561), through their answer tools (tool, the intended design, #548),
  // or in text alone; text stays every channel's fallback. The workspace file's own
  // `answerChannel` overrides the repo's
  answerChannel: AnswerChannel
}

export type AnswerChannel = 'script' | 'tool' | 'text'

export type WakeKind = 'judge' | 'task' | 'tell'

// What a wake asks: the line's first word is the action kind (judge, task, tell), the
// second this wake name, then key=value fields with no spaces. Context lines follow it in
// the visible prompt: a mod cannot attach hidden context to its own prompt (SPEC 8.1).
type Base = { key: string; class: ActionClass; rule: string; reason: string; issue: number | null }

export type Action =
  | (Base & { kind: 'heartbeat' | 'sweep' | 'claim' | 'close-issue' | 'milestone-later' })
  | (Base & { kind: 'spawn'; agent: 'designer'; model: string | null; notes: string[] })
  | (Base & {
      kind: 'spawn'
      agent: 'adjudicator'
      purpose: AdjudicatorPurpose
      run: string
      branch: string
      step: string | null
      head: string | null
      pr: number | null
      brief: string | null
      model: string | null
      warns: string[]
      // purpose merge: pointers only, never a diff (D-05). The implementer's handoff head, the
      // run's verdict lines and the latest guard lines for this head; empty for other purposes.
      handoffHead: string | null
      verdicts: string[]
      guard: string[]
    })
  | (Base & {
      kind: 'spawn'
      agent: 'fixer'
      purpose: FixerPurpose
      run: string | null
      branch: string
      head: string | null
      pr: number | null
      brief: string | null
      model: string | null
      instructions: string
    })
  | (Base & { kind: 'delegate'; brief: string })
  | (Base & {
      kind: 'respond'
      run: string
      branch: string
      // the gate's step name; null when unknown (a park seen only in the event log, a failed run
      // the watcher printed no step for): respond then takes the step awaiting approval
      step: string | null
      head: string
      action: 'approve' | 'fix' | 'skip'
      findings: string | null
      instructions: string | null
      addFinding: string | null
      ignore: string | null
      approveReason: string | null
      logReview: boolean
    })
  // Only rule P2a may launch this command; SPEC 5.4 owns resume eligibility.
  | (Base & { kind: 'env-retry'; run: string; branch: string; step: string | null; head: string })
  | (Base & { kind: 'guard' | 'update-behind'; pr: number; run: string; head: string })
  // the worktrees on the run's branch, moved to the run's head when origin holds it, or the head the loop's own update-behind pushed (#551, #595)
  | (Base & { kind: 'fast-forward'; pr: number; run: string; head: string; origin: string; branch: string })
  // rule H5: the main checkout, on origin's default branch, fast-forwarded to origin's (#555);
  // head: its commit as observe read it, so plan knows whether a refusal still stands
  | (Base & { kind: 'update-checkout'; branch: string; head: string | null })
  | (Base & { kind: 'fix-linkage' | 'pr-reopen'; pr: number })
  | (Base & { kind: 'merge'; pr: number; run: string; head: string; bump: Bump | null; bumpReason: string | null })
  | (Base & { kind: 'release-parent'; created: number[] })
  // rule D3: the owner's answer on the issue, recorded as a note and a resume (control state)
  | (Base & { kind: 'owner-resume'; text: string })
  | (Base & { kind: 'abandon'; run: string | null; branch: string | null; note: string })
  | (Base & { kind: 'milestone-expect'; bump: Bump; why: string })
  | (Base & { kind: 'pr-comment'; pr: number; body: string })
  // rule M8: the PR of a superseded run, and the PR on the branch its work moved to (#553)
  | (Base & { kind: 'pr-close'; pr: number; run: string; newBranch: string; by: number })
  // rule H3: the slot, the branch its lease worked, and the lease the return is pinned to (#563)
  | (Base & { kind: 'release-worktree'; path: string; branch: string; lease: string })
  // rule H4: why the update is due, and when it was asked for (the key's subject)
  | (Base & { kind: 'restart-self'; why: string; at: Ms })
  // rule M7 for a hand merge: read the merged issue's rollout
  | (Base & { kind: 'rollout'; pr: number | null })
  | (Base & { kind: 'stop-agent'; agentId: string; entry: string })
  | (Base & { kind: WakeKind; wake: string; fields: Record<string, string>; context: string[] })
  | (Base & { kind: 'title'; text: string })

export type Skip = { rule: string; issue: number | null; why: string }

export type PlanResult = {
  tier: Tier
  overridden: boolean
  actions: Action[]
  skipped: Skip[]
  title: string
  owner: number
  // each rate cap tripped this pass: a bucket (start, spawn, wake) or a per-issue key
  // '<kind>:<issue>' (SPEC 11.4)
  capped: string[]
  // a claim was held back by maxInFlightIssues this pass (SPEC 4.2)
  atCap: boolean
}
