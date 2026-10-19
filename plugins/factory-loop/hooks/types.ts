// The factory loop's data: what observe builds (State), what plan returns (Action), and
// what the ledger keeps. docs/factory-loop/v2/SPEC.md section 13 is the contract; the section numbers below
// are its. Types only, so the pure planner can import it. The v2 rule layer's vocabulary
// (docs/factory-loop/v2/SPEC.md) is v2/types.ts's; its action kinds, actions, outcomes and State
// fields join the unions here, so the dispatcher, the ledger and the store carry them.
import type { AgentStep, Model, SplitReasons, StateTimeouts, V2Action, V2ActionKind, V2Outcome, V2State } from './v2/types'

export type Ms = number

export type Tier = 'normal' | 'slow' | 'stop-new' | 'stop-all'

// Each action has one class; the tier decides which classes may run (v2 SPEC 13.5.2).
export type ActionClass = 'free' | 'owner' | 'drive' | 'develop' | 'start'

export type Stage =
  | 'queued'
  | 'designing'
  | 'implementing'
  | 'in pipeline'
  | 'parked'
  | 'waiting'
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
  // the open issues waiting on this one, or null if unread
  blocking: number | null
  subIssues: number | null
  // the title marks it a tracker (config trackerTitle, e.g. 'Epic: ...'), or null if unread
  epic: boolean | null
  // a tracker's open sub-issues, nested ones included, ascending, from its timeline; read only
  // for trackers named in control.only (D-35). null: not read.
  subIssueList: number[] | null
  brief: Brief | null
  delegatedBrief: string | null
  // the factory source shows the holder's claim lapsed: its lease ended then, with no renewal (v2 H1)
  claimLapsedAt: Ms | null
  // the newest `reclaimed` event of the issue: a sweep or a release gave its claim back (v2 H1)
  reclaimedAt: Ms | null
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
// openIssues: the numbers of the open issue lines (not PRs), in the order listed
export type Milestone = { open: number; closed: number; openIssues: number[]; expected: Bump | null }
// ReleaseInfo: the last release tag (null: the repo has no release yet) and when the oldest merge
// into the default branch since that tag happened (null: unknown or none)
export type ReleaseInfo = { tag: string | null; oldest: Ms | null }

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
  // a v2 resume carries its note for the issue's next step (v2 SPEC 11, P1)
  resumed: { subject: string; at: Ms; note?: string }[]
  dropped: { issue: number; at: Ms }[]
  notes: { issue: number | null; text: string; at: Ms }[]
}

export type AgentType = 'designer' | 'implementer' | 'adjudicator' | 'fixer'
export type AdjudicatorPurpose = 'gate' | 'weakening' | 'merge'
export type FixerPurpose = 'gate' | 'conflict' | 'regate' | 'weakening' | 'review' | 'guard' | 'handoff' | 'resume'
export type Rollout = 'merge' | 'run-it' | 'keep-open'

// An adjudicator's one ACTION line, parsed (the retired v1 adjudicator reply). `merge` and `hold` answer purpose
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

// The merge adjudicator's report lines (the retired v1 adjudicator reply): SUMMARY, BUMP and FLAGS. A flag marks what
// release sequencing must know: a base image or template change, a restart, a run-it rollout.
export type MergeFlag = 'image' | 'template' | 'restart' | 'run-it'
export type MergeReport = { summary: string; bump: Bump; bumpReason: string; flags: MergeFlag[] }

// What an executor recorded about a finished action (v2 SPEC 13.7). An agent reply the parser
// cannot read is recorded as a failed attempt, except the designer's, which goes to the
// model as `judge(report)` and is recorded as { unparsed: true }.
export type Outcome =
  // a CLI's exit code; on failure the first 2 000 characters of its stderr (v2 SPEC 13.10 item 1)
  | { kind: 'cli'; exit: number; detail?: string }
  | { kind: 'claim'; result: 'claimed' | 'lost' }
  | { kind: 'designer'; brief: string | null; created: number[]; pendingDecision: boolean }
  | { kind: 'designer'; unparsed: true }
  | { kind: 'adjudicator'; verdicts: string[]; action: AdjudicatorAction; report: MergeReport | null }
  | { kind: 'handoff'; notGated: boolean; run: string | null; head: string | null; newBranch: string | null }
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
  | V2Outcome

export type ActionKind =
  | 'heartbeat'
  | 'sweep'
  | 'claim'
  | 'close-issue'
  | 'release-parent'
  | 'milestone-later'
  | 'restart-self'
  | 'rollout'
  | 'stop-agent'
  | 'judge'
  | 'task'
  | 'tell'
  | 'title'
  | V2ActionKind

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
  wake?: string
  status: LedgerStatus
  attempts: number
  startedAt: Ms
  endedAt: Ms | null
  agentId?: string
  outcome?: Outcome
  // a wake's id (v2 SPEC 13.8.1 `id=`), the turn it started, whether its reminder went out (for an
  // agent, its one repair message, #548), and the session that submitted it (a restart ends the
  // wakes of the session before, v2 SPEC 13.7.5)
  wakeId?: string
  turnId?: string
  reminded?: boolean
  session?: string
  // the executor's last few words, for the decision log
  summary?: string
  // a v2 agent step's kind, which the per-issue rate cap counts by (D-24; v2 appendix B)
  step?: AgentStep
  // the key's own attempt cap, when its action set one (a v2 slot op's, appendix B)
  maxAttempts?: number
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
  // null until the first successful read, which happens only while the milestone qualifies
  release: ReleaseInfo | null
  ledger: LedgerEntry[]
  control: Control
  lastTitle: string | null
  // when the last rename went out; null until one has since the module loaded
  lastTitleAt: Ms | null
  githubBackoffUntil: Ms | null
  // null: not read (the replay harness, a state built outside a pass)
  checkout: Checkout | null
  // what v2 reads besides (v2 SPEC 2.4)
  v2?: V2State
}

export type Mode = 'off' | 'observe' | 'act'

export type Config = {
  mode: Mode
  // observe mode only: plan as this device (the live orchestrator's) to shadow its work
  shadowDevice: string | null
  readyLabel: string
  // S1 claims issues with this label after the owner's list, before the rest: order only, never a filter
  priorityLabel: string
  inDevLabel: string
  skipLabels: string[]
  // a title matching this pattern marks a tracker, like sub-issues do (MEM: trackers are never claimed)
  trackerTitle: string
  usageSlowPct: number
  usageStopNewPct: number
  usageStopAllPct: number
  passEveryMs: Ms
  // the repo expects a release at least this often; the release wake names it (#772)
  minimumReleaseCadenceMs: Ms
  // the merge queue holds its merges while a release bump PR is open: the branch prefix that marks one (null: no hold), and the window from the PR's opening (0: no hold)
  releaseBranchPrefix: string | null
  releaseHoldMs: Ms
  // the title is renamed at most this often (O1 is a throttle)
  titleEveryMs: Ms
  // the factory report is built at most this often (#684)
  reportEveryMs: Ms
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
  // a queue starved this long (ready issues, all blocked, nothing in flight) tells the owner (S1)
  starvedNoticeAfterMs: Ms
  agentTimeoutMs: Record<AgentType, Ms>
  wakeTimeoutMs: Record<WakeKind, Ms>
  maxAttempts: Partial<Record<ActionKind | AgentType, number>>
  retryBackoffMs: Ms
  // per rolling hour; merges are never capped (D-24)
  rateCaps: { start: number; spawn: number; wake: number; perIssueKind: number }
  // act mode without DEV_ROLE=orchestrator, for a testbed (v2 SPEC 13.11.2)
  allowActOutsideOrchestrator: boolean
  // one timing record per pass in trace-YYYY-MM-DD.jsonl (#552); the workspace file's own
  // `trace`, which `/factory trace` writes, overrides the repo's
  trace: boolean
  // the trace files' total size: the oldest go first, and today's is cut short past it
  traceMaxBytes: number
  // how the prompts and the repair message ask agents to answer (v2 SPEC 13.4.2): through the checked
  // answer script (script, the default: a workaround until a timer-spawned agent reaches the
  // loop's tool hook, #560, #561), through their answer tools (tool, the intended design, #548),
  // or in text alone; text stays every channel's fallback. The workspace file's own
  // `answerChannel` overrides the repo's
  answerChannel: AnswerChannel
  // where the record rebuild reads (v2 SPEC 3.3): the old store (old), the new one (new), or both,
  // compared, with the records from the old (shadow, the default)
  eventsSource: EventsSource
  // --- v2 (v2 SPEC 2.3, appendix A) ---
  // the step timeouts and the waiting states' tell periods (v2 SPEC 4.4)
  stateTimeoutMs: StateTimeouts
  // a wait on GitHub: no check started this long after the head was first seen, or one running
  // this long, is unknown (v2 SPEC 4.4)
  ciStartMs: Ms
  ciRunMs: Ms
  // a PR's read stands this long, unless something the loop knows makes it due sooner (v2 SPEC 2.4)
  prEveryMs: Ms
  // triage calls per life (v2 SPEC 5.1); its agent's model (5.2)
  maxTriages: number
  // minutes a requested wind-down may take before the stop (0: wind-down off; v2 SPEC 10.11)
  windDownMinutes: number
  // the lives an issue gets: a release at the last one rejects it instead of putting it back in the
  // queue (v2 SPEC 6.4)
  maxLives: number
  triageModel: Model
  // the review step's implementation and its model (v2 SPEC 8.2, 8.3)
  reviewer: string
  reviewerModel: Model
  // the stop gate's commands in the slot, joined with &&, and their one budget (v2 SPEC 10.6)
  gateCommands: string[]
  gateTimeoutMs: Ms
  // how many stop gates run at once across the companion's process: a whole number of at least 1, or
  // 'auto' (cpus / GATE_CPUS, config.ts resolveGateConcurrency); the longest a finished writer waits
  // for its turn (v2 SPEC 10.6)
  gateConcurrency: 'auto' | number
  gateWaitTimeoutMs: Ms
}

export type AnswerChannel = 'script' | 'tool' | 'text'
export type EventsSource = 'old' | 'new' | 'shadow'

export type WakeKind = 'judge' | 'task' | 'tell'

// What every action carries. maxAttempts: the key's own cap, for a kind whose ops differ (v2's
// slot); otherwise config.maxAttempts holds the kind's.
export type ActionBase = { key: string; class: ActionClass; rule: string; reason: string; issue: number | null; maxAttempts?: number }
type Base = ActionBase

// What a wake asks: the line's first word is the action kind (judge, task, tell), the
// second this wake name, then key=value fields with no spaces. Context lines follow it in
// the visible prompt: a mod cannot attach hidden context to its own prompt (v2 SPEC 13.8.1).
export type Action =
  | (Base & { kind: 'heartbeat' | 'sweep' | 'claim' | 'close-issue' | 'milestone-later' })
  // reasons and childWhys: the split's reasons and each child's why (childWhys aligned with created);
  // null when the life's design answer can no longer be read
  | (Base & { kind: 'release-parent'; created: number[]; reasons?: SplitReasons | null; childWhys?: string[] | null })
  // rule H4: why the update is due, and when it was asked for (the key's subject)
  | (Base & { kind: 'restart-self'; why: string; at: Ms; windDownAt?: Ms | null })
  // rule M7 for a hand merge: read the merged issue's rollout
  | (Base & { kind: 'rollout'; pr: number | null })
  | (Base & { kind: 'stop-agent'; agentId: string; entry: string })
  | (Base & { kind: WakeKind; wake: string; fields: Record<string, string>; context: string[] })
  | (Base & { kind: 'title'; text: string })
  | V2Action

export type Skip = { rule: string; issue: number | null; why: string }

export type PlanResult = {
  tier: Tier
  overridden: boolean
  actions: Action[]
  skipped: Skip[]
  title: string
  owner: number
  // each rate cap tripped this pass: a bucket (start, spawn, wake) or a per-issue key
  // '<kind>:<issue>' (v2 SPEC 13.11.4)
  capped: string[]
  // a claim was held back by maxInFlightIssues this pass (v2 SPEC 13.4.2)
  atCap: boolean
  // S1: the pass was starved (a ready queue, all of it unclaimable, nothing in flight); null: unknown (a source failed)
  starved?: boolean | null
}
