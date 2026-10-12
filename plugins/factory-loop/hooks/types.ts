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
  brief: Brief | null
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

export type Slot = { path: string; branch: string | null; state: string; dirty: boolean | null; busy: boolean }
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
  serial: boolean
  usageOverride: { untilPct: number; expiresAt: Ms } | null
  resumed: { subject: string; at: Ms }[]
  dropped: { issue: number; at: Ms }[]
  notes: { issue: number | null; text: string; at: Ms }[]
}

export type AgentType = 'designer' | 'implementer' | 'adjudicator' | 'fixer'
export type FixerPurpose = 'gate' | 'conflict' | 'regate' | 'weakening' | 'review' | 'guard' | 'handoff'
export type Rollout = 'merge' | 'run-it' | 'keep-open'

export type GuardFail = { name: string; reason: string }

// An adjudicator's one ACTION line, parsed (SPEC 7.3).
export type AdjudicatorAction =
  | { type: 'approve'; reason: string | null }
  | { type: 'fix'; findings: string | null; instructions: string | null; addFinding: string | null }
  | { type: 'skip' }
  | { type: 'escalate'; why: string }
  | { type: 'fixer'; instructions: string }

// What an executor recorded about a finished action (SPEC 7). An agent reply the parser
// cannot read is recorded as a failed attempt, except the designer's, which goes to the
// model as `judge(report)` and is recorded as { unparsed: true }.
export type Outcome =
  | { kind: 'cli'; exit: number }
  | { kind: 'claim'; result: 'claimed' | 'lost' }
  | { kind: 'designer'; brief: string | null; created: number[]; pendingDecision: boolean }
  | { kind: 'designer'; unparsed: true }
  | { kind: 'adjudicator'; verdicts: string[]; action: AdjudicatorAction }
  | { kind: 'handoff'; notGated: boolean; run: string | null; head: string | null; newBranch: string | null }
  | { kind: 'guard'; fails: GuardFail[]; warns: string[] }
  | { kind: 'update-behind'; result: 'updated' | 'fail' | 'skip'; from: string | null; to: string | null; line: string }
  | { kind: 'merge'; result: 'merged' | 'refused'; rollout: Rollout | null; closeIssue: number | null; line: string }
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
  | 'guard'
  | 'update-behind'
  | 'fix-linkage'
  | 'merge'
  | 'close-issue'
  | 'release-parent'
  | 'abandon'
  | 'milestone-later'
  | 'milestone-expect'
  | 'pr-reopen'
  | 'pr-comment'
  | 'release-worktree'
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
  heartbeatEveryMs: Ms
  sweepEveryMs: Ms
  slowGapMs: Ms
  maxStartsPerPass: number
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
  maxAttempts: Partial<Record<ActionKind | AgentType, number>>
  retryBackoffMs: Ms
  rateCaps: { start: number; spawn: number; merge: number; wake: number; perIssueKind: number }
}

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
      purpose: 'gate' | 'weakening'
      run: string
      branch: string
      step: string | null
      head: string | null
      pr: number | null
      brief: string | null
      model: string | null
      warns: string[]
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
      step: string
      head: string
      action: 'approve' | 'fix' | 'skip'
      findings: string | null
      instructions: string | null
      addFinding: string | null
      approveReason: string | null
      logReview: boolean
    })
  | (Base & { kind: 'guard' | 'update-behind'; pr: number; run: string; head: string })
  | (Base & { kind: 'fix-linkage' | 'pr-reopen'; pr: number })
  | (Base & { kind: 'merge'; pr: number; run: string; head: string; bump: Bump | null; bumpReason: string | null })
  | (Base & { kind: 'release-parent'; created: number[] })
  | (Base & { kind: 'abandon'; run: string | null; branch: string | null; note: string })
  | (Base & { kind: 'milestone-expect'; bump: Bump; why: string })
  | (Base & { kind: 'pr-comment'; pr: number; body: string })
  | (Base & { kind: 'release-worktree'; path: string; branch: string })
  | (Base & { kind: 'stop-agent'; agentId: string; entry: string })
  | (Base & { kind: 'judge' | 'task' | 'tell'; wake: string; fields: Record<string, string>; context: string[] })
  | (Base & { kind: 'title'; text: string })

export type Skip = { rule: string; issue: number | null; why: string }

export type PlanResult = {
  tier: Tier
  overridden: boolean
  actions: Action[]
  skipped: Skip[]
  title: string
  owner: number
}
