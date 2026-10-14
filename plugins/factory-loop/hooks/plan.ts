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
  AgentView,
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
// A failure the guard-fail judge answered `wait` (or `fixer`, its fixer ended) is asked about
// again after this, if it still stands unchanged (#550): the slow reminder.
const JUDGE_REMIND_MS = 30 * 60_000
// The title's M: issues merged in this window (D-23).
const MERGED_WINDOW_MS = 6 * HOUR
// An agent still listed at work this long after its answer was recorded did not end its turn:
// the list marks one that did completed within seconds (answeredLive).
const ANSWERED_GRACE_MS = 60_000
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
  'checkout',
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
  'pr-close',
]
// What waits while the main checkout is off its default branch (rule G5, #544): each starts work
// in it or reads its code (a claim leads to a designer; agents begin in it; a task is the model
// working from it). Free commands read only the object store and remote refs, so they go on (a
// fast-forward moves pool worktrees only, #551, and rule H5 moves this checkout only while it is
// clean on its default branch, #555).
const CHECKOUT_HELD: readonly ActionKind[] = ['claim', 'spawn', 'delegate', 'task']
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
  // the last action each issue wanted that did not go out, and why: what a PR waits for (#550)
  gated: Map<number, { key: string; gate: Gate; rule: string }>
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

// guardSeq: the number a guard key ends with (guard:<pr>:<head>:<n>). The next guard of a PR and
// head is one past the highest: a re-check that matched the guard before it replaced that entry
// (ledger.ts foldRecheck), so the count of entries is no key.
export function guardSeq(key: string): number {
  const n = Number(key.slice(key.lastIndexOf(':') + 1))
  return Number.isInteger(n) && n > 0 ? n : 0
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
    gated: new Map(),
  }

  const blind = !state.sources.factory.ok
  if (blind) {
    blindPass(ctx)
  } else {
    checkout(ctx)
    updateCheckout(ctx)
    housekeeping(ctx)
    if (state.sources.runs.ok) {
      const runs = currentRuns(ctx)
      pipelineGates(ctx, runs)
      merges(ctx, runs)
      supersededPrs(ctx)
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
  // once per owner resume, whatever the config says (#537)
  if (kind === 'env-retry') return 1
  return config.maxAttempts[kind] ?? 3
}

function attemptsKind(action: Action): ActionKind | AgentType {
  if (action.kind === 'spawn') return action.agent
  if (action.kind === 'delegate') return 'implementer'
  return action.kind
}

// cadenceOf: the interval of a kind that runs on a cadence. Heartbeat, sweep and update-checkout
// retry at their next due time (SPEC 6.1), so they are never used up: past their attempts they
// wait at most one interval between tries, and the owner hears once (agent-failed). null: any
// other kind.
function cadenceOf(config: Config, kind: ActionKind | AgentType): Ms | null {
  if (kind === 'heartbeat') return config.heartbeatEveryMs
  if (kind === 'sweep') return config.sweepEveryMs
  if (kind === 'update-checkout') return config.checkoutEveryMs
  return null
}

// gate: whether the action under this key may run now (SPEC 5.1 "blocked").
function gate(ctx: Ctx, key: string, kind: ActionKind | AgentType): Gate {
  const entry = ctx.byKey.get(key)
  if (entry === undefined) return 'go'
  if (entry.status === 'running') return 'running'
  if (entry.status === 'done') return 'done'
  // an agent that failed, timed out (a stop that did not take, SPEC 13) or was lost is retried
  // only once the agent list shows it ended, so two never work one key (SPEC A1, 10.4)
  if (entry.agentId !== undefined && agentLive(ctx, entry.agentId)) return 'running'
  const cadence = cadenceOf(ctx.config, kind)
  if (cadence === null && entry.attempts >= maxAttempts(ctx.config, kind)) return 'exhausted'
  if (entry.status === 'lost') return 'go'
  const doubled = ctx.config.retryBackoffMs * 2 ** Math.max(0, entry.attempts - 1)
  const backoff = kind === 'update-behind' ? ctx.config.updateBehindRetryMs : cadence === null ? doubled : Math.min(doubled, cadence)
  if (entry.endedAt !== null && ctx.state.now - entry.endedAt < backoff) return 'wait'
  return 'go'
}

// want: emit the action unless its key is blocked. A notice counts toward the title's owner
// items whether or not it goes out this pass, so the count stays while the issue stands. An
// exhausted key is named in the decision log: it is what `/factory retry` clears (D-38). A
// cadenced kind that failed its attempts in a row tells the owner once, and keeps trying.
function want(ctx: Ctx, action: Action): Gate {
  if (action.kind === 'tell' && OWNER_TELLS.includes(action.wake)) ctx.owner.add(action.key)
  const kind = attemptsKind(action)
  const g = gate(ctx, action.key, kind)
  if (g === 'go') ctx.out.push(action)
  else if (action.issue !== null) ctx.gated.set(action.issue, { key: action.key, gate: g, rule: action.rule })
  const entry = ctx.byKey.get(action.key)
  if (g === 'running' && entry !== undefined && entry.status !== 'running') {
    skip(ctx, action.rule, action.issue, `${action.key}: its agent ${entry.agentId} still runs`)
  }
  if (g === 'exhausted') {
    skip(ctx, action.rule, action.issue, `exhausted: ${action.key}`)
    if (action.kind === 'task') ctx.exhausted.push(action.key)
    else if (WAKES.includes(action.kind)) ctx.owner.add(action.key)
    // env-retry tells the owner itself (envRetry): only a resume reruns it, never a retry
    else if (action.kind !== 'env-retry') ctx.exhausted.push(action.key)
  } else if (cadenceOf(ctx.config, kind) !== null) {
    if (entry !== undefined && entry.status !== 'running' && entry.status !== 'done' && entry.attempts >= maxAttempts(ctx.config, kind)) {
      ctx.exhausted.push(action.key)
    }
  }
  return g
}

// agentLive: the session's agent list shows this agent still at work.
function agentLive(ctx: Ctx, agentId: string): boolean {
  return listedLive(ctx.state.agents, agentId)
}

// listedLive: an agent list shows this agent still at work (the stop-agent executor asks too).
export function listedLive(agents: readonly AgentView[], agentId: string): boolean {
  const seen = agents.find(a => a.id === agentId)
  return seen !== undefined && seen.status !== 'completed' && seen.status !== 'failed' && seen.status !== 'killed'
}

// answeredLive: an agent entry that is done, while the list still shows its agent at work
// ANSWERED_GRACE_MS after the answer. An answer through the tool ends the entry before the
// agent's turn does (SPEC 7.3a.4), and an agent that works on, or waits on background work,
// still holds its branch (agentWriting), so rules A1 and A2 keep covering it. The grace leaves
// alone an agent the list has not yet marked completed.
function answeredLive(agents: readonly AgentView[], e: LedgerEntry, now: Ms): boolean {
  if (e.status !== 'done' || e.agentId === undefined || e.endedAt === null || (e.kind !== 'spawn' && e.kind !== 'delegate')) return false
  return now - e.endedAt > ANSWERED_GRACE_MS && listedLive(agents, e.agentId)
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

// --- G5: the main checkout (#544) ----------------------------------------------------------

// checkoutMoved: why the main checkout is not where an agent may start in it: detached, on
// another branch, carrying changes, or unreadable; null when it is on its default branch and
// clean, or was not read (the replay harness).
export function checkoutMoved(state: State): string | null {
  const c = state.checkout
  if (c === null) return null
  if ('error' in c) return `unreadable: ${c.error}`
  if (c.branch === null) return `detached at ${(c.head ?? 'unknown').slice(0, 7)}`
  if (c.branch !== c.defaultBranch) return `on ${c.branch}, not ${c.defaultBranch}`
  if (c.dirty.length === 0) return null
  const more = c.dirty.length > 3 ? ` and ${c.dirty.length - 3} more` : ''
  return `has changes: ${c.dirty.slice(0, 3).join(', ')}${more}`
}

// A moved checkout tells the owner once per sight (its branch, commit and whether it carries
// changes), and admit holds what starts in it until it is back. The loop never puts it back
// itself: an agent may be using it.
function checkout(ctx: Ctx) {
  const why = checkoutMoved(ctx.state)
  const c = ctx.state.checkout
  if (why === null || c === null) return
  if ('error' in c) {
    want(ctx, wake('tell', 'checkout', 'tell:checkout:unreadable', 'G5', null, {}, [why]))
    return
  }
  const seen = `${c.branch ?? 'detached'}@${c.head ?? 'unknown'}${c.dirty.length > 0 ? ':changed' : ''}`
  want(ctx, wake('tell', 'checkout', `tell:checkout:${seen}`, 'G5', null, { branch: c.branch ?? 'detached', head: c.head, default: c.defaultBranch }, [why]))
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
  // a restart that failed is used up (restart-self runs once): the owner hears, since the drain
  // holds every start, develop and drive action until the update is re-issued or turned off
  if (due !== null && gate(ctx, `restart:${due.at}`, 'restart-self') === 'exhausted') {
    skip(ctx, 'H4', null, `exhausted: restart:${due.at}`)
    ctx.exhausted.push(`restart:${due.at}`)
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
// running ledger entry (an agent, a wake, a command), and any pipeline run still running,
// pending or ci-stalled (its CI step still polls in the daemon), of any device, since the
// workspace's daemon serves them all. Empty: safe.
function drainBlockers(ctx: Ctx): string[] {
  const { state } = ctx
  if (!state.sources.runs.ok) return ['the runs source']
  const entries = state.ledger.filter(e => e.status === 'running').map(e => e.key)
  const runs = state.runs
    .filter(r => r.state === 'running' || r.state === 'pending' || r.state === 'ci-stalled')
    .map(r => `run ${r.run} ${r.state}`)
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
  // an exhausted restart was named, and told, by housekeeping
  if (gate(ctx, key, 'restart-self') !== 'go') return null
  return { kind: 'restart-self', key, class: 'free', rule: 'H4', reason: 'update due, nothing in flight', issue: null, why: due.reason, at: due.at }
}

// --- H5: the main checkout kept up to date with origin (#555) --------------------------------

// Agents begin in the main checkout and designers read its code, so it follows origin's default
// branch: after a merge (the loop's own, or a hand merge's rollout read) and at least every
// checkoutEveryMs, it is fast-forwarded, only while G5 finds it on its default branch and clean
// (the executor checks again and refuses commits origin lacks). It waits while a designer or
// adjudicator is at work, as files changing under them would change mid-read. Implementers and
// fixers work in a worktree of their own, so they do not hold it: they run for hours, and would
// keep it stale all run. A refusal G5 cannot see, such as commits origin lacks, tells the owner
// once per sight with G5's notice.
function updateCheckout(ctx: Ctx) {
  const { state, config } = ctx
  const c = state.checkout
  if (c === null || 'error' in c || checkoutMoved(state) !== null) return
  const last = lastDone(ctx, 'update-checkout')
  const refused = outcome(last, 'update-checkout')
  if (refused?.result === 'refused') {
    const key = `tell:checkout:${c.branch ?? 'detached'}@${c.head ?? 'unknown'}:refused`
    want(ctx, wake('tell', 'checkout', key, 'H5', null, { branch: c.branch, head: c.head, default: c.defaultBranch }, [refused.line]))
  }
  const since = last?.startedAt ?? Number.NEGATIVE_INFINITY
  const merged = state.ledger.some(
    e => e.status === 'done' && (e.endedAt ?? 0) > since && (outcome(e, 'merge')?.result === 'merged' || outcome(e, 'rollout') !== undefined),
  )
  if (!merged && last !== undefined && state.now - (last.endedAt ?? 0) < config.checkoutEveryMs) return
  const readers = checkoutReaders(ctx)
  if (readers.length > 0) {
    skip(ctx, 'H5', null, `update-checkout waits for agents reading the main checkout: ${readers.join(', ')}`)
    return
  }
  want(ctx, {
    kind: 'update-checkout',
    key: `update-checkout:${last?.endedAt ?? 0}`,
    class: 'free',
    rule: 'H5',
    reason: merged ? 'a merge since the last update' : 'due',
    issue: null,
    branch: c.defaultBranch,
  })
}

// checkoutReaders: the loop's designers and adjudicators still at work, by the ledger or by the
// agent list (one whose answer is in may read on).
function checkoutReaders(ctx: Ctx): string[] {
  return ctx.state.ledger
    .filter(e => e.kind === 'spawn' && (e.agent === 'designer' || e.agent === 'adjudicator'))
    .filter(e => e.status === 'running' || (e.agentId !== undefined && agentLive(ctx, e.agentId)))
    .map(e => e.key)
    .sort()
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
      // P2a (#537): a resume of an escalation whose verdicts were all ENV is the owner's word that
      // the environment is fixed, so the same head is rerun rather than a new adjudicator asked
      // about the stale failure
      const envEscalation = resumed > 0 && run.head !== null ? envOnlyEscalation(ctx, run, at, resumed) : undefined
      if (envEscalation !== undefined) {
        envRetry(ctx, run, at, suffix, envEscalation)
        continue
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

// envOnlyEscalation: the verdict lines of this gate's latest adjudication, when it escalated with
// every verdict ENV and the owner resumed the run after it; undefined otherwise. A round with no
// adjudication is an env-retry's, so a second resume after a rerun looks back past it. Any other
// verdict (a code failure), or none, is never rerun.
function envOnlyEscalation(ctx: Ctx, run: RunView, at: string, resumed: number): string[] | undefined {
  for (let round = resumed - 1; round >= 0; round--) {
    const adj = done(ctx, `adjudicate:${at}${round > 0 ? `:r${round}` : ''}`)
    if (adj === undefined) continue
    const verdict = outcome(adj, 'adjudicator')
    if (verdict === undefined || verdict.action.type !== 'escalate') return undefined
    if (verdict.verdicts.length === 0 || !verdict.verdicts.every(v => /^ENV:/.test(v))) return undefined
    return resumes(ctx, `run:${run.run}`, adj.endedAt ?? Number.POSITIVE_INFINITY) > 0 ? verdict.verdicts : undefined
  }
  return undefined
}

// envRetry, rule P2a: the rerun, once for this resume (one attempt, never retried). A clean launch
// starts a new run, which the P rules then judge afresh; if this run is still at the gate
// respondSettleMs later, the owner is told again rather than the loop trying more. A launch
// that failed or was lost is told the same way, not as agent-failed: `/factory retry` never
// clears an env-retry, only a fresh resume reruns it.
function envRetry(ctx: Ctx, run: RunView, at: string, suffix: string, verdicts: string[]) {
  const n = run.issue as number
  const key = `env-retry:${at}${suffix}`
  const fields = { issue: n, run: run.run, step: run.step, brief: briefOf(ctx, ctx.issues.get(n)) }
  const g = want(ctx, {
    kind: 'env-retry',
    key,
    class: 'drive',
    rule: 'P2a',
    reason: 'owner resumed an environment escalation',
    issue: n,
    run: run.run,
    branch: run.branch,
    step: run.step,
    head: run.head as string,
  })
  if (g === 'exhausted') {
    const why = ctx.byKey.get(key)?.summary
    const line = `the pipeline could not be run again on this head after the resume${why === undefined ? '' : ` (${why})`}; resuming the run tries once more`
    want(ctx, wake('tell', 'escalate', `tell:escalate:${at}${suffix}`, 'P2a', n, fields, [line, ...verdicts]))
    return
  }
  const ran = g === 'done' ? done(ctx, key) : undefined
  if (ran === undefined || ctx.state.now - (ran.endedAt ?? 0) < ctx.config.respondSettleMs) return
  want(
    ctx,
    wake('tell', 'escalate', `tell:escalate:${at}${suffix}`, 'P2a', n, fields, [
      'the pipeline was run again on this head after the resume, and the run is still at this gate',
      ...verdicts,
    ]),
  )
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
    step: run.step,
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
  const outAt = ctx.out.length
  const skippedAt = ctx.skipped.length
  ctx.gated.clear()
  for (const run of runs) {
    if (!MERGEABLE_STATES.includes(run.state) || run.pr === null || run.head === null) continue
    const n = run.issue as number
    const pr = run.pr
    const head = run.head
    const guards = state.ledger
      .filter(e => e.kind === 'guard' && e.pr === pr && e.head === head)
      .sort((a, b) => a.startedAt - b.startedAt)
    const latest = guards[guards.length - 1]
    const next = Math.max(0, ...guards.map(e => guardSeq(e.key))) + 1
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
    // M1: a fresh guard outcome for this PR and head, or a guard run. Before a head's first guard,
    // a clean slot on its branch is fast-forwarded to the run's head first (it runs first in the
    // pass), so a worktree the pipeline's own commits left behind does not fail `head` (#551).
    if (latest === undefined) {
      if (cleanSlotOn(ctx, run.branch)) want(ctx, fastForward(run, `fast-forward:${pr}:${head}`, 'M1'))
      want(ctx, guardAction(1))
      continue
    }
    if (latest.status === 'running') {
      skip(ctx, 'M1', n, `PR #${pr} waits for ${latest.key} to finish`)
      continue
    }
    if (latest.status !== 'done') {
      want(ctx, { ...guardAction(guards.length), key: latest.key })
      continue
    }
    const result = outcome(latest, 'guard')
    if (result === undefined) continue
    // a repair on this PR since the guard makes it stale: a fixer that ended done, with a commit
    // or without one (#550), a fix-linkage, a fast-forward that moved a worktree or found none
    // lagging any more (#551), or an update-behind that pushed a new PR head (the run's head,
    // which the watcher prints, stays)
    const lastRepair = Math.max(0, ...state.ledger.filter(e => e.pr === pr && repaired(e)).map(e => e.endedAt ?? 0))
    const age = state.now - (latest.endedAt ?? 0)
    const transientOnly = result.fails.length > 0 && result.fails.every(f => classifyFail(f) === 'transient')
    if ((latest.endedAt ?? 0) < lastRepair || age >= config.guardTtlMs || (transientOnly && age >= config.guardRecheckMs)) {
      want(ctx, guardAction(next))
      continue
    }
    if (result.fails.length > 0) {
      onGuardFails(ctx, run, result.fails, guardSeq(latest.key), latest.startedAt)
      continue
    }
    if (result.warns.length > 0 && done(ctx, `pr-comment:${pr}:${head}`) === undefined) {
      weakening(ctx, run, result.warns)
      continue
    }
    mergeReview(ctx, run, result)
  }
  // a PR no rule acted on this pass says what it waits for (#550)
  for (const run of runs) {
    if (!MERGEABLE_STATES.includes(run.state) || run.pr === null || run.head === null) continue
    const n = run.issue as number
    if (ctx.out.slice(outAt).some(a => a.issue === n) || ctx.skipped.slice(skippedAt).some(s => s.issue === n)) continue
    const g = ctx.gated.get(n)
    skip(ctx, g?.rule ?? 'M1', n, waitsFor(ctx, run, g))
  }
}

// repaired: a done entry that changed a PR or its worktree, after which its guard is stale (M1).
// Rule M2's fast-forward that answers CURRENT counts too: the lag its guard saw is gone (the slot
// was reused or moved), so a re-guard, not the judge, looks again. M1's runs before the first
// guard, so its CURRENT says nothing about that guard (#551).
function repaired(e: LedgerEntry): boolean {
  if (e.status !== 'done') return false
  if (e.kind === 'fix-linkage' || (e.kind === 'spawn' && e.agent === 'fixer')) return true
  const forward = outcome(e, 'fast-forward')?.result
  return outcome(e, 'update-behind')?.result === 'updated' || forward === 'forwarded' || (forward === 'current' && e.rule === 'M2')
}

// waitsFor: what a PR no rule acted on this pass waits for, from the last action it wanted that
// did not go out (#550).
function waitsFor(ctx: Ctx, run: RunView, g: { key: string; gate: Gate } | undefined): string {
  const pr = run.pr as number
  if (g === undefined) return `PR #${pr} waits: no rule acts on it`
  if (g.gate === 'running') return `PR #${pr} waits for ${g.key} to finish`
  if (g.gate === 'wait') return `PR #${pr} waits out the retry backoff of ${g.key}`
  if (g.gate !== 'done') return `PR #${pr} waits: ${g.key} is ${g.gate}`
  if (g.key.startsWith('tell:')) return `PR #${pr} waits on the owner (${g.key})`
  let guardEnd = 0
  for (const e of ctx.state.ledger) {
    if (e.kind === 'guard' && e.pr === pr && e.head === run.head && e.status === 'done') guardEnd = Math.max(guardEnd, e.endedAt ?? 0)
  }
  const due = Math.max(0, guardEnd + ctx.config.guardTtlMs - ctx.state.now)
  return `PR #${pr} waits for its head to move or its next guard in ${Math.ceil(due / 1000)}s (${g.key} is done)`
}

// cleanSlotOn: a pool slot has the branch checked out and nothing uncommitted (#551).
function cleanSlotOn(ctx: Ctx, branch: string): boolean {
  return ctx.state.sources.pool.ok && (ctx.state.pool?.slots ?? []).some(s => s.branch === branch && s.dirty === false)
}

function fastForward(run: RunView, key: string, rule: 'M1' | 'M2'): Action {
  return {
    kind: 'fast-forward',
    key,
    class: 'free',
    rule,
    reason: rule === 'M1' ? 'before the first guard of a head' : 'guard: a worktree lags the run head',
    issue: run.issue as number,
    pr: run.pr as number,
    run: run.run,
    head: run.head as string,
    branch: run.branch,
  }
}

// worktreeLag: a guard `head` FAIL whose only problem is a worktree elsewhere on the branch: the
// run, origin and PR heads are all this head, and every worktree's head was read (the guard
// prints `run= origin= pr=` and a `worktree=` per worktree). That the worktree is behind, clean
// and has nothing origin lacks is the fast-forward's to prove (#551).
export function worktreeLag(fail: GuardFail, head: string): boolean {
  if (fail.name !== 'head') return false
  const m = /^run=(\S+) origin=(\S+) pr=(\S+)((?: worktree=\S+)*) \(run /.exec(fail.reason)
  if (m === null || m[1] !== head || m[2] !== head || m[3] !== head) return false
  const worktrees = (m[4] ?? '').split(' worktree=').filter(w => w !== '')
  return worktrees.some(w => w !== head) && !worktrees.includes('unknown')
}

// lagForward: rule M2 for a worktree that lags the run's head (#551): the fast-forward, once per
// guard, unless one already went through, or found nothing lagging, before this guard ran (the
// lag came back, so the judge looks). 'acting' while it is wanted; else the line of a refusal,
// for the judge, or null.
function lagForward(ctx: Ctx, run: RunView, seq: number, guardAt: Ms): 'acting' | string | null {
  const pr = run.pr as number
  const head = run.head as string
  const went = ctx.state.ledger.some(
    e => e.kind === 'fast-forward' && e.pr === pr && e.head === head && repaired(e) && (e.endedAt ?? 0) <= guardAt,
  )
  if (went) return null
  const key = `fast-forward:${pr}:${head}:${seq}`
  const ended = done(ctx, key)
  if (ended !== undefined) {
    const o = outcome(ended, 'fast-forward')
    return o?.result === 'refused' ? o.line : null
  }
  // one that ran out of attempts is no owner notice: the judge hears of the lag instead
  if (gate(ctx, key, 'fast-forward') === 'exhausted') return null
  want(ctx, fastForward(run, key, 'M2'))
  return 'acting'
}

// digest: a short stable name for a text (FNV-1a, 32 bits), for a key that follows content.
function digest(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

// guardFixerKey: the fixer a guard-fail judge's round asked for, keyed like that round.
function guardFixerKey(judgeKey: string): string {
  return `fixer:guard:${judgeKey.slice('judge:guard-fail:'.length)}`
}

// guardJudgeKey: the guard-fail judge for one failure (#550), keyed by the PR, head and a digest
// of the FAIL lines, not the guard's number, so a re-check that fails the same way wakes no one.
// A new round (':r<n>') comes once the owner resumed the run after the last, or as a slow
// reminder JUDGE_REMIND_MS after an answer other than hold (and after the fixer it asked for).
function guardJudgeKey(ctx: Ctx, run: RunView, base: string): string {
  for (let round = 0; ; round++) {
    const key = `${base}${roundSuffix(round)}`
    const entry = done(ctx, key)
    if (entry === undefined) return key
    const decision = outcome(entry, 'wake')?.decision
    let since = entry.endedAt ?? 0
    if (decision === 'fixer') {
      const fixer = done(ctx, guardFixerKey(key))
      const spent = gate(ctx, guardFixerKey(key), 'fixer') === 'exhausted'
      since = fixer !== undefined ? Math.max(since, fixer.endedAt ?? 0) : spent ? since : Number.POSITIVE_INFINITY
    }
    const resumed = resumes(ctx, `run:${run.run}`, entry.endedAt ?? 0) > 0
    if (!resumed && (decision === 'hold' || ctx.state.now - since < JUDGE_REMIND_MS)) return key
  }
}

function onGuardFails(ctx: Ctx, run: RunView, fails: GuardFail[], seq: number, guardAt: Ms) {
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
        skip(ctx, 'M2', n, `PR #${pr} is held by judge(guard-fail) until the owner resumes run:${run.run}`)
        return
      }
      // a worktree the pipeline's own commits left behind is fast-forwarded, not judged (#551)
      const context = [...lines]
      if (fails.some(f => worktreeLag(f, head))) {
        const forward = lagForward(ctx, run, seq, guardAt)
        if (forward === 'acting') return
        if (forward !== null) context.push(`FAST-FORWARD ${forward}`)
      }
      const key = guardJudgeKey(ctx, run, `judge:guard-fail:${pr}:${head}:${digest(lines.join('\n'))}`)
      const judged = done(ctx, key)
      const answer = outcome(judged, 'wake')
      if (answer === undefined) {
        want(ctx, wake('judge', 'guard-fail', key, 'M2', n, { issue: n, pr, run: run.run, head, brief }, context))
      } else if (answer.decision === 'fixer') {
        want(ctx, fixer('guard', guardFixerKey(key), answer.instructions ?? lines.join('\n')))
      } else {
        const remind = Math.max(0, (judged?.endedAt ?? 0) + JUDGE_REMIND_MS - ctx.state.now)
        skip(ctx, 'M2', n, `PR #${pr} waits: judge(guard-fail) answered ${answer.decision}; asked again if the failure changes, or in ${Math.ceil(remind / 1000)}s`)
      }
      return
    }
  }
}

// --- M8: the PR of a superseded run (#553, I-39) ---------------------------------------------

// A fixer sent to a run that handed off on a new branch superseded that run (act-agents.ts logs
// `superseded`), and so did task(redrive) on `REGATE new-branch`; callum-flow-regate then says
// "once the new PR exists, close the old PR".
type Moved = { issue: number; run: string; pr: number; newRun: string | null; newBranch: string }

// supersededPrs: each superseded run's PR is closed once the branch its work moved to has a PR,
// with a link to the newest one down the chain. A run the watcher still shows and the event log
// does not mark superseded is left alone; a merged or closed PR is the executor's to leave. The
// new branch is the fixer's own word, so one that is not a branch of the same issue moves nothing.
function supersededPrs(ctx: Ctx) {
  const moves: Moved[] = []
  const leftOpen = new Set<number>()
  for (const e of [...ctx.byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    const handoff = outcome(e.status === 'done' && e.kind === 'spawn' && e.agent === 'fixer' ? e : undefined, 'handoff')
    if (handoff === undefined || handoff.newBranch === null || e.issue === null || e.run === null || e.pr === null) continue
    if (issueFromBranch(handoff.newBranch) !== e.issue) {
      leftOpen.add(e.pr)
      if (isLive(ctx.issues.get(e.issue))) skip(ctx, 'M8', e.issue, `PR #${e.pr} left open: ${handoff.newBranch} is not a branch of #${e.issue}`)
      continue
    }
    moves.push({ issue: e.issue, run: e.run, pr: e.pr, newRun: handoff.run, newBranch: handoff.newBranch })
  }
  // a run the event log marks superseded with no fixer behind it (task(redrive), I-39) moved to
  // callum-flow-regate's <branch>-v<n>: it moves once a run of the issue on such a branch, not
  // superseded itself, shows a PR of its own
  for (const old of ctx.state.runs) {
    if (!old.superseded || old.issue === null || old.pr === null || leftOpen.has(old.pr) || moves.some(m => m.pr === old.pr)) continue
    const next = ctx.state.runs.find(
      r => !r.superseded && r.issue === old.issue && r.pr !== null && r.pr !== old.pr && r.branch.startsWith(`${old.branch}-v`),
    )
    if (next !== undefined) moves.push({ issue: old.issue, run: old.run, pr: old.pr, newRun: next.run, newBranch: next.branch })
  }
  for (const m of moves) {
    const key = `pr-close:${m.pr}`
    if (done(ctx, key) !== undefined || ctx.state.runs.some(r => r.run === m.run && !r.superseded)) continue
    const by = replacement(ctx, moves, m, [])
    if (by === null) {
      if (isLive(ctx.issues.get(m.issue))) skip(ctx, 'M8', m.issue, `PR #${m.pr} superseded: waiting for the PR of ${m.newBranch}`)
      continue
    }
    want(ctx, { kind: 'pr-close', key, class: 'free', rule: 'M8', reason: `superseded by #${by}`, issue: m.issue, pr: m.pr, run: m.run, newBranch: m.newBranch, by })
  }
}

// replacement: the PR the moved work has now. A new run that moved on in turn was superseded by
// a fixer sent with its PR, so the chain is followed to its newest PR; null while the new
// branch has none yet. Only a run of the same issue on the new branch counts: the run id the
// fixer reports is its own word too, and may name another issue's run.
function replacement(ctx: Ctx, moves: Moved[], m: Moved, seen: string[]): number | null {
  const next =
    m.newRun === null ? undefined : moves.find(o => o.run === m.newRun && o.issue === m.issue && o.run !== m.run && !seen.includes(o.run))
  if (next !== undefined) return replacement(ctx, moves, next, [...seen, m.run]) ?? next.pr
  const run = ctx.state.runs.find(r => r.pr !== null && r.pr !== m.pr && r.issue === m.issue && r.branch === m.newBranch)
  return run?.pr ?? null
}

// prHead: the PR's head as this loop's own updates left it. update-behind pushes a new PR head
// but never touches the run, whose head the watcher keeps printing, so the head an UPDATED pushed
// is where the next update starts from, and its key (SPEC M2b).
function prHead(ctx: Ctx, pr: number, runHead: string): string {
  const seen = new Set<string>([runHead])
  let head = runHead
  for (;;) {
    const entry = ctx.byKey.get(`update-behind:${pr}:${head}`)
    const moved = outcome(entry?.status === 'done' ? entry : undefined, 'update-behind')
    if (moved?.result !== 'updated' || moved.to === null || seen.has(moved.to)) return head
    seen.add(moved.to)
    head = moved.to
  }
}

function updateBehind(ctx: Ctx, run: RunView, fixer: (p: 'regate', k: string, i: string) => Action) {
  const n = run.issue as number
  const pr = run.pr as number
  const head = prHead(ctx, pr, run.head as string)
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
  const byIssue = new Map<number, Merged>()
  const rollouts: LedgerEntry[] = []
  for (const entry of ctx.byKey.values()) {
    if (entry.status !== 'done' || entry.issue === null) continue
    const merge = outcome(entry, 'merge')
    if (merge?.result === 'merged') {
      byIssue.set(entry.issue, { issue: entry.issue, pr: entry.pr, key: entry.key, rollout: merge.rollout, closeIssue: merge.closeIssue })
    } else if (outcome(entry, 'rollout') !== undefined) {
      rollouts.push(entry)
    }
  }
  // a rollout read stands in for a hand merge, or fills in a merge whose own read failed
  for (const entry of rollouts) {
    const roll = outcome(entry, 'rollout')
    const n = entry.issue as number
    const merged = byIssue.get(n)
    if (roll === undefined || (merged !== undefined && merged.rollout !== null)) continue
    const pr = merged?.pr ?? entry.pr ?? ctx.issues.get(n)?.pr ?? null
    const closeIssue = merged?.closeIssue ?? roll.closeIssue ?? (roll.rollout === 'merge' && epicBase(ctx, pr) ? n : null)
    byIssue.set(n, { issue: n, pr, key: merged?.key ?? entry.key, rollout: roll.rollout, closeIssue })
  }
  return [...byIssue.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

// epicBase: the PR's latest guard failed `base` because the PR targets a branch other than the
// default. A closing PR merged there by hand gets no closing reference from GitHub, so its issue
// is closed as callum-flow-merge would have said to (D-29); callum-flow-rollout reads no base.
function epicBase(ctx: Ctx, pr: number | null): boolean {
  if (pr === null) return false
  let latest: LedgerEntry | undefined
  for (const e of ctx.state.ledger) {
    if (e.kind !== 'guard' || e.pr !== pr || e.status !== 'done' || outcome(e, 'guard') === undefined) continue
    if (latest === undefined || e.startedAt > latest.startedAt) latest = e
  }
  return outcome(latest, 'guard')?.fails.some(f => f.name === 'base' && f.reason.startsWith('PR targets ')) ?? false
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
  // A merge of the loop's own whose rollout read failed right after it: read it again, or its
  // follow-ups (the Run it, the milestone) would be lost.
  const unread = state.ledger
    .filter(e => e.kind === 'merge' && e.issue !== null && e.status === 'done' && state.now - (e.endedAt ?? 0) <= ROLLOUT_WITHIN_MS)
    .filter(e => {
      const merged = outcome(e, 'merge')
      return merged?.result === 'merged' && merged.rollout === null
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  for (const e of unread) {
    const n = e.issue as number
    want(ctx, { kind: 'rollout', key: `rollout:${n}`, class: 'free', rule: 'M7', reason: 'merged, rollout unread', issue: n, pr: e.pr })
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
    // no designer at work and none that answered: none ever started, or it failed, timed out or
    // was lost (SPEC 10.4: a retry re-checks D2, whose 'no brief newer than stageSince' fails)
    const settled = entry === undefined || (entry.status !== 'running' && entry.status !== 'done')
    if (result === null && settled && resumed === 0 && issue.brief !== null && issue.brief.at >= life) {
      // A brief this life with no designer record (the loop restarted while it ran), or one its
      // designer posted before it ended without a RESULT line.
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
  const runningClaims = state.ledger.filter(e => e.kind === 'claim' && e.status === 'running')
  // a claim done but not yet observed holds its place under the caps as a running one does (#547)
  const unseen = unseenClaims(ctx)
  const waiting = [...unseen].filter(n => !runningClaims.some(e => e.issue === n)).length
  const myLive = state.issues.filter(issue => mine(ctx, issue) && isLive(issue)).length + waiting
  // An issue in design takes a worktree as soon as its implementer starts; one just claimed is
  // about to be in design.
  const myDesigning = state.issues.filter(issue => mine(ctx, issue) && issue.stage === 'designing').length + waiting
  const lastClaim = Math.max(0, ...state.ledger.filter(e => e.kind === 'claim').map(e => e.startedAt))
  // merge work this pass plans, or that still runs from an earlier one
  const mergeWork = ctx.out.some(a => a.rule.startsWith('M')) || state.ledger.some(e => e.status === 'running' && e.rule.startsWith('M'))
  const cap = config.maxInFlightIssues
  // a claim still running counts as started: it takes its worktree, its place under the caps and
  // its share of the pass, so planning again while it runs adds no claim (SPEC 5.9 idempotence)
  let started = runningClaims.length
  for (const n of order) {
    const issue = ctx.issues.get(n)
    if (unseen.has(n)) {
      skip(ctx, 'D1', n, 'claimed; the factory state has not caught up')
      continue
    }
    const why = candidateProblem(ctx, issue, n)
    if (why !== null) {
      skip(ctx, 'D1', n, why)
      continue
    }
    const key = `claim:${n}:${issue?.stageSince ?? 'new'}`
    // its claim is in flight (counted as started above)
    if (ctx.byKey.get(key)?.status === 'running') continue
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

// unseenClaims: the issues whose latest successful claim the observed state does not show yet:
// still queued (or unknown to the factory) and no stage entered after the claim ended. The
// claimed event reaches the factory a few seconds after the claim, and a ready event queue-watch
// logged first can land before it (#538). Past one heartbeat interval the observed state counts
// again, so a claim whose event never landed holds nothing back for good.
function unseenClaims(ctx: Ctx): Set<number> {
  const { state, config } = ctx
  const latest = new Map<number, Ms>()
  for (const e of state.ledger) {
    if (e.kind !== 'claim' || e.status !== 'done' || e.issue === null || e.endedAt === null) continue
    if (outcome(e, 'claim')?.result !== 'claimed') continue
    latest.set(e.issue, Math.max(latest.get(e.issue) ?? 0, e.endedAt))
  }
  const out = new Set<number>()
  for (const [n, endedAt] of latest) {
    if (state.now - endedAt >= config.heartbeatEveryMs) continue
    const stage = ctx.issues.get(n)?.stage ?? null
    const since = ctx.issues.get(n)?.stageSince ?? null
    if ((stage !== null && stage !== 'queued') || (since !== null && since > endedAt)) continue
    out.add(n)
  }
  return out
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
  // a running agent entry, or a done one whose agent works on past its answer
  const running = state.ledger
    .filter(e => (e.status === 'running' && e.agentId !== undefined && (e.kind === 'spawn' || e.kind === 'delegate')) || answeredLive(state.agents, e, state.now))
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
    const stopped = (why: string) => wake('tell', 'stopped', `tell:stopped:${agentId}`, 'A2', entry.issue, { issue: entry.issue, why })
    if (issue.open === false || (issue.stage !== null && ENDED.includes(issue.stage))) {
      const why = issue.open === false ? 'closed' : (issue.stage as Stage)
      want(ctx, stop(`issue ${why}`))
      want(ctx, stopped(why))
    } else if (issue.holder !== null && issue.holder !== state.device && isLive(issue)) {
      want(ctx, stop(`claimed by ${issue.holder}`))
      want(ctx, wake('tell', 'claim-lost', `tell:claim-lost:${entry.issue}:${issue.holder}`, 'A2', entry.issue, { issue: entry.issue, holder: issue.holder }))
    } else if (state.control.dropped.some(d => d.issue === entry.issue)) {
      want(ctx, stop('owner dropped it'))
      want(ctx, stopped('dropped'))
    } else if (agent === 'implementer' && splitAfter(ctx, entry.issue, entry.startedAt)) {
      want(ctx, stop('issue split while implementing'))
      want(ctx, stopped('split'))
    }
  }
  // SPEC 13: a stop of rule A1 that failed leaves the agent running, marked timed-out (ledger.ts
  // finish); its rule waits for the agent list (gate), and the owner hears once
  for (const e of state.ledger) {
    if (e.kind === 'stop-agent' && e.rule === 'A1' && e.status === 'failed') ctx.exhausted.push(e.key)
  }
  for (const key of new Set(ctx.exhausted)) {
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

// writesBranch: an action that changes an issue's branch or its PR's head: an implementer or a
// fixer, a respond or env-retry (the pipeline commits on the run's head), an update-behind, a
// merge; and a fast-forward, which moves the worktree an agent of the issue may be working in.
function writesBranch(action: Action): boolean {
  if (action.kind === 'spawn') return action.agent === 'fixer'
  return ['delegate', 'respond', 'env-retry', 'update-behind', 'fast-forward', 'merge'].includes(action.kind)
}

// agentWriting: an implementer or fixer of this issue still runs, by the ledger, or by the agent
// list for one whose entry ended while the agent went on (a stop that did not take, SPEC 13).
function agentWriting(ctx: Ctx, issue: number): boolean {
  return ctx.state.ledger.some(
    e =>
      e.issue === issue &&
      (e.kind === 'delegate' || (e.kind === 'spawn' && e.agent === 'fixer')) &&
      (e.status === 'running' || (e.agentId !== undefined && agentLive(ctx, e.agentId))),
  )
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
  const moved = checkoutMoved(state)
  const kept: Action[] = []
  const writing = new Set<number>()
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
    if (moved !== null && CHECKOUT_HELD.includes(action.kind)) {
      skip(ctx, action.rule, issue, `main checkout ${moved} (${action.kind})`)
      continue
    }
    // one writer per branch: while an implementer or fixer of the issue still works (or one was
    // kept this pass), nothing else that writes its branch starts (found on the testbed: a guard
    // fixer and a conflict fixer on one PR at once)
    if (issue !== null && writesBranch(action)) {
      if (writing.has(issue) || agentWriting(ctx, issue)) {
        skip(ctx, action.rule, issue, `an agent already works the branch of #${issue} (${action.kind})`)
        continue
      }
      if (action.kind === 'delegate' || action.kind === 'spawn') writing.add(issue)
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
  if (checkoutMoved(state) !== null) words.push('checkout')
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
