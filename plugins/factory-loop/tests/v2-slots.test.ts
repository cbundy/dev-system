// The slots under planner v2 (docs/factory-loop/v2/SPEC.md 10.1, 10.2, 10.8, 3.5, 5.1, 17.1
// properties 5, 6 and 11): W2 frees a loop slot no record holds, W1 leases one for the records that
// need one as far as capacity, the reserve and the tier allow, and the `slot` executor runs the
// plugin's factory-slot tool and reads its result line. Plans are driven through planV2 itself;
// keys are found through the key codec (keys.ts), never as literals. The tool itself is tested over
// real git in tests/factory-loop-v2-slot.test.js.
import { describe, expect, test } from 'claude-code/testing'

import { ctxOf, dispatch } from '../hooks/act'
import type { ActEnv } from '../hooks/act'
import type { ActIo } from '../hooks/exec'
import { start } from '../hooks/ledger'
import type { Runtime } from '../hooks/observe'
import type { Action, Config, LedgerEntry, PlanResult, State } from '../hooks/types'
import { SLOT_SCRIPT, readSlot, slotArgv } from '../hooks/v2/act-slots'
import { freeKey, leaseKey, lifeOf, prepareKey, stepKey, transitionKey } from '../hooks/v2/keys'
import { emptyV2State, holderOf } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { madeRecord } from '../hooks/v2/table'
import { ISSUE_STATES, SLOT_STATES } from '../hooks/v2/types'
import type { IssueRecord, IssueState, Lease, StepMarker, V2State } from '../hooks/v2/types'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, control, entry, state as baseState } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const HOUR = 60 * MIN
const CFG = config({ planner: 'v2', mode: 'act', maxInFlightIssues: 3, worktreeReserve: 2 })
const LIFE = lifeOf(NOW - 2 * HOUR)
const OK = { ok: true, at: NOW }

type Slot = Extract<Action, { kind: 'slot' }>

// rec: a record of one life, settled at seq 3 in building unless the test says otherwise.
function rec(n: number, over: Partial<IssueRecord> = {}): IssueRecord {
  return { ...madeRecord({ issue: n, life: LIFE, branch: `issue-${n}`, pr: null, others: [] }, NOW - 30 * MIN), seq: 3, seqAt: NOW - 20 * MIN, state: 'building', step: 'build', since: NOW - 20 * MIN, ...over }
}

const queued = (n: number, over: Partial<IssueRecord> = {}) => rec(n, { state: 'queued', step: 'lease', seq: 1, ...over })

const leaseFor = (r: Pick<IssueRecord, 'issue' | 'life'>): Lease => ({ path: `/slots/${r.issue}-${r.life}`, lease: `L${r.issue}${r.life}`, holder: holderOf(r.issue, r.life), issue: r.issue, life: r.life, status: 'leased', busy: false })

// world: these records, each in a slot state holding its slot, every v2 source read, the pool with
// `free` free slots.
function world(records: IssueRecord[], over: { free?: number; leases?: Lease[]; ledger?: LedgerEntry[] } & Partial<State> = {}, v2: Partial<V2State> = {}): State {
  const { free = 10, leases, ledger = [], ...rest } = over
  const s = baseState({ pool: { free, total: 16, slots: [] }, ...rest })
  const base = emptyV2State(NOW, records)
  return {
    ...s,
    ledger: [...s.ledger, ...ledger],
    v2: { ...base, sources: { store: OK, leases: OK, prs: OK, interventions: OK, comments: OK }, leases: leases ?? records.filter(r => SLOT_STATES.includes(r.state)).map(leaseFor), ...v2 },
  }
}

const plan = (s: State, cfg: Config = CFG): PlanResult => planV2(s, cfg)
const slots = (r: PlanResult, op?: Slot['op']): Slot[] => r.actions.filter((a): a is Slot => a.kind === 'slot' && (op === undefined || a.op === op))
const leased = (r: PlanResult) => slots(r, 'lease').map(a => a.issue)
const freed = (r: PlanResult) => slots(r, 'free').map(a => a.lease)
const said = (r: PlanResult, n: number | null) => r.skipped.filter(s => s.issue === n).map(s => s.why)

// leaseEntry: a lease attempt of the record's life, keyed by its number.
function leaseEntry(r: Pick<IssueRecord, 'issue' | 'life'>, n: number, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return entry(leaseKey(r, n), 'slot', { issue: r.issue, rule: 'W1', startedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN, ...over })
}

// --- W1: lease ----------------------------------------------------------------------------------------------

describe('W1: lease', () => {
  test('a queued record is leased a slot for its life, once; the lease leads it on (T1) and nothing leases it again', () => {
    const r = queued(20)
    const p = plan(world([r]))
    expect(slots(p, 'lease')).toEqual([expect.objectContaining({ key: leaseKey(r, 1), class: 'free', rule: 'W1', issue: 20, life: LIFE, path: null, lease: null, maxAttempts: 3 })])
    // the lease shows in the pool: T1 takes it, and W1 has nothing to do
    const held = plan(world([r], { leases: [leaseFor(r)], ledger: [leaseEntry(r, 1)] }))
    expect(leased(held)).toEqual([])
    expect(held.actions.find(a => a.kind === 'transition' && a.issue === 20)).toMatchObject({ row: 'T1' })
  })

  test('capacity: queued records are leased while those in flight stay under K; parked and closed records never count; the cap shows in the title', () => {
    const records = [rec(1), rec(2, { state: 'parked', step: null }), rec(3, { state: 'closed', step: null, why: 'merged' }), queued(10), queued(11), queued(12)]
    const p = plan(world(records))
    expect(leased(p)).toEqual([10, 11])
    expect(said(p, 12)).toContain('W1: capacity: 3 of 3 in flight')
    expect(p.atCap).toBe(true)
    // a queued record that holds its lease already counts
    const taking = plan(world([rec(1), queued(10), queued(11), queued(12)], { leases: [leaseFor(rec(1)), leaseFor(queued(10))] }))
    expect(leased(taking)).toEqual([11])
    expect(leased(plan(world([rec(1), queued(10), queued(11)]), { ...CFG, maxInFlightIssues: null }))).toEqual([10, 11])
  })

  test('the reserve: a queued record is leased only while the pool\'s free slots exceed worktreeReserve, each lease taking one', () => {
    const p = plan(world([queued(10), queued(11), queued(12)], { free: 3 }))
    expect(leased(p)).toEqual([10])
    expect(said(p, 11)).toContain('W1: no free worktree: 2 free, 2 kept in reserve')
    expect(leased(plan(world([queued(10)], { free: 2 })))).toEqual([])
    // the pool's free slots not known: nothing is leased, and the record says why
    const blind = baseState().sources
    const unread = plan(world([queued(10)], { sources: { ...blind, pool: { ok: false, at: null, error: 'treehouse failed' } } }))
    expect(leased(unread)).toEqual([])
    expect(said(unread, 10)).toContain('W1: the pool\'s free slots are not known (treehouse failed)')
  })

  test('order: a lost slot first, then resumes by the time they parked, then new claims by claim time', () => {
    const lost = rec(30, { state: 'reviewing', step: 'review' })
    const early = queued(31, { life: lifeOf(NOW - 5 * HOUR) })
    const late = queued(32, { life: lifeOf(NOW - 4 * HOUR) })
    // two resumes: #34 parked before #33, though #33 was claimed first and resumed first
    const r33 = queued(33, { life: lifeOf(NOW - 9 * HOUR), seq: 6, since: NOW - 30 * MIN })
    const r34 = queued(34, { life: lifeOf(NOW - 8 * HOUR), seq: 6, since: NOW - 10 * MIN })
    const parkedAt = (r: IssueRecord, at: number) => entry(transitionKey({ ...r, seq: 5 }), 'transition', { issue: r.issue, startedAt: at, endedAt: at, outcome: { kind: 'transition', row: 'U4', event: 'unknown', cause: null, from: 'building', to: 'parked', step: 'build', stored: true, via: 'unknown:timeout' } })
    const s = world([late, r33, early, lost, r34], { leases: [], ledger: [parkedAt(r33, NOW - 3 * HOUR), parkedAt(r34, NOW - 6 * HOUR)] })
    expect(leased(plan(s, { ...CFG, maxInFlightIssues: null }))).toEqual([30, 34, 33, 31, 32])
    // with room for two more in flight, the lost slot takes none of it
    expect(leased(plan(s, { ...CFG, maxInFlightIssues: 3 }))).toEqual([30, 34, 33])
  })

  test('a slot state whose lease vanished is leased again, above K and with one free slot, once its step stopped running; the step waits for it meanwhile', () => {
    const others = [rec(1), rec(2), rec(3)]
    const lost = rec(40, { state: 'designing', step: 'design' })
    const leases = others.map(leaseFor)
    const p = plan(world([...others, lost], { leases, free: 1 }))
    expect(slots(p, 'lease')).toEqual([expect.objectContaining({ issue: 40, key: leaseKey(lost, 1), reason: expect.stringContaining('gone') })])
    expect(said(p, 40)).toContain('design waits for its slot (W1)')
    expect(leased(plan(world([...others, lost], { leases, free: 0 })))).toEqual([])
    // its step still runs in the lost slot: the lease waits, so the step's unknown names the slot
    const step = entry(stepKey(lost, 'design', 1), 'agent-step', { issue: 40, status: 'running', endedAt: null, startedAt: NOW - 5 * MIN, step: 'design' })
    const busy = plan(world([...others, lost], { leases, ledger: [step] }))
    expect(leased(busy)).toEqual([])
    expect(said(busy, 40)).toContain(`W1: its slot is gone and ${stepKey(lost, 'design', 1)} still runs`)
  })

  test('the tier and the owner: a lease is held while they would hold the step it leads to', () => {
    const toDesign = queued(50)
    const toReview = queued(51, { resumeTo: 'reviewing', pr: 651 })
    const s = world([toDesign, toReview])
    // the fixture's usage reads 40% of the five-hour window
    const tier = (t: 'stop-new' | 'stop-all') => plan(s, { ...CFG, usageSlowPct: 10, usageStopNewPct: 30, usageStopAllPct: t === 'stop-all' ? 35 : 90 })
    const stopNew = tier('stop-new')
    expect(leased(stopNew)).toEqual([51])
    expect(said(stopNew, 50)).toContain('W1: tier stop-new holds design (develop)')
    expect(leased(tier('stop-all'))).toEqual([])
    const noNew = plan({ ...s, control: control({ noNewWork: true }) })
    expect(leased(noNew)).toEqual([51])
    expect(said(noNew, 50)).toContain('W1: owner: no new work holds design')
  })

  test('a lease under way takes its place and its slot: running, or done after the pool was read; a done one the pool no longer shows is leased again under the next number', () => {
    const r = queued(60)
    const running = plan(world([r, queued(61)], { free: 3, ledger: [leaseEntry(r, 1, { status: 'running', endedAt: null })] }))
    expect(leased(running)).toEqual([])
    expect(said(running, 60)).toContain('W1: its lease 1 runs')
    expect(said(running, 61)).toContain('W1: no free worktree: 2 free, 2 kept in reserve')
    const unseen = plan(world([r], { ledger: [leaseEntry(r, 1, { startedAt: NOW - 1, endedAt: NOW })] }))
    expect(leased(unseen)).toEqual([])
    expect(said(unseen, 60)).toContain('W1: lease 1 is newer than the pool\'s read')
    const vanished = plan(world([r], { ledger: [leaseEntry(r, 1)] }))
    expect(slots(vanished, 'lease')).toEqual([expect.objectContaining({ key: leaseKey(r, 2) })])
  })

  test('a failed lease runs again under its own key after its backoff; one that used up its attempts holds the record, and the owner hears once', () => {
    const r = queued(70)
    const failed = (attempts: number, endedAt: number) => leaseEntry(r, 1, { status: 'failed', attempts, endedAt, summary: 'factory-slot lease: exit 1: the pool is full', maxAttempts: 3 })
    expect(slots(plan(world([r], { ledger: [failed(1, NOW - HOUR)] })), 'lease')).toEqual([expect.objectContaining({ key: leaseKey(r, 1) })])
    expect(leased(plan(world([r], { ledger: [failed(1, NOW - 1000)] })))).toEqual([])
    const used = plan(world([r], { ledger: [failed(3, NOW - HOUR)] }))
    expect(leased(used)).toEqual([])
    expect(said(used, 70)).toContain(`W1: stalled: ${leaseKey(r, 1)}`)
    expect(used.actions.filter(a => a.kind === 'tell' && a.issue === 70)).toEqual([expect.objectContaining({ wake: 'stalled' })])
  })
})

// --- W2: free --------------------------------------------------------------------------------------------

describe('W2: free', () => {
  test('a loop slot of a life no record holds is freed, keyed by its lease, two attempts; a parked or closed record\'s too; a queued or slot-state record keeps its own', () => {
    const parked = rec(80, { state: 'parked', step: null })
    const closed = rec(81, { state: 'closed', step: null, why: 'merged' })
    const ghost = { issue: 82, life: LIFE }
    const keep = [rec(83), queued(84)]
    const leases = [parked, closed, ghost, ...keep].map(leaseFor)
    const p = plan(world([parked, closed, ...keep], { leases }))
    expect(slots(p, 'free')).toEqual(
      [parked, closed, ghost].map(r => expect.objectContaining({ kind: 'slot', op: 'free', key: freeKey(leaseFor(r).lease), rule: 'W2', class: 'free', issue: r.issue, life: LIFE, path: leaseFor(r).path, lease: leaseFor(r).lease, maxAttempts: 2 })),
    )
    // done: never again
    const done = entry(freeKey(leaseFor(parked).lease), 'slot', { issue: 80 })
    expect(freed(plan(world([parked], { leases: [leaseFor(parked)], ledger: [done] })))).toEqual([])
  })

  test('a slot is freed only once nothing of its life runs in it; a person\'s lease and v1\'s are never touched', () => {
    const parked = rec(85, { state: 'parked', step: null, seq: 5 })
    const step = entry(stepKey({ ...parked, seq: 4 }, 'build', 1), 'agent-step', { issue: 85, status: 'running', endedAt: null, step: 'build' })
    const p = plan(world([parked], { leases: [leaseFor(parked)], ledger: [step] }))
    expect(freed(p)).toEqual([])
    expect(said(p, 85)).toContain(`W2: slot ${leaseFor(parked).path} of life ${LIFE} waits: ${step.key} still runs in it`)
    const prep = entry(prepareKey({ ...parked, seq: 4 }, 1), 'slot', { issue: 85, status: 'running', endedAt: null })
    expect(freed(plan(world([parked], { leases: [leaseFor(parked)], ledger: [prep] })))).toEqual([])
    const theirs: Lease[] = [
      { path: '/slots/p', lease: 'Lp', holder: 'callum', issue: null, life: null, status: 'leased', busy: true },
      { path: '/slots/v1', lease: 'Lv1', holder: 'factory-loop', issue: null, life: null, status: 'leased', busy: false },
    ]
    expect(freed(plan(world([], { leases: theirs })))).toEqual([])
  })

  test('for one issue the old life\'s slot is freed before the new life\'s lease (totality/T-19)', () => {
    const old = { issue: 90, life: lifeOf(NOW - 20 * HOUR) }
    const now = queued(90)
    const p = plan(world([rec(90, { ...old, state: 'closed', step: null, why: 'dropped' }), now], { leases: [leaseFor(old)] }))
    const order = slots(p).map(a => `${a.op} ${a.life}`)
    expect(order).toEqual([`free ${old.life}`, `lease ${LIFE}`])
  })

  test('nothing is leased or freed while the pool\'s leases were not read: every slot would look gone', () => {
    const r = queued(95)
    const p = plan(world([r, rec(96, { state: 'parked', step: null })], {}, { sources: { store: OK, leases: { ok: false, at: null, error: 'treehouse status did not read' }, prs: OK, interventions: OK, comments: OK } }))
    expect(slots(p)).toEqual([])
    expect(said(p, null)).toContain('W1, W2: the pool\'s leases were not read (treehouse status did not read); no slot is leased or freed')
  })
})

// --- properties (17.1) -------------------------------------------------------------------------------------

// rng: a small seeded generator, so a failure names its seed.
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// generated: records in any state, some holding their lease, stray leases (a released life, a
// person's), lease attempts in every status, a pool of any size and K of any value.
function generated(seed: number): { s: State; cfg: Config } {
  const r = rng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T
  const records: IssueRecord[] = []
  const leases: Lease[] = []
  const ledger: LedgerEntry[] = []
  for (let n = 1; n <= 1 + Math.floor(r() * 7); n++) {
    const st: IssueState = pick(ISSUE_STATES)
    const life = lifeOf(NOW - (1 + Math.floor(r() * 20)) * HOUR)
    const rr = rec(n, { life, state: st, step: st === 'queued' ? 'lease' : st === 'parked' || st === 'closed' ? null : 'build', seq: st === 'queued' && r() < 0.5 ? 4 : 2, resumeTo: st === 'queued' ? pick([null, 'reviewing', 'fixing'] as const) : null })
    records.push(rr)
    if (r() < 0.5) leases.push(leaseFor(rr))
    const status = pick(['none', 'running', 'done', 'fresh', 'failed'] as const)
    if (status === 'running') ledger.push(leaseEntry(rr, 1, { status: 'running', endedAt: null }))
    if (status === 'done') ledger.push(leaseEntry(rr, 1))
    if (status === 'fresh') ledger.push(leaseEntry(rr, 1, { endedAt: NOW }))
    if (status === 'failed') ledger.push(leaseEntry(rr, 1, { status: 'failed', attempts: 1 + Math.floor(r() * 3), endedAt: NOW - HOUR, maxAttempts: 3 }))
    if (r() < 0.2) ledger.push(entry(stepKey(rr, 'build', 1), 'agent-step', { issue: n, status: 'running', endedAt: null, step: 'build' }))
  }
  if (r() < 0.5) leases.push(leaseFor({ issue: 50, life: LIFE }))
  if (r() < 0.5) leases.push({ path: '/slots/person', lease: 'Lperson', holder: 'callum', issue: null, life: null, status: 'leased', busy: false })
  const cfg = { ...CFG, maxInFlightIssues: pick([1, 2, 3, 4, null]), worktreeReserve: pick([0, 1, 2]) }
  return { s: world(records, { leases, ledger, free: Math.floor(r() * 7) }), cfg }
}

// apply: the pass's slot actions as if each worked: a lease takes a fresh slot, a free returns one.
function apply(s: State, p: PlanResult): Lease[] {
  const v2 = s.v2 as V2State
  let out = [...v2.leases]
  let fresh = 0
  for (const a of slots(p)) {
    if (a.op === 'free') out = out.filter(l => l.lease !== a.lease)
    if (a.op === 'lease') out.push({ path: `/slots/new-${fresh}`, lease: `Lnew${fresh++}`, holder: holderOf(a.issue ?? 0, a.life), issue: a.issue, life: a.life, status: 'leased', busy: false })
  }
  return out
}

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1)

describe('properties of the slots (v2 SPEC 17.1)', () => {
  test('property 6, one writer: no two records share a slot, a live record holds at most one, and no slot a record holds is freed', () => {
    const seen = { lease: 0, free: 0 }
    for (const seed of SEEDS) {
      const { s, cfg } = generated(seed)
      const v2 = s.v2 as V2State
      const p = plan(s, cfg)
      const leases = apply(s, p)
      const paths = leases.map(l => l.path)
      expect({ seed, shared: paths.length - new Set(paths).size }).toEqual({ seed, shared: 0 })
      for (const r of v2.records.filter(x => x.state !== 'closed')) {
        const before = v2.leases.some(l => l.issue === r.issue && l.life === r.life)
        const underWay = s.ledger.some(e => e.kind === 'slot' && e.issue === r.issue && /\/lease\/\d+$/.test(e.key) && (e.status === 'running' || (e.status === 'done' && (e.endedAt ?? 0) >= NOW)))
        const planned = slots(p, 'lease').filter(a => a.issue === r.issue && a.life === r.life).length
        expect({ seed, issue: r.issue, planned: planned <= (before || underWay ? 0 : 1) }).toEqual({ seed, issue: r.issue, planned: true })
        expect({ seed, issue: r.issue, held: leases.filter(l => l.issue === r.issue && l.life === r.life).length <= 1 }).toEqual({ seed, issue: r.issue, held: true })
      }
      seen.lease += slots(p, 'lease').length
      seen.free += slots(p, 'free').length
      for (const a of slots(p, 'free')) {
        const holder = v2.records.find(r => r.issue === a.issue && r.life === a.life && (r.state === 'queued' || SLOT_STATES.includes(r.state)))
        expect({ seed, freed: a.lease, holder: holder?.state ?? null }).toEqual({ seed, freed: a.lease, holder: null })
      }
    }
    // the worlds exercise both rules
    expect(seen.lease > 50 && seen.free > 50).toBe(true)
  })

  test('property 5, capacity: a lease never takes a queued record past K in flight', () => {
    for (const seed of SEEDS) {
      const { s, cfg } = generated(seed)
      const v2 = s.v2 as V2State
      const k = cfg.maxInFlightIssues
      if (k === null) continue
      const holds = (r: IssueRecord) => v2.leases.some(l => l.issue === r.issue && l.life === r.life)
      const underWay = (r: IssueRecord) => s.ledger.some(e => e.issue === r.issue && e.kind === 'slot' && (e.status === 'running' || e.endedAt === NOW))
      const before = v2.records.filter(r => SLOT_STATES.includes(r.state) || (r.state === 'queued' && (holds(r) || underWay(r)))).length
      const added = slots(plan(s, cfg), 'lease').filter(a => v2.records.find(r => r.issue === a.issue)?.state === 'queued').length
      if (added > 0) expect({ seed, flight: before + added <= k }).toEqual({ seed, flight: true })
    }
  })

  test('property 11, held steps never time out: a record W1 holds for any number of passes spends no attempt', () => {
    // K is full with steps that run (the lost #201 counts too); #200 is queued, and #201 lost its slot
    // with no free one left
    const busy = [1, 2, 3].map(n => rec(n))
    const waiting = queued(200)
    const lost = rec(201, { state: 'designing', step: 'design' })
    const runningSteps = busy.map(r => entry(stepKey(r, 'build', 1), 'agent-step', { issue: r.issue, status: 'running', endedAt: null, step: 'build' }))
    for (let hours = 0; hours <= 48; hours += 4) {
      const now = NOW + hours * HOUR
      const s = world([...busy, waiting, lost], { now, free: 0, leases: busy.map(leaseFor), ledger: runningSteps.map(e => ({ ...e, startedAt: now - MIN })) })
      const p = plan(s, { ...CFG, stateTimeoutMs: { ...CFG.stateTimeoutMs, build: 100 * HOUR } })
      expect(said(p, 200)).toContain('W1: capacity: 4 of 3 in flight')
      expect(said(p, 201)).toContain('W1: no free worktree')
      for (const n of [200, 201]) {
        const spent = p.actions.filter(a => a.issue === n && ((a.kind === 'slot' && a.op !== 'free') || a.kind === 'agent-step' || (a.kind === 'transition' && a.event !== 'timeout')))
        expect({ hours, n, spent }).toEqual({ hours, n, spent: [] })
      }
    }
  })
})

// --- the executor (act-slots.ts) ------------------------------------------------------------------------

function runtime(): Runtime {
  return {
    mode: 'act',
    repo: REPO,
    device: DEVICE,
    runSource: 'local',
    poolSize: 16,
    cwd: '/work',
    loopDir: LOOP_DIR,
    sink: null,
    env: { CALLUM_FLOW_REPO: REPO },
    toolsDir: TOOLS,
    pluginRoot: PLUGIN_ROOT,
    config: CFG,
    configProblems: [],
  }
}

type Reply = { exitCode?: number; stdout?: string; stderr?: string }

// actWorld: an act step over a recording ActIo whose commands answer as told.
function actWorld(reply: (argv: string[]) => Reply = () => ({})) {
  const argvs: string[][] = []
  const inits: { cwd: string; stdin?: string; timeoutMs: number }[] = []
  const io: ActIo = {
    now: async () => NOW,
    run: async (argv, init) => {
      argvs.push([...argv])
      inits.push(init)
      return { exitCode: 0, stdout: '', stderr: '', ...reply(argv) }
    },
    spawnAgent: async () => ({ agentId: 'a1' }),
    stopAgent: async () => ({ stopped: true }),
    submit: async () => undefined,
    rename: async () => undefined,
    usage: async () => ({ fiveHour: 10, sevenDay: 10 }),
    readFile: async () => null,
    writeFile: async () => undefined,
  }
  const env: ActEnv = { io, rt: runtime(), live: { ledger: [] }, commands: [], wakeId: () => 'w1', session: 's', save: async () => true, holds: async () => true, killed: async () => false, problems: [] }
  const run = (action: Action) => dispatch(ctxOf(env, world([]), start([], action, NOW).entry), action)
  return { argvs, inits, run }
}

const BIN = `${PLUGIN_ROOT}/${SLOT_SCRIPT}`
const SLOT = '/workspaces/dev-system/.treehouse/dev-system-22f535/4/dev-system'
const HEAD = '9e01b77c0ffee000000000000000000000000001'
const r5 = rec(5)
const MARKER: StepMarker = { v: 1, repo: REPO, issue: 5, life: LIFE, seq: 3, step: 'build', role: 'writer', branch: 'issue-5', gateCommands: ['npm test'], gateTimeoutMs: 600_000, loopDir: '' }
const act = (op: Slot['op'], over: Partial<Slot> = {}): Slot => ({ kind: 'slot', op, key: `${op}-key`, class: 'free', rule: 'W1', reason: 'x', issue: 5, life: LIFE, path: SLOT, lease: 'L5', branch: null, marker: null, ...over })

describe('the slot executor (act-slots.ts)', () => {
  test('lease: the plugin\'s tool, from the main checkout, its slot and lease read from LEASED', async () => {
    const w = actWorld(() => ({ stdout: `LEASED path=${SLOT} lease=4a4eae3e\n` }))
    expect(await w.run(act('lease', { path: null, lease: null }))).toEqual({ status: 'done', outcome: { kind: 'slot', op: 'lease', path: SLOT, lease: '4a4eae3e', head: null, killed: null }, summary: `leased ${SLOT} (4a4eae3e)` })
    expect(w.argvs).toEqual([[BIN, 'lease', '5', LIFE]])
    expect(w.inits[0]).toMatchObject({ cwd: '/work', stdin: '' })
  })

  test('prepare: the marker gets the loop dir; the head, and the leftovers file when one was saved', async () => {
    const leftovers = `${LOOP_DIR}/leftovers/5-${LIFE}-s3-1.patch`
    const w = actWorld(() => ({ stdout: `PREPARED head=${HEAD}\nLEFTOVERS file=${leftovers}\n` }))
    const a = act('prepare', { key: prepareKey(r5, 1), rule: 'S2', branch: 'issue-5', marker: MARKER })
    expect(await w.run(a)).toEqual({ status: 'done', outcome: { kind: 'slot', op: 'prepare', path: SLOT, lease: 'L5', head: HEAD, killed: null, leftovers }, summary: `prepared at 9e01b77; leftovers saved to ${leftovers}` })
    expect(w.argvs).toEqual([[BIN, 'prepare', SLOT, 'L5', 'issue-5', JSON.stringify({ ...MARKER, loopDir: LOOP_DIR })]])
    const clean = actWorld(() => ({ stdout: `PREPARED head=${HEAD}\n` }))
    expect(await clean.run(a)).toMatchObject({ status: 'done', outcome: { head: HEAD, leftovers: null } })
    // the action must name its slot, lease, branch and marker: a loop bug, never retried
    expect(await actWorld().run({ ...a, marker: null })).toMatchObject({ status: 'failed', noRetry: true, summary: expect.stringContaining('refused') })
  })

  test('the old step\'s processes: KILLED <n>; with no slot known, nothing to end and no command', async () => {
    const w = actWorld(() => ({ stdout: 'KILLED 2\n' }))
    const a = act('kill', { rule: 'S3' })
    expect(await w.run(a)).toMatchObject({ status: 'done', outcome: { kind: 'slot', op: 'kill', killed: 2 } })
    expect(w.argvs).toEqual([[BIN, ...slotArgv(a, runtime()).slice(1)]])
    const none = actWorld()
    expect(await none.run({ ...a, path: null })).toMatchObject({ status: 'done', outcome: { killed: 0 } })
    expect(none.argvs).toEqual([])
  })

  test('free: the loop dir for the leftovers; FREED or GONE is done, GONE with no lease left', async () => {
    const w = actWorld(() => ({ stdout: `FREED path=${SLOT}\n` }))
    const a = act('free', { key: freeKey('L5'), rule: 'W2' })
    expect(await w.run(a)).toEqual({ status: 'done', outcome: { kind: 'slot', op: 'free', path: SLOT, lease: 'L5', head: null, killed: null }, summary: `freed ${SLOT}` })
    expect(w.argvs).toEqual([[BIN, 'free', SLOT, 'L5', LOOP_DIR]])
    expect(await actWorld(() => ({ stdout: `GONE path=${SLOT}\n` })).run(a)).toMatchObject({ status: 'done', outcome: { lease: null }, summary: expect.stringContaining('gone already') })
  })

  test('failures: a refusal (3) or a usage error (2) is never retried; any other exit, a throw or a missing result line is', async () => {
    const a = act('free')
    for (const [exitCode, noRetry] of [
      [3, true],
      [2, true],
      [1, undefined],
    ] as const) {
      const r = await actWorld(() => ({ exitCode, stderr: 'factory-slot: no\n' })).run(a)
      expect(r).toMatchObject({ status: 'failed', outcome: { kind: 'cli', exit: exitCode } })
      expect('noRetry' in r ? r.noRetry : undefined).toBe(noRetry)
    }
    expect(await actWorld(() => ({ stdout: 'something else\n' })).run(a)).toMatchObject({ status: 'failed', summary: expect.stringContaining('no result line') })
    expect(await actWorld(() => ({ stdout: 'PREPARED head=not-a-sha\n' })).run(act('prepare', { branch: 'issue-5', marker: MARKER }))).toMatchObject({ status: 'failed' })
  })

  test('readSlot reads each op\'s line and nothing else', () => {
    const at = { path: SLOT, lease: 'L5' }
    expect(readSlot('lease', `noise\nLEASED path=/a b/c lease=xyz\n`, at)).toMatchObject({ path: '/a b/c', lease: 'xyz' })
    expect(readSlot('lease', 'LEASED path=/a\n', at)).toBeNull()
    expect(readSlot('kill', 'KILLED x\n', at)).toBeNull()
    expect(readSlot('free', '', at)).toBeNull()
  })
})
