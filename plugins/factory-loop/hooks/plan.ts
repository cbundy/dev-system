// The factory loop's plan: a pure function from what observe saw to what to do next.
// It encodes the decision table of docs/factory-loop/SPEC.md section 5, rule by rule.
// No I/O and no clock (the time is state.now), and nothing imported but types, so the
// same state and config always give the same actions. Every action already running or
// done is in state.ledger under its key, so planning an unchanged state again yields
// nothing new.
import type {
  Action,
  ActionClass,
  ActionKind,
  AdjudicatorAction,
  AgentType,
  Bump,
  Config,
  GuardFail,
  IssueView,
  LedgerEntry,
  MergeFlag,
  MergeReport,
  Ms,
  Outcome,
  PlanResult,
  Rollout,
  RunView,
  Skip,
  Stage,
  State,
  Tier,
  Usage,
} from './types'

const HOUR = 3_600_000
const BREAKER_MS = 30 * 60_000
// A drain this long tells the owner (rule H4, D-15).
const DRAIN_SLOW_MS = HOUR
// The title's M: issues merged in this window (D-23).
const MERGED_WINDOW_MS = 6 * HOUR
// A hand merge older than this gets no follow-ups (rule M7). callum-flow-factory-state lists a
// final stage for 24 hours, and the bound keeps a merge from ever outliving the ledger's 7-day
// prune of its `rollout:<issue>` entry, so it can never be re-triggered.
const ROLLOUT_WITHIN_MS = 24 * HOUR
const LIVE: readonly Stage[] = ['designing', 'implementing', 'in pipeline', 'parked', 'ready to merge']
const ENDED: readonly Stage[] = ['merged', 'closed without merge']
const MERGEABLE_STATES = ['merge-ready', 'head-mismatch', 'conflict']
const WAKES: readonly ActionKind[] = ['judge', 'task', 'tell']
// Notices where the owner has to act or decide; they go out before any other wake (rule O2).
const OWNER_TELLS = [
  'decision',
  'escalate',
  'review-cap',
  'merge-refused',
  'merge-hold',
  'untrusted-pr',
  'rollout',
  'base',
  'no-ci',
  'ci-triggers',
  'update-behind',
  'linkage',
]
// Actions that write to GitHub (or read it heavily); held while GitHub rate-limits us.
const GITHUB: readonly ActionKind[] = [
  'claim',
  'heartbeat',
  'sweep',
  'guard',
  'update-behind',
  'fix-linkage',
  'merge',
  'rollout',
  'close-issue',
  'release-parent',
  'abandon',
  'milestone-later',
  'milestone-expect',
  'pr-reopen',
  'pr-comment',
]
const ALLOWED: Record<Tier, readonly ActionClass[]> = {
  normal: ['free', 'owner', 'drive', 'develop', 'start'],
  slow: ['free', 'owner', 'drive', 'develop', 'start'],
  'stop-new': ['free', 'owner', 'drive'],
  'stop-all': ['free', 'owner'],
}
// A drain for an update holds every class that starts or drives work (rule H4).
const DRAINED: readonly ActionClass[] = ['start', 'develop', 'drive']
const BUMP_RANK: Record<Bump, number> = { patch: 1, minor: 2, major: 3 }
// Merge report flags that need a release-sequencing call before the merge (rule M5).
const CALL_FLAGS: readonly MergeFlag[] = ['run-it', 'image', 'template']

type Gate = 'go' | 'running' | 'done' | 'wait' | 'exhausted'

type Ctx = {
  state: State
  config: Config
  tier: Tier
  out: Action[]
  skipped: Skip[]
  owner: Set<string>
  exhausted: string[]
  byKey: Map<string, LedgerEntry>
  issues: Map<number, IssueView>
  capped: string[]
  atCap: boolean
}

// tierOf: the usage tier (SPEC rule G3). The higher of the two windows decides; a missing
// reading is Normal (the skill fails open); an owner override keeps Normal below its pct.
export function tierOf(
  usage: Usage,
  config: Config,
  override: State['control']['usageOverride'],
  now: number,
): { tier: Tier; overridden: boolean } {
  if (usage.unavailable || (usage.fiveHour === null && usage.sevenDay === null)) {
    return { tier: 'normal', overridden: false }
  }
  const live = (pct: number | null, resetsAt: number | null) => (resetsAt !== null && now >= resetsAt ? 0 : (pct ?? 0))
  const binding = Math.max(live(usage.fiveHour, usage.fiveHourResetsAt), live(usage.sevenDay, usage.sevenDayResetsAt))
  const base: Tier =
    binding >= config.usageStopAllPct
      ? 'stop-all'
      : binding >= config.usageStopNewPct
        ? 'stop-new'
        : binding >= config.usageSlowPct
          ? 'slow'
          : 'normal'
  if (base !== 'normal' && override !== null && now < override.expiresAt && binding < override.untilPct) {
    return { tier: 'normal', overridden: true }
  }
  return { tier: base, overridden: false }
}

// issueFromBranch: the issue number of a branch named by the convention issue-<N>-...
export function issueFromBranch(branch: string): number | null {
  const m = branch.match(/(?:^|[/_-])issue-(\d+)(?:-|$)/)
  return m ? Number(m[1]) : null
}

// sameLabel: labels are compared without regard to case, so `in development` matches GitHub's
// `In development` (SPEC 4.2).
export function sameLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export function plan(state: State, config: Config): PlanResult {
  const { tier, overridden } = tierOf(state.usage, config, state.control.usageOverride, state.now)
  const byKey = new Map<string, LedgerEntry>()
  for (const entry of [...state.ledger].sort((a, b) => a.startedAt - b.startedAt)) byKey.set(entry.key, entry)
  const ctx: Ctx = {
    state,
    config,
    tier,
    out: [],
    skipped: [],
    owner: new Set(),
    exhausted: [],
    byKey,
    issues: new Map(state.issues.map(issue => [issue.number, issue])),
    capped: [],
    atCap: false,
  }

  const blind = !state.sources.factory.ok
  if (blind) {
    blindPass(ctx)
  } else {
    housekeeping(ctx)
    if (state.sources.runs.ok) {
      const runs = currentRuns(ctx)
      pipelineGates(ctx, runs)
      merges(ctx, runs)
    } else {
      skip(ctx, 'P', null, 'runs source unavailable')
    }
    handMerges(ctx)
    mergeFollowUps(ctx)
    design(ctx)
    redelegate(ctx)
    handoffs(ctx)
    drops(ctx)
    claims(ctx)
    agents(ctx)
    release(ctx)
  }

  const actions = admit(ctx)
  const restart = blind ? null : restartWhenDrained(ctx, actions)
  const title = titleOf(state, config, tier, { owner: ctx.owner.size, blind, capped: ctx.capped, atCap: ctx.atCap })
  if (title !== state.lastTitle) {
    actions.push({ kind: 'title', key: 'title', class: 'free', rule: 'O1', reason: 'status changed', issue: null, text: title })
  }
  // the restart ends the session, so it goes after everything else, the title included
  if (restart !== null) actions.push(restart)
  return { tier, overridden, actions, skipped: ctx.skipped, title, owner: ctx.owner.size, capped: ctx.capped, atCap: ctx.atCap }
}

// --- helpers -------------------------------------------------------------------------

function skip(ctx: Ctx, rule: string, issue: number | null, why: string) {
  ctx.skipped.push({ rule, issue, why })
}

function mine(ctx: Ctx, issue: IssueView) {
  return issue.holder !== null && issue.holder === ctx.state.device
}

function isLive(issue: IssueView | undefined) {
  return issue !== undefined && issue.stage !== null && LIVE.includes(issue.stage)
}

function maxAttempts(config: Config, kind: ActionKind | AgentType) {
  if (kind === 'update-behind') return config.updateBehindRetries + 1
  return config.maxAttempts[kind] ?? 3
}

function attemptsKind(action: Action): ActionKind | AgentType {
  if (action.kind === 'spawn') return action.agent
  if (action.kind === 'delegate') return 'implementer'
  return action.kind
}

// gate: whether the action under this key may run now (SPEC 5.1 "blocked").
function gate(ctx: Ctx, key: string, kind: ActionKind | AgentType): Gate {
  const entry = ctx.byKey.get(key)
  if (entry === undefined) return 'go'
  if (entry.status === 'running') return 'running'
  if (entry.status === 'done') return 'done'
  if (entry.attempts >= maxAttempts(ctx.config, kind)) return 'exhausted'
  if (entry.status === 'lost') return 'go'
  const backoff =
    kind === 'update-behind'
      ? ctx.config.updateBehindRetryMs
      : ctx.config.retryBackoffMs * 2 ** Math.max(0, entry.attempts - 1)
  if (entry.endedAt !== null && ctx.state.now - entry.endedAt < backoff) return 'wait'
  return 'go'
}

// want: emit the action unless its key is blocked. A notice counts toward the title's owner
// items whether or not it goes out this pass, so the count stays while the issue stands. An
// exhausted key is named in the decision log: it is what `/factory retry` clears (D-38).
function want(ctx: Ctx, action: Action): Gate {
  if (action.kind === 'tell' && OWNER_TELLS.includes(action.wake)) ctx.owner.add(action.key)
  const kind = attemptsKind(action)
  const g = gate(ctx, action.key, kind)
  if (g === 'go') ctx.out.push(action)
  if (g === 'exhausted') {
    skip(ctx, action.rule, action.issue, `exhausted: ${action.key}`)
    if (action.kind === 'task') ctx.exhausted.push(action.key)
    else if (WAKES.includes(action.kind)) ctx.owner.add(action.key)
    else ctx.exhausted.push(action.key)
  }
  return g
}

function done(ctx: Ctx, key: string): LedgerEntry | undefined {
  const entry = ctx.byKey.get(key)
  return entry?.status === 'done' ? entry : undefined
}

function outcome<K extends Outcome['kind']>(entry: LedgerEntry | undefined, kind: K) {
  const o = entry?.outcome
  return o !== undefined && o.kind === kind ? (o as Extract<Outcome, { kind: K }>) : undefined
}

function lastDone(ctx: Ctx, kind: ActionKind): LedgerEntry | undefined {
  let last: LedgerEntry | undefined
  for (const entry of ctx.state.ledger) {
    if (entry.kind !== kind || entry.status !== 'done' || entry.endedAt === null) continue
    if (last === undefined || entry.endedAt > (last.endedAt ?? 0)) last = entry
  }
  return last
}

function lastClaimAt(ctx: Ctx, n: number): Ms {
  let at = 0
  for (const entry of ctx.state.ledger) {
    if (entry.kind !== 'claim' || entry.issue !== n || entry.status !== 'done' || entry.endedAt === null) continue
    if (entry.outcome?.kind === 'claim' && entry.outcome.result !== 'claimed') continue
    at = Math.max(at, entry.endedAt)
  }
  return at
}

function resumes(ctx: Ctx, subject: string, after = Number.NEGATIVE_INFINITY) {
  return ctx.state.control.resumed.filter(r => r.subject === subject && r.at > after).length
}

function modelLabel(issue: IssueView | undefined): string | null {
  const labels = (issue?.labels ?? [])
    .map(l => l.toLowerCase())
    .filter(l => l.startsWith('model:'))
    .sort()
  const first = labels[0]
  return first === undefined ? null : first.slice('model:'.length)
}

type DesignResult = { brief: string | null; created: number[]; pendingDecision: boolean }

function designResult(ctx: Ctx, entry: LedgerEntry | undefined, reportKey: string): DesignResult | 'unparsed' | null {
  const o = outcome(entry, 'designer')
  if (o === undefined) return null
  if ('unparsed' in o) {
    const answer = outcome(done(ctx, reportKey), 'wake')
    return answer?.decision === 'parsed' ? fromFields(answer.fields) : 'unparsed'
  }
  return o
}

function fromFields(fields: Record<string, unknown>): DesignResult {
  const created = Array.isArray(fields.created) ? fields.created.filter(n => typeof n === 'number') : []
  return {
    brief: typeof fields.brief === 'string' ? fields.brief : null,
    created,
    pendingDecision: fields.pendingDecision === true,
  }
}

// briefOf: the brief URL for an issue (SPEC 5.1): the designer's, else the posted comment's,
// else the one its delegation logged.
function briefOf(ctx: Ctx, issue: IssueView | undefined): string | null {
  if (issue === undefined) return null
  let best: { at: number; url: string } | undefined
  for (const entry of ctx.state.ledger) {
    if (entry.issue !== issue.number || entry.kind !== 'spawn' || entry.agent !== 'designer') continue
    const result = designResult(ctx, entry.status === 'done' ? entry : undefined, `judge:report:${entry.key}`)
    if (result === null || result === 'unparsed' || result.brief === null) continue
    const at = entry.endedAt ?? 0
    if (best === undefined || at > best.at) best = { at, url: result.brief }
  }
  return best?.url ?? issue.brief?.url ?? issue.delegatedBrief
}

function wake(
  kind: 'judge' | 'task' | 'tell',
  name: string,
  key: string,
  rule: string,
  issue: number | null,
  fields: Record<string, string | number | null>,
  context: string[] = [],
  klass: ActionClass = kind === 'tell' ? 'owner' : 'drive',
): Action {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) if (v !== null) clean[k] = String(v)
  return { kind, wake: name, key, class: klass, rule, reason: `${kind} ${name}`, issue, fields: clean, context }
}

// --- G2: a blind pass ------------------------------------------------------------------

function blindPass(ctx: Ctx) {
  const { state, config } = ctx
  const since = state.sources.factory.at
  skip(ctx, 'G2', null, `factory source unavailable${state.sources.factory.error ? `: ${state.sources.factory.error}` : ''}`)
  if (since === null || state.now - since >= config.blindNoticeAfterMs) {
    want(ctx, wake('tell', 'blind', `tell:blind:${since ?? 0}`, 'G2', null, { since: since ?? 'never' }))
  }
}

// --- H: housekeeping -------------------------------------------------------------------

function housekeeping(ctx: Ctx) {
  const { state, config } = ctx
  const held = state.issues.filter(issue => mine(ctx, issue) && isLive(issue))
  const beat = lastDone(ctx, 'heartbeat')
  if (held.length > 0) {
    // A claim starts its own lease, so each held issue was last renewed by the later of its
    // claim and the last heartbeat. The stalest of those decides.
    const beatAt = beat?.endedAt ?? 0
    const stalest = Math.min(...held.map(issue => Math.max(beatAt, lastClaimAt(ctx, issue.number))))
    const afterLoad = stalest >= state.loadedAt
    if (!afterLoad || state.now - stalest >= config.heartbeatEveryMs) {
      want(ctx, {
        kind: 'heartbeat',
        key: `heartbeat:${beatAt}`,
        class: 'free',
        rule: 'H1',
        reason: afterLoad ? 'lease renewal due' : 'first pass after load',
        issue: null,
      })
    }
  }
  const sweep = lastDone(ctx, 'sweep')
  if (sweep === undefined || state.now - (sweep.endedAt ?? 0) >= config.sweepEveryMs) {
    want(ctx, { kind: 'sweep', key: `sweep:${sweep?.endedAt ?? 0}`, class: 'free', rule: 'H2', reason: 'sweep due', issue: null })
  }
  // H4: a drain that has lasted an hour tells the owner once, with what it still waits on.
  const due = state.control.updateDue
  const holding = due === null ? [] : drainBlockers(ctx)
  if (due !== null && holding.length > 0 && state.now - due.at >= DRAIN_SLOW_MS) {
    want(ctx, wake('tell', 'drain-slow', `tell:drain-slow:${due.at}`, 'H4', null, { since: due.at }, [`update: ${due.reason}`, `waiting on: ${holding.join(', ')}`]))
  }
  if (!state.sources.pool.ok || state.pool === null) return
  for (const slot of [...state.pool.slots].sort((a, b) => a.path.localeCompare(b.path))) {
    if (slot.state === 'available' || slot.busy || slot.dirty !== false || slot.branch === null) continue
    const n = issueFromBranch(slot.branch)
    const issue = n === null ? undefined : ctx.issues.get(n)
    if (issue === undefined || issue.stage === null || !ENDED.includes(issue.stage)) continue
    const agentRunning = state.ledger.some(e => e.status === 'running' && e.issue === n && e.agentId !== undefined)
    if (agentRunning) continue
    want(ctx, {
      kind: 'release-worktree',
      key: `release:${slot.path}:${slot.branch}`,
      class: 'free',
      rule: 'H3',
      reason: `${issue.stage}, slot clean`,
      issue: n,
      path: slot.path,
      branch: slot.branch,
    })
  }
}

// drainBlockers: what keeps the safe state for a restart from holding (rule H4, D-15): any
// running ledger entry (an agent, a wake, a command), and any pipeline run still running or
// pending, of any device, since the workspace's daemon serves them all. Empty: safe.
function drainBlockers(ctx: Ctx): string[] {
  const { state } = ctx
  if (!state.sources.runs.ok) return ['the runs source']
  const entries = state.ledger.filter(e => e.status === 'running').map(e => e.key)
  const runs = state.runs.filter(r => r.state === 'running' || r.state === 'pending').map(r => `run ${r.run} ${r.state}`)
  return [...entries.sort(), ...runs.sort()].slice(0, 6)
}

// H4: once the drain is complete and nothing else is planned, restart for the update.
function restartWhenDrained(ctx: Ctx, kept: Action[]): Action | null {
  const due = ctx.state.control.updateDue
  if (due === null) return null
  const holding = drainBlockers(ctx)
  if (holding.length > 0) {
    skip(ctx, 'H4', null, `update due: draining, waiting on ${holding.join(', ')}`)
    return null
  }
  if (kept.length > 0) {
    skip(ctx, 'H4', null, 'update due: this pass has other actions to finish first')
    return null
  }
  const key = `restart:${due.at}`
  const g = gate(ctx, key, 'restart-self')
  if (g === 'exhausted') skip(ctx, 'H4', null, `exhausted: ${key}`)
  if (g !== 'go') return null
  return { kind: 'restart-self', key, class: 'free', rule: 'H4', reason: 'update due, nothing in flight', issue: null, why: due.reason, at: due.at }
}

// --- the runs the P and M rules act on (SPEC 5.4) ------------------------------------------

function currentRuns(ctx: Ctx): RunView[] {
  const byIssue = new Map<number, RunView[]>()
  for (const run of ctx.state.runs) {
    if (run.issue === null || run.superseded) continue
    const list = byIssue.get(run.issue) ?? []
    list.push(run)
    byIssue.set(run.issue, list)
  }
  const current: RunView[] = []
  for (const [n, list] of [...byIssue.entries()].sort((a, b) => a[0] - b[0])) {
    const issue = ctx.issues.get(n)
    if (issue === undefined || issue.open === false || (issue.stage !== null && ENDED.includes(issue.stage))) continue
    // Another device's run, or one nobody claimed (the owner's own), is not this loop's to drive.
    if (!mine(ctx, issue)) continue
    const known = list.filter(r => r.run !== 'unknown').sort((a, b) => (a.run < b.run ? -1 : a.run > b.run ? 1 : 0))
    const pick = known.length > 0 ? known[known.length - 1] : list.length === 1 ? list[0] : undefined
    if (pick !== undefined) current.push(pick)
  }
  return current
}

// --- P: pipeline gates ----------------------------------------------------------------

// gateOf: one gate of one run. Without a step (the event log has none), the park's time tells
// two parks on one head apart, as when a run parks at review and then at test.
function gateOf(run: RunView): string {
  const gate = run.step ?? (run.state === 'parked' && run.since !== null ? `park@${run.since}` : null)
  return `${run.run}:${gate}:${run.head}`
}

function pipelineGates(ctx: Ctx, runs: RunView[]) {
  const { state, config } = ctx
  for (const run of runs) {
    const n = run.issue as number
    const issue = ctx.issues.get(n)
    const brief = briefOf(ctx, issue)
    const model = modelLabel(issue)

    // A failed run's step is not always known (the event log does not record it); the
    // adjudicator reads the run and finds it.
    if (run.state === 'parked' || (run.state === 'failed' && run.run !== 'unknown')) {
      const resumed = resumes(ctx, `run:${run.run}`)
      const suffix = resumed > 0 ? `:r${resumed}` : ''
      const at = gateOf(run)
      if (run.step === 'review') {
        const rounds = Math.max(run.reviewFixRounds, ledgerReviewFixes(ctx, run.run))
        if (rounds >= config.reviewFixCap + resumed) {
          want(
            ctx,
            wake('tell', 'review-cap', `tell:review-cap:${run.run}:${rounds}`, 'P1', n, { issue: n, run: run.run, rounds, brief }, run.verdicts),
          )
          continue
        }
        if (!state.sources.facts.ok) {
          skip(ctx, 'P2', n, 'event log unavailable: review rounds cannot be counted')
          continue
        }
      }
      const adjKey = `adjudicate:${at}${suffix}`
      const adj = done(ctx, adjKey)
      if (adj === undefined) {
        want(ctx, {
          kind: 'spawn',
          agent: 'adjudicator',
          purpose: 'gate',
          key: adjKey,
          class: 'drive',
          rule: 'P2',
          reason: `${run.state} at ${run.step}`,
          issue: n,
          run: run.run,
          branch: run.branch,
          step: run.step,
          head: run.head,
          pr: run.pr,
          brief,
          model,
          warns: [],
          handoffHead: null,
          verdicts: [],
          guard: [],
        })
        continue
      }
      const verdict = outcome(adj, 'adjudicator')
      if (verdict === undefined) continue
      const action = verdict.action
      if (action.type === 'escalate') {
        want(
          ctx,
          wake('tell', 'escalate', `tell:escalate:${at}${suffix}`, 'P3', n, { issue: n, run: run.run, step: run.step, brief }, [
            action.why,
            ...verdict.verdicts,
          ]),
        )
      } else if (action.type === 'fixer') {
        want(ctx, {
          kind: 'spawn',
          agent: 'fixer',
          purpose: 'gate',
          key: `fixer:gate:${at}${suffix}`,
          class: 'drive',
          rule: 'P3',
          reason: 'adjudicator asked for a fixer',
          issue: n,
          run: run.run,
          branch: run.branch,
          head: run.head,
          pr: run.pr,
          brief,
          model,
          instructions: action.instructions,
        })
      } else if (action.type === 'merge' || action.type === 'hold') {
        // the merge review's answers; the parser rejects them for a gate, so this is a loop bug
        skip(ctx, 'P3', n, `adjudicator: ACTION ${action.type} does not answer a gate`)
      } else {
        respond(ctx, run, action, `respond:${at}:${action.type}${suffix}`)
      }
      continue
    }

    // A failed or cancelled run while the loop's own fixer or re-drive for the issue is at work
    // (or just finished) is that work's doing: its handoff, or the new run, comes next.
    if ((run.state === 'failed' || run.state === 'cancelled') && ownRedrive(ctx, n)) {
      skip(ctx, 'P4', n, 'a fixer or re-drive of the loop is at work on it')
      continue
    }

    if (run.state === 'failed' && run.run === 'unknown') {
      want(ctx, wake('task', 'redrive', `task:redrive:${run.branch}:${run.head}`, 'P4', n, { issue: n, branch: run.branch, head: run.head, cause: 'infrastructure' }))
      continue
    }

    if (run.state === 'cancelled') {
      const key = `judge:cancelled:${run.run}:${run.head}`
      const answer = outcome(done(ctx, key), 'wake')
      if (answer === undefined) {
        want(ctx, wake('judge', 'cancelled', key, 'P5', n, { issue: n, run: run.run, branch: run.branch, head: run.head, brief }))
      } else if (answer.decision === 'redrive') {
        want(ctx, wake('task', 'redrive', `task:redrive:${run.branch}:${run.head}`, 'P5', n, { issue: n, branch: run.branch, head: run.head, cause: 'cancelled' }))
      } else if (answer.decision === 'drop') {
        want(ctx, {
          kind: 'abandon',
          key: `abandon:${n}:${run.run}`,
          class: 'free',
          rule: 'P5',
          reason: 'cancelled run dropped',
          issue: n,
          run: run.run,
          branch: run.branch,
          note: answer.reason ?? 'cancelled run dropped',
        })
      }
      continue
    }

    if (run.state === 'ci-stalled') {
      if (run.detail?.includes('reason=no-workflow')) {
        want(ctx, wake('tell', 'no-ci', `tell:no-ci:${run.run}`, 'P6', n, { issue: n, pr: run.pr }))
      } else if (run.detail?.includes('reason=no-checks') && run.pr !== null) {
        const key = `reopen:${run.pr}:${run.run}`
        const reopened = done(ctx, key)
        if (reopened === undefined) {
          want(ctx, { kind: 'pr-reopen', key, class: 'free', rule: 'P6a', reason: 'no CI checks registered', issue: n, pr: run.pr })
        } else if (state.now - (reopened.endedAt ?? 0) >= config.ciStallRecheckMs) {
          want(ctx, wake('tell', 'ci-triggers', `tell:ci-triggers:${run.run}`, 'P6b', n, { issue: n, pr: run.pr }))
        }
      }
    }
  }
}

const REDRIVE_SETTLE_MS = 30 * 60_000

function ownRedrive(ctx: Ctx, issue: number) {
  return ctx.state.ledger.some(
    e =>
      e.issue === issue &&
      ((e.kind === 'spawn' && e.agent === 'fixer') || (e.kind === 'task' && e.wake === 'redrive')) &&
      (e.status === 'running' || (e.endedAt !== null && ctx.state.now - e.endedAt < REDRIVE_SETTLE_MS)),
  )
}

function ledgerReviewFixes(ctx: Ctx, run: string) {
  const heads = new Set<string>()
  for (const entry of ctx.state.ledger) {
    if (entry.kind !== 'respond' || entry.run !== run || entry.status !== 'done') continue
    const [, , step, head, action] = entry.key.split(':')
    if (step === 'review' && action === 'fix' && head !== undefined) heads.add(head)
  }
  return heads.size
}

// respond, then P3a: a respond that left the gate where it was is tried once more, then the
// model reads the run's log and daemon.log and re-drives or reports (D-37).
function respond(ctx: Ctx, run: RunView, action: AdjAction, key: string) {
  const { state, config } = ctx
  const n = run.issue as number
  const make = (k: string, logReview: boolean): Action => ({
    kind: 'respond',
    key: k,
    class: 'drive',
    rule: k.endsWith(':retry') ? 'P3a' : 'P3',
    reason: `adjudicator: ${action.type}`,
    issue: n,
    run: run.run,
    branch: run.branch,
    step: run.step as string,
    head: run.head as string,
    action: action.type,
    findings: action.type === 'fix' ? action.findings : null,
    instructions: action.type === 'fix' ? action.instructions : null,
    addFinding: action.type === 'fix' ? action.addFinding : null,
    approveReason: action.type === 'approve' ? action.reason : null,
    logReview,
  })
  const first = done(ctx, key)
  if (first === undefined) {
    want(ctx, make(key, action.type === 'fix' && run.step === 'review'))
    return
  }
  if (state.now - (first.endedAt ?? 0) < config.respondSettleMs) return
  const retryKey = `${key}:retry`
  const retry = done(ctx, retryKey)
  if (retry === undefined) {
    want(ctx, make(retryKey, false))
  } else if (state.now - (retry.endedAt ?? 0) >= config.respondSettleMs) {
    want(
      ctx,
      wake('task', 'respond-stuck', `task:respond-stuck:${gateOf(run)}`, 'P3a', n, {
        issue: n,
        run: run.run,
        branch: run.branch,
        step: run.step,
        head: run.head,
      }),
    )
  }
}

type AdjAction = Exclude<AdjudicatorAction, { type: 'escalate' } | { type: 'fixer' } | { type: 'merge' } | { type: 'hold' }>

// --- M: merge -------------------------------------------------------------------------

type FailClass = 'author' | 'rollout' | 'base' | 'gates' | 'state' | 'conflict' | 'behind' | 'linkage' | 'transient' | 'judge'
const FAIL_ORDER: readonly FailClass[] = ['author', 'rollout', 'base', 'gates', 'state', 'conflict', 'behind', 'linkage', 'transient', 'judge']

// classifyFail: a guard FAIL line by its fixed reason prefixes (SPEC 6.2).
export function classifyFail(fail: GuardFail): FailClass {
  const reason = fail.reason
  switch (fail.name) {
    case 'author':
    case 'rollout':
    case 'base':
    case 'gates':
    case 'linkage':
      return fail.name
    case 'mergeable':
      if (reason.startsWith('conflicts with')) return 'conflict'
      if (reason.startsWith('behind ')) return 'behind'
      if (reason.startsWith('GitHub has not computed') || reason.startsWith('branch rules not met')) return 'transient'
      if (/^PR is (merged|closed|a draft)/i.test(reason)) return 'state'
      if (reason.startsWith('cannot read')) return 'transient'
      return 'judge'
    case 'checks': {
      if (reason === 'no checks reported' || reason.startsWith('cannot ')) return 'transient'
      const pairs = reason
        .split(',')
        .map(p => p.trim())
        .filter(p => p.length > 0)
      return pairs.length > 0 && pairs.every(p => p.endsWith('=pending')) ? 'transient' : 'judge'
    }
    default:
      return 'judge'
  }
}

type GuardResult = Extract<Outcome, { kind: 'guard' }>

function merges(ctx: Ctx, runs: RunView[]) {
  const { state, config } = ctx
  for (const run of runs) {
    if (!MERGEABLE_STATES.includes(run.state) || run.pr === null || run.head === null) continue
    const n = run.issue as number
    const pr = run.pr
    const head = run.head
    const guards = state.ledger
      .filter(e => e.kind === 'guard' && e.pr === pr && e.head === head)
      .sort((a, b) => a.startedAt - b.startedAt)
    const latest = guards[guards.length - 1]
    const guardAction = (seq: number): Action => ({
      kind: 'guard',
      key: `guard:${pr}:${head}:${seq}`,
      class: 'free',
      rule: 'M1',
      reason: `${run.state}, no fresh guard`,
      issue: n,
      pr,
      run: run.run,
      head,
    })
    // M1: a fresh guard outcome for this PR and head, or a guard run.
    if (latest === undefined) {
      want(ctx, guardAction(1))
      continue
    }
    if (latest.status === 'running') continue
    if (latest.status !== 'done') {
      want(ctx, { ...guardAction(guards.length), key: latest.key })
      continue
    }
    const result = outcome(latest, 'guard')
    if (result === undefined) continue
    const lastRepair = Math.max(
      0,
      ...state.ledger.filter(e => e.kind === 'fix-linkage' && e.pr === pr && e.status === 'done').map(e => e.endedAt ?? 0),
    )
    const age = state.now - (latest.endedAt ?? 0)
    const transientOnly = result.fails.length > 0 && result.fails.every(f => classifyFail(f) === 'transient')
    if ((latest.endedAt ?? 0) < lastRepair || age >= config.guardTtlMs || (transientOnly && age >= config.guardRecheckMs)) {
      want(ctx, guardAction(guards.length + 1))
      continue
    }
    if (result.fails.length > 0) {
      onGuardFails(ctx, run, result.fails, guards.length)
      continue
    }
    if (result.warns.length > 0 && done(ctx, `pr-comment:${pr}:${head}`) === undefined) {
      weakening(ctx, run, result.warns)
      continue
    }
    mergeReview(ctx, run, result)
  }
}

function onGuardFails(ctx: Ctx, run: RunView, fails: GuardFail[], seq: number) {
  const n = run.issue as number
  const pr = run.pr as number
  const head = run.head as string
  const classes = fails.map(classifyFail)
  if (run.state === 'conflict') classes.push('conflict')
  const top = FAIL_ORDER.find(c => classes.includes(c)) as FailClass
  const lines = fails.map(f => `GUARD ${f.name} FAIL ${f.reason}`)
  const brief = briefOf(ctx, ctx.issues.get(n))
  const model = modelLabel(ctx.issues.get(n))
  const fixer = (purpose: 'conflict' | 'regate' | 'guard', key: string, instructions: string): Action => ({
    kind: 'spawn',
    agent: 'fixer',
    purpose,
    key,
    class: 'drive',
    rule: purpose === 'regate' ? 'M2a' : 'M2',
    reason: `guard: ${purpose}`,
    issue: n,
    run: run.run,
    branch: run.branch,
    head,
    pr,
    brief,
    model,
    instructions,
  })
  switch (top) {
    case 'author':
      want(ctx, wake('tell', 'untrusted-pr', `tell:untrusted-pr:${pr}`, 'M2', n, { issue: n, pr }, lines))
      return
    case 'rollout':
      want(ctx, wake('tell', 'rollout', `tell:rollout:${pr}:${head}`, 'M2', n, { issue: n, pr }, lines))
      return
    case 'base':
      want(ctx, wake('tell', 'base', `tell:base:${pr}:${head}`, 'M2', n, { issue: n, pr }, lines))
      return
    case 'gates':
    case 'state':
    case 'transient':
      skip(ctx, 'M2', n, `guard: waiting (${top})`)
      return
    case 'conflict': {
      const reason = fails.find(f => classifyFail(f) === 'conflict')?.reason ?? 'the PR conflicts with its base'
      want(ctx, fixer('conflict', `fixer:conflict:${pr}:${head}`, `${reason}. Keep both sides of colliding additions.`))
      return
    }
    case 'behind':
      updateBehind(ctx, run, fixer)
      return
    case 'linkage': {
      const key = `fix-linkage:${pr}:${head}`
      if (done(ctx, key) === undefined) {
        want(ctx, { kind: 'fix-linkage', key, class: 'free', rule: 'M2', reason: 'guard: linkage', issue: n, pr })
      } else {
        want(ctx, wake('tell', 'linkage', `tell:linkage:${pr}:${head}`, 'M2', n, { issue: n, pr }, lines))
      }
      return
    }
    case 'judge': {
      const held = ctx.state.ledger.some(
        e =>
          e.kind === 'judge' &&
          e.wake === 'guard-fail' &&
          e.pr === pr &&
          e.head === head &&
          outcome(e.status === 'done' ? e : undefined, 'wake')?.decision === 'hold' &&
          resumes(ctx, `run:${run.run}`, e.endedAt ?? 0) === 0,
      )
      if (held) {
        ctx.owner.add(`hold:guard:${pr}:${head}`)
        return
      }
      const key = `judge:guard-fail:${pr}:${head}:${seq}`
      const answer = outcome(done(ctx, key), 'wake')
      if (answer === undefined) {
        want(ctx, wake('judge', 'guard-fail', key, 'M2', n, { issue: n, pr, run: run.run, head, brief }, lines))
      } else if (answer.decision === 'fixer') {
        want(ctx, fixer('guard', `fixer:guard:${pr}:${head}`, answer.instructions ?? lines.join('\n')))
      }
      return
    }
  }
}

function updateBehind(ctx: Ctx, run: RunView, fixer: (p: 'regate', k: string, i: string) => Action) {
  const n = run.issue as number
  const pr = run.pr as number
  const head = run.head as string
  const key = `update-behind:${pr}:${head}`
  const entry = ctx.byKey.get(key)
  const result = outcome(entry, 'update-behind')
  if (entry?.status === 'done' && result !== undefined) {
    if (result.result === 'fail') want(ctx, fixer('regate', `fixer:regate:${pr}:${head}`, result.line))
    return
  }
  if (gate(ctx, key, 'update-behind') === 'exhausted' && result?.result === 'skip') {
    want(ctx, wake('tell', 'update-behind', `tell:update-behind:${pr}:${head}`, 'M2b', n, { issue: n, pr }, [result.line]))
    return
  }
  want(ctx, { kind: 'update-behind', key, class: 'free', rule: 'M2', reason: 'guard: behind its base', issue: n, pr, run: run.run, head })
}

// weakeningRound: how many times the owner resumed this run after an escalated test-weakening
// review on this PR and head; each resume asks for a fresh review (':r<n>'), as M5a does.
function weakeningRound(ctx: Ctx, pr: number, head: string, run: string): number {
  let round = 0
  while (round <= ctx.state.control.resumed.length) {
    const adj = done(ctx, `adjudicate-weakening:${pr}:${head}${roundSuffix(round)}`)
    const type = outcome(adj, 'adjudicator')?.action.type
    if (adj === undefined || (type !== 'escalate' && type !== 'hold')) break
    if (resumes(ctx, `run:${run}`, adj.endedAt ?? 0) === 0) break
    round += 1
  }
  return round
}

function weakening(ctx: Ctx, run: RunView, warns: string[]) {
  const n = run.issue as number
  const pr = run.pr as number
  const head = run.head as string
  const issue = ctx.issues.get(n)
  const brief = briefOf(ctx, issue)
  const model = modelLabel(issue)
  const sfx = roundSuffix(weakeningRound(ctx, pr, head, run.run))
  const key = `adjudicate-weakening:${pr}:${head}${sfx}`
  const verdict = outcome(done(ctx, key), 'adjudicator')
  if (verdict === undefined) {
    want(ctx, {
      kind: 'spawn',
      agent: 'adjudicator',
      purpose: 'weakening',
      key,
      class: 'drive',
      rule: 'M3',
      reason: 'guard: test-weakening WARN',
      issue: n,
      run: run.run,
      branch: run.branch,
      step: null,
      head,
      pr,
      brief,
      model,
      warns,
      handoffHead: null,
      verdicts: [],
      guard: [],
    })
    return
  }
  const action = verdict.action
  if (action.type === 'approve' || action.type === 'skip') {
    want(ctx, {
      kind: 'pr-comment',
      key: `pr-comment:${pr}:${head}`,
      class: 'free',
      rule: 'M3',
      reason: 'test-weakening justified',
      issue: n,
      pr,
      body: ['Test-weakening warning accepted after adjudication:', '', ...warns, '', ...verdict.verdicts].join('\n'),
    })
  } else if (action.type === 'escalate' || action.type === 'hold') {
    const why = action.type === 'escalate' ? action.why : action.reason
    want(ctx, wake('tell', 'escalate', `tell:escalate:pr:${pr}:${head}${sfx}`, 'M3', n, { issue: n, pr, run: run.run, brief }, [why, ...warns]))
  } else if (action.type === 'merge') {
    skip(ctx, 'M3', n, 'adjudicator: ACTION merge does not answer a test-weakening WARN')
  } else {
    const instructions = action.type === 'fixer' ? action.instructions : (action.instructions ?? warns.join('\n'))
    want(ctx, {
      kind: 'spawn',
      agent: 'fixer',
      purpose: 'weakening',
      key: `fixer:weakening:${pr}:${head}${sfx}`,
      class: 'drive',
      rule: 'M3',
      reason: 'restore weakened tests',
      issue: n,
      run: run.run,
      branch: run.branch,
      head,
      pr,
      brief,
      model,
      instructions,
    })
  }
}

type Review = Extract<Outcome, { kind: 'adjudicator' }>
type FoundReview = { review: Review; head: string; carried: boolean }

function roundSuffix(round: number) {
  return round > 0 ? `:r${round}` : ''
}

// The done entries of one PR and head under a key family, every round: '<base>' and '<base>:r<n>'.
function rounds(ctx: Ctx, base: string): LedgerEntry[] {
  return [...ctx.byKey.values()]
    .filter(e => e.status === 'done' && (e.key === base || e.key.startsWith(`${base}:r`)))
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0) || (a.key < b.key ? -1 : 1))
}

// holdEnd: when a round of the merge review was held (M5a), by the adjudicator's hold or by a
// judge(sequence) that answered hold or ran out (its timeout falls back to hold, SPEC 8.2).
function holdEnd(ctx: Ctx, pr: number, head: string, sfx: string): Ms | null {
  const adj = done(ctx, `adjudicate-merge:${pr}:${head}${sfx}`)
  const type = outcome(adj, 'adjudicator')?.action.type
  if (adj !== undefined && (type === 'hold' || type === 'escalate')) return adj.endedAt ?? 0
  const seqKey = `judge:sequence:${pr}:${head}${sfx}`
  const seq = ctx.byKey.get(seqKey)
  if (seq === undefined) return null
  const held = outcome(done(ctx, seqKey), 'wake')?.decision === 'hold' || gate(ctx, seqKey, 'judge') === 'exhausted'
  return held ? (seq.endedAt ?? 0) : null
}

// mergeRound: how many times the owner resumed this run after a merge hold on this PR and head.
// Each resume asks for a fresh review, whose keys end in ':r<n>' (as P2 does after a resume).
function mergeRound(ctx: Ctx, pr: number, head: string, run: string): number {
  let round = 0
  while (round <= ctx.state.control.resumed.length) {
    const held = holdEnd(ctx, pr, head, roundSuffix(round))
    if (held === null || resumes(ctx, `run:${run}`, held) === 0) break
    round += 1
  }
  return round
}

// mergeAnswer: the merge adjudicator's answer for this head and round, or, on a head's first
// round, the `merge` answer of the head an update-behind rebased from: its patch is proven
// unchanged, so the review carries over (M5).
function mergeAnswer(ctx: Ctx, pr: number, head: string, sfx: string): FoundReview | undefined {
  const own = outcome(done(ctx, `adjudicate-merge:${pr}:${head}${sfx}`), 'adjudicator')
  if (own !== undefined) return { review: own, head, carried: false }
  if (sfx !== '') return undefined
  for (const entry of ctx.state.ledger) {
    const moved = outcome(entry.status === 'done' && entry.pr === pr ? entry : undefined, 'update-behind')
    if (moved?.result !== 'updated' || moved.to !== head || moved.from === null) continue
    const before = rounds(ctx, `adjudicate-merge:${pr}:${moved.from}`)
      .map(e => outcome(e, 'adjudicator'))
      .filter(o => o?.action.type === 'merge')
      .pop()
    if (before !== undefined) return { review: before, head: moved.from, carried: true }
  }
  return undefined
}

// handoffHead: the head the implementer handed off, from the issue's latest delegation.
function handoffHead(ctx: Ctx, n: number): string | null {
  let best: LedgerEntry | undefined
  for (const entry of ctx.state.ledger) {
    if (entry.kind !== 'delegate' || entry.issue !== n || entry.status !== 'done' || outcome(entry, 'handoff') === undefined) continue
    if (best === undefined || (entry.endedAt ?? 0) > (best.endedAt ?? 0)) best = entry
  }
  return outcome(best, 'handoff')?.head ?? null
}

// M4, M5, M5a, M5b: the merge adjudicator reviews the PR from pointers (D-05), then the loop
// merges, asks the model to sequence a flagged merge, holds, or spawns the fixer it asked for.
function mergeReview(ctx: Ctx, run: RunView, guard: GuardResult) {
  const n = run.issue as number
  const pr = run.pr as number
  const head = run.head as string
  const issue = ctx.issues.get(n)
  const brief = briefOf(ctx, issue)
  const model = modelLabel(issue)
  const sfx = roundSuffix(mergeRound(ctx, pr, head, run.run))
  const found = mergeAnswer(ctx, pr, head, sfx)
  if (found === undefined) {
    want(ctx, {
      kind: 'spawn',
      agent: 'adjudicator',
      purpose: 'merge',
      key: `adjudicate-merge:${pr}:${head}${sfx}`,
      class: 'drive',
      rule: 'M4',
      reason: sfx === '' ? 'guard passed: review before merging' : 'owner resumed after a merge hold',
      issue: n,
      run: run.run,
      branch: run.branch,
      step: null,
      head,
      pr,
      brief,
      model,
      warns: [],
      handoffHead: handoffHead(ctx, n),
      verdicts: run.verdicts,
      guard: [...guard.fails.map(f => `GUARD ${f.name} FAIL ${f.reason}`), ...guard.warns],
    })
    return
  }
  const action = found.review.action
  switch (action.type) {
    case 'merge':
      mergeOrSequence(ctx, run, found, sfx)
      return
    case 'hold':
    case 'escalate':
      mergeHold(ctx, run, action.type === 'hold' ? action.reason : action.why, sfx)
      return
    case 'fixer':
      want(ctx, {
        kind: 'spawn',
        agent: 'fixer',
        purpose: 'review',
        key: `fixer:review:${pr}:${head}${sfx}`,
        class: 'drive',
        rule: 'M5b',
        reason: 'merge adjudicator asked for a fixer',
        issue: n,
        run: run.run,
        branch: run.branch,
        head,
        pr,
        brief,
        model,
        instructions: action.instructions,
      })
      return
    default:
      skip(ctx, 'M4', n, `merge adjudicator: ACTION ${action.type} does not answer a merge review`)
  }
}

// M5a: a hold lasts until the head moves or the owner resumes run:<id> after it.
function mergeHold(ctx: Ctx, run: RunView, reason: string, sfx: string) {
  const n = run.issue as number
  const pr = run.pr as number
  const head = run.head as string
  want(ctx, wake('tell', 'merge-hold', `tell:merge-hold:${pr}:${head}${sfx}`, 'M5a', n, { issue: n, pr, run: run.run, head }, [reason]))
}

// runItWaiting: another issue this device merged with a run-it rollout whose Run it is not done
// yet. A second run-it PR waits for it, so two Run its never overlap (M5). The task answered
// `hold` while its release waits on the owner, so only `done`, the issue closing, or the owner
// resuming it ends the wait.
function runItWaiting(ctx: Ctx, n: number): number | null {
  let first: number | null = null
  for (const m of mergedIssues(ctx)) {
    if (m.issue === n || m.rollout !== 'run-it') continue
    const task = done(ctx, `task:run-it:${m.issue}`)
    if (outcome(task, 'wake')?.decision === 'done' || ctx.issues.get(m.issue)?.open === false) continue
    if (task !== undefined && resumes(ctx, `issue:${m.issue}`, task.endedAt ?? 0) > 0) continue
    if (first === null || m.issue < first) first = m.issue
  }
  return first
}

function mergeOrSequence(ctx: Ctx, run: RunView, found: FoundReview, sfx: string) {
  const n = run.issue as number
  const pr = run.pr as number
  const head = run.head as string
  const report = found.review.report
  if (report?.flags.includes('run-it')) {
    const waiting = runItWaiting(ctx, n)
    if (waiting !== null) {
      skip(ctx, 'M5', n, `run-it: waits for the Run it of #${waiting}`)
      return
    }
  }
  if (report !== null && (report.bump === 'major' || report.flags.some(f => CALL_FLAGS.includes(f)))) {
    const key = `judge:sequence:${pr}:${head}${sfx}`
    // a sequencing answer carries over a rebase-only update with the review it followed
    const carried = found.carried
      ? rounds(ctx, `judge:sequence:${pr}:${found.head}`)
          .map(e => outcome(e, 'wake'))
          .filter(o => o?.decision === 'merge')
          .pop()
      : undefined
    const answer = outcome(done(ctx, key), 'wake') ?? carried
    if (answer === undefined) {
      const flags = report.flags.join(',') || 'none'
      want(
        ctx,
        wake('judge', 'sequence', key, 'M5', n, { pr, issue: n, head, flags, bump: report.bump }, [
          `SUMMARY: ${report.summary}`,
          `BUMP: ${report.bump} ${report.bumpReason}`,
          `FLAGS: ${flags}`,
        ]),
      )
      return
    }
    if (answer.decision === 'hold') {
      mergeHold(ctx, run, answer.reason ?? 'held for release sequencing', sfx)
      return
    }
    if (answer.decision !== 'merge') {
      skip(ctx, 'M5', n, `judge(sequence): no such decision ${answer.decision}`)
      return
    }
  }
  const key = `merge:${pr}:${head}`
  const merged = outcome(done(ctx, key), 'merge')
  if (merged?.result === 'refused') {
    want(ctx, wake('tell', 'merge-refused', `tell:merge-refused:${pr}:${head}`, 'M6', n, { issue: n, pr }, [merged.line]))
    return
  }
  want(ctx, {
    kind: 'merge',
    key,
    class: 'free',
    rule: 'M5',
    reason: found.carried ? 'review carried over a rebase-only update' : 'merge adjudicator: merge',
    issue: n,
    pr,
    run: run.run,
    head,
    bump: report?.bump ?? null,
    bumpReason: report?.bumpReason ?? null,
  })
}

type Merged = { issue: number; pr: number | null; key: string; rollout: Rollout | null; closeIssue: number | null }

// mergedIssues: every merge with its rollout: the loop's own merges, and the rollouts read for
// hand merges (D-29).
function mergedIssues(ctx: Ctx): Merged[] {
  const out: Merged[] = []
  for (const entry of ctx.byKey.values()) {
    if (entry.status !== 'done' || entry.issue === null) continue
    const merge = outcome(entry, 'merge')
    const roll = outcome(entry, 'rollout')
    if (merge?.result === 'merged') {
      out.push({ issue: entry.issue, pr: entry.pr, key: entry.key, rollout: merge.rollout, closeIssue: merge.closeIssue })
    } else if (roll !== undefined) {
      const pr = entry.pr ?? ctx.issues.get(entry.issue)?.pr ?? null
      out.push({ issue: entry.issue, pr, key: entry.key, rollout: roll.rollout, closeIssue: roll.closeIssue })
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

// latestReport: the report of the last merge answer for a PR, whatever its head (a rebase-only
// update moves the head after the review).
function latestReport(ctx: Ctx, pr: number): MergeReport | null {
  let best: { at: number; report: MergeReport } | undefined
  for (const entry of ctx.byKey.values()) {
    if (entry.status !== 'done' || !entry.key.startsWith(`adjudicate-merge:${pr}:`)) continue
    const review = outcome(entry, 'adjudicator')
    if (review?.action.type !== 'merge' || review.report === null) continue
    const at = entry.endedAt ?? 0
    if (best === undefined || at >= best.at) best = { at, report: review.report }
  }
  return best?.report ?? null
}

// M7 for a hand merge: an issue this device held reached merged with no merge of the loop's
// own, so its rollout is read the way the merge executor would have (D-29).
function handMerges(ctx: Ctx) {
  const { state } = ctx
  for (const issue of [...state.issues].sort((a, b) => a.number - b.number)) {
    if (!mine(ctx, issue) || issue.stage !== 'merged' || issue.stageSince === null) continue
    if (state.now - issue.stageSince > ROLLOUT_WITHIN_MS) continue
    const n = issue.number
    const ownMerge = state.ledger.some(
      e => e.kind === 'merge' && e.issue === n && (e.status === 'running' || outcome(e.status === 'done' ? e : undefined, 'merge')?.result === 'merged'),
    )
    if (ownMerge) continue
    want(ctx, { kind: 'rollout', key: `rollout:${n}`, class: 'free', rule: 'M7', reason: 'merged by hand: read its rollout', issue: n, pr: issue.pr })
  }
}

// M7: what a merge leaves to do, by the merged issue's rollout, from a merge or a rollout outcome.
function mergeFollowUps(ctx: Ctx) {
  const { state } = ctx
  const milestoneKnown = state.sources.milestone.ok
  for (const m of mergedIssues(ctx)) {
    const n = m.issue
    const free = (kind: 'close-issue' | 'milestone-later', key: string, issue: number, reason: string): Action => ({
      kind,
      key,
      class: 'free',
      rule: 'M7',
      reason,
      issue,
    })
    if (m.rollout === 'merge' && m.closeIssue !== null) {
      want(ctx, free('close-issue', `close:${m.closeIssue}`, m.closeIssue, 'epic base: close by hand'))
    }
    if ((m.rollout === 'run-it' || m.rollout === 'keep-open') && milestoneKnown && state.milestone !== null) {
      want(ctx, free('milestone-later', `milestone-later:${n}`, n, `${m.rollout} leaves the issue open`))
    }
    if (m.rollout === 'run-it') {
      want(ctx, wake('task', 'run-it', `task:run-it:${n}`, 'M7', n, { issue: n, pr: m.pr }))
    }
    const report = m.pr === null ? null : latestReport(ctx, m.pr)
    if (report !== null && milestoneKnown && state.milestone !== null) {
      const expected = state.milestone.expected
      if (expected === null || BUMP_RANK[report.bump] > BUMP_RANK[expected]) {
        want(ctx, {
          kind: 'milestone-expect',
          key: `expect:${report.bump}:${m.pr}`,
          class: 'free',
          rule: 'M7',
          reason: `merge report: ${report.bump}`,
          issue: n,
          bump: report.bump,
          why: report.bumpReason || `#${n}`,
        })
      }
    }
  }
}

// --- D: design and delegation ------------------------------------------------------------

function design(ctx: Ctx) {
  for (const issue of [...ctx.state.issues].sort((a, b) => a.number - b.number)) {
    if (!mine(ctx, issue) || issue.stage !== 'designing') continue
    const n = issue.number
    const life = issue.stageSince ?? 0
    const resumed = resumes(ctx, `issue:${n}`, life)
    const key = resumed > 0 ? `design:${n}:${life}:r${resumed}` : `design:${n}:${life}`
    const entry = ctx.byKey.get(key)
    const reportKey = `judge:report:${key}`
    let result = designResult(ctx, entry?.status === 'done' ? entry : undefined, reportKey)

    if (result === 'unparsed') {
      want(ctx, wake('judge', 'report', reportKey, 'D3', n, { issue: n, agent: 'designer', entry: key }))
      continue
    }
    if (result === null && entry === undefined && resumed === 0 && issue.brief !== null && issue.brief.at >= life) {
      // A brief this life with no designer record (the loop restarted while it ran).
      const briefKey = `judge:report:brief:${n}:${issue.brief.url}`
      const answer = outcome(done(ctx, briefKey), 'wake')
      if (answer === undefined) {
        want(ctx, wake('judge', 'report', briefKey, 'D3', n, { issue: n, agent: 'designer', brief: issue.brief.url }))
        continue
      }
      result = answer.decision === 'parsed' ? fromFields(answer.fields) : null
      if (result === null) continue
    }
    if (result === null) {
      const notes = ctx.state.control.notes.filter(note => note.issue === n || note.issue === null).map(note => note.text)
      want(ctx, {
        kind: 'spawn',
        agent: 'designer',
        key,
        class: 'develop',
        rule: 'D2',
        reason: resumed > 0 ? 'owner resumed' : 'claimed, no brief',
        issue: n,
        model: modelLabel(issue),
        notes,
      })
      continue
    }
    if (result.pendingDecision) {
      want(ctx, wake('tell', 'decision', `tell:decision:${n}:${result.brief ?? 'none'}`, 'D3', n, { issue: n, brief: result.brief }))
      continue
    }
    if (result.created.length > 0) {
      want(ctx, {
        kind: 'release-parent',
        key: `release-parent:${n}`,
        class: 'free',
        rule: 'D3',
        reason: `split into ${result.created.join(',')}`,
        issue: n,
        created: result.created,
      })
      continue
    }
    if (result.brief !== null) {
      want(ctx, { kind: 'delegate', key: `delegate:${n}:${result.brief}`, class: 'develop', rule: 'D4', reason: 'brief ready', issue: n, brief: result.brief })
    }
  }
}

// D4 again for an implementing issue: its implementer failed, timed out or was lost before
// any run started, so the same delegation is retried while attempts remain.
function redelegate(ctx: Ctx) {
  for (const issue of [...ctx.state.issues].sort((a, b) => a.number - b.number)) {
    if (!mine(ctx, issue) || issue.stage !== 'implementing' || issue.run !== null) continue
    if (ctx.state.runs.some(r => r.issue === issue.number && !r.superseded)) continue
    const entries = ctx.state.ledger
      .filter(e => e.kind === 'delegate' && e.issue === issue.number)
      .sort((a, b) => a.startedAt - b.startedAt)
    const last = entries[entries.length - 1]
    if (last === undefined || last.status === 'done' || last.status === 'running') continue
    const brief = last.key.slice(`delegate:${issue.number}:`.length)
    want(ctx, { kind: 'delegate', key: last.key, class: 'develop', rule: 'D4', reason: `implementer ${last.status}, no run`, issue: issue.number, brief })
  }
}

// D5: a handoff that says its commit was not gated goes to the model.
function handoffs(ctx: Ctx) {
  const entries = ctx.state.ledger
    .filter(e => e.status === 'done' && (e.kind === 'delegate' || (e.kind === 'spawn' && e.agent === 'fixer')))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  for (const entry of entries) {
    const handoff = outcome(entry, 'handoff')
    if (handoff === undefined || !handoff.notGated || entry.issue === null) continue
    if (!isLive(ctx.issues.get(entry.issue))) continue
    const key = `judge:handoff:${entry.key}`
    const answer = outcome(done(ctx, key), 'wake')
    if (answer === undefined) {
      want(ctx, wake('judge', 'handoff', key, 'D5', entry.issue, { issue: entry.issue, entry: entry.key, run: handoff.run, head: handoff.head }))
    } else if (answer.decision === 'fixer') {
      const issue = ctx.issues.get(entry.issue)
      want(ctx, {
        kind: 'spawn',
        agent: 'fixer',
        purpose: 'handoff',
        key: `fixer:handoff:${entry.key}`,
        class: 'drive',
        rule: 'D5',
        reason: 'commit not gated',
        issue: entry.issue,
        run: handoff.run,
        branch: handoff.newBranch ?? '',
        head: handoff.head,
        pr: issue?.pr ?? null,
        brief: briefOf(ctx, issue),
        model: modelLabel(issue),
        instructions: answer.instructions ?? '',
      })
    }
  }
}

// D6: issues the owner dropped are abandoned.
function drops(ctx: Ctx) {
  for (const drop of [...ctx.state.control.dropped].sort((a, b) => a.issue - b.issue || a.at - b.at)) {
    const issue = ctx.issues.get(drop.issue)
    if (issue?.stage === 'closed without merge') continue
    const run = ctx.state.runs.find(r => r.issue === drop.issue && r.run === issue?.run)
    want(ctx, {
      kind: 'abandon',
      key: `abandon:${drop.issue}:${drop.at}`,
      class: 'free',
      rule: 'D6',
      reason: 'owner dropped it',
      issue: drop.issue,
      run: issue?.run ?? null,
      branch: run?.branch ?? null,
      note: 'dropped by the owner',
    })
  }
}

// onlyIssues: control.only with each tracker in it standing for its open sub-issues, ascending
// (D-35). A tracker whose sub-issues are not read yet stands for nothing this pass.
function onlyIssues(ctx: Ctx): number[] {
  const out: number[] = []
  const add = (n: number) => {
    if (!out.includes(n)) out.push(n)
  }
  for (const n of ctx.state.control.only) {
    const issue = ctx.issues.get(n)
    const tracker = issue !== undefined && ((issue.subIssues ?? 0) > 0 || issue.epic === true)
    if (!tracker) add(n)
    else if (issue.subIssueList === null) skip(ctx, 'D1', n, 'owner: only names this tracker, whose sub-issues are not read yet')
    else issue.subIssueList.forEach(add)
  }
  return out
}

// D1: claim queue candidates, in priority order, as far as tier and capacity allow.
function claims(ctx: Ctx) {
  const { state, config, tier } = ctx
  for (const source of ['queue', 'github', 'pool'] as const) {
    if (!state.sources[source].ok) {
      skip(ctx, 'D1', null, `${source} source unavailable`)
      return
    }
  }
  if (state.pool === null) return
  const control = state.control
  // `only` names the issues that may be claimed, in its order; `priority` orders the rest.
  const only = onlyIssues(ctx)
  for (const n of only) {
    const stage = ctx.issues.get(n)?.stage ?? null
    if (!state.queue.includes(n) && (stage === null || stage === 'queued')) skip(ctx, 'D1', n, 'owner: only names it, but it is not in the ready queue')
  }
  const listed = (control.only.length > 0 ? only : control.priority).filter(n => state.queue.includes(n))
  const order = [...listed, ...[...state.queue].filter(n => !listed.includes(n)).sort((a, b) => a - b)]
  const myLive = state.issues.filter(issue => mine(ctx, issue) && isLive(issue)).length
  // An issue in design takes a worktree as soon as its implementer starts.
  const myDesigning = state.issues.filter(issue => mine(ctx, issue) && issue.stage === 'designing').length
  const lastClaim = Math.max(0, ...state.ledger.filter(e => e.kind === 'claim').map(e => e.startedAt))
  const mergeWork = ctx.out.some(a => a.rule.startsWith('M'))
  const cap = config.maxInFlightIssues
  let started = 0
  for (const n of order) {
    const issue = ctx.issues.get(n)
    const why = candidateProblem(ctx, issue, n)
    if (why !== null) {
      skip(ctx, 'D1', n, why)
      continue
    }
    let limit: string | null = null
    if (control.noNewWork) limit = 'owner: no new work'
    else if (control.only.length > 0 && !only.includes(n)) limit = `owner: only ${control.only.map(o => `#${o}`).join(' ')}`
    else if (tier === 'stop-new' || tier === 'stop-all') limit = `tier ${tier}`
    else if (state.pool.free - myDesigning - started <= config.worktreeReserve) limit = 'no free worktree'
    else if (cap !== null && myLive + started >= cap) limit = `in-flight cap: ${myLive + started} of ${cap}`
    else if (control.serial && myLive + started > 0) limit = 'owner: one at a time'
    else if (tier === 'slow' && started > 0) limit = 'slow: one claim per pass'
    else if (tier === 'slow' && mergeWork) limit = 'slow: merging first'
    else if (tier === 'slow' && lastClaim > 0 && state.now - lastClaim < config.slowGapMs) limit = 'slow: too soon after the last claim'
    else if (started >= config.maxStartsPerPass) limit = 'claims per pass'
    if (limit !== null) {
      if (limit.startsWith('in-flight cap')) ctx.atCap = true
      skip(ctx, 'D1', n, limit)
      continue
    }
    const key = `claim:${n}:${issue?.stageSince ?? 'new'}`
    const prior = outcome(done(ctx, key), 'claim')
    if (prior?.result === 'lost') {
      skip(ctx, 'D1', n, 'another device holds it')
      continue
    }
    const g = want(ctx, { kind: 'claim', key, class: 'start', rule: 'D1', reason: 'ready and unblocked', issue: n })
    if (g === 'go') started += 1
  }
  // The in-flight cap held a claim back: the owner hears once each time it is reached, which a
  // new claim starts over (SPEC 4.2). A notice only, not an owner item.
  if (ctx.atCap && cap !== null) {
    const since = lastDone(ctx, 'claim')?.endedAt ?? 0
    want(ctx, wake('tell', 'at-cap', `tell:at-cap:${since}`, 'D1', null, { live: myLive, cap }))
  }
}

function candidateProblem(ctx: Ctx, issue: IssueView | undefined, n: number): string | null {
  const { config, state } = ctx
  if (issue === undefined) return 'not observed'
  if (issue.open !== true) return issue.open === false ? 'closed' : 'GitHub state unknown'
  if (issue.trusted !== true) return issue.trusted === false ? 'untrusted author' : 'author unknown'
  if (issue.labels === null) return 'labels unknown'
  if (!issue.labels.some(l => sameLabel(l, config.readyLabel))) return `no ${config.readyLabel} label`
  const skipLabel = issue.labels.find(l => config.skipLabels.some(s => sameLabel(s, l)))
  if (skipLabel !== undefined) return `label ${skipLabel}`
  if (issue.blockedBy === null) return 'blockers unknown'
  if (issue.blockedBy > 0) return `blocked by ${issue.blockedBy} open issue${issue.blockedBy > 1 ? 's' : ''}`
  if (issue.subIssues === null) return 'sub-issues unknown'
  if (issue.subIssues > 0) return 'tracker (has sub-issues)'
  if (issue.epic === true) return 'tracker (title)'
  if (issue.stage !== null && issue.stage !== 'queued') return `stage ${issue.stage}`
  if (state.control.skip.includes(n)) return 'owner: skip'
  if (state.control.paused.includes(n)) return 'owner: paused'
  if (state.control.dropped.some(d => d.issue === n)) return 'owner: dropped'
  return null
}

// --- A: agents ------------------------------------------------------------------------

function agents(ctx: Ctx) {
  const { state, config } = ctx
  const running = state.ledger
    .filter(e => e.status === 'running' && e.agentId !== undefined && (e.kind === 'spawn' || e.kind === 'delegate'))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  for (const entry of running) {
    const agentId = entry.agentId as string
    const agent: AgentType = entry.kind === 'delegate' ? 'implementer' : (entry.agent ?? 'fixer')
    const stop = (reason: string): Action => ({
      kind: 'stop-agent',
      key: `stop:${agentId}`,
      class: 'free',
      rule: reason === 'timed out' ? 'A1' : 'A2',
      reason,
      issue: entry.issue,
      agentId,
      entry: entry.key,
    })
    if (state.now - entry.startedAt > config.agentTimeoutMs[agent]) {
      want(ctx, stop('timed out'))
      continue
    }
    if (entry.issue === null) continue
    const issue = ctx.issues.get(entry.issue)
    if (issue === undefined || state.control.paused.includes(entry.issue)) continue
    if (issue.open === false || (issue.stage !== null && ENDED.includes(issue.stage))) {
      want(ctx, stop(`issue ${issue.open === false ? 'closed' : issue.stage}`))
    } else if (issue.holder !== null && issue.holder !== state.device && isLive(issue)) {
      want(ctx, stop(`claimed by ${issue.holder}`))
      want(ctx, wake('tell', 'claim-lost', `tell:claim-lost:${entry.issue}:${issue.holder}`, 'A2', entry.issue, { issue: entry.issue, holder: issue.holder }))
    } else if (state.control.dropped.some(d => d.issue === entry.issue)) {
      want(ctx, stop('owner dropped it'))
    } else if (agent === 'implementer' && splitAfter(ctx, entry.issue, entry.startedAt)) {
      want(ctx, stop('issue split while implementing'))
      want(ctx, wake('tell', 'stopped', `tell:stopped:${agentId}`, 'A2', entry.issue, { issue: entry.issue, why: 'split' }))
    }
  }
  for (const key of ctx.exhausted) {
    const entry = ctx.byKey.get(key)
    const name = entry?.kind === 'task' ? 'task-timeout' : 'agent-failed'
    want(ctx, wake('tell', name, `tell:${name}:${key}`, 'A1', entry?.issue ?? null, { key, kind: entry?.kind ?? null }))
  }
}

function splitAfter(ctx: Ctx, issue: number, since: number) {
  return ctx.state.ledger.some(e => {
    if (e.issue !== issue || e.kind !== 'spawn' || e.agent !== 'designer' || (e.endedAt ?? 0) < since) return false
    const result = designResult(ctx, e.status === 'done' ? e : undefined, `judge:report:${e.key}`)
    return result !== null && result !== 'unparsed' && result.created.length > 0
  })
}

// --- O3: the release ---------------------------------------------------------------------

function release(ctx: Ctx) {
  const { state } = ctx
  const m = state.milestone
  if (!state.sources.milestone.ok || m === null || m.open > 0 || m.closed === 0) return
  want(ctx, wake('task', 'release', `task:release:${m.closed}:${m.expected ?? 'none'}`, 'O3', null, { closed: m.closed, expected: m.expected }))
}

// --- admitting actions: control, drain, tier, GitHub backoff, breakers, caps, one wake -------

// Rate-cap buckets per rolling hour; merges have none (D-24).
type Bucket = 'start' | 'spawn' | 'wake'

function bucketOf(kind: ActionKind, klass: ActionClass): Bucket | null {
  if (klass === 'start') return 'start'
  if (kind === 'spawn' || kind === 'delegate') return 'spawn'
  if (WAKES.includes(kind)) return 'wake'
  return null
}

function breakerOpen(ctx: Ctx, kind: ActionKind): number | null {
  const ended = ctx.state.ledger
    .filter(e => e.kind === kind && e.endedAt !== null && e.status !== 'running')
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
  const last3 = ended.slice(-3)
  const newest = last3[last3.length - 1]
  if (last3.length < 3 || newest === undefined || !last3.every(e => e.status === 'failed')) return null
  const at = newest.endedAt ?? 0
  return ctx.state.now - at < BREAKER_MS ? at : null
}

function admit(ctx: Ctx): Action[] {
  const { state, config, tier } = ctx
  const control = state.control
  const hourAgo = state.now - HOUR
  const recent = state.ledger.filter(e => e.startedAt > hourAgo)
  const counts: Record<Bucket, number> = { start: 0, spawn: 0, wake: 0 }
  const perIssueKind = new Map<string, number>()
  for (const entry of recent) {
    const bucket = bucketOf(entry.kind, entry.class)
    if (bucket !== null) counts[bucket] += 1
    if (entry.issue !== null && bucket !== null) {
      const k = `${entry.kind}:${entry.issue}`
      perIssueKind.set(k, (perIssueKind.get(k) ?? 0) + 1)
    }
  }
  const caps: Record<Bucket, number> = config.rateCaps
  const tripped = new Set<string>()
  const breakers = new Map<ActionKind, number>()
  const backoff = state.githubBackoffUntil !== null && state.now < state.githubBackoffUntil
  const kept: Action[] = []
  for (const action of ctx.out) {
    const issue = action.issue
    if (issue !== null && control.paused.includes(issue) && action.kind !== 'heartbeat') {
      skip(ctx, action.rule, issue, `owner: paused (${action.kind})`)
      continue
    }
    if (
      issue !== null &&
      control.dropped.some(d => d.issue === issue) &&
      !['abandon', 'stop-agent', 'tell'].includes(action.kind)
    ) {
      skip(ctx, action.rule, issue, `owner: dropped (${action.kind})`)
      continue
    }
    if (control.noNewWork && (action.class === 'start' || action.class === 'develop')) {
      skip(ctx, action.rule, issue, `owner: no new work (${action.kind})`)
      continue
    }
    if (control.updateDue !== null && DRAINED.includes(action.class)) {
      skip(ctx, action.rule, issue, `update due: draining (${action.kind})`)
      continue
    }
    if (!ALLOWED[tier].includes(action.class)) {
      skip(ctx, action.rule, issue, `tier ${tier} (${action.kind})`)
      continue
    }
    if (backoff && GITHUB.includes(action.kind)) {
      skip(ctx, action.rule, issue, `GitHub rate limit (${action.kind})`)
      continue
    }
    const breaker = breakerOpen(ctx, action.kind)
    if (breaker !== null) {
      breakers.set(action.kind, breaker)
      skip(ctx, action.rule, issue, `breaker open (${action.kind})`)
      continue
    }
    const bucket = bucketOf(action.kind, action.class)
    if (bucket !== null && counts[bucket] >= caps[bucket]) {
      tripped.add(bucket)
      skip(ctx, action.rule, issue, `rate cap: ${bucket} ${counts[bucket]}/${caps[bucket]}`)
      continue
    }
    if (issue !== null && bucket !== null) {
      const k = `${action.kind}:${issue}`
      const n = perIssueKind.get(k) ?? 0
      if (n >= config.rateCaps.perIssueKind) {
        tripped.add(k)
        skip(ctx, action.rule, issue, `rate cap: ${action.kind} on #${issue} ${n}/${config.rateCaps.perIssueKind}`)
        continue
      }
      perIssueKind.set(k, n + 1)
    }
    if (bucket !== null) counts[bucket] += 1
    kept.push(action)
  }
  ctx.capped = [...tripped].sort()
  const hour = Math.floor(state.now / HOUR)
  for (const bucket of ctx.capped) {
    const notice = wake('tell', 'runaway', `tell:runaway:${bucket}:${hour}`, 'O2', null, { cap: bucket })
    if (gate(ctx, notice.key, 'tell') === 'go') kept.push(notice)
  }
  for (const [kind, at] of [...breakers.entries()].sort()) {
    const notice = wake('tell', 'breaker', `tell:breaker:${kind}:${at}`, 'O2', null, { kind })
    if (gate(ctx, notice.key, 'tell') === 'go') kept.push(notice)
  }
  return oneWake(ctx, kept)
}

// O2: at most one wake per pass, none while one is open; owner notices first.
function oneWake(ctx: Ctx, actions: Action[]): Action[] {
  const open = ctx.state.ledger.some(e => WAKES.includes(e.kind) && e.status === 'running')
  const rank = (a: Action) => {
    if (a.kind === 'tell') return OWNER_TELLS.includes(a.wake) ? 0 : 3
    return a.kind === 'judge' ? 1 : 2
  }
  let chosen: Action | undefined
  for (const action of actions) {
    if (!WAKES.includes(action.kind)) continue
    if (chosen === undefined || rank(action) < rank(chosen)) chosen = action
  }
  return actions.filter(action => {
    if (!WAKES.includes(action.kind)) return true
    if (!open && action === chosen) return true
    skip(ctx, action.rule, action.issue, open ? 'a wake is open' : 'one wake per pass')
    return false
  })
}

// --- O1: the title (SPEC 9.1, D-23) --------------------------------------------------------

export type TitleNotes = { owner: number; blind: boolean; capped: string[]; atCap: boolean }

// titleOf: the repo's short name and three counts, Q (the queue), D (designing through ready
// to merge) and M (merged in the last 6 hours), then a word for each thing that needs
// attention. No usage numbers: a usage tier shows only when it holds work.
export function titleOf(state: State, config: Config, tier: Tier, notes: TitleNotes): string {
  const name = state.repo.split('/')[1] ?? state.repo
  const live = state.issues.filter(i => isLive(i)).length
  const merged = state.issues.filter(i => i.stage === 'merged' && i.stageSince !== null && state.now - i.stageSince <= MERGED_WINDOW_MS).length
  // a blind pass has no counts to trust: `blind` takes their place
  const head = notes.blind ? `🔄 ${name}` : `🔄 ${name} (Q:${state.queue.length} - D:${live} - M:${merged})`
  const words: string[] = []
  if (config.mode !== 'act') words.push('observe')
  if (notes.blind) words.push('blind')
  if (tier === 'stop-new') words.push('stop new')
  if (tier === 'stop-all') words.push('stop all')
  if (!notes.blind) {
    const stuck = state.issues.filter(i => i.stuck !== null && isLive(i)).length
    if (stuck > 0) words.push(`stuck ${stuck}`)
  }
  if (notes.atCap) words.push('at cap')
  for (const c of notes.capped) words.push(`capped ${c}`)
  if (state.githubBackoffUntil !== null && state.now < state.githubBackoffUntil) words.push('gh wait')
  if (notes.owner > 0) words.push(`owner ${notes.owner}`)
  return [head, ...words].join(' · ')
}
