// The foundation (hooks/foundation.ts; docs/factory-loop/v2/SPEC.md 2.2): its copies of plan.ts's
// generic code behave as v1's own on v1's fixtures (parity), and what v2 adds to it: the breaker's
// step-unknown bucket (5.3), a v2 agent step in the rate caps by its step kind (D-24), a key's own
// attempt cap, and v2's GitHub kinds.
//
// Parity: v1's admission is private to plan.ts, so it is compared through plan() itself. For each
// fixture, v1's plan with no filter in play gives what v1 wants; the same wanted actions through
// foundation's admit, on the state with a filter in play, keep exactly what v1's own plan of that
// state keeps, and trip the same caps. With no filter in play they keep all of it.
import { describe, expect, test } from 'claude-code/testing'

import {
  ALLOWED,
  GITHUB_V2,
  STEP_BREAKER,
  admit,
  gate,
  newCtx,
  oneWake,
  stepBreaker,
  tierOf,
  titleOf,
  wake,
  want,
} from '../hooks/foundation'
import type { PlanCtx } from '../hooks/foundation'
import { LIVE, checkoutMoved, plan, tierOf as v1TierOf, titleOf as v1TitleOf } from '../hooks/plan'
import type { TitleNotes } from '../hooks/plan'
import { TIER_CLASSES } from '../hooks/rails'
import type { Action, Config, LedgerEntry, PlanResult, State, Tier, Usage } from '../hooks/types'
import { V2_OWNER_TELLS } from '../hooks/v2/types'
import { MIN, NOW, config, control, entry, issue, mine, state, withLedger } from './fixtures'

const CFG = config()
const HOUR = 60 * MIN
// v1's owner notices and GitHub kinds, private to plan.ts (OWNER_TELLS, GITHUB): as they stand there
const V1_OWNER = ['decision', 'escalate', 'review-cap', 'merge-refused', 'merge-hold', 'untrusted-pr', 'rollout', 'base', 'no-ci', 'ci-triggers', 'update-behind', 'linkage', 'checkout']
const V1_GITHUB: Action['kind'][] = ['claim', 'heartbeat', 'sweep', 'guard', 'update-behind', 'fix-linkage', 'merge', 'rollout', 'close-issue', 'release-parent', 'abandon', 'milestone-later', 'milestone-expect', 'pr-reopen', 'pr-comment', 'pr-close']

const usage = (pct: number): Usage => ({ fiveHour: pct, sevenDay: pct, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false })
const wanted = (r: PlanResult) => r.actions.filter(a => a.kind !== 'title' && a.kind !== 'restart-self')
const keysOf = (actions: readonly Action[]) => actions.map(a => a.key)

function ctxOf(s: State, cfg: Config = CFG, owner: readonly string[] = V1_OWNER, github: readonly Action['kind'][] = V1_GITHUB): PlanCtx {
  return newCtx(s, cfg, v1TierOf(s.usage, cfg, s.control.usageOverride, s.now), owner, github)
}

// admitted: foundation's admission of these actions on this state.
function admitted(s: State, actions: readonly Action[]) {
  const ctx = ctxOf(s)
  ctx.out = [...actions]
  return { kept: admit(ctx), ctx }
}

// v1's fixtures: work of each class an admission filter reads (start, develop, drive, free)
const SCENARIOS: Record<string, State> = {
  'two claims': state({ queue: [7, 8], issues: [issue(7), issue(8)] }),
  'a design': state({ issues: [mine(60, 'designing')] }),
  'a claim and a design': state({ queue: [9], issues: [issue(9), mine(61, 'designing')] }),
  'housekeeping due': state({ ledger: [], issues: [mine(62, 'implementing')] }),
}

// The filters, each on a state where v1's rules want the same actions and only admission differs.
const FILTERS: Record<string, (s: State) => State> = {
  'every issue paused': s => ({ ...s, control: control({ paused: [7, 8, 9, 60, 61, 62] }) }),
  'no new work': s => ({ ...s, control: control({ noNewWork: true }) }),
  'stop new': s => ({ ...s, usage: usage(91) }),
  'stop all': s => ({ ...s, usage: usage(96) }),
  'a GitHub backoff': s => ({ ...s, githubBackoffUntil: NOW + 10 * MIN }),
  'the start cap': s => withLedger(s, Array.from({ length: 30 }, (_, i) => entry(`claim:${100 + i}:x`, 'claim', { class: 'start', startedAt: NOW - 30 * MIN }))),
  'the spawn cap on one issue': s =>
    withLedger(s, Array.from({ length: 6 }, (_, i) => entry(`design:60:old${i}`, 'spawn', { agent: 'designer', class: 'develop', issue: 60, status: 'lost', startedAt: NOW - 40 * MIN }))),
  'the claim breaker': s =>
    withLedger(s, [1, 2, 3].map(i => entry(`claim:${200 + i}:x`, 'claim', { class: 'start', issue: 200 + i, status: 'failed', attempts: 3, startedAt: NOW - (10 + i) * MIN, endedAt: NOW - (5 + i) * MIN }))),
}

describe('parity with plan.ts (v2 SPEC 2.2)', () => {
  test('the class matrix is v1\'s, and the act step\'s; the tier is plan.ts\'s own', () => {
    expect(ALLOWED).toEqual(TIER_CLASSES)
    expect(tierOf).toBe(v1TierOf)
  })

  test('with no filter in play, admission keeps every action v1 keeps', () => {
    for (const [name, s] of Object.entries(SCENARIOS)) {
      const r = plan(s, CFG)
      expect({ name, kept: keysOf(admitted(s, wanted(r)).kept) }).toEqual({ name, kept: keysOf(wanted(r)) })
    }
  })

  test('each generic filter keeps exactly what v1 keeps, trips the same caps, and names why it held each action', () => {
    for (const [name, s] of Object.entries(SCENARIOS)) {
      const want0 = wanted(plan(s, CFG))
      for (const [filter, apply] of Object.entries(FILTERS)) {
        const held = apply(s)
        const v1 = plan(held, CFG)
        const f = admitted(held, want0)
        const ours = (kept: readonly Action[]) => keysOf(kept.filter(a => a.kind !== 'tell' || (a.wake !== 'runaway' && a.wake !== 'breaker'))).sort()
        expect({ name, filter, kept: ours(f.kept) }).toEqual({ name, filter, kept: ours(wanted(v1)).filter(k => want0.some(a => a.key === k)) })
        expect({ name, filter, capped: f.ctx.capped }).toEqual({ name, filter, capped: v1.capped })
        for (const a of want0.filter(x => !f.kept.some(k => k.key === x.key))) {
          expect({ name, filter, key: a.key, skipped: f.ctx.skipped.some(sk => sk.rule === a.rule && sk.issue === a.issue) }).toEqual({ name, filter, key: a.key, skipped: true })
        }
        // the tripped cap and breaker tell the owner as v1's do
        const notices = (kept: readonly Action[]) => keysOf(kept.filter(a => a.kind === 'tell' && (a.wake === 'runaway' || a.wake === 'breaker'))).sort()
        expect({ name, filter, notices: notices(f.kept) }).toEqual({ name, filter, notices: notices(v1.actions) })
      }
    }
  })

  test('a failed key waits out its backoff, runs again, and is used up as v1\'s gate says', () => {
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
      // v1 plans the claim exactly when the copy's gate says go
      expect({ over, planned: keysOf(plan(held, CFG).actions).includes(key) }).toEqual({ over, planned: g === 'go' })
    }
  })

  test('the title frame gives v1\'s titles', () => {
    const states: State[] = [
      SCENARIOS['two claims'] as State,
      state({ issues: [mine(60, 'designing'), mine(61, 'merged', { stageSince: NOW - HOUR }), mine(62, 'parked', { stuck: 'S3 parked' })], queue: [1] }),
      state({ githubBackoffUntil: NOW + MIN, checkout: { branch: 'x', head: 'h', defaultBranch: 'main', dirty: [] } }),
    ]
    const notes: TitleNotes[] = [
      { owner: 0, blind: false, capped: [], atCap: false },
      { owner: 2, blind: false, capped: ['start', 'spawn:60'], atCap: true },
      { owner: 1, blind: true, capped: [], atCap: false },
    ]
    for (const s of states) {
      for (const n of notes) {
        for (const tier of ['normal', 'slow', 'stop-new', 'stop-all'] as Tier[]) {
          for (const mode of ['observe', 'act'] as const) {
            const cfg = config({ mode })
            const live = s.issues.filter(i => i.open !== false && i.stage !== null && LIVE.includes(i.stage))
            const merged = s.issues.filter(i => i.stage === 'merged' && i.stageSince !== null && s.now - i.stageSince <= 6 * HOUR).length
            const stuck = live.filter(i => i.stuck !== null).length
            const frame = {
              repo: s.repo,
              counts: n.blind ? null : `Q:${s.queue.length} - D:${live.length} - M:${merged}`,
              observe: mode !== 'act',
              blind: n.blind,
              before: checkoutMoved(s) === null ? [] : ['checkout'],
              tier,
              after: !n.blind && stuck > 0 ? [`stuck ${stuck}`] : [],
              atCap: n.atCap,
              capped: n.capped,
              backoff: s.githubBackoffUntil !== null && s.now < s.githubBackoffUntil,
              owner: n.owner,
            }
            expect(titleOf(frame)).toBe(v1TitleOf(s, cfg, tier, n))
          }
        }
      }
    }
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
