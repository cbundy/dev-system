// R1 and the release (docs/factory-loop/v2/SPEC.md 6.2, 6.4, 10.7): a live claim of this device with
// no record and no claim in flight is a ghost, released at once: its agents stopped and its factory
// labels off, then, once those have ended and W2 has freed its slot, `reclaimed` or `abandoned`,
// last. Property 17 of 17.1 runs over generated factories on every planV2 call here: R1 never names
// an issue a record holds, a claim in flight or another device's claim; a done release plans nothing
// next pass; observe mode executes nothing. The tripwire tells the owner once of a new change to the
// main checkout. No test here asserts an exact key: keys come from the key codec.
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Action, AgentView, Checkout, IssueView, LedgerEntry, PlanResult, Stage, State } from '../hooks/types'
import { claimKey, lifeOf } from '../hooks/v2/keys'
import { emptyV2State } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { checkoutChange, ghostsOf, tripwireKey } from '../hooks/v2/reconcile'
import {
  LIVE_STAGES,
  RELEASE_OPS,
  isReleaseEntry,
  releaseEffects,
  releaseEvent,
  releaseEventAction,
  releaseIntervention,
  releaseKey,
  releaseLabels,
  releaseReason,
  releaseState,
} from '../hooks/v2/release'
import { GITHUB_V2, newCtx, tierOf } from '../hooks/foundation'
import { V2_OWNER_TELLS } from '../hooks/v2/types'
import type { IssueRecord, Lease, V2Ctx, V2State } from '../hooks/v2/types'
import { CLEAN, DEVICE, MIN, NOW, OTHER, config, entry, issue, state } from './fixtures'
import { NO_EVENTS, QUIET_BEATS, REPO, TOOLS, factoryDoc, host, iso } from './host'
import type { Seen } from './host'

const HOUR = 60 * MIN
const CFG = config({ planner: 'v2' })
const STAGES: readonly (Stage | null)[] = ['queued', 'designing', 'implementing', 'in pipeline', 'parked', 'ready to merge', 'merged', 'closed without merge', null]

function record(over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    issue: 470,
    life: 'tbq3k0',
    seq: 4,
    seqAt: NOW - 10 * MIN,
    state: 'building',
    since: NOW - 10 * MIN,
    resumeTo: null,
    branch: 'issue-470',
    pr: null,
    head: null,
    approvedPatch: null,
    brief: null,
    step: 'build',
    attempt: 1,
    cut: false,
    triages: 0,
    fixes: 0,
    round: 0,
    question: null,
    why: null,
    notes: [],
    prClosedAt: null,
    ...over,
  }
}

// held: an issue this device holds in a live stage, as the factory source shows it, not labelled ready
function held(n: number, over: Partial<IssueView> = {}): IssueView {
  return issue(n, { stage: 'designing', stageSince: NOW - 3 * HOUR, holder: DEVICE, labels: ['enhancement'], ...over })
}

// lease: a loop slot leased for the issue's life (10.1)
function lease(n: number, life: string, over: Partial<Lease> = {}): Lease {
  return { path: `/slots/${n}`, lease: `L${n}`, holder: `factory-loop:${n}:${life}`, issue: n, life, status: 'leased', busy: false, ...over }
}

type World = {
  issues?: IssueView[]
  records?: IssueRecord[]
  ledger?: LedgerEntry[]
  leases?: Lease[]
  leasesOk?: boolean
  agents?: AgentView[]
  before?: Checkout | null
  checkout?: Checkout | null
}

// world: a v2 pass's State: the factory's issues, the records, the ledger, the loop's leases, the
// session's agents, and the main checkout before and now (both clean unless a test says so).
function world(o: World = {}): State {
  const s = state({ issues: o.issues ?? [], agents: o.agents ?? [], checkout: o.checkout === undefined ? CLEAN : o.checkout })
  const v2 = { ...emptyV2State(NOW, o.records ?? []), leases: o.leases ?? [], checkoutBefore: o.before === undefined ? CLEAN : o.before }
  v2.sources = { ...v2.sources, leases: o.leasesOk === false ? { ok: false, at: null, error: 'test' } : { ok: true, at: NOW } }
  return { ...s, ledger: [...s.ledger, ...(o.ledger ?? [])], v2 }
}

const r1 = (result: PlanResult) => result.actions.filter(a => a.rule === 'R1')
const r1Skips = (result: PlanResult, n?: number) => result.skipped.filter(x => x.rule === 'R1' && (n === undefined || x.issue === n)).map(x => x.why)

// ran: the state after these actions ended with this status
function ran(s: State, actions: readonly Action[], status: LedgerEntry['status'] = 'done', over: Partial<LedgerEntry> = {}): State {
  const ended = actions.map(a =>
    entry(a.key, a.kind, { issue: a.issue, rule: a.rule, status, startedAt: NOW - 2 * MIN, endedAt: status === 'running' ? null : NOW - MIN, ...over }),
  )
  return { ...s, ledger: [...s.ledger.filter(e => !actions.some(a => a.key === e.key)), ...ended] }
}

const withLeases = (s: State, leases: Lease[]): State => ({ ...s, v2: { ...(s.v2 ?? emptyV2State(NOW)), leases } })

describe('R1: a ghost is released (v2 SPEC 6.2, 6.4)', () => {
  test('its agents stopped and its factory labels off first; its event last, once they have ended and W2 has freed its slot; then nothing more', () => {
    const agent = entry('i470/l0/s3/build/a1', 'agent-step', { issue: 470, status: 'running', agentId: 'agent-7', endedAt: null })
    let s = world({
      issues: [held(470, { stage: 'implementing', pr: 621 })],
      ledger: [agent],
      leases: [lease(470, 'tbq3k0')],
      agents: [{ id: 'agent-7', type: 'factory-loop:builder', status: 'running' }],
    })
    const first = planV2(s, CFG)
    expect(r1(first).map(a => a.kind)).toEqual(['stop-agent', 'label'])
    expect(r1(first)[0]).toMatchObject({ kind: 'stop-agent', class: 'free', issue: 470, agentId: 'agent-7', entry: agent.key })
    expect(r1(first)[1]).toMatchObject({ kind: 'label', class: 'free', issue: 470, op: 'clear', label: null })
    expect(r1Skips(first, 470)).toHaveLength(1)
    expect(r1Skips(first, 470)[0]).toMatch(/waits for its agent agent-7 stopped, its factory labels off, slot \/slots\/470 freed \(W2\)/)

    // both effects done; W2 has not freed the slot yet
    s = ran(s, r1(first))
    const second = planV2(s, CFG)
    expect(r1(second)).toEqual([])
    expect(r1Skips(second, 470)).toEqual([expect.stringMatching(/waits for slot \/slots\/470 freed \(W2\)$/)])

    // the slot is free: the event, last, with the release's fields
    s = withLeases(s, [])
    const third = planV2(s, CFG)
    expect(r1(third)).toHaveLength(1)
    expect(r1(third)[0]).toMatchObject({
      kind: 'event',
      issue: 470,
      event: { state: 'abandoned', issue: 470, pr: 621, stage: 'implementing', reason: 'reconcile' },
    })

    // a done release plans nothing next pass, though the factory still shows the claim (property 17)
    s = ran(s, r1(third))
    const fourth = planV2(s, CFG)
    expect(r1(fourth)).toEqual([])
    expect(r1Skips(fourth, 470)).toEqual([])
  })

  test('labelled ready it goes back to the queue (reclaimed); with its labels not read yet, its event waits for a read', () => {
    const ready = ran(world({ issues: [held(471, { labels: ['Ready', 'bug'] })] }), [])
    const effects = r1(planV2(ready, CFG))
    expect(r1(planV2(ran(ready, effects), CFG))).toEqual([expect.objectContaining({ kind: 'event', event: expect.objectContaining({ state: 'reclaimed' }) })])

    const unread = world({ issues: [held(472, { labels: null })] })
    const done = ran(unread, r1(planV2(unread, CFG)))
    const next = planV2(done, CFG)
    expect(r1(next)).toEqual([])
    expect(r1Skips(next, 472)).toEqual([expect.stringMatching(/waits for a read of #472's labels/)])
  })

  test('it waits for a read of the pool when the leases were not read, and its effects still go', () => {
    const s = world({ issues: [held(473)], leasesOk: false })
    const first = planV2(s, CFG)
    expect(r1(first).map(a => a.kind)).toEqual(['label'])
    const next = planV2(ran(s, r1(first)), CFG)
    expect(r1(next)).toEqual([])
    expect(r1Skips(next, 473)[0]).toMatch(/waits for a read of the pool/)
  })

  test('an effect that used up its attempts holds the release: its skip line says stalled and the owner hears once; a stop that failed does not hold it', () => {
    const s = world({
      issues: [held(474)],
      ledger: [entry('i474/l0/s1/design/a1', 'agent-step', { issue: 474, status: 'running', agentId: 'agent-9', endedAt: null })],
    })
    const [stop, label] = r1(planV2(s, CFG))
    if (stop === undefined || label === undefined) throw new Error('expected a stop and a label')
    const stuck = ran(ran(s, [stop], 'failed'), [label], 'failed', { attempts: 3, summary: 'gh issue edit: exit 1: label not found' })
    const result = planV2(stuck, CFG)
    expect(r1(result).map(a => [a.kind, 'wake' in a ? a.wake : null])).toEqual([['tell', 'stalled']])
    expect(r1Skips(result, 474)).toEqual([`stalled: ${label.key}: gh issue edit: exit 1: label not found`])
    expect(result.owner).toBe(1)
    // told once
    const told = ran(stuck, r1(result))
    expect(r1(planV2(told, CFG))).toEqual([])

    // a stop that failed is best effort: with the labels off, the event goes
    const event = r1(planV2(ran(ran(s, [stop], 'failed'), [label]), CFG))
    expect(event.map(a => a.kind)).toEqual(['event'])
  })

  test('a label write that failed waits for its retry, and spends nothing else', () => {
    const s = world({ issues: [held(475)] })
    const [label] = r1(planV2(s, CFG))
    if (label === undefined) throw new Error('expected a label')
    const failed = ran(s, [label], 'failed', { attempts: 1 })
    const result = planV2(failed, CFG)
    expect(r1(result)).toEqual([])
    expect(r1Skips(result, 475)[0]).toMatch(/waits for its factory labels off/)
    // after its backoff it runs again
    expect(r1(planV2({ ...failed, now: NOW + 10 * MIN }, CFG)).map(a => a.key)).toEqual([label.key])
  })

  test('a later claim of the same issue is a release of its own: its keys never reuse an earlier one\'s', () => {
    const s = world({ issues: [held(476, { stageSince: NOW - 3 * HOUR })] })
    const first = r1(planV2(s, CFG))
    const released = ran(ran(s, first), [releaseEventAction({ issue: 476, claim: lifeOf(NOW - 3 * HOUR), ready: false, stage: 'designing', checked: 'x', branch: null, pr: null }, 'x')])
    expect(r1(planV2(released, CFG))).toEqual([])
    // claimed again an hour ago, with no record (a lost store): a ghost again, released again
    const again = { ...released, issues: [held(476, { stageSince: NOW - HOUR })] }
    const second = r1(planV2(again, CFG))
    expect(second.map(a => a.kind)).toEqual(['label'])
    expect(second.map(a => a.key).some(k => first.some(a => a.key === k))).toBe(false)
  })

  test('the claim\'s own entry dates the release when it is newer than the stage the factory shows', () => {
    const claim = entry('claim:477:derived:1', 'claim', { issue: 477, startedAt: NOW - HOUR, endedAt: NOW - HOUR, outcome: { kind: 'claim', result: 'claimed' } })
    const s = world({ issues: [held(477, { stageSince: NOW - 3 * HOUR })], ledger: [claim] })
    const [g] = ghostsOf(ctxOf(s))
    expect(g?.claim).toBe(lifeOf(NOW - HOUR))
    expect(r1(planV2(s, CFG)).map(a => a.key)).toEqual([releaseKey(477, lifeOf(NOW - HOUR), RELEASE_OPS.label)])
  })

  test('a ghost with no claim time is named, not released', () => {
    const s = world({ issues: [held(478, { stageSince: null })] })
    const result = planV2(s, CFG)
    expect(r1(result)).toEqual([])
    expect(r1Skips(result, 478)).toEqual([expect.stringMatching(/no claim time is known/)])
  })
})

describe('R1 names nothing but a ghost (property 17)', () => {
  const cases: [string, World][] = [
    ['a record that is not closed', { issues: [held(480)], records: [record({ issue: 480, state: 'parked', step: null })] }],
    ['a closed record at least as new as the factory\'s view (its closing events have not reached it)', { issues: [held(480, { stageSince: NOW - HOUR })], records: [record({ issue: 480, state: 'closed', step: null, why: 'dropped', since: NOW - 30 * MIN })] }],
    ['a running claim', { issues: [held(480)], ledger: [entry(claimKey(480, 'tbq3k0'), 'claim', { issue: 480, status: 'running', endedAt: null })] }],
    ['a done v2 claim whose record S0 has still to make', { issues: [held(480)], ledger: [entry(claimKey(480, 'tbq3k0'), 'claim', { issue: 480, outcome: { kind: 'claim', result: 'claimed' } })] }],
    ['another device\'s claim', { issues: [held(480, { holder: OTHER })] }],
    ['no holder', { issues: [held(480, { holder: null })] }],
    ['a claim that ended or lapsed (queued)', { issues: [held(480, { stage: 'queued' })] }],
    ['a final stage', { issues: [held(480, { stage: 'merged' }), held(481, { stage: 'closed without merge' })] }],
    ['an issue closed on GitHub (the sweep logs it)', { issues: [held(480, { open: false })] }],
  ]
  for (const [name, w] of cases) {
    test(`not: ${name}`, () => {
      const result = planV2(world(w), CFG)
      expect(r1(result)).toEqual([])
      expect(r1Skips(result)).toEqual([])
    })
  }

  test('but: a closed record older than the claim the factory shows; a claim another device lost', () => {
    const older = world({ issues: [held(482, { stageSince: NOW - HOUR })], records: [record({ issue: 482, state: 'closed', step: null, why: 'dropped', since: NOW - 3 * HOUR })] })
    expect(r1(planV2(older, CFG)).map(a => a.issue)).toEqual([482])
    const lost = world({ issues: [held(483)], ledger: [entry(claimKey(483, 'tbq3k0'), 'claim', { issue: 483, outcome: { kind: 'claim', result: 'lost' } })] })
    expect(r1(planV2(lost, CFG)).map(a => a.issue)).toEqual([483])
    const recorded = world({ issues: [held(484)], records: [record({ issue: 484, life: 'tbq3k0', state: 'closed', step: null, why: 'dropped', since: NOW - 5 * HOUR })], ledger: [entry(claimKey(484, 'tbq3k0'), 'claim', { issue: 484 })] })
    expect(r1(planV2(recorded, CFG)).map(a => a.issue)).toEqual([484])
  })

  // a ghost by the spec's words (6.2), restated for the property
  function ghost(s: State, n: number): boolean {
    const i = s.issues.find(x => x.number === n)
    if (i === undefined || i.holder !== DEVICE || i.stage === null || !LIVE_STAGES.includes(i.stage) || i.open === false) return false
    const records = (s.v2?.records ?? []).filter(r => r.issue === n)
    if (records.some(r => r.state !== 'closed')) return false
    if (records.length > 0 && (i.stageSince === null || records.some(r => r.since >= (i.stageSince ?? 0)))) return false
    const lives = records.map(r => claimKey(n, r.life))
    return !s.ledger.some(
      e => e.kind === 'claim' && e.issue === n && (e.status === 'running' || (e.status === 'done' && e.key.startsWith(claimKey(n, '')) && !(e.outcome?.kind === 'claim' && e.outcome.result === 'lost') && !lives.includes(e.key))),
    )
  }

  // a deterministic generator, so a failure names its seed
  function rng(seed: number): () => number {
    let x = seed * 2654435761 + 1
    return () => {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      return (x >>> 0) / 4294967296
    }
  }
  const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T

  function generated(seed: number): State {
    const r = rng(seed)
    const issues: IssueView[] = []
    const records: IssueRecord[] = []
    const ledger: LedgerEntry[] = []
    const leases: Lease[] = []
    const agents: AgentView[] = []
    for (let n = 500; n < 508; n++) {
      const since = pick(r, [null, NOW - 2 * HOUR, NOW - 30 * MIN])
      issues.push(
        issue(n, {
          holder: pick(r, [DEVICE, DEVICE, OTHER, null]),
          stage: pick(r, STAGES),
          stageSince: since,
          open: pick(r, [true, true, false, null]),
          labels: pick(r, [null, ['bug'], ['ready'], ['Ready', 'bug']]),
          pr: pick(r, [null, 600 + n]),
        }),
      )
      const life = pick(r, ['tbq3k0', 'tbq9z9'])
      const rec = pick(r, ['none', 'none', 'open', 'closed-old', 'closed-new'])
      if (rec === 'open') records.push(record({ issue: n, life, state: pick(r, ['queued', 'building', 'parked', 'merge-queue'] as const), step: null }))
      if (rec === 'closed-old') records.push(record({ issue: n, life, state: 'closed', step: null, why: 'dropped', since: NOW - 4 * HOUR }))
      if (rec === 'closed-new') records.push(record({ issue: n, life, state: 'closed', step: null, why: 'merged', since: NOW - 5 * MIN }))
      const claim = pick(r, ['none', 'running', 'done', 'done-recorded', 'lost', 'v1'])
      const claimed = { kind: 'claim', result: 'claimed' } as const
      if (claim === 'running') ledger.push(entry(claimKey(n, 'tbq1a1'), 'claim', { issue: n, status: 'running', endedAt: null }))
      if (claim === 'done') ledger.push(entry(claimKey(n, 'tbq1a1'), 'claim', { issue: n, outcome: claimed }))
      if (claim === 'done-recorded') ledger.push(entry(claimKey(n, life), 'claim', { issue: n, outcome: claimed }))
      if (claim === 'lost') ledger.push(entry(claimKey(n, 'tbq1a1'), 'claim', { issue: n, outcome: { kind: 'claim', result: 'lost' } }))
      if (claim === 'v1') ledger.push(entry(`claim:${n}:derived:1`, 'claim', { issue: n, startedAt: NOW - 3 * HOUR, outcome: claimed }))
      const agent = pick(r, ['none', 'running', 'listed', 'gone'])
      if (agent !== 'none') {
        ledger.push(entry(`i${n}/l0/s2/build/a1`, 'agent-step', { issue: n, agentId: `agent-${n}`, status: agent === 'running' ? 'running' : 'done', endedAt: agent === 'running' ? null : NOW - 5 * MIN }))
        if (agent !== 'gone') agents.push({ id: `agent-${n}`, type: 'factory-loop:builder', status: 'running' })
      }
      if (r() < 0.3) leases.push(lease(n, life))
    }
    return world({ issues, records, ledger, leases, agents, leasesOk: r() > 0.1 })
  }

  test('over generated factories: every R1 action and skip line names a ghost; its event comes only after its effects and its slot; a done release plans nothing more; planning is deterministic and idempotent', () => {
    const seen = { ghosts: 0, reclaimed: 0, abandoned: 0, kept: 0 }
    for (let seed = 1; seed <= 300; seed++) {
      let s = generated(seed)
      seen.kept += s.issues.filter(i => i.holder === DEVICE && i.stage !== null && LIVE_STAGES.includes(i.stage) && !ghost(s, i.number)).length
      const ghosts = new Set(s.issues.filter(i => ghost(s, i.number)).map(i => i.number))
      const released = new Map<number, string>()
      for (let pass = 0; pass < 6; pass++) {
        const result = planV2(s, CFG)
        expect(planV2(s, CFG)).toEqual(result)
        const mineR1 = r1(result).filter(a => a.kind !== 'tell')
        for (const a of mineR1) {
          if (!ghosts.has(a.issue ?? -1)) throw new Error(`seed ${seed}: R1 named #${a.issue}, not a ghost (${a.key})`)
          if (released.has(a.issue ?? -1)) throw new Error(`seed ${seed}: R1 planned ${a.key} after #${a.issue}'s release was done`)
        }
        for (const x of result.skipped.filter(k => k.rule === 'R1')) {
          if (x.issue === null || !ghosts.has(x.issue) || released.has(x.issue)) throw new Error(`seed ${seed}: an R1 skip line for #${x.issue}: ${x.why}`)
        }
        for (const a of mineR1.filter(x => x.kind === 'event')) {
          const n = a.issue ?? -1
          const effects = s.ledger.filter(e => e.issue === n && e.rule === 'R1' && e.kind !== 'event')
          if (!effects.some(e => e.kind === 'label' && e.status === 'done')) throw new Error(`seed ${seed}: #${n}'s event before its labels were off`)
          if (effects.some(e => e.status === 'running')) throw new Error(`seed ${seed}: #${n}'s event while a stop runs`)
          if ((s.v2?.leases ?? []).some(l => l.issue === n) || s.v2?.sources.leases.ok !== true) throw new Error(`seed ${seed}: #${n}'s event before its slot was free`)
          const i = s.issues.find(x => x.number === n)
          const ready = (i?.labels ?? []).some(l => l.toLowerCase() === 'ready')
          if (a.kind === 'event' && a.event.state !== releaseState(ready)) throw new Error(`seed ${seed}: #${n} released as ${a.event.state}`)
        }
        // idempotent: with its actions running, planning again starts none of them again
        const again = r1(planV2(ran(s, mineR1, 'running'), CFG)).filter(a => mineR1.some(m => m.key === a.key))
        if (again.length > 0) throw new Error(`seed ${seed}: planned again while running: ${again.map(a => a.key).join(', ')}`)
        // the act step runs everything; W2 frees the slots; the pool is read
        for (const a of mineR1) {
          if (a.kind !== 'event') continue
          released.set(a.issue ?? -1, a.key)
          seen[a.event.state === 'reclaimed' ? 'reclaimed' : 'abandoned'] += 1
        }
        s = withLeases(ran(s, mineR1), [])
        s = { ...s, v2: { ...(s.v2 ?? emptyV2State(NOW)), sources: { ...(s.v2 ?? emptyV2State(NOW)).sources, leases: { ok: true, at: NOW } } } }
      }
      // every ghost whose labels were read ends released
      for (const n of ghosts) {
        const read = s.issues.find(x => x.number === n)?.labels !== null
        const dated =
          s.issues.find(x => x.number === n)?.stageSince !== null ||
          s.ledger.some(e => e.kind === 'claim' && e.issue === n && e.status === 'done' && !(e.outcome?.kind === 'claim' && e.outcome.result === 'lost'))
        if (read && dated && !released.has(n)) throw new Error(`seed ${seed}: ghost #${n} was never released`)
      }
      seen.ghosts += ghosts.size
    }
    // the generator reaches every case: ghosts released both ways, and live claims a record or a claim holds
    expect(seen.ghosts).toBeGreaterThan(100)
    expect(seen.reclaimed).toBeGreaterThan(30)
    expect(seen.abandoned).toBeGreaterThan(15)
    expect(seen.kept).toBeGreaterThan(300)
  })
})

describe('the main-checkout tripwire (v2 SPEC 10.7)', () => {
  const dirty = (paths: string[], over: Partial<Exclude<Checkout, { error: string }>> = {}): Checkout => ({ ...CLEAN, dirty: paths, ...over })
  const tells = (result: PlanResult) => result.actions.filter((a): a is Extract<Action, { kind: 'tell' }> => a.kind === 'tell' && a.wake === 'checkout')

  test('a new tracked change tells the owner once, with its paths and the steps that ran in that window', () => {
    const steps = [
      entry('i470/l0/s3/build/a1', 'agent-step', { issue: 470, status: 'running', endedAt: null }),
      entry('i471/l0/s2/design/a1', 'agent-step', { issue: 471, endedAt: NOW - MIN }),
      entry('i472/l0/s2/design/a1', 'agent-step', { issue: 472, endedAt: NOW - 30 * MIN }),
    ]
    const now = dirty(['README.md', 'hooks/a.ts'])
    const s = world({ before: dirty(['hooks/a.ts']), checkout: now, ledger: steps })
    const result = planV2(s, CFG)
    const [tell] = tells(result)
    expect(tells(result)).toHaveLength(1)
    expect(tell).toMatchObject({ key: tripwireKey(now as Exclude<Checkout, { error: string }>), class: 'owner', rule: 'R1', issue: null, fields: { branch: 'main', moved: 'no', paths: '1', steps: '2' } })
    expect(tell?.context).toEqual(['changed:', '- README.md', 'steps in that window:', '- i470/l0/s3/build/a1 (running, #470)', '- i471/l0/s2/design/a1 (done, #471)'])
    expect(result.owner).toBe(1)
    // told: the same change is not told again
    expect(tells(planV2(ran(s, tells(result)), CFG))).toEqual([])
  })

  test('a moved HEAD tells; nothing new, a first read, a failed read or changes cleaned away do not', () => {
    const moved = dirty([], { head: '9e01b77aa45eef8d6c31556c1b5ac3d5dd34f3ff' })
    const told = tells(planV2(world({ before: CLEAN, checkout: moved }), CFG))
    expect(told).toHaveLength(1)
    expect(told[0]?.fields.moved).toBe('yes')
    expect(told[0]?.context[0]).toBe('HEAD moved: 5251b75 -> 9e01b77 on main')
    for (const [before, now] of [
      [dirty(['a']), dirty(['a'])],
      [null, dirty(['a'])],
      [{ error: 'git status failed' }, dirty(['a'])],
      [CLEAN, { error: 'git status failed' }],
      [dirty(['a', 'b']), dirty(['b'])],
    ] as [Checkout | null, Checkout | null][]) {
      expect(tells(planV2(world({ before, checkout: now }), CFG))).toEqual([])
    }
  })

  test('checkoutChange and tripwireKey: one key per checkout, another for a different change', () => {
    expect(checkoutChange(CLEAN, dirty(['b', 'a']))).toEqual({ head: CLEAN.head, branch: 'main', moved: null, paths: ['a', 'b'] })
    expect(checkoutChange(CLEAN, dirty([], { branch: null }))?.moved).toEqual({ from: CLEAN.head, to: CLEAN.head })
    const a = dirty(['x', 'y']) as Exclude<Checkout, { error: string }>
    expect(tripwireKey(a)).toBe(tripwireKey(dirty(['y', 'x']) as Exclude<Checkout, { error: string }>))
    expect(tripwireKey(a)).not.toBe(tripwireKey(dirty(['x']) as Exclude<Checkout, { error: string }>))
  })
})

describe('the release (v2 SPEC 6.4)', () => {
  const input = { issue: 467, claim: 'tbq3k0', ready: false, stage: 'in pipeline', checked: 'no run update,\n no PR push', branch: 'feat/issue-467-x', pr: 621 }

  test('reclaimed when still labelled ready, else abandoned; reason reconcile, the stage and what was checked on one line', () => {
    expect(releaseEvent(input)).toEqual({ state: 'abandoned', issue: 467, branch: 'feat/issue-467-x', pr: 621, stage: 'in pipeline', checked: 'no run update, no PR push', reason: 'reconcile' })
    expect(releaseEvent({ ...input, ready: true }).state).toBe('reclaimed')
    expect(releaseReason('in pipeline', 'a\nb')).toBe('no live step in in pipeline: a b')
  })

  test('the labels a release removes: every factory label, and for the migration In development too, as the issue spells them', () => {
    const labels = ['bug', 'factory:building', 'In development', 'FACTORY:parked', 'ready']
    expect(releaseLabels(labels, false, 'in development')).toEqual(['factory:building', 'FACTORY:parked'])
    expect(releaseLabels(labels, true, 'in development')).toEqual(['factory:building', 'In development', 'FACTORY:parked'])
  })

  test('the intervention a release is: by its who, cause reconcile, keyed by the release\'s event, a reason of at most 200 characters', () => {
    const iv = releaseIntervention({ ...input, checked: 'x'.repeat(400) }, 'person')
    expect(iv).toMatchObject({ state: 'intervention', who: 'person', cause: 'reconcile', issue: 467, pr: 621, life: null, fact: releaseKey(467, 'tbq3k0', RELEASE_OPS.event) })
    expect(iv.reason.length).toBeLessThanOrEqual(200)
    expect(iv.reason).toMatch(/^abandoned: no live step in in pipeline: x+\.\.\.$/)
    expect(releaseIntervention(input, 'loop').who).toBe('loop')
  })

  test('its effects in order, each R1\'s and free: a stop per agent, then every factory label off; its event is its own action; its done event entry is the release', () => {
    const effects = releaseEffects(input, [{ agentId: 'a1', entry: 'k1' }, { agentId: 'a2', entry: 'k2' }], 'why')
    expect(effects.map(a => [a.kind, a.rule, a.class, a.issue])).toEqual([
      ['stop-agent', 'R1', 'free', 467],
      ['stop-agent', 'R1', 'free', 467],
      ['label', 'R1', 'free', 467],
    ])
    expect(new Set(effects.map(a => a.key)).size).toBe(3)
    const event = releaseEventAction(input, 'why')
    expect(event).toMatchObject({ kind: 'event', rule: 'R1', class: 'free', issue: 467, key: releaseKey(467, 'tbq3k0', RELEASE_OPS.event) })
    expect(isReleaseEntry({ kind: 'event', rule: 'R1' })).toBe(true)
    expect(isReleaseEntry({ kind: 'event', rule: 'S3' })).toBe(false)
    expect(isReleaseEntry({ kind: 'label', rule: 'R1' })).toBe(false)
  })
})

// --- observe mode executes nothing (property 17) -------------------------------------------------------

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const USAGE = 'five_hour=40 resets_at=2026-10-13T05:00:00Z resets_in=1 seven_day=60 seven_day_resets_at=2026-10-16T11:00:00Z seven_day_resets_in=1 source=oauth'

function driverWorld(ghostIssue: number) {
  const issueJson = { issue: { number: ghostIssue, title: 'x', state: 'open', labels: [{ name: 'bug' }, { name: 'In development' }], issue_dependencies_summary: { blocked_by: 0 }, sub_issues_summary: { total: 0 } }, stripped: 0 }
  return (argv: string[], s: Seen) => {
    const [cmd, ...args] = argv
    switch (cmd) {
      case 'callum-flow-factory-state':
        return { stdout: factoryDoc([{ issue: ghostIssue, stage: 'implementing', entered_at: iso(NOW - 3 * HOUR), holder: DEVICE, run: null, pr: null, stuck: null, github: null }]) }
      case 'dev-query':
        return { stdout: (s.stdin ?? '').includes('workers_status') ? QUIET_BEATS : NO_EVENTS }
      case `${TOOLS}/queue-watch.sh`:
        return { stdout: 'queue known=none now=none\n' }
      case `${TOOLS}/usage-check.sh`:
        return { stdout: USAGE }
      case 'callum-flow-issue-read':
        if (args.includes('--list')) return { stdout: JSON.stringify({ issues: [], stripped: 0 }) }
        return args.join(' ') === `--json ${ghostIssue}` ? { stdout: JSON.stringify(issueJson) } : { stdout: JSON.stringify({ issues: [], stripped: 0 }) }
      case 'treehouse':
        return { stdout: '[]' }
    }
    return undefined
  }
}

describe('R1 in the driver', () => {
  test('observe mode with planner v2: the release of a ghost is planned and logged, and nothing of it runs', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { repo: REPO, checkout: '/work', planner: 'v2' }, run: driverWorld(470) })
    await $.session.start(START)
    await clock.advance(6_000)
    // a second pass, once the issue's labels have been read
    await clock.advance(61_000)
    const line = h.last()
    expect(line).toMatchObject({ mode: 'observe', executed: false, planner: 'v2' })
    const actions = line.actions as { kind: string; rule: string; issue: number | null; reason: string }[]
    expect(actions.filter(a => a.rule === 'R1').map(a => [a.kind, a.issue])).toEqual([['label', 470]])
    expect(actions.find(a => a.rule === 'R1')?.reason).toMatch(/^ghost #470: a live claim of this device in implementing for \d+ min with no record: its factory labels off$/)
    const ran = h.commands().map(c => c.argv.join(' '))
    expect(ran.filter(c => c.startsWith('gh issue edit') || c.startsWith('callum-flow-event'))).toEqual([])
    expect([...h.store.keys()].filter(k => k.startsWith('records:'))).toEqual([])
    expect(h.store.get(`ledger:${REPO}`)).toBeUndefined()
  })
})

// ctxOf: the context R1 works in for a state, for the pure helpers' own tests.
function ctxOf(s: State): V2Ctx {
  const base = newCtx(s, CFG, tierOf(s.usage, CFG, s.control.usageOverride, s.now), V2_OWNER_TELLS, GITHUB_V2)
  return Object.assign(base, { v2: s.v2 as V2State })
}
