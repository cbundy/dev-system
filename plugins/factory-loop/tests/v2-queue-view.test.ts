// S1's queue view (hooks/v2/queue-view.ts): every candidate in order with its place, score and why,
// the why-codes of every skip and limit, the claim S1 wants that admission drops, and a plan that is
// the same with or without the view.
import { describe, expect, test } from 'claude-code/testing'

import type { LedgerEntry, State } from '../hooks/types'
import { claimKey, lifeOf } from '../hooks/v2/keys'
import { emptyV2State } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { whyOf } from '../hooks/v2/queue-view'
import type { Why } from '../hooks/v2/queue-view'
import { madeRecord } from '../hooks/v2/table'
import type { IssueRecord, V2State } from '../hooks/v2/types'
import { MIN, NOW, config, control, entry, issue, state as baseState } from './fixtures'
import type { Config } from '../hooks/types'

const OK = { ok: true, at: NOW }
const CFG = config({ mode: 'act', maxInFlightIssues: 5, skipLabels: ['skip-factory'] })
const LIFE = lifeOf(NOW - 5 * 60 * MIN)

const rec = (n: number): IssueRecord => ({ ...madeRecord({ issue: n, life: LIFE, branch: `issue-${n}`, pr: null, others: [] }, NOW - 4 * 60 * MIN), seq: 3, seqAt: NOW - 3 * 60 * MIN, state: 'building', step: 'build', since: NOW - 3 * 60 * MIN })

function world(issues: ReturnType<typeof issue>[], over: Partial<State> = {}, records: IssueRecord[] = [], v2: Partial<V2State> = {}): State {
  const s = baseState({ queue: issues.map(i => i.number), issues, ...over })
  return { ...s, v2: { ...emptyV2State(NOW, records), sources: { store: OK, leases: OK, prs: OK, interventions: OK, comments: OK, dualWrite: OK, releasePrs: OK, main: OK }, ...v2 } }
}

const whys = (s: State, c: Config = CFG): Record<number, Why | null> => Object.fromEntries((planV2(s, c).queue?.rows ?? []).map(r => [r.issue, r.why]))
const failedClaim = (n: number, attempts: number): LedgerEntry => entry(claimKey(n, LIFE), 'claim', { issue: n, status: 'failed', attempts, endedAt: NOW - 20 * MIN })

describe('why-codes of the claim filters', () => {
  test('each candidateProblem return has its code', () => {
    const issues = [
      issue(1),
      issue(2, { blockedBy: 2 }),
      issue(3, { labels: ['ready', 'skip-factory'] }),
      issue(4),
      issue(5),
      issue(6, { labels: ['ready', 'factory:rejected'] }),
      issue(7, { subIssues: 2 }),
      issue(8, { epic: true }),
      issue(9, { trusted: false }),
      issue(10, { open: false }),
      issue(11, { labels: ['enhancement'] }),
      issue(12, { labels: null }),
      issue(13, { blockedBy: null }),
      issue(14, { subIssues: null }),
      issue(15, { trusted: null }),
      issue(16, { open: null }),
      issue(17, { holder: 'other-device', stage: 'implementing' }),
    ]
    const s = world([...issues], { control: control({ skip: [4], paused: [5] }), queue: [...issues.map(i => i.number), 99] })
    expect(whys(s)).toEqual({ 1: null, 2: 'blocked', 3: 'skipped', 4: 'skipped', 5: 'paused', 6: 'rejected', 7: 'tracker', 8: 'tracker', 9: 'untrusted', 10: 'unknown', 11: 'unknown', 12: 'unknown', 13: 'unknown', 14: 'unknown', 15: 'unknown', 16: 'unknown', 17: 'held', 99: 'unknown' })
  })

  test('a live record, a claim in flight, a handled claim and a lost claim are held; used up attempts are exhausted', () => {
    const issues = [issue(1), issue(2), issue(3), issue(4), issue(5)]
    const lost = entry(claimKey(4, LIFE), 'claim', { issue: 4, status: 'done', outcome: { kind: 'claim', result: 'lost' } as never, startedAt: NOW - 10 * MIN })
    const s = world(issues, { ledger: [entry(claimKey(2, LIFE), 'claim', { issue: 2, status: 'running' }), failedClaim(3, 1), lost, failedClaim(5, 9)] }, [rec(1)])
    const got = whys(s, { ...CFG, maxAttempts: { ...CFG.maxAttempts, claim: 3 } })
    expect(got[1]).toBe('held')
    expect(got[2]).toBe('held')
    expect(got[4]).toBe('held')
    expect(got[5]).toBe('exhausted')
  })

  test('the owner only list puts the rest outside it', () => {
    const s = world([issue(1), issue(2), issue(3)], { control: control({ only: [2] }) })
    expect(whys(s)).toEqual({ 2: null, 1: 'outside_only', 3: 'outside_only' })
  })

  test('no new work, one at a time, the claims per pass and the capacity limit', () => {
    expect(Object.values(whys(world([issue(1), issue(2)], { control: control({ noNewWork: true }) })))).toEqual(['new_off', 'new_off'])
    const serial = world([issue(1), issue(2)], { control: control({ serial: true }) })
    expect(Object.values(whys(serial)).sort()).toEqual(['no_slot', null].sort())
    expect(Object.values(whys(world([issue(1), issue(2)]), { ...CFG, maxStartsPerPass: 1 })).sort()).toEqual(['no_slot', null].sort())
    const capped = world([issue(1), issue(2)], {}, [rec(7)])
    const p = planV2(capped, { ...CFG, maxInFlightIssues: 1 })
    expect(p.queue?.rows.map(r => r.why)).toEqual(['no_slot', 'no_slot'])
    expect(p.queue?.free_slots).toBe(0)
  })

  test('the usage tiers: stop-new and stop-all, and the slow tier limits', () => {
    const usage = (pct: number) => ({ fiveHour: pct, sevenDay: 10, fiveHourResetsAt: null, sevenDayResetsAt: null, unavailable: false })
    expect(Object.values(whys(world([issue(1)], { usage: usage(CFG.usageStopAllPct) })))).toEqual(['usage_tier'])
    expect(Object.values(whys(world([issue(1)], { usage: usage(CFG.usageStopNewPct) })))).toEqual(['usage_tier'])
    const slow = whys(world([issue(1), issue(2)], { usage: usage(CFG.usageSlowPct) }))
    expect(Object.values(slow).sort()).toEqual(['usage_tier', null].sort())
  })
})

describe('whyOf', () => {
  const MAPPED: Array<[string, Why]> = [
    ['blocked by 1 open issue', 'blocked'], ['blocked by 3 open issues', 'blocked'], ['label skip-factory', 'skipped'], ['owner: skip', 'skipped'], ['owner: paused', 'paused'],
    ['label factory:rejected: the owner removes it to try again', 'rejected'], ['owner: only #3 #4', 'outside_only'], ['capacity: 3 of 3 queued or in flight', 'no_slot'], ['owner: one at a time', 'no_slot'],
    ['claims per pass', 'no_slot'], ['owner: no new work', 'new_off'], ['tier stop-new', 'usage_tier'], ['tier stop-all', 'usage_tier'], ['slow: one claim per pass', 'usage_tier'],
    ['slow: too soon after the last claim', 'usage_tier'], ['tracker (has sub-issues)', 'tracker'], ['tracker (title)', 'tracker'], ['in the factory as building', 'held'],
    ['another device holds it (box)', 'held'], ['another device holds it', 'held'], ['exhausted: i1/claim/x', 'exhausted'], ['untrusted author', 'untrusted'],
    ['not observed', 'unknown'], ['closed', 'unknown'], ['GitHub state unknown', 'unknown'], ['author unknown', 'unknown'], ['labels unknown', 'unknown'], ['no ready label', 'unknown'],
    ['blockers unknown', 'unknown'], ['sub-issues unknown', 'unknown'],
  ]
  for (const [text, code] of MAPPED) test(`${text} -> ${code}`, () => expect(whyOf(text)).toBe(code))
  test('a reason that maps to nothing gives null, so a new skip reason fails here', () => {
    expect(whyOf('some new reason')).toBeNull()
  })
})

describe('the view as the plan returns it', () => {
  const issues = [issue(1), issue(2, { blockedBy: 1 }), issue(3)]

  test('rows in order with rank, score and factors; the owner controls and the free slots', () => {
    const p = planV2(world(issues, { control: control({ priority: [3], serial: false }) }), CFG)
    const q = p.queue
    expect(q?.considered).toBe(3)
    expect(q?.rows.map(r => [r.issue, r.rank])).toEqual([[3, 1], [1, 2], [2, 3]])
    expect(q?.priority).toEqual([3])
    expect(q?.free_slots).toBe(3)
    const claimed = p.actions.find(a => a.kind === 'claim' && a.issue === 3)
    expect(claimed?.kind === 'claim' ? claimed.score?.score : null).toBe(q?.rows[0]?.score)
    expect(q?.rows[0]).toMatchObject({ claimable: true, why: null })
    expect(q?.rows[2]).toMatchObject({ claimable: false, why: 'blocked' })
  })

  test('free_slots is null when the cap is unset', () => {
    expect(planV2(world(issues), { ...CFG, maxInFlightIssues: null as never }).queue?.free_slots).toBeNull()
  })

  test('a claim wind-down drops after S1 wanted it ends not claimable, no_slot', () => {
    const request = { requestedAt: NOW - MIN, iso: new Date(NOW - MIN).toISOString(), trigger: 'restart-self', problem: null }
    const p = planV2(world(issues, {}, [], { windDown: { request, stopNow: false, previous: null } as never }), CFG)
    expect(p.actions.some(a => a.kind === 'claim')).toBe(false)
    expect(p.queue?.rows.map(r => [r.issue, r.claimable, r.why])).toEqual([[1, false, 'no_slot'], [2, false, 'blocked'], [3, false, 'no_slot']])
  })

  test('a claim admission drops (a GitHub backoff) ends not claimable, no_slot, while the claims it keeps stay claimable', () => {
    const p = planV2(world(issues, { githubBackoffUntil: NOW + 5 * MIN }), CFG)
    expect(p.actions.some(a => a.kind === 'claim')).toBe(false)
    expect(p.queue?.rows.map(r => r.why)).toEqual(['no_slot', 'blocked', 'no_slot'])
    const free = planV2(world(issues), CFG)
    expect(free.queue?.rows.filter(r => r.claimable).map(r => r.issue)).toEqual(free.actions.filter(a => a.kind === 'claim').map(a => a.issue))
  })

  test('no view when a source failed or the store failed', () => {
    const s = world(issues)
    expect(planV2({ ...s, sources: { ...s.sources, queue: { ok: false, at: NOW, error: 'x' } } }, CFG).queue).toBeUndefined()
    expect(planV2({ ...s, sources: { ...s.sources, github: { ok: false, at: NOW, error: 'x' } } }, CFG).queue).toBeUndefined()
    const store = { ...s, v2: { ...(s.v2 as V2State), sources: { ...(s.v2 as V2State).sources, store: { ok: false, at: NOW, error: 'x' } } } }
    expect(planV2(store, CFG).queue).toBeUndefined()
    expect(planV2({ ...s, v2: undefined }, CFG).queue).toBeUndefined()
  })

  test('actions and skipped are the same whether or not the view is read', () => {
    const s = world([...issues, issue(4, { labels: null }), issue(5, { trusted: false })], { control: control({ priority: [3] }) })
    const p = planV2(s, CFG)
    const { queue: _q, ...rest } = p
    expect(p.queue).toBeDefined()
    expect(rest.actions.filter(a => a.kind === 'claim').map(a => a.issue)).toEqual([3, 1])
    expect(rest.skipped.filter(k => k.rule === 'S1').map(k => [k.issue, k.why])).toEqual([[2, 'blocked by 1 open issue'], [4, 'labels unknown'], [5, 'untrusted author']])
  })
})
