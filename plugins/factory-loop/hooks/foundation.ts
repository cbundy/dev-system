// The foundation's generic plan code (docs/factory-loop/v2/SPEC.md 2.2): the usage tier (tierOf),
// the class matrix, gate and want, the generic admission filters (control, tier, GitHub backoff,
// the breakers, the rate caps), one wake and the title frame, and the helpers the rest of the loop
// shares (the live stages, the issue of a branch, the agent list's reading, the release review).
// The v2 planner (v2/plan.ts) composes its rules with them.
//
// One addition of v2's: the executor breaker gains a bucket for step unknowns across issues
// (v2 SPEC 5.3), which holds every start, develop and drive action for 30 minutes.
//
// Pure: no clock (state.now), no I/O, and nothing imported but types and v2's vocabulary.
import type { Action, ActionClass, ActionKind, AgentStatus, AgentType, AgentView, Config, LedgerEntry, Ms, Skip, State, Tier, Usage } from './types'
import { AGENT_STEPS } from './v2/types'

const MIN = 60_000
export const HOUR = 60 * MIN

// The classes each tier allows (v2 SPEC 13.5.2; rails.ts TIER_CLASSES is the act step's copy).
export const ALLOWED: Readonly<Record<Tier, readonly ActionClass[]>> = {
  normal: ['free', 'owner', 'drive', 'develop', 'start'],
  slow: ['free', 'owner', 'drive', 'develop', 'start'],
  'stop-new': ['free', 'owner', 'drive'],
  'stop-all': ['free', 'owner'],
}

export const WAKES: readonly ActionKind[] = ['judge', 'task', 'tell']

// The kinds that write to GitHub (or read it heavily): held while GitHub rate-limits us (v2 SPEC
// 13.10 item 2), by plan and, for the rest of a pass that met a limit, by the act step (act.ts runActions).
export const GITHUB_V2: readonly ActionKind[] = [
  'claim',
  'heartbeat',
  'sweep',
  'rollout',
  'close-issue',
  'delete-branch',
  'release-parent',
  'milestone-later',
  'label',
  'comment',
  'pr',
  'split',
  'upstream',
  'link',
  'close-tracker',
  'ci-rerun',
  'queue-update',
  'queue-merge',
  'queue-train',
  'released',
]

// The executor breaker (v2 SPEC 13.11.4): three failures in a row of one kind hold that kind this long.
export const BREAKER_MS = 30 * MIN

// The step-unknown breaker (v2 SPEC 5.3): `trips` unexplained unknowns of agent steps, on at least
// `records` issues, within `windowMs`, close the `classes` for `holdMs` from the newest of them.
// Unexplained: not caused by a load, a usage limit or a lost slot (5.1).
export const STEP_BREAKER = {
  trips: 3,
  records: 2,
  windowMs: 15 * MIN,
  holdMs: 30 * MIN,
  classes: ['start', 'develop', 'drive'] as readonly ActionClass[],
  explained: ['load', 'usage', 'slot'] as readonly string[],
} as const

export type Gate = 'go' | 'running' | 'done' | 'wait' | 'exhausted'

// What a plan builds as its rules run, and what the admission filters read.
// ownerTells: the notice kinds that are owner items (they count in the title and go
// out first); github: the kinds held during a GitHub backoff.
export type PlanCtx = {
  state: State
  config: Config
  tier: Tier
  overridden: boolean
  out: Action[]
  skipped: Skip[]
  owner: Set<string>
  exhausted: string[]
  byKey: Map<string, LedgerEntry>
  capped: string[]
  atCap: boolean
  ownerTells: readonly string[]
  github: readonly ActionKind[]
}

// newCtx: an empty plan over this state, its tier read, the ledger by key (the latest start wins).
export function newCtx(state: State, config: Config, tier: { tier: Tier; overridden: boolean }, ownerTells: readonly string[], github: readonly ActionKind[]): PlanCtx {
  const byKey = new Map<string, LedgerEntry>()
  for (const entry of [...state.ledger].sort((a, b) => a.startedAt - b.startedAt)) byKey.set(entry.key, entry)
  return {
    state,
    config,
    tier: tier.tier,
    overridden: tier.overridden,
    out: [],
    skipped: [],
    owner: new Set(),
    exhausted: [],
    byKey,
    capped: [],
    atCap: false,
    ownerTells,
    github,
  }
}

export function skip(ctx: PlanCtx, rule: string, issue: number | null, why: string): void {
  ctx.skipped.push({ rule, issue, why })
}

// --- gate and want ------------------------------------------------------------

// maxAttemptsOf: the key's own cap when its action or entry carries one, else the kind's setting,
// else 3.
export function maxAttemptsOf(config: Config, kind: ActionKind | AgentType, cap?: number): number {
  return cap ?? config.maxAttempts[kind] ?? 3
}

// cadenceOf: the interval of a kind that runs on a cadence. Heartbeat and sweep retry at their
// next due time, so they are never used up (v2 SPEC 13.6.1). null: any other kind.
export function cadenceOf(config: Config, kind: ActionKind | AgentType): Ms | null {
  if (kind === 'heartbeat') return config.heartbeatEveryMs
  if (kind === 'sweep') return config.sweepEveryMs
  return null
}

// gate: whether the action under this key may run now (v2 SPEC 13.5.1 "blocked"): new keys go; a
// running or done key is not planned again; a failed, timed-out or lost one runs again after its
// backoff until its attempts are used up, and an agent's only once the agent list shows it ended.
export function gate(ctx: PlanCtx, key: string, kind: ActionKind | AgentType, cap?: number): Gate {
  const entry = ctx.byKey.get(key)
  if (entry === undefined) return 'go'
  if (entry.status === 'running') return 'running'
  if (entry.status === 'done') return 'done'
  if (entry.agentId !== undefined && listedLive(ctx.state.agents, entry.agentId)) return 'running'
  const cadence = cadenceOf(ctx.config, kind)
  if (cadence === null && entry.attempts >= maxAttemptsOf(ctx.config, kind, cap ?? entry.maxAttempts)) return 'exhausted'
  if (entry.status === 'lost') return 'go'
  const doubled = ctx.config.retryBackoffMs * 2 ** Math.max(0, entry.attempts - 1)
  const backoff = cadence === null ? doubled : Math.min(doubled, cadence)
  if (entry.endedAt !== null && ctx.state.now - entry.endedAt < backoff) return 'wait'
  return 'go'
}

// want: plan the action unless its key is blocked, and say what blocked it. An owner notice counts
// toward the title's owner items whether or not it goes out this pass. An exhausted key is named
// in the decision log and kept in ctx.exhausted for its rule to tell; a cadenced kind that failed
// its attempts in a row is kept there too, and keeps trying: a running retry counts, since the
// ledger counts its attempt (attempts - 1 earlier ones), so the tell stays while the retry runs.
export function want(ctx: PlanCtx, action: Action): Gate {
  if (action.kind === 'tell' && ctx.ownerTells.includes(action.wake)) ctx.owner.add(action.key)
  const kind = action.kind
  const g = gate(ctx, action.key, kind, action.maxAttempts)
  if (g === 'go') ctx.out.push(action)
  const entry = ctx.byKey.get(action.key)
  if (g === 'running' && entry !== undefined && entry.status !== 'running') {
    skip(ctx, action.rule, action.issue, `${action.key}: its agent ${entry.agentId} still runs`)
  }
  if (g === 'exhausted') {
    skip(ctx, action.rule, action.issue, `exhausted: ${action.key}`)
    if (WAKES.includes(action.kind) && action.kind !== 'task') ctx.owner.add(action.key)
    else ctx.exhausted.push(action.key)
  } else if (cadenceOf(ctx.config, kind) !== null) {
    if (entry !== undefined && entry.status !== 'done') {
      const earlier = entry.status === 'running' ? entry.attempts - 1 : entry.attempts
      if (earlier >= maxAttemptsOf(ctx.config, kind, entry.maxAttempts)) ctx.exhausted.push(action.key)
    }
  }
  return g
}

// wake: a judge, task or tell action, its fields as text (an empty one dropped).
export function wake(
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

// blindPass (G2): the factory source failed, so the pass plans nothing but the owner's notice
// once it has failed for blindNoticeAfterMs.
export function blindPass(ctx: PlanCtx): void {
  const { state, config } = ctx
  const since = state.sources.factory.at
  skip(ctx, 'G2', null, `factory source unavailable${state.sources.factory.error ? `: ${state.sources.factory.error}` : ''}`)
  if (since === null || state.now - since >= config.blindNoticeAfterMs) {
    want(ctx, wake('tell', 'blind', `tell:blind:${since ?? 0}`, 'G2', null, { since: since ?? 'never', error: state.sources.factory.error?.slice(0, 300) ?? null }))
  }
}

// --- the breakers (v2 SPEC 13.11.4, 5.3) -------------------------------------------------------

// executorBreaker: the time the newest of this kind's last three ended entries ended, when all
// three failed within BREAKER_MS of now; else null.
export function executorBreaker(state: State, kind: ActionKind): Ms | null {
  const ended = state.ledger
    .filter(e => e.kind === kind && e.endedAt !== null && e.status !== 'running')
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
  const last3 = ended.slice(-3)
  const newest = last3[last3.length - 1]
  if (last3.length < 3 || newest === undefined || !last3.every(e => e.status === 'failed')) return null
  const at = newest.endedAt ?? 0
  return state.now - at < BREAKER_MS ? at : null
}

// An unexplained unknown of an agent step, as the transition that handled it recorded it: its
// event is unknown or a running step's timeout, its step an agent's, its cause none of a load, a
// usage limit or a lost slot. A transition lost to a reload counts by the facts it carries from
// its start (ledger.ts start): either the store took it, or the record's next transition reuses
// its key and replaces it, so nothing counts twice.
function unexplained(e: LedgerEntry): boolean {
  const o = e.outcome
  if (e.kind !== 'transition' || (e.status !== 'done' && e.status !== 'lost') || o?.kind !== 'transition') return false
  if (o.event !== 'unknown' && o.event !== 'timeout') return false
  if (o.step === null || !(AGENT_STEPS as readonly string[]).includes(o.step)) return false
  return o.cause === null || !STEP_BREAKER.explained.includes(o.cause)
}

// stepBreaker: when the step-unknown breaker is open (v2 SPEC 5.3): `since` is the newest of the
// unknowns that tripped it, `until` when it closes. A trip is any `trips` unexplained unknowns, on
// at least `records` issues, within `windowMs` of each other; it holds `holdMs` from the newest.
// An unknown that ended while a trip held is the breaker's own (its cause is `breaker`, 5.1) and
// counts toward no trip, so a trip neither extends itself nor moves its `since`, and is told once.
// null when it is closed now.
export function stepBreaker(ledger: readonly LedgerEntry[], now: Ms): { since: Ms; until: Ms } | null {
  const seen = ledger.filter(unexplained).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
  const counted: LedgerEntry[] = []
  let open: { since: Ms; until: Ms } | null = null
  for (const e of seen) {
    const at = e.endedAt ?? 0
    if (open !== null && at < open.until) continue
    counted.push(e)
    const window = counted.filter(x => at - (x.endedAt ?? 0) <= STEP_BREAKER.windowMs)
    const issues = new Set(window.map(x => x.issue))
    if (window.length >= STEP_BREAKER.trips && issues.size >= STEP_BREAKER.records) open = { since: at, until: at + STEP_BREAKER.holdMs }
  }
  return open !== null && now < open.until ? open : null
}

// --- admitting actions (the generic filters) ------------------------------------------

// Rate-cap buckets per rolling hour (D-24). A v2 agent step spawns an agent.
export type Bucket = 'start' | 'spawn' | 'wake'

export function bucketOf(kind: ActionKind, klass: ActionClass): Bucket | null {
  if (klass === 'start') return 'start'
  if (kind === 'agent-step') return 'spawn'
  if (WAKES.includes(kind)) return 'wake'
  return null
}

// perIssueKind: what the per-issue rate cap counts an action or entry under: its kind, and a v2
// agent step by its step kind (D-24, v2 appendix B).
function perIssueKind(kind: ActionKind, step: string | undefined): string {
  return kind === 'agent-step' && step !== undefined ? step : kind
}

// admit (G4): the planned actions, in order, through the generic filters: a paused issue (all but
// its heartbeat), no new work (start and develop), the usage tier, the GitHub backoff, the
// breakers, and the rate caps per bucket and per kind on one issue. Each held action has a skip
// line naming the filter. A tripped cap or breaker tells the owner once (runaway, breaker); then
// one wake at most (oneWake).
export function admit(ctx: PlanCtx): Action[] {
  const { state, config, tier } = ctx
  const control = state.control
  const recent = state.ledger.filter(e => e.startedAt > state.now - HOUR)
  const counts: Record<Bucket, number> = { start: 0, spawn: 0, wake: 0 }
  const perIssue = new Map<string, number>()
  for (const entry of recent) {
    const bucket = bucketOf(entry.kind, entry.class)
    if (bucket !== null) counts[bucket] += 1
    if (entry.issue !== null && bucket !== null) {
      const k = `${perIssueKind(entry.kind, entry.step)}:${entry.issue}`
      perIssue.set(k, (perIssue.get(k) ?? 0) + 1)
    }
  }
  const caps: Record<Bucket, number> = config.rateCaps
  const tripped = new Set<string>()
  const breakers = new Map<string, Ms>()
  const backoff = state.githubBackoffUntil !== null && state.now < state.githubBackoffUntil
  const steps = stepBreaker(state.ledger, state.now)
  // the step-unknown breaker is a fact of the ledger: the owner hears once it trips, whether or not
  // this pass asks for anything it holds (v2 SPEC 5.3), and its tell logs the trip (7.2)
  if (steps !== null) breakers.set('steps', steps.since)
  const kept: Action[] = []
  for (const action of ctx.out) {
    const issue = action.issue
    if (issue !== null && control.paused.includes(issue) && action.kind !== 'heartbeat') {
      skip(ctx, action.rule, issue, `owner: paused (${action.kind})`)
      continue
    }
    if (control.noNewWork && (action.class === 'start' || action.class === 'develop')) {
      skip(ctx, action.rule, issue, `owner: no new work (${action.kind})`)
      continue
    }
    if (!ALLOWED[tier].includes(action.class)) {
      skip(ctx, action.rule, issue, `tier ${tier} (${action.kind})`)
      continue
    }
    if (backoff && ctx.github.includes(action.kind)) {
      skip(ctx, action.rule, issue, `GitHub rate limit (${action.kind})`)
      continue
    }
    const breaker = executorBreaker(state, action.kind)
    if (breaker !== null) {
      breakers.set(action.kind, breaker)
      skip(ctx, action.rule, issue, `breaker open (${action.kind})`)
      continue
    }
    if (steps !== null && STEP_BREAKER.classes.includes(action.class)) {
      skip(ctx, action.rule, issue, `breaker open: step unknowns (${action.kind})`)
      continue
    }
    const bucket = bucketOf(action.kind, action.class)
    if (bucket !== null && counts[bucket] >= caps[bucket]) {
      tripped.add(bucket)
      skip(ctx, action.rule, issue, `rate cap: ${bucket} ${counts[bucket]}/${caps[bucket]}`)
      continue
    }
    if (issue !== null && bucket !== null) {
      const name = perIssueKind(action.kind, action.kind === 'agent-step' ? action.step : undefined)
      const k = `${name}:${issue}`
      const n = perIssue.get(k) ?? 0
      if (n >= config.rateCaps.perIssueKind) {
        tripped.add(k)
        skip(ctx, action.rule, issue, `rate cap: ${name} on #${issue} ${n}/${config.rateCaps.perIssueKind}`)
        continue
      }
      perIssue.set(k, n + 1)
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
    if (ctx.ownerTells.includes('breaker')) ctx.owner.add(notice.key)
    if (gate(ctx, notice.key, 'tell') === 'go') kept.push(notice)
  }
  return oneWake(ctx, kept)
}

// oneWake (O2): at most one wake per pass, none while one is open; owner notices first, then a
// judge, then a task, then any other notice.
export function oneWake(ctx: PlanCtx, actions: readonly Action[]): Action[] {
  const open = ctx.state.ledger.some(e => WAKES.includes(e.kind) && e.status === 'running')
  const rank = (a: Action) => {
    if (a.kind === 'tell') return ctx.ownerTells.includes(a.wake) ? 0 : 3
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

// --- the title frame (O1; D-23, D-27) ---------------------------------------------------------------

// What a title says: the repo's short name, the layer's counts (null on a blind pass, whose counts
// are not to be trusted), and a word for each thing that needs attention. `before` and `after` are
// the layer's own words, around the usage tier's: v2's parked count.
export type TitleFrame = {
  repo: string
  counts: string | null
  observe: boolean
  blind: boolean
  before: readonly string[]
  tier: Tier
  after: readonly string[]
  atCap: boolean
  capped: readonly string[]
  backoff: boolean
  owner: number
  // when a stopped session began holding work (session-hold.ts)
  held?: number | null
}

// titleDue: O1 is a throttle: a title goes out when it
// differs from the last one and either none was set since the module loaded or titleEveryMs has passed.
export function titleDue(state: State, config: Config, title: string): boolean {
  return title !== state.lastTitle && (state.lastTitleAt === null || state.now - state.lastTitleAt >= config.titleEveryMs)
}

// titleOf: the session title's frame. No usage numbers: a usage tier shows only
// when it holds work.
export function titleOf(f: TitleFrame): string {
  const name = f.repo.split('/')[1] ?? f.repo
  const head = f.counts === null ? `🔄 ${name}` : `🔄 ${name} (${f.counts})`
  const words: string[] = []
  if (f.observe) words.push('observe')
  if (f.blind) words.push('blind')
  words.push(...f.before)
  if (f.tier === 'stop-new') words.push('stop new')
  if (f.tier === 'stop-all') words.push('stop all')
  words.push(...f.after)
  if (f.atCap) words.push('at cap')
  for (const c of f.capped) words.push(`capped ${c}`)
  if (f.backoff) words.push('gh wait')
  if (f.owner > 0) words.push(`owner ${f.owner}`)
  if (f.held != null) words.push(`held: session stopped since ${new Date(f.held).toISOString().slice(11, 16)}`)
  return [head, ...words].join(' · ')
}

// --- shared helpers: the usage tier, the live stages, the agent list, the release review ----------


// tierOf: the usage tier (rule G3, v2 SPEC 13.5.2). The higher of the two windows decides; a missing
// reading is Normal (stop-new in API-key mode) (the skill fails open); an owner override keeps Normal below its pct.
export function tierOf(
  usage: Usage,
  config: Config,
  override: State['control']['usageOverride'],
  now: number,
): { tier: Tier; overridden: boolean } {
  // API-key mode (spend.ts): spend against the budget is the one reading; a missing one stops new work and
  // no override lifts it, because nothing then says how much was spent
  const spend = usage.auth === 'api-key' ? (usage.unavailable ? null : (usage.spend ?? null)) : undefined
  if (spend === null) return { tier: 'stop-new', overridden: false }
  if (spend === undefined && (usage.unavailable || (usage.fiveHour === null && usage.sevenDay === null))) {
    return { tier: 'normal', overridden: false }
  }
  const live = (pct: number | null, resetsAt: number | null) => (resetsAt !== null && now >= resetsAt ? 0 : (pct ?? 0))
  const binding = spend !== undefined
    ? live(Math.ceil((100 * spend.usd) / spend.budgetUsd), spend.resetsAt) // spend.ts spendPct
    : Math.max(live(usage.fiveHour, usage.fiveHourResetsAt), live(usage.sevenDay, usage.sevenDayResetsAt))
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

// listedLive: an agent list shows this agent still at work (the stop-agent executor asks too):
// listed, not failed or killed, and its turn not ended (turnEnded).
export function listedLive(agents: readonly AgentView[], agentId: string): boolean {
  const seen = agents.find(a => a.id === agentId)
  return seen !== undefined && !turnEnded(seen.status) && seen.status !== 'failed' && seen.status !== 'killed'
}

// turnEnded: an agent of the loop listed past its turn: `completed`, or `idle`, which the engine
// documents as between turns, until a message wakes it (AgentStatus). On Claude Code 2.1.299 an
// agent that ended its turn is listed idle for 20 s or more before completed (#560). Nothing but
// the loop's own repair message wakes one of its agents, and while that is on its way, or its
// reply awaited, the entry is running and the reconciling read holds it at work (act.ts
// reconcilable), so idle reads as ended here exactly as completed does.
export function turnEnded(status: AgentStatus): boolean {
  return status === 'completed' || status === 'idle'
}

// isoOf: a time as toISOString() writes it (UTC, to the millisecond), by calendar arithmetic: this
// module reads no clock and builds no Date, so the plan stays pure (a year 1000 to 9999 only).
export function isoOf(ms: Ms): string {
  const day = Math.floor(ms / 86_400_000)
  const left = ms - day * 86_400_000
  const z = day + 719_468
  const era = Math.floor(z / 146_097)
  const doe = z - era * 146_097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const month = mp < 10 ? mp + 3 : mp - 9
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0)
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  const date = `${pad(year, 4)}-${pad(month)}-${pad(doy - Math.floor((153 * mp + 2) / 5) + 1)}`
  return `${date}T${pad(Math.floor(left / 3_600_000))}:${pad(Math.floor(left / 60_000) % 60)}:${pad(Math.floor(left / 1000) % 60)}.${pad(left % 1000, 3)}Z`
}

// releaseDue: the review's key and fields: one release task per UTC hour, keyed by tag and hour whatever the waiting set is. `waiting`: the issues waiting on a release tag: the review is then due while the milestone has open items or none closed, and its fields name them. A release task already started this hour (running or ended) makes it null: a wait that arrives later joins the running review or gets the next hour's. `newest`: the newest known tag (the tag view), when given it is the key's and field's tag and `oldest` is left out if it differs from the release read's (that read belongs to the older tag). `short` is config.ts's shortDuration (this module imports types only; foundation.test.ts holds them together)
export function releaseDue({ milestone: m, release: r = null, sources, ledger, now }: State, config: Config, waiting: readonly number[] = [], newest: string | null = null) {
  const hour = (at: number) => isoOf(at).slice(0, 13), tag = newest ?? (r === null ? 'unknown' : (r.tag ?? 'none')), short = (ms: Ms) => ms > 0 && ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms > 0 && ms % 60_000 === 0 ? `${ms / 60_000}m` : ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`
  if (!sources.milestone.ok || m === null || (waiting.length === 0 && (m.open > 0 || m.closed === 0))) return null
  if (ledger.some(e => e.kind === 'task' && e.wake === 'release' && hour(e.startedAt) === hour(now))) return null
  return { key: `task:release:${tag}:${hour(now)}`, fields: { closed: m.closed, expected: m.expected, tag, oldest: r === null || r.oldest === null || (newest !== null && newest !== r.tag) ? null : isoOf(r.oldest), cadence: short(config.minimumReleaseCadenceMs), ...(waiting.length > 0 ? { waiting: [...waiting] } : {}) } }
}
