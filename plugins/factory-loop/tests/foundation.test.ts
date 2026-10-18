// The foundation (hooks/foundation.ts; docs/factory-loop/v2/SPEC.md 2.2): the generic plan code the
// v2 planner composes its rules with (the class matrix, gate, the admission filters, one wake, the
// title frame), the helpers the rest of the loop shares (the usage tier, the issue of a branch,
// the agent list's reading, the release review), and what v2 adds: the breaker's step-unknown
// bucket (5.3), a v2 agent step in the rate caps by its step kind (D-24), a key's own attempt cap,
// and v2's GitHub kinds.
import { describe, expect, test } from 'claude-code/testing'

import {
  ALLOWED,
  GITHUB_V2,
  LIVE,
  STEP_BREAKER,
  admit,
  gate,
  isoOf,
  issueFromBranch,
  listedLive,
  newCtx,
  oneWake,
  releaseDue,
  stepBreaker,
  tierOf,
  titleOf,
  turnEnded,
  wake,
  want,
} from '../hooks/foundation'
import type { PlanCtx } from '../hooks/foundation'
import { shortDuration } from '../hooks/config'
import { TIER_CLASSES } from '../hooks/rails'
import type { Action, AgentStatus, Config, LedgerEntry, State, Usage } from '../hooks/types'
import { V2_OWNER_TELLS } from '../hooks/v2/types'
import { MIN, NOW, config, entry, issue, mine, state, withLedger } from './fixtures'

const CFG = config()
const HOUR = 60 * MIN
// v2's owner notices and GitHub kinds are the planner's; these are the tests' own small sets
const OWNER = ['decision', 'escalate']

const keysOf = (actions: readonly Action[]) => actions.map(a => a.key)

function ctxOf(s: State, cfg: Config = CFG, owner: readonly string[] = OWNER, github: readonly Action['kind'][] = GITHUB_V2): PlanCtx {
  return newCtx(s, cfg, tierOf(s.usage, cfg, s.control.usageOverride, s.now), owner, github)
}

const reading = (fiveHour: number | null, sevenDay: number | null, unavailable = false): Usage => ({ fiveHour, sevenDay, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable })

describe('the usage tier (G3)', () => {
  test('the class matrix is the act step\'s', () => {
    expect(ALLOWED).toEqual(TIER_CLASSES)
  })

  test('the tier comes from the higher window; missing usage is Normal (SKILL:38-45)', () => {
    expect(tierOf(reading(10, 84), CFG, null, NOW).tier).toBe('normal')
    expect(tierOf(reading(85, 20), CFG, null, NOW).tier).toBe('slow')
    expect(tierOf(reading(10, 90), CFG, null, NOW).tier).toBe('stop-new')
    expect(tierOf(reading(95, 10), CFG, null, NOW).tier).toBe('stop-all')
    expect(tierOf(reading(null, null, true), CFG, null, NOW).tier).toBe('normal')
  })

  test('a window whose reset has passed counts as zero until the next read (SKILL:47-48)', () => {
    const u = { fiveHour: 97, sevenDay: 80, fiveHourResetsAt: NOW - MIN, sevenDayResetsAt: NOW + 3 * 86_400_000, unavailable: false }
    expect(tierOf(u, CFG, null, NOW).tier).toBe('normal')
    expect(tierOf({ ...u, sevenDay: 91 }, CFG, null, NOW).tier).toBe('stop-new')
    expect(tierOf({ ...u, fiveHourResetsAt: NOW + MIN }, CFG, null, NOW).tier).toBe('stop-all')
  })

  test('an owner override runs past a threshold until it expires (SKILL:49)', () => {
    const u = reading(60, 92)
    expect(tierOf(u, CFG, { untilPct: 100, expiresAt: NOW + MIN }, NOW)).toEqual({ tier: 'normal', overridden: true })
    expect(tierOf(u, CFG, { untilPct: 100, expiresAt: NOW - MIN }, NOW).tier).toBe('stop-new')
    expect(tierOf(u, CFG, { untilPct: 91, expiresAt: NOW + MIN }, NOW).tier).toBe('stop-new')
  })
})

describe('the shared helpers', () => {
  test('the issue comes from the branch convention issue-<N>', () => {
    expect(issueFromBranch('feat/issue-506-implementer-route-v2')).toBe(506)
    expect(issueFromBranch('issue-448-dev-statusline')).toBe(448)
    expect(issueFromBranch('chore/release-1.0')).toBeNull()
  })

  test('the live stages are the ones before a merge or a close', () => {
    expect(LIVE).toEqual(['designing', 'implementing', 'in pipeline', 'parked', 'waiting', 'ready to merge'])
  })

  test('an agent whose turn ended (completed, or idle between turns) is not at work; a failed or killed one is not live either', () => {
    for (const [status, ended] of [['completed', true], ['idle', true], ['running', false], ['waiting', false], ['pending', false], ['failed', false], ['killed', false]] as [AgentStatus, boolean][]) {
      expect({ status, ended: turnEnded(status) }).toEqual({ status, ended })
      expect({ status, live: listedLive([{ id: 'a1', type: 'x', status }], 'a1') }).toEqual({ status, live: status === 'running' || status === 'waiting' || status === 'pending' })
    }
    expect(listedLive([], 'a1')).toBe(false)
    expect(listedLive([{ id: 'a2', type: 'x', status: 'running' }], 'a1')).toBe(false)
  })
})

describe('isoOf: the time as toISOString writes it, from calendar arithmetic (the planner builds no Date)', () => {
  test('it agrees with Date over the days around every month and year end, and across a spread of times', () => {
    const times = [0, 951_782_400_000, 951_868_799_999, 1_709_164_799_999, 1_709_164_800_000, 4_102_444_799_999, NOW, NOW + 1, Date.UTC(2026, 11, 31, 23, 59, 59, 999)]
    for (let i = 0; i < 2000; i++) times.push(Math.floor((i * 2_654_435_761) % 4_000_000_000_000))
    for (const t of times) expect({ t, iso: isoOf(t) }).toEqual({ t, iso: new Date(t).toISOString() })
  })
})

describe('O3: the hourly release review (releaseDue, shared with v2)', () => {
  const RHOUR = new Date(NOW).toISOString().slice(0, 13)
  const closed = (over: Partial<State> = {}) => state({ milestone: { open: 0, closed: 5, openIssues: [], expected: 'minor' }, ...over })
  const done = (key: string, at: number, decision = 'hold') =>
    entry(key, 'task', { wake: 'release', class: 'drive', status: 'done', startedAt: at, endedAt: at + MIN, outcome: { kind: 'wake', decision, reason: null, instructions: null, bump: null, bumpReason: null, fields: {} } })

  test('the key names the last tag and the UTC hour; the fields are closed, expected, tag, oldest, cadence in order', () => {
    const oldest = Date.UTC(2026, 9, 12, 8, 30)
    const due = releaseDue(closed({ release: { tag: 'v1.0.0', oldest } }), CFG)
    expect(due?.key).toBe(`task:release:v1.0.0:${RHOUR}`)
    expect(Object.entries(due?.fields ?? {})).toEqual([['closed', 5], ['expected', 'minor'], ['tag', 'v1.0.0'], ['oldest', '2026-10-12T08:30:00.000Z'], ['cadence', '6h']])
    // the cadence is written out as config.ts's shortDuration does
    for (const ms of [3_600_000, 90 * 60_000, 2 * 3_600_000, 21_600_000, 3_661_000, 3_600_500]) {
      expect({ ms, cadence: releaseDue(closed({ release: { tag: 'v1.0.0', oldest } }), { ...CFG, minimumReleaseCadenceMs: ms })?.fields.cadence }).toEqual({ ms, cadence: shortDuration(ms) })
    }
    // no release yet: none; an unknown oldest is dropped
    const none = releaseDue(closed({ release: { tag: null, oldest: null } }), CFG)
    expect(none).toMatchObject({ key: `task:release:none:${RHOUR}`, fields: { closed: 5, expected: 'minor', tag: 'none' } })
    expect(Object.keys(none?.fields ?? {})).toEqual(['closed', 'expected', 'tag', 'oldest', 'cadence'])
  })

  test('two milestones at the same count each wake: a new tag, or a later hour', () => {
    const first = done(`task:release:v1.0.0:${RHOUR}`, NOW)
    expect(releaseDue(closed({ release: { tag: 'v1.1.0', oldest: null }, ledger: [...state().ledger, { ...first, startedAt: NOW - 2 * 3_600_000 }] }), CFG)?.key).toBe(`task:release:v1.1.0:${RHOUR}`)
    expect(releaseDue(closed({ now: NOW + 3_600_000, release: { tag: 'v1.0.0', oldest: null }, ledger: [...state().ledger, first] }), CFG)?.key).toBe('task:release:v1.0.0:2026-10-13T04')
  })

  test('at most one release task per UTC hour, whatever its key; a hold waits for the next hour', () => {
    const ledger = [...state().ledger, done(`task:release:v1.0.0:${RHOUR}`, NOW)]
    expect(releaseDue(closed({ release: { tag: 'v1.0.0', oldest: null }, ledger }), CFG)).toBeNull()
    expect(releaseDue(closed({ release: { tag: 'v1.1.0', oldest: null }, ledger }), CFG)).toBeNull()
    expect(releaseDue(closed({ now: NOW + 60 * MIN, release: { tag: 'v1.0.0', oldest: null }, ledger }), CFG)?.key).toBe('task:release:v1.0.0:2026-10-13T04')
  })

  test('the hour boundary: HH:59:59.999 and the next HH:00:00 differ, and the key has no colon', () => {
    expect(releaseDue(closed({ now: Date.UTC(2026, 9, 13, 3, 59, 59, 999) }), CFG)?.key).toBe('task:release:unknown:2026-10-13T03')
    expect(releaseDue(closed({ now: Date.UTC(2026, 9, 13, 4, 0, 0) }), CFG)?.key).toBe('task:release:unknown:2026-10-13T04')
  })

  test('waiting issues (v2): `waiting` joins the fields and the review is due with open items or none closed; one per UTC hour; none given leaves the rule and fields as they were', () => {
    const open = state({ milestone: { open: 2, closed: 0, openIssues: [], expected: null }, release: { tag: 'v1.0.0', oldest: null } })
    expect(releaseDue(open, CFG)).toBeNull()
    expect(releaseDue(open, CFG, [])).toBeNull()
    expect(releaseDue(open, CFG, [7, 9])).toMatchObject({ key: `task:release:v1.0.0:${RHOUR}`, fields: { waiting: [7, 9] } })
    const plain = releaseDue(closed({ release: { tag: 'v1.0.0', oldest: null } }), CFG)
    expect(Object.keys(plain?.fields ?? {})).not.toContain('waiting')
    expect(Object.keys(releaseDue(closed({ release: { tag: 'v1.0.0', oldest: null } }), CFG, [3])?.fields ?? {})).toEqual(['closed', 'expected', 'tag', 'oldest', 'cadence', 'waiting'])
    expect(releaseDue({ ...open, ledger: [...open.ledger, done(`task:release:v1.0.0:${RHOUR}`, NOW)] }, CFG, [7])).toBeNull()
    expect(releaseDue({ ...open, milestone: null }, CFG, [7])).toBeNull()
    expect(releaseDue({ ...open, sources: { ...open.sources, milestone: { ok: false, at: NOW } } }, CFG, [7])).toBeNull()
  })

  test('no review with an open item, nothing closed, a milestone source that is not ok, or no milestone', () => {
    expect(releaseDue(state({ milestone: { open: 1, closed: 5, openIssues: [], expected: null } }), CFG)).toBeNull()
    expect(releaseDue(state({ milestone: { open: 0, closed: 0, openIssues: [], expected: null } }), CFG)).toBeNull()
    expect(releaseDue(state({ milestone: null }), CFG)).toBeNull()
    const s = closed()
    expect(releaseDue({ ...s, sources: { ...s.sources, milestone: { ok: false, at: NOW } } }, CFG)).toBeNull()
  })
})

describe('gate: a failed key waits out its backoff, runs again, and is used up', () => {
  test('the cases by status, attempts and time since it ended', () => {
    const s = state({ queue: [7], issues: [issue(7)] })
    const key = `claim:7:${NOW - 30 * MIN}`
    const cases: [Partial<LedgerEntry>, string][] = [
      [{ status: 'failed', attempts: 1, endedAt: NOW - MIN }, 'wait'],
      [{ status: 'failed', attempts: 1, endedAt: NOW - 5 * MIN }, 'go'],
      [{ status: 'failed', attempts: 2, endedAt: NOW - 3 * MIN }, 'wait'],
      [{ status: 'lost', attempts: 1, endedAt: NOW - MIN }, 'go'],
      [{ status: 'failed', attempts: 3, endedAt: NOW - HOUR }, 'exhausted'],
      [{ status: 'running', endedAt: null }, 'running'],
      [{ status: 'done' }, 'done'],
    ]
    for (const [over, g] of cases) {
      const held = withLedger(s, [entry(key, 'claim', { class: 'start', issue: 7, ...over })])
      expect({ over, gate: gate(ctxOf(held), key, 'claim') }).toEqual({ over, gate: g })
    }
  })
})

describe('the title frame', () => {
  const frame = { repo: 'cbundy/dev-system', counts: 'Q:2 - D:1 - M:0', observe: false, blind: false, before: [], tier: 'normal' as const, after: [], atCap: false, capped: [], backoff: false, owner: 0 }

  test('the counts, then a word for each thing that needs attention, in order', () => {
    expect(titleOf(frame)).toBe('🔄 dev-system (Q:2 - D:1 - M:0)')
    expect(titleOf({ ...frame, observe: true })).toBe('🔄 dev-system (Q:2 - D:1 - M:0) · observe')
    expect(titleOf({ ...frame, observe: true, tier: 'stop-new' })).toBe('🔄 dev-system (Q:2 - D:1 - M:0) · observe · stop new')
    expect(titleOf({ ...frame, tier: 'stop-all' })).toBe('🔄 dev-system (Q:2 - D:1 - M:0) · stop all')
    expect(titleOf({ ...frame, before: ['checkout'], tier: 'stop-new', after: ['stuck 1'], atCap: true, capped: ['start', 'spawn:60'], backoff: true, owner: 2 })).toBe(
      '🔄 dev-system (Q:2 - D:1 - M:0) · checkout · stop new · stuck 1 · at cap · capped start · capped spawn:60 · gh wait · owner 2',
    )
  })

  test('a blind pass has no counts: blind takes their place', () => {
    expect(titleOf({ ...frame, counts: null, observe: true, blind: true, owner: 1 })).toBe('🔄 dev-system · observe · blind · owner 1')
  })
})

describe('one wake (O2)', () => {
  const tell = (name: string) => wake('tell', name, `tell:${name}:1`, 'O2', null, {})
  const judge = wake('judge', 'report', 'judge:report:1', 'D3', 1, {})
  const task = wake('task', 'release', 'task:release:1:none', 'O3', null, {})

  test('one wake goes: an owner notice first, then a judge, then a task, then any other notice; the rest wait', () => {
    const lists: [Action[], string][] = [
      [[tell('runaway'), task, judge, tell('decision')], 'tell:decision:1'],
      [[tell('runaway'), task, judge], 'judge:report:1'],
      [[tell('runaway'), task], 'task:release:1:none'],
      [[tell('runaway'), tell('blind')], 'tell:runaway:1'],
    ]
    for (const [list, chosen] of lists) {
      const ctx = ctxOf(state())
      const kept = oneWake(ctx, [...list, { kind: 'sweep', key: 'sweep:0', class: 'free', rule: 'H2', reason: 'x', issue: null }])
      expect(keysOf(kept)).toEqual([chosen, 'sweep:0'])
      expect(ctx.skipped.filter(s => s.why === 'one wake per pass')).toHaveLength(list.length - 1)
    }
  })

  test('none while a wake is open, and v2\'s owner notices rank first under v2', () => {
    const open = withLedger(state(), [entry('tell:x:1', 'tell', { wake: 'x', status: 'running', endedAt: null })])
    const ctx = ctxOf(open)
    expect(keysOf(oneWake(ctx, [tell('decision')]))).toEqual([])
    expect(ctx.skipped).toEqual([{ rule: 'O2', issue: null, why: 'a wake is open' }])
    const v2 = ctxOf(state(), CFG, V2_OWNER_TELLS)
    expect(keysOf(oneWake(v2, [judge, tell('parked')]))).toEqual(['tell:parked:1'])
  })
})

// --- what v2 adds ---------------------------------------------------------------------------------------

// A done transition that handled an unknown of an agent step (v2 SPEC 5.3), as its outcome records it.
function unknownAt(issue: number, at: number, cause: 'load' | 'usage' | 'breaker' | 'slot' | null = null, step: 'build' | 'lease' = 'build', event: 'unknown' | 'timeout' = 'unknown'): LedgerEntry {
  return entry(`i${issue}/lss1x2k/s${at}/t`, 'transition', {
    issue,
    startedAt: at,
    endedAt: at,
    outcome: { kind: 'transition', row: 'U2', event, cause, from: 'building', to: 'building', step, stored: true },
  })
}

const agentStep = (issue: number, step: 'design' | 'build' | 'review' | 'fix' | 'triage', klass: 'develop' | 'drive' = 'develop'): Action => ({
  kind: 'agent-step',
  key: `i${issue}/lss1x2k/s1/${step}/a1`,
  class: klass,
  rule: 'S2',
  reason: 'step',
  issue,
  step,
  life: 'ss1x2k',
  seq: 1,
  attempt: 1,
  branch: `issue-${issue}`,
  slot: null,
  notes: [],
})

describe('the step-unknown breaker (v2 SPEC 5.3)', () => {
  test('three unexplained unknowns of agent steps on two issues within 15 minutes trip it, for 30 minutes from the newest', () => {
    const three = [unknownAt(1, NOW - 10 * MIN), unknownAt(2, NOW - 8 * MIN), unknownAt(1, NOW - 4 * MIN, null, 'build', 'timeout')]
    expect(stepBreaker(three, NOW)).toEqual({ since: NOW - 4 * MIN, until: NOW - 4 * MIN + STEP_BREAKER.holdMs })
    expect(stepBreaker(three, NOW - 4 * MIN + STEP_BREAKER.holdMs)).toBeNull()
  })

  test('it stays closed for one issue alone, for unknowns spread past the window, for a load, a usage limit or a lost slot, and for steps no agent runs', () => {
    const closed: [string, LedgerEntry[]][] = [
      ['one issue', [unknownAt(1, NOW - 10 * MIN), unknownAt(1, NOW - 8 * MIN), unknownAt(1, NOW - 4 * MIN)]],
      ['spread', [unknownAt(1, NOW - 40 * MIN), unknownAt(2, NOW - 20 * MIN), unknownAt(3, NOW - 4 * MIN)]],
      ['explained', [unknownAt(1, NOW - 10 * MIN, 'load'), unknownAt(2, NOW - 8 * MIN, 'usage'), unknownAt(3, NOW - 4 * MIN, 'slot')]],
      ['two only', [unknownAt(1, NOW - 10 * MIN), unknownAt(2, NOW - 8 * MIN), unknownAt(3, NOW - 4 * MIN, 'load')]],
      ['not an agent step', [unknownAt(1, NOW - 10 * MIN, null, 'lease'), unknownAt(2, NOW - 8 * MIN, null, 'lease'), unknownAt(3, NOW - 4 * MIN, null, 'lease')]],
    ]
    for (const [name, ledger] of closed) expect({ name, open: stepBreaker(ledger, NOW) }).toEqual({ name, open: null })
    // the breaker's own cause counts: an unknown while it was open is not explained
    expect(stepBreaker([unknownAt(1, NOW - 10 * MIN, 'breaker'), unknownAt(2, NOW - 8 * MIN), unknownAt(3, NOW - 4 * MIN)], NOW)).not.toBeNull()
  })

  test('the unknowns that end while it holds are its own: they neither extend the hold nor move its since (fault drill 1, 2026-10-15)', () => {
    // two unknowns, then the one that trips it; then the unknowns its hold brought, on both records
    const t0 = NOW - 40 * MIN
    const trip = t0 + 11 * MIN
    const ledger = [unknownAt(4, t0), unknownAt(3, t0 + 5_000), unknownAt(4, trip, 'breaker'), unknownAt(3, trip + 5_000, 'breaker'), unknownAt(4, t0 + 22 * MIN, 'breaker'), unknownAt(3, t0 + 22 * MIN + 5_000, 'breaker')]
    const held = { since: trip, until: trip + STEP_BREAKER.holdMs }
    expect(stepBreaker(ledger, trip + MIN)).toEqual(held)
    expect(stepBreaker(ledger, t0 + 23 * MIN)).toEqual(held)
    expect(stepBreaker(ledger, held.until)).toBeNull()
    // after the hold, three new unknowns trip it again
    const after = [...ledger, unknownAt(1, held.until + MIN), unknownAt(2, held.until + 2 * MIN), unknownAt(1, held.until + 3 * MIN)]
    expect(stepBreaker(after, held.until + 4 * MIN)).toEqual({ since: held.until + 3 * MIN, until: held.until + 3 * MIN + STEP_BREAKER.holdMs })
  })

  test('it is told once it trips, though the pass asks for nothing it holds (v2 SPEC 5.3, 7.2)', () => {
    const s = withLedger(state(), [unknownAt(1, NOW - 10 * MIN), unknownAt(2, NOW - 8 * MIN), unknownAt(3, NOW - 4 * MIN)])
    const ctx = ctxOf(s, CFG, V2_OWNER_TELLS, GITHUB_V2)
    ctx.out = [{ kind: 'label', key: 'i1/lss1x2k/s2/label', class: 'free', rule: 'S3', reason: 'label', issue: 1, op: 'set', label: 'factory:building' }]
    expect(keysOf(admit(ctx))).toEqual(['i1/lss1x2k/s2/label', `tell:breaker:steps:${NOW - 4 * MIN}`])
    expect(ctx.skipped).toEqual([])
    expect(ctx.owner.has(`tell:breaker:steps:${NOW - 4 * MIN}`)).toBe(true)
    // closed: nothing told
    const quiet = ctxOf(state(), CFG, V2_OWNER_TELLS, GITHUB_V2)
    quiet.out = []
    expect(keysOf(admit(quiet))).toEqual([])
  })

  test('while open it holds every start, develop and drive action, names the filter, and tells the owner once as an owner item; free work goes on', () => {
    const s = withLedger(state({ queue: [7], issues: [issue(7)] }), [unknownAt(1, NOW - 10 * MIN), unknownAt(2, NOW - 8 * MIN), unknownAt(3, NOW - 4 * MIN)])
    const ctx = ctxOf(s, CFG, V2_OWNER_TELLS, GITHUB_V2)
    ctx.out = [
      { kind: 'claim', key: 'i7/claim/x', class: 'start', rule: 'S1', reason: 'claim', issue: 7 },
      agentStep(1, 'build'),
      agentStep(2, 'triage', 'drive'),
      { kind: 'label', key: 'i1/lss1x2k/s2/label', class: 'free', rule: 'S3', reason: 'label', issue: 1, op: 'set', label: 'factory:building' },
    ]
    const kept = admit(ctx)
    expect(keysOf(kept)).toEqual(['i1/lss1x2k/s2/label', `tell:breaker:steps:${NOW - 4 * MIN}`])
    expect(ctx.skipped.map(x => x.why)).toEqual(['breaker open: step unknowns (claim)', 'breaker open: step unknowns (agent-step)', 'breaker open: step unknowns (agent-step)'])
    expect(ctx.owner.has(`tell:breaker:steps:${NOW - 4 * MIN}`)).toBe(true)
    // told once: the tell's own key, done, goes no more
    const told = withLedger(s, [entry(`tell:breaker:steps:${NOW - 4 * MIN}`, 'tell', { wake: 'breaker' })])
    const again = ctxOf(told, CFG, V2_OWNER_TELLS, GITHUB_V2)
    again.out = [agentStep(1, 'build')]
    expect(keysOf(admit(again))).toEqual([])
  })
})

describe('v2 actions in the foundation\'s filters', () => {
  test('an agent step counts in the spawn bucket, and the per-issue cap counts it by its step kind (D-24)', () => {
    const builds = Array.from({ length: 6 }, (_, i) => entry(`i5/lss1x2k/s${i}/build/a1`, 'agent-step', { class: 'develop', issue: 5, step: 'build', status: 'lost', startedAt: NOW - 30 * MIN }))
    const ctx = ctxOf(withLedger(state(), builds), CFG, V2_OWNER_TELLS, GITHUB_V2)
    ctx.out = [agentStep(5, 'build'), agentStep(5, 'fix', 'drive')]
    expect(keysOf(admit(ctx))).toEqual(['i5/lss1x2k/s1/fix/a1', 'tell:runaway:build:5:' + Math.floor(NOW / HOUR)])
    expect(ctx.capped).toEqual(['build:5'])
    expect(ctx.skipped).toContainEqual({ rule: 'S2', issue: 5, why: 'rate cap: build on #5 6/6' })
    const spawns = Array.from({ length: CFG.rateCaps.spawn }, (_, i) => entry(`s${i}`, 'agent-step', { class: 'drive', issue: 100 + i, step: 'review', startedAt: NOW - 10 * MIN }))
    const full = ctxOf(withLedger(state(), spawns), CFG, V2_OWNER_TELLS, GITHUB_V2)
    full.out = [agentStep(6, 'review', 'drive')]
    admit(full)
    expect(full.capped).toEqual(['spawn'])
  })

  test('a GitHub backoff holds v2\'s GitHub writes and nothing else of v2\'s', () => {
    const s = state({ githubBackoffUntil: NOW + MIN })
    const ctx = ctxOf(s, CFG, V2_OWNER_TELLS, GITHUB_V2)
    ctx.out = [
      { kind: 'label', key: 'l', class: 'free', rule: 'S3', reason: 'x', issue: 1, op: 'set', label: 'factory:queued' },
      { kind: 'ci-rerun', key: 'r', class: 'free', rule: 'S2', reason: 'x', issue: 1, pr: 2, runId: '3', round: 1 },
      { kind: 'transition', key: 't', class: 'free', rule: 'S3', reason: 'x', issue: 1, row: 'T1', event: 'ok', from: null, next: {} as never, trigger: { kind: 'fact', fact: 'x' } },
    ]
    expect(keysOf(admit(ctx))).toEqual(['t'])
  })

  test('a key\'s own attempt cap, from its action or its entry, decides when it is used up', () => {
    const failed = (attempts: number) => withLedger(state(), [entry('slot/l1/free', 'slot', { status: 'failed', attempts, endedAt: NOW - HOUR, maxAttempts: 2 })])
    const free: Action = { kind: 'slot', key: 'slot/l1/free', class: 'free', rule: 'W2', reason: 'free', issue: 1, op: 'free', life: 'x', path: '/p', lease: 'l1', branch: null, marker: null, keepScratch: false, maxAttempts: 2 }
    expect(gate(ctxOf(failed(1)), free.key, 'slot', free.maxAttempts)).toBe('go')
    expect(gate(ctxOf(failed(2)), free.key, 'slot', free.maxAttempts)).toBe('exhausted')
    // the entry's own cap stands when the action names none, and the kind's default (3) when neither does
    expect(gate(ctxOf(failed(2)), free.key, 'slot')).toBe('exhausted')
    const plain = withLedger(state(), [entry('slot/l1/free', 'slot', { status: 'failed', attempts: 2, endedAt: NOW - HOUR })])
    expect(gate(ctxOf(plain), free.key, 'slot')).toBe('go')
    // want names an exhausted key and keeps it for its rule to tell
    const ctx = ctxOf(failed(2))
    expect(want(ctx, free)).toBe('exhausted')
    expect(ctx.exhausted).toEqual(['slot/l1/free'])
    expect(ctx.skipped).toEqual([{ rule: 'W2', issue: 1, why: 'exhausted: slot/l1/free' }])
  })
})
