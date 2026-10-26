// R1 and the release (docs/factory-loop/v2/SPEC.md 6.2, 6.4, 10.7): a live claim of this device with
// no record and no claim in flight is a ghost, released at once: its agents stopped and its labels
// set by the release's outcome, then, once those have ended and W2 has freed its slot, its event,
// last. The outcome: back in the queue with ready re-added (`reclaimed`), unless the owner dropped
// it (it leaves, `abandoned`), and unless this was its maxLives-th life (rejected: factory:rejected,
// a comment and an owner tell, then `abandoned`). Property 17 of 17.1 runs over generated
// factories on every planV2 call here: R1 never names an issue a record holds, a claim in flight or
// another device's claim; a done release begins nothing again, whatever the factory still shows,
// and logs its intervention exactly once (7.2); observe mode executes nothing. The tripwire tells
// the owner once of each change to the main checkout, and keeps planning its notice until it is
// told.
// No test here asserts an exact key: keys come from the key codec.
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Action, AgentView, Checkout, IssueView, LedgerEntry, PlanResult, State } from '../hooks/types'
import { LIVE_STATES } from '../hooks/factory-state-map'
import { claimKey, interventionKey, lifeAt, lifeOf } from '../hooks/v2/keys'
import { knownLives, livesBefore } from '../hooks/v2/lives'
import { emptyV2State } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { checkoutBaseOf, checkoutChange, claimOf, ghostsOf, tripwireKey } from '../hooks/v2/reconcile'
import type { CheckoutBase, CheckoutRead } from '../hooks/v2/reconcile'
import {
  RELEASE_OPS,
  RELEASE_OUTCOMES,
  isReleaseEntry,
  releaseClaimOf,
  releaseEffects,
  releaseEvent,
  releaseEventAction,
  releaseIntervention,
  releaseKey,
  releaseLabels,
  releaseOutcomeOf,
  releaseReason,
  releaseState,
} from '../hooks/v2/release'
import type { ReleaseOutcome } from '../hooks/v2/release'
import { GITHUB_V2, newCtx, tierOf } from '../hooks/foundation'
import { V2_OWNER_TELLS } from '../hooks/v2/types'
import type { IssueRecord, IssueState, Lease, V2Ctx, V2State } from '../hooks/v2/types'
import { CLEAN, DEVICE, MIN, NOW, OTHER, config, entry, issue, state } from './fixtures'
import { NO_EVENTS, QUIET_BEATS, REPO, TOOLS, factoryDoc, host, iso, ENGINE_TEST } from './host'
import type { Seen } from './host'

const HOUR = 60 * MIN
const CFG = config()
const STATES: readonly (IssueState | null)[] = ['queued', 'designing', 'building', 'reviewing', 'fixing', 'parked', 'waiting', 'merge-queue', 'closed', null]

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
    conflicts: 0,
    envBlocked: null,
    round: 0,
    question: null,
    parts: null,
    why: null,
    notes: [],
    prClosedAt: null,
    wait: null,
    lives: 1,
    ...over,
  }
}

// held: an issue this device holds in a live stage, as the factory source shows it, not labelled ready
function held(n: number, over: Partial<IssueView> = {}): IssueView {
  return issue(n, { state: 'designing', stateSince: NOW - 3 * HOUR, holder: DEVICE, labels: ['enhancement'], ...over })
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
  base?: CheckoutBase | null
  checkout?: Checkout | null
  // the owner's drops (`/factory drop N`)
  dropped?: { issue: number; at: number }[]
}

// world: a v2 pass's State: the factory's issues, the records, the ledger, the loop's leases, the
// session's agents, the main checkout the tripwire last settled on (read a pass ago) and the one
// now (both clean unless a test says so).
function world(o: World = {}): State {
  const s = state({ issues: o.issues ?? [], agents: o.agents ?? [], checkout: o.checkout === undefined ? CLEAN : o.checkout })
  const v2 = { ...emptyV2State(NOW, o.records ?? []), leases: o.leases ?? [], checkoutBase: o.base === undefined ? { checkout: CLEAN, at: NOW - MIN } : o.base }
  v2.sources = { ...v2.sources, leases: o.leasesOk === false ? { ok: false, at: null, error: 'test' } : { ok: true, at: NOW } }
  return { ...s, control: { ...s.control, dropped: o.dropped ?? [] }, ledger: [...s.ledger, ...(o.ledger ?? [])], v2 }
}

const r1 = (result: PlanResult) => result.actions.filter(a => a.rule === 'R1')
// R1's intervention (v2 SPEC 6.4, 7.2): a done release is a loop intervention, cause reconcile,
// derived from its done event entry (rules-interventions.ts) and so planned once, the pass after it
const isIv = (a: Action) => a.kind === 'event' && a.event.state === 'intervention'
const releaseIv = (n: number, fact: string, cause = 'reconcile') => ({ kind: 'event', rule: 'R1', issue: n, key: interventionKey(fact), event: { state: 'intervention', who: 'loop', cause, issue: n, fact } })
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
  test('its agents stopped and its labels set first (ready back on, the factory labels off); its event last, once they have ended and W2 has freed its slot; then nothing more', () => {
    const agent = entry('i470/l0/s3/build/a1', 'agent-step', { issue: 470, status: 'running', agentId: 'agent-7', endedAt: null })
    let s = world({
      issues: [held(470, { state: 'building', pr: 621 })],
      ledger: [agent],
      leases: [lease(470, 'tbq3k0')],
      agents: [{ id: 'agent-7', type: 'factory-loop:builder', status: 'running' }],
    })
    const first = planV2(s, CFG)
    expect(r1(first).map(a => a.kind)).toEqual(['stop-agent', 'label'])
    expect(r1(first)[0]).toMatchObject({ kind: 'stop-agent', class: 'free', issue: 470, agentId: 'agent-7', entry: agent.key })
    expect(r1(first)[1]).toMatchObject({ kind: 'label', class: 'free', issue: 470, op: 'requeue', label: null, ready: 'ready' })
    expect(r1Skips(first, 470)).toHaveLength(1)
    expect(r1Skips(first, 470)[0]).toMatch(/waits for its agent agent-7 stopped, its labels set, slot \/slots\/470 freed \(W2\)/)

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
      event: { state: 'reclaimed', issue: 470, pr: 621, stage: 'building', reason: 'reconcile', outcome: 'requeue', lives: 1 },
    })

    // a done release begins nothing again, though the factory still shows the claim (property 17):
    // the next pass plans only its intervention, once
    s = ran(s, r1(third))
    const fourth = planV2(s, CFG)
    expect(r1(fourth)).toEqual([expect.objectContaining(releaseIv(470, r1(third)[0]?.key ?? ''))])
    expect(r1Skips(fourth, 470)).toEqual([])
    // logged: then nothing more
    s = ran(s, r1(fourth))
    const fifth = planV2(s, CFG)
    expect(r1(fifth)).toEqual([])
    expect(r1Skips(fifth, 470)).toEqual([])
  })

  test('open, it goes back to the queue whatever its labels (reclaimed); with its GitHub state not read, its stops go and its labels wait for a read', () => {
    for (const labels of [['Ready', 'bug'], ['bug'], null]) {
      const open = world({ issues: [held(471, { labels })] })
      const effects = r1(planV2(open, CFG))
      expect(effects.map(a => (a.kind === 'label' ? a.op : a.kind))).toEqual(['requeue'])
      expect(r1(planV2(ran(open, effects), CFG))).toEqual([expect.objectContaining({ kind: 'event', event: expect.objectContaining({ state: 'reclaimed', outcome: 'requeue' }) })])
    }

    const agent = entry('i472/l0/s3/build/a1', 'agent-step', { issue: 472, status: 'running', agentId: 'agent-2', endedAt: null })
    const unread = world({ issues: [held(472, { open: null })], ledger: [agent] })
    const first = r1(planV2(unread, CFG))
    expect(first.map(a => a.kind)).toEqual(['stop-agent'])
    const next = planV2(ran(unread, first), CFG)
    expect(r1(next)).toEqual([])
    expect(r1Skips(next, 472)).toEqual([expect.stringMatching(/waits for a read of #472 that shows it open/)])
  })

  test('the owner dropped it since its claim: it leaves the factory (abandoned), its factory labels off and no ready; a drop before its claim does not count', () => {
    const claim = entry('claim:473:derived:1', 'claim', { issue: 473, startedAt: NOW - HOUR, endedAt: NOW - HOUR, outcome: { kind: 'claim', result: 'claimed' } })
    const s = world({ issues: [held(473)], ledger: [claim], dropped: [{ issue: 473, at: NOW - 10 * MIN }] })
    const [label] = r1(planV2(s, CFG))
    expect(label).toMatchObject({ kind: 'label', op: 'clear', key: releaseKey(473, lifeOf(NOW - HOUR), 'leave') })
    const [event] = r1(planV2(ran(s, [label as Action]), CFG))
    expect(event).toMatchObject({ kind: 'event', event: { state: 'abandoned', outcome: 'leave', lives: 1 } })
    const before = world({ issues: [held(473)], ledger: [claim], dropped: [{ issue: 473, at: NOW - 2 * HOUR }] })
    expect(r1(planV2(before, CFG))).toEqual([expect.objectContaining({ kind: 'label', op: 'requeue' })])
  })

  test('a release keeps the outcome it began with: a drop that lands after the requeue began changes nothing', () => {
    const s = world({ issues: [held(474)] })
    const [label] = r1(planV2(s, CFG))
    expect(label).toMatchObject({ op: 'requeue' })
    const later = { ...ran(s, [label as Action], 'failed', { attempts: 1 }), now: NOW + 10 * MIN, control: { ...s.control, dropped: [{ issue: 474, at: NOW + 5 * MIN }] } }
    expect(r1(planV2(later, CFG)).map(a => a.key)).toEqual([label?.key])
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
    expect(r1Skips(result, 475)[0]).toMatch(/waits for its labels set/)
    // after its backoff it runs again
    expect(r1(planV2({ ...failed, now: NOW + 10 * MIN }, CFG)).map(a => a.key)).toEqual([label.key])
  })

  test('a later claim of the same issue is a release of its own: its keys never reuse an earlier one\'s', () => {
    const s = world({ issues: [held(476, { stateSince: NOW - 3 * HOUR })] })
    const first = r1(planV2(s, CFG))
    const event = releaseEventAction({ issue: 476, claim: lifeOf(NOW - 3 * HOUR), outcome: 'requeue', lives: 1, stage: 'designing', checked: 'x', branch: null, pr: null }, 'x')
    let released = ran(ran(s, first), [event])
    // its intervention, logged once; then nothing
    const iv = r1(planV2(released, CFG))
    expect(iv).toEqual([expect.objectContaining(releaseIv(476, event.key))])
    released = ran(released, iv)
    expect(r1(planV2(released, CFG))).toEqual([])
    // claimed again an hour ago, its record lost with the store: its claim entry, rebuilt from its
    // `claimed` event, dates a ghost of its own, released again under keys of its own
    const claim = entry('claim:476:derived:2', 'claim', { issue: 476, startedAt: NOW - HOUR, endedAt: NOW - HOUR, outcome: { kind: 'claim', result: 'claimed' } })
    const again = { ...released, issues: [held(476, { stateSince: NOW - HOUR })], ledger: [...released.ledger, claim] }
    const second = r1(planV2(again, CFG))
    expect(second.map(a => a.kind)).toEqual(['label'])
    expect(second.map(a => a.key).some(k => first.some(a => a.key === k))).toBe(false)
  })

  test('the claim\'s own entry dates the release, whatever stage the factory shows', () => {
    const claim = entry('claim:477:derived:1', 'claim', { issue: 477, startedAt: NOW - HOUR, endedAt: NOW - HOUR, outcome: { kind: 'claim', result: 'claimed' } })
    for (const stateSince of [NOW - 3 * HOUR, NOW - 10 * MIN, null]) {
      const s = world({ issues: [held(477, { stateSince })], ledger: [claim] })
      const [g] = ghostsOf(ctxOf(s))
      expect(g?.claim).toBe(lifeOf(NOW - HOUR))
      expect(r1(planV2(s, CFG)).map(a => a.key)).toEqual([releaseKey(477, lifeOf(NOW - HOUR), 'requeue')])
    }
  })

  test('a release once begun keeps its keys when the stage the factory shows moves (a run\'s stage); a done one is never begun again', () => {
    let s = world({ issues: [held(479, { state: 'reviewing', stateSince: NOW - 3 * HOUR })] })
    const [label] = r1(planV2(s, CFG))
    if (label === undefined) throw new Error('expected a label')
    s = ran(s, [label])
    // the run moved on: the factory shows a later stage time, and the release goes on under its own claim
    const moved = (st: State, since: number): State => ({ ...st, issues: [held(479, { state: 'merge-queue', stateSince: since })] })
    const [g] = ghostsOf(ctxOf(moved(s, NOW - 20 * MIN)))
    expect(g?.claim).toBe(releaseClaimOf(479, label.key))
    const events = r1(planV2(moved(s, NOW - 20 * MIN), CFG))
    expect(events.map(a => a.kind)).toEqual(['event'])
    expect(releaseClaimOf(479, events[0]?.key ?? '')).toBe(releaseClaimOf(479, label.key))
    s = ran(moved(s, NOW - 20 * MIN), events)
    // done: its intervention is logged once
    const iv = r1(planV2(moved(s, NOW - 15 * MIN), CFG))
    expect(iv).toEqual([expect.objectContaining(releaseIv(479, events[0]?.key ?? ''))])
    s = ran(s, iv)
    // the factory still shows it live and its stage keeps moving; nothing is cleared or logged again
    for (const since of [NOW - 10 * MIN, NOW - MIN]) {
      const later = moved(s, since)
      expect(ghostsOf(ctxOf(later))).toEqual([])
      expect(r1(planV2(later, CFG))).toEqual([])
      expect(r1Skips(planV2(later, CFG), 479)).toEqual([])
    }
  })

  test('a done release leaves the issue to S1: with the factory still showing it live, S1\'s claim starts the new life', () => {
    let s = world({ issues: [held(486, { labels: ['ready'], state: 'reviewing', stateSince: NOW - 2 * HOUR })] })
    s = ran(s, r1(planV2(s, CFG)))
    s = ran(s, r1(planV2(s, CFG)))
    expect(s.ledger.some(e => isReleaseEntry(e) && e.status === 'done')).toBe(true)
    // its intervention, logged the pass after
    const iv = r1(planV2(s, CFG))
    expect(iv.map(a => (a.kind === 'event' && a.event.state === 'intervention' ? a.event.cause : a.kind))).toEqual(['reconcile'])
    s = ran(s, iv)
    // still live in the factory view (its run's stage), and no ghost: S1 may claim it
    expect(ghostsOf(ctxOf(s))).toEqual([])
    // S1 claims it: in flight, then done with its record still to make, then held by its record
    const life = lifeOf(NOW)
    const claiming = { ...s, ledger: [...s.ledger, entry(claimKey(486, life), 'claim', { issue: 486, status: 'running', startedAt: NOW, endedAt: null })] }
    const claimed = { ...s, ledger: [...s.ledger, entry(claimKey(486, life), 'claim', { issue: 486, startedAt: NOW, endedAt: NOW, outcome: { kind: 'claim', result: 'claimed' } })] }
    const recorded = { ...claimed, v2: { ...(claimed.v2 ?? emptyV2State(NOW)), records: [record({ issue: 486, life, state: 'queued', step: null, since: NOW })] } }
    for (const st of [claiming, claimed, recorded]) {
      expect(ghostsOf(ctxOf(st))).toEqual([])
      expect(r1(planV2(st, CFG))).toEqual([])
    }
    // its claim dates any later release: a ghost of the new life (its record lost) is released under keys of its own
    expect(claimOf(claimed.ledger, held(486))).toBe(life)
  })

  test('at its maxLives-th life it is rejected: factory:rejected on, one comment and one owner tell listing why each life ended, then abandoned; its intervention is cause rejected', () => {
    // two earlier lives: a record dropped by triage, then a ghost R1 put back in the queue
    const first = record({ issue: 487, life: lifeOf(NOW - 30 * HOUR), state: 'closed', step: null, why: 'dropped', notes: ['triage: needs a decision'], since: NOW - 29 * HOUR, lives: 1 })
    const second = entry(releaseKey(487, lifeOf(NOW - 20 * HOUR), 'requeue'), 'label', { issue: 487, rule: 'R1', startedAt: NOW - 19 * HOUR, endedAt: NOW - 19 * HOUR })
    const claim = entry('claim:487:derived:3', 'claim', { issue: 487, startedAt: NOW - 3 * HOUR, endedAt: NOW - 3 * HOUR, outcome: { kind: 'claim', result: 'claimed' } })
    let s = world({ issues: [held(487, { state: 'building', pr: 701 })], records: [first], ledger: [second, claim] })
    const plans = r1(planV2(s, CFG))
    const life = lifeOf(NOW - 3 * HOUR)
    expect(plans.map(a => [a.kind, a.kind === 'label' ? a.op : a.kind === 'tell' ? a.wake : null])).toEqual([
      ['label', 'reject'],
      ['comment', null],
      ['tell', 'rejected'],
    ])
    const [label, comment, tell] = plans
    expect(label?.key).toBe(releaseKey(487, life, 'reject'))
    expect(comment).toMatchObject({ kind: 'comment', on: 'issue', number: 487 })
    const body = comment?.kind === 'comment' ? comment.body : ''
    expect(body).toMatch(/its 3rd life ended without a merge, so it is labelled `factory:rejected`/)
    expect(body).toMatch(/^- life 1, claimed .* UTC: dropped: triage: needs a decision$/m)
    expect(body).toMatch(/^- life 2, claimed .* UTC: released: a live claim with no record, put back in the queue$/m)
    expect(body).toMatch(/^- life 3, claimed .* UTC: released: a live claim of this device in building with no record$/m)
    expect(body).toMatch(/remove `factory:rejected` and add `ready` to #487/)
    expect(tell).toMatchObject({ kind: 'tell', wake: 'rejected', class: 'owner', issue: 487, fields: { issue: '487', lives: '3', max: '3' } })
    expect(planV2(s, CFG).owner).toBeGreaterThanOrEqual(1)
    // the event waits for the labels, the comment and the tell
    expect(r1Skips(planV2(ran(s, [label as Action, comment as Action]), CFG), 487)).toEqual([expect.stringMatching(/waits for its owner told$/)])
    s = ran(s, plans)
    const [event] = r1(planV2(s, CFG))
    expect(event).toMatchObject({ kind: 'event', event: { state: 'abandoned', outcome: 'reject', lives: 3, reason: 'reconcile', pr: 701 } })
    s = ran(s, [event as Action])
    expect(r1(planV2(s, CFG))).toEqual([expect.objectContaining(releaseIv(487, event?.key ?? '', 'rejected'))])
    // a lower maxLives rejects sooner; a higher one puts it back in the queue
    const cfg = (maxLives: number) => config({ maxLives })
    const fresh = world({ issues: [held(488)] })
    expect(r1(planV2(fresh, cfg(1))).map(a => (a.kind === 'label' ? a.op : a.kind))).toEqual(['reject', 'comment', 'tell'])
    expect(r1(planV2(world({ issues: [held(487, { state: 'building' })], records: [first], ledger: [second, claim] }), cfg(4))).map(a => (a.kind === 'label' ? a.op : a.kind))).toEqual(['requeue'])
  })

  test('a ghost with no claim time is named, not released', () => {
    const s = world({ issues: [held(478, { stateSince: null })] })
    const result = planV2(s, CFG)
    expect(r1(result)).toEqual([])
    expect(r1Skips(result, 478)).toEqual([expect.stringMatching(/no claim time is known/)])
  })
})

describe('R1 names nothing but a ghost (property 17)', () => {
  const cases: [string, World][] = [
    ['a record that is not closed', { issues: [held(480)], records: [record({ issue: 480, state: 'parked', step: null })] }],
    ['a closed record at least as new as the factory\'s view (its closing events have not reached it)', { issues: [held(480, { stateSince: NOW - HOUR })], records: [record({ issue: 480, state: 'closed', step: null, why: 'dropped', since: NOW - 30 * MIN })] }],
    ['a running claim', { issues: [held(480)], ledger: [entry(claimKey(480, 'tbq3k0'), 'claim', { issue: 480, status: 'running', endedAt: null })] }],
    ['a done v2 claim whose record S0 has still to make', { issues: [held(480)], ledger: [entry(claimKey(480, 'tbq3k0'), 'claim', { issue: 480, outcome: { kind: 'claim', result: 'claimed' } })] }],
    ['another device\'s claim', { issues: [held(480, { holder: OTHER })] }],
    ['no holder', { issues: [held(480, { holder: null })] }],
    ['a claim that ended or lapsed (queued)', { issues: [held(480, { state: 'queued' })] }],
    ['a final stage', { issues: [held(480, { state: 'closed', merged: true }), held(481, { state: 'closed' })] }],
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
    const older = world({ issues: [held(482, { stateSince: NOW - HOUR })], records: [record({ issue: 482, state: 'closed', step: null, why: 'dropped', since: NOW - 3 * HOUR })] })
    expect(r1(planV2(older, CFG)).map(a => a.issue)).toEqual([482])
    const lost = world({ issues: [held(483)], ledger: [entry(claimKey(483, 'tbq3k0'), 'claim', { issue: 483, outcome: { kind: 'claim', result: 'lost' } })] })
    expect(r1(planV2(lost, CFG)).map(a => a.issue)).toEqual([483])
    const recorded = world({ issues: [held(484)], records: [record({ issue: 484, life: 'tbq3k0', state: 'closed', step: null, why: 'dropped', since: NOW - 5 * HOUR })], ledger: [entry(claimKey(484, 'tbq3k0'), 'claim', { issue: 484 })] })
    expect(r1(planV2(recorded, CFG)).map(a => a.issue)).toEqual([484])
  })

  // a ghost by the spec's words (6.2), restated for the property
  function ghost(s: State, n: number): boolean {
    const i = s.issues.find(x => x.number === n)
    if (i === undefined || i.holder !== DEVICE || i.state === null || !LIVE_STATES.includes(i.state) || i.open === false) return false
    const records = (s.v2?.records ?? []).filter(r => r.issue === n)
    if (records.some(r => r.state !== 'closed')) return false
    if (records.length > 0 && (i.stateSince === null || records.some(r => r.since >= (i.stateSince ?? 0)))) return false
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
    const dropped: { issue: number; at: number }[] = []
    for (let n = 500; n < 508; n++) {
      // the owner's drop since the claim (it leaves), or two earlier lives R1 released (its third is rejected)
      if (r() < 0.15) dropped.push({ issue: n, at: NOW - 5 * MIN })
      const earlier = r() < 0.2
      if (earlier) for (const h of [30, 20]) ledger.push(entry(releaseKey(n, lifeOf(NOW - h * HOUR), 'requeue'), 'label', { issue: n, rule: 'R1', startedAt: NOW - (h - 1) * HOUR, endedAt: NOW - (h - 1) * HOUR }))
      const since = pick(r, [null, NOW - 2 * HOUR, NOW - 30 * MIN])
      issues.push(
        issue(n, {
          holder: pick(r, [DEVICE, DEVICE, OTHER, null]),
          state: pick(r, STATES),
          stateSince: since,
          open: pick(r, [true, true, false, null]),
          labels: pick(r, [null, ['bug'], ['ready'], ['Ready', 'bug']]),
          pr: pick(r, [null, 600 + n]),
        }),
      )
      const life = pick(r, ['tbq3k0', 'tbq9z9'])
      const rec = earlier ? 'none' : pick(r, ['none', 'none', 'open', 'closed-old', 'closed-new'])
      if (rec === 'open') records.push(record({ issue: n, life, state: pick(r, ['queued', 'building', 'parked', 'merge-queue'] as const), step: null }))
      if (rec === 'closed-old') records.push(record({ issue: n, life, state: 'closed', step: null, why: 'dropped', since: NOW - 4 * HOUR }))
      if (rec === 'closed-new') records.push(record({ issue: n, life, state: 'closed', step: null, why: 'merged', since: NOW - 5 * MIN }))
      // earlier lives come with a claim of this life, which dates the ghost after them
      const claim = earlier ? 'v1' : pick(r, ['none', 'running', 'done', 'done-recorded', 'lost', 'v1'])
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
    return world({ issues, records, ledger, leases, agents, dropped, leasesOk: r() > 0.1 })
  }

  // outcome: how a ghost's release must end (6.4): it leaves when the owner dropped it since its
  // claim, it is rejected at its maxLives-th life, and else it goes back to the queue.
  function outcome(s: State, n: number): ReleaseOutcome {
    const g = ghostsOf(ctxOf(s)).find(x => x.issue === n)
    const claimAt = g?.claim === null || g === undefined ? null : lifeAt(g.claim)
    if (claimAt !== null && s.control.dropped.some(d => d.issue === n && d.at >= claimAt)) return 'leave'
    if ((g?.lives.count ?? 0) + 1 >= CFG.maxLives) return 'reject'
    return 'requeue'
  }

  // about 1 s alone, and past the default 5 s when the host is loaded (a 5.5 s failure seen at
  // load average 25 on 16 CPUs): a generous bound of its own
  test('over generated factories: every R1 action and skip line names a ghost; its event comes only after its effects and its slot; a done release plans nothing more; planning is deterministic and idempotent', { timeoutMs: 60_000 }, () => {
    const seen = { ghosts: 0, requeue: 0, leave: 0, reject: 0, kept: 0 }
    for (let seed = 1; seed <= 300; seed++) {
      let s = generated(seed)
      seen.kept += s.issues.filter(i => i.holder === DEVICE && i.state !== null && LIVE_STATES.includes(i.state) && !ghost(s, i.number)).length
      const ghosts = new Set(s.issues.filter(i => ghost(s, i.number)).map(i => i.number))
      // each ghost's outcome, fixed when its release begins
      const outcomes = new Map([...ghosts].map(n => [n, outcome(s, n)]))
      const released = new Map<number, string>()
      const logged = new Map<number, string>()
      // R1's interventions: each a done release's, cause reconcile, keyed by its event, planned only
      // once its event is done and never again once logged (7.2, property 13)
      const interventions = (all: readonly Action[]) => {
        const ivs = all.filter(isIv)
        for (const a of ivs) {
          const n = a.issue ?? -1
          const fact = released.get(n)
          if (fact === undefined) throw new Error(`seed ${seed}: R1 planned ${a.key} for #${n}, whose release is not done`)
          if (logged.has(n)) throw new Error(`seed ${seed}: R1 planned ${a.key} again after it was logged`)
          expect(a).toMatchObject(releaseIv(n, fact, outcomes.get(n) === 'reject' ? 'rejected' : 'reconcile'))
        }
        return ivs
      }
      for (let pass = 0; pass < 6; pass++) {
        const result = planV2(s, CFG)
        expect(planV2(s, CFG)).toEqual(result)
        // the tripwire's tells are not a ghost's; a rejection's tell is
        const all = r1(result).filter(a => a.kind !== 'tell' || a.wake === 'rejected')
        const ivs = interventions(all)
        const mineR1 = all.filter(a => !isIv(a))
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
          const want = outcomes.get(n) ?? 'requeue'
          if (a.kind === 'event' && (a.event.state !== releaseState(want) || !('outcome' in a.event) || a.event.outcome !== want)) throw new Error(`seed ${seed}: #${n} released as ${a.event.state}, not ${want}`)
          if (want === 'reject' && !s.ledger.some(e => e.issue === n && e.kind === 'tell' && e.status === 'done')) throw new Error(`seed ${seed}: #${n} rejected before the owner was told`)
          if (want === 'reject' && !s.ledger.some(e => e.issue === n && e.kind === 'comment' && e.status === 'done')) throw new Error(`seed ${seed}: #${n} rejected before its comment`)
        }
        // the labels say the outcome: ready back only for a requeue, factory:rejected only for a rejection
        for (const a of mineR1.filter(x => x.kind === 'label')) {
          const want = outcomes.get(a.issue ?? -1)
          const op = a.kind === 'label' ? a.op : null
          if (op !== { requeue: 'requeue', leave: 'clear', reject: 'reject' }[want ?? 'requeue']) throw new Error(`seed ${seed}: #${a.issue}'s labels by op ${op}, its outcome ${want}`)
          if (op === 'requeue' && s.issues.find(x => x.number === a.issue)?.open !== true) throw new Error(`seed ${seed}: #${a.issue} requeued with its GitHub state unknown`)
        }
        // idempotent: with its actions running, planning again starts none of them again
        const again = r1(planV2(ran(s, all, 'running'), CFG)).filter(a => all.some(m => m.key === a.key))
        if (again.length > 0) throw new Error(`seed ${seed}: planned again while running: ${again.map(a => a.key).join(', ')}`)
        // the act step runs everything; W2 frees the slots; the pool is read
        for (const a of mineR1) {
          if (a.kind !== 'event') continue
          released.set(a.issue ?? -1, a.key)
          seen[outcomes.get(a.issue ?? -1) ?? 'requeue'] += 1
        }
        for (const a of ivs) logged.set(a.issue ?? -1, a.key)
        s = withLeases(ran(s, all), [])
        s = { ...s, v2: { ...(s.v2 ?? emptyV2State(NOW)), sources: { ...(s.v2 ?? emptyV2State(NOW)).sources, leases: { ok: true, at: NOW } } } }
        // the factory keeps showing a released claim live, and a run's stage moves its time
        s = { ...s, issues: s.issues.map(i => (released.has(i.number) && i.stateSince !== null ? { ...i, stateSince: NOW - (5 - pass) * MIN } : i)) }
      }
      // a release done on the last pass logs its intervention on the next; every done release has
      // exactly one
      const last = interventions(r1(planV2(s, CFG)).filter(a => a.kind !== 'tell'))
      for (const a of last) logged.set(a.issue ?? -1, a.key)
      s = ran(s, last)
      for (const n of released.keys()) if (!logged.has(n)) throw new Error(`seed ${seed}: #${n}'s release logged no intervention`)
      if (logged.size !== released.size) throw new Error(`seed ${seed}: ${logged.size} interventions for ${released.size} releases`)
      // a done release leaves the issue to S1: no ghost; S1's claim, then its record, start the new life
      const life = lifeOf(NOW)
      for (const n of released.keys()) if (ghostsOf(ctxOf(s)).some(g => g.issue === n)) throw new Error(`seed ${seed}: #${n} is a ghost after its release was done`)
      const claimed: State = { ...s, ledger: [...s.ledger, ...[...released.keys()].map(n => entry(claimKey(n, life), 'claim', { issue: n, startedAt: NOW, endedAt: NOW, outcome: { kind: 'claim', result: 'claimed' } }))] }
      const recorded: State = { ...claimed, v2: { ...(claimed.v2 ?? emptyV2State(NOW)), records: [...(claimed.v2?.records ?? []), ...[...released.keys()].map(n => record({ issue: n, life, state: 'queued', step: null, since: NOW }))] } }
      for (const st of [claimed, recorded]) {
        const after = planV2(st, CFG)
        const named = [...r1(after).filter(a => a.kind !== 'tell').map(a => a.issue), ...after.skipped.filter(k => k.rule === 'R1').map(k => k.issue)]
        for (const n of released.keys()) if (named.includes(n)) throw new Error(`seed ${seed}: R1 named #${n} after S1 claimed it`)
      }
      // every ghost ends released, but one whose requeue waits for a read of its GitHub state
      for (const n of ghosts) {
        const read = s.issues.find(x => x.number === n)?.open === true || outcomes.get(n) !== 'requeue'
        const dated =
          s.issues.find(x => x.number === n)?.stateSince !== null ||
          s.ledger.some(e => e.kind === 'claim' && e.issue === n && e.status === 'done' && !(e.outcome?.kind === 'claim' && e.outcome.result === 'lost'))
        if (read && dated && !released.has(n)) throw new Error(`seed ${seed}: ghost #${n} was never released`)
      }
      seen.ghosts += ghosts.size
    }
    // the generator reaches every case: ghosts released all three ways, and live claims a record or a claim holds
    expect(seen.ghosts).toBeGreaterThan(100)
    expect(seen.requeue).toBeGreaterThan(30)
    expect(seen.leave).toBeGreaterThan(10)
    expect(seen.reject).toBeGreaterThan(10)
    expect(seen.kept).toBeGreaterThan(300)
  })
})

describe('the main-checkout tripwire (v2 SPEC 10.7)', () => {
  const dirty = (paths: string[], over: Partial<CheckoutRead> = {}): CheckoutRead => ({ ...CLEAN, dirty: paths, ...over })
  const tells = (result: PlanResult) => result.actions.filter((a): a is Extract<Action, { kind: 'tell' }> => a.kind === 'tell' && a.wake === 'checkout')
  const base = (checkout: CheckoutRead, at = NOW - MIN): CheckoutBase => ({ checkout, at })

  test('a new tracked change tells the owner once, with its paths and the steps that ran in that window', () => {
    const steps = [
      entry('i470/l0/s3/build/a1', 'agent-step', { issue: 470, status: 'running', endedAt: null }),
      entry('i471/l0/s2/design/a1', 'agent-step', { issue: 471, endedAt: NOW - MIN }),
      entry('i472/l0/s2/design/a1', 'agent-step', { issue: 472, endedAt: NOW - 30 * MIN }),
    ]
    const now = dirty(['README.md', 'hooks/a.ts'])
    const s = world({ base: base(dirty(['hooks/a.ts'])), checkout: now, ledger: steps })
    const result = planV2(s, CFG)
    const [tell] = tells(result)
    expect(tells(result)).toHaveLength(1)
    expect(tell).toMatchObject({ key: tripwireKey(now), class: 'owner', rule: 'R1', issue: null, fields: { branch: 'main', moved: 'no', paths: '1', steps: '2' } })
    expect(tell?.context).toEqual(['changed:', '- README.md', 'steps in that window:', '- i470/l0/s3/build/a1 (running, #470)', '- i471/l0/s2/design/a1 (done, #471)'])
    expect(result.owner).toBe(1)
    // told: the same change is not told again, and the base moves past it
    const told = ran(s, tells(result))
    expect(tells(planV2(told, CFG))).toEqual([])
    expect(checkoutBaseOf(base(dirty(['hooks/a.ts'])), now, told.ledger, NOW)).toEqual({ checkout: now, at: NOW })
  })

  test('a moved HEAD tells; nothing new, no base, a failed read or changes cleaned away do not', () => {
    const moved = dirty([], { head: '9e01b77aa45eef8d6c31556c1b5ac3d5dd34f3ff', ahead: 1 })
    const told = tells(planV2(world({ base: base(CLEAN), checkout: moved }), CFG))
    expect(told).toHaveLength(1)
    expect(told[0]?.fields.moved).toBe('yes')
    expect(told[0]?.context[0]).toBe('HEAD moved: 5251b75 -> 9e01b77 on main')
    for (const [b, now] of [
      [base(dirty(['a'])), dirty(['a'])],
      [null, dirty(['a'])],
      [base(CLEAN), { error: 'git status failed' }],
      [base(dirty(['a', 'b'])), dirty(['b'])],
    ] as [CheckoutBase | null, Checkout | null][]) {
      expect(tells(planV2(world({ base: b, checkout: now }), CFG))).toEqual([])
    }
  })

  // passes: the tripwire over several passes, observe's base carried between them as observe
  // carries it (checkoutBaseOf), with what each pass did to the ledger and the store
  type Pass = { checkout: Checkout | null; ledger?: LedgerEntry[]; storeOk?: boolean; restart?: boolean }
  function passes(list: Pass[]): { tells: Action[][]; admitted: Action[][] } {
    let b: CheckoutBase | null = base(CLEAN, NOW - 10 * MIN)
    let ledger: LedgerEntry[] = []
    const out = { tells: [] as Action[][], admitted: [] as Action[][] }
    list.forEach((p, i) => {
      const at = NOW + i * MIN
      const added = p.ledger ?? []
      ledger = [...ledger.filter(e => !added.some(n => n.key === e.key)), ...added]
      if (p.restart) b = null
      b = checkoutBaseOf(b, p.checkout, ledger, at)
      let s: State = { ...world({ base: b, checkout: p.checkout, ledger }), now: at }
      if (p.storeOk === false && s.v2 !== undefined) s = { ...s, v2: { ...s.v2, sources: { ...s.v2.sources, store: { ok: false, at: null, error: 'store down' } } } }
      const result = planV2(s, CFG)
      out.tells.push(tells(result))
      out.admitted.push(result.actions.filter(a => a.rule === 'R1'))
    })
    return out
  }
  const now = dirty(['plugins/x.ts'])
  const key = tripwireKey(now)
  const toldAt = (at: number) => entry(key, 'tell', { rule: 'R1', startedAt: at, endedAt: at })
  const openWake = entry('tell:other:1', 'tell', { status: 'running', startedAt: NOW - MIN, endedAt: null })

  test('a notice a wake held back is planned again on the next pass, and told once', () => {
    const p = passes([
      { checkout: now, ledger: [openWake] },
      { checkout: now, ledger: [{ ...openWake, status: 'done', endedAt: NOW }] },
      { checkout: now, ledger: [toldAt(NOW + MIN)] },
      { checkout: now },
    ])
    // the first pass planned it, and the open wake held it back
    expect(p.admitted[0]).toEqual([])
    expect(p.admitted[1]?.map(a => a.key)).toEqual([key])
    expect(p.admitted[2]).toEqual([])
    expect(p.admitted[3]).toEqual([])
  })

  test('a failed read, a store-blind pass and a restart in between lose nothing', () => {
    const p = passes([
      { checkout: now, ledger: [openWake] },
      { checkout: { error: 'git status failed' } },
      { checkout: now, storeOk: false },
      { checkout: null },
      { checkout: now, restart: true, ledger: [{ ...openWake, status: 'done', endedAt: NOW }] },
    ])
    expect(p.admitted.slice(0, 4)).toEqual([[], [], [], []])
    expect(p.admitted[4]?.map(a => a.key)).toEqual([key])
  })

  test('after a restart a change already told is not told again; a clean checkout is no change', () => {
    const p = passes([
      { checkout: now, ledger: [toldAt(NOW - HOUR)], restart: true },
      { checkout: CLEAN, restart: true },
      { checkout: dirty([], { head: '9e01b77aa45eef8d6c31556c1b5ac3d5dd34f3ff' }), restart: true },
    ])
    expect(p.tells).toEqual([[], [], []])
  })

  test('a told change moves the base; a further change is told again; changes cleaned away are no change, and a checkout told before is not told again', () => {
    const more = dirty(['plugins/x.ts', 'README.md'])
    const p = passes([{ checkout: now }, { checkout: now, ledger: [toldAt(NOW)] }, { checkout: more }, { checkout: dirty([]) }, { checkout: now }])
    expect(p.admitted.map(a => a.map(x => x.key))).toEqual([[key], [], [tripwireKey(more)], [], []])
    expect(p.tells[2]?.[0]?.context).toEqual(['changed:', '- README.md'])
  })

  const B = '9e01b77aa45eef8d6c31556c1b5ac3d5dd34f3ff'
  const skips = (result: PlanResult) => result.skipped.filter(s => s.why.startsWith('checkout:'))

  test('a clean fast-forward along origin is not told, the base moves, and later changes are told once', () => {
    for (const behind of [0, 2]) {
      const ff = dirty([], { head: B, ahead: 0, behind })
      const p = passes([{ checkout: ff }, { checkout: dirty(['new.ts'], { head: B, behind }) }, { checkout: dirty([], { head: 'c0ffee77aa45eef8d6c31556c1b5ac3d5dd34f3f', ahead: 1 }) }])
      expect(p.tells[0]).toEqual([])
      expect(p.tells[1]).toHaveLength(1)
      expect(p.tells[1]?.[0]).toMatchObject({ fields: { moved: 'no', paths: '1' } })
      expect(p.tells[2]).toHaveLength(1)
      expect(p.tells[2]?.[0]).toMatchObject({ fields: { moved: 'yes' } })
      expect(checkoutBaseOf(base(CLEAN), ff, [], NOW)).toMatchObject({ checkout: ff, settled: { from: CLEAN.head, to: B, behind } })
    }
  })

  test('a HEAD move that is not along origin still tells', () => {
    const cases: Partial<CheckoutRead>[] = [{ ahead: 1 }, { branch: 'issue-1', upstream: 'origin/issue-1' }, { branch: null, upstream: null, ahead: null, behind: null }, { upstream: null, ahead: null, behind: null }, { ahead: null }, { upstream: 'origin/other' }]
    for (const over of cases) {
      const told = tells(planV2(world({ base: base(CLEAN), checkout: dirty([], { head: B, ...over }) }), CFG))
      expect(told).toHaveLength(1)
      expect(told[0]?.fields.moved).toBe('yes')
    }
    const withPath = tells(planV2(world({ base: base(CLEAN), checkout: dirty(['a.ts'], { head: B }) }), CFG))
    expect(withPath[0]?.context).toEqual(['changed:', '- a.ts'])
  })

  test('the settled skip line shows on the pass the base moves, and not on the next', () => {
    const ff = dirty([], { head: B, behind: 3 })
    const settled = checkoutBaseOf(base(CLEAN), ff, [], NOW)
    const first = planV2(world({ base: settled, checkout: ff }), CFG)
    expect(skips(first).map(s => s.why)).toEqual(['checkout: HEAD 5251b75 -> 9e01b77 is on origin/main (0 ahead, 3 behind); not told'])
    const next = checkoutBaseOf(settled, ff, [], NOW + MIN)
    expect(next?.settled).toBeUndefined()
    expect(skips(planV2(world({ base: next, checkout: ff }), CFG))).toEqual([])
  })

  test('the settled skip line is not repeated while a later change waits to be told', () => {
    const ff = dirty([], { head: B, behind: 3 })
    const settled = checkoutBaseOf(base(CLEAN), ff, [], NOW)
    expect(settled?.settled).toBeDefined()
    const changed = dirty(['new.ts'], { head: B, behind: 3 })
    const kept = checkoutBaseOf(settled, changed, [], NOW + MIN)
    expect(kept?.settled).toBeUndefined()
    expect(skips(planV2(world({ base: kept, checkout: changed }), CFG))).toEqual([])
  })

  test('checkoutBaseOf: a failed or missing read keeps the base; the first read is a clean checkout at its HEAD unless told', () => {
    const b = base(CLEAN)
    expect(checkoutBaseOf(b, { error: 'x' }, [], NOW)).toBe(b)
    expect(checkoutBaseOf(b, null, [], NOW)).toBe(b)
    expect(checkoutBaseOf(null, now, [], NOW)).toEqual({ checkout: CLEAN, at: NOW })
    expect(checkoutBaseOf(null, now, [toldAt(NOW - MIN)], NOW)).toEqual({ checkout: now, at: NOW })
    expect(checkoutBaseOf(b, now, [], NOW)).toBe(b)
    expect(checkoutBaseOf(b, now, [{ ...toldAt(NOW - MIN), status: 'failed' }], NOW)).toBe(b)
  })

  test('checkoutChange and tripwireKey: one key per checkout, another for a different change', () => {
    expect(checkoutChange(CLEAN, dirty(['b', 'a']))).toEqual({ head: CLEAN.head, branch: 'main', moved: null, paths: ['a', 'b'] })
    expect(checkoutChange(CLEAN, dirty([], { branch: null }))?.moved).toEqual({ from: CLEAN.head, to: CLEAN.head })
    const a = dirty(['x', 'y'])
    expect(tripwireKey(a)).toBe(tripwireKey(dirty(['y', 'x'])))
    expect(tripwireKey(a)).not.toBe(tripwireKey(dirty(['x'])))
  })
})

describe('the release (v2 SPEC 6.4)', () => {
  const input = { issue: 467, claim: 'tbq3k0', outcome: 'leave' as ReleaseOutcome, lives: null, stage: 'in pipeline', checked: 'no run update,\n no PR push', branch: 'feat/issue-467-x', pr: 621 }

  test('reclaimed back to the queue, else abandoned; reason reconcile, its outcome and life, the stage and what was checked on one line', () => {
    expect(releaseEvent(input)).toEqual({ state: 'abandoned', issue: 467, branch: 'feat/issue-467-x', pr: 621, stage: 'in pipeline', checked: 'no run update, no PR push', reason: 'reconcile', outcome: 'leave', lives: null })
    expect(releaseEvent({ ...input, outcome: 'requeue', lives: 2 })).toMatchObject({ state: 'reclaimed', outcome: 'requeue', lives: 2 })
    expect(releaseEvent({ ...input, outcome: 'reject', lives: 3 })).toMatchObject({ state: 'abandoned', outcome: 'reject', lives: 3 })
    expect(RELEASE_OUTCOMES.map(releaseState)).toEqual(['reclaimed', 'abandoned', 'abandoned'])
    expect(releaseReason('in pipeline', 'a\nb')).toBe('no live step in in pipeline: a b')
  })

  test('the labels a release removes: every factory label, and for the migration In development too, as the issue spells them', () => {
    const labels = ['bug', 'factory:building', 'In development', 'FACTORY:parked', 'ready']
    expect(releaseLabels(labels, false, 'in development')).toEqual(['factory:building', 'FACTORY:parked'])
    expect(releaseLabels(labels, true, 'in development')).toEqual(['factory:building', 'In development', 'FACTORY:parked'])
  })

  test('the intervention a release is: by its who, cause reconcile (rejected for a rejection), keyed by the release\'s event, a reason of at most 200 characters', () => {
    const iv = releaseIntervention({ ...input, checked: 'x'.repeat(400) }, 'person')
    expect(iv).toMatchObject({ state: 'intervention', who: 'person', cause: 'reconcile', issue: 467, pr: 621, life: null, fact: releaseKey(467, 'tbq3k0', RELEASE_OPS.event) })
    expect(iv.reason.length).toBeLessThanOrEqual(200)
    expect(iv.reason).toMatch(/^abandoned: no live step in in pipeline: x+\.\.\.$/)
    expect(releaseIntervention(input, 'loop').who).toBe('loop')
    expect(releaseIntervention({ ...input, outcome: 'reject', lives: 3 }, 'loop')).toMatchObject({ cause: 'rejected', reason: expect.stringMatching(/^rejected at life 3: no live step/) })
  })

  test('its effects in order, each R1\'s and free: a stop per agent, then the labels by its outcome (a rejection\'s comment after); its event is its own action; its done event entry is the release', () => {
    const effects = releaseEffects(input, [{ agentId: 'a1', entry: 'k1' }, { agentId: 'a2', entry: 'k2' }], 'why', 'ready', [], 3)
    expect(effects.map(a => [a.kind, a.rule, a.class, a.issue])).toEqual([
      ['stop-agent', 'R1', 'free', 467],
      ['stop-agent', 'R1', 'free', 467],
      ['label', 'R1', 'free', 467],
    ])
    expect(new Set(effects.map(a => a.key)).size).toBe(3)
    const ops = (o: ReleaseOutcome) => releaseEffects({ ...input, outcome: o, lives: 3 }, [], 'why', 'Ready', ['life 1: x'], 3).map(a => (a.kind === 'label' ? [a.op, a.ready ?? null, a.key] : [a.kind, null, a.key]))
    expect(ops('requeue')).toEqual([['requeue', 'Ready', releaseKey(467, 'tbq3k0', 'requeue')]])
    expect(ops('leave')).toEqual([['clear', null, releaseKey(467, 'tbq3k0', 'leave')]])
    expect(ops('reject')).toEqual([
      ['reject', null, releaseKey(467, 'tbq3k0', 'reject')],
      ['comment', null, releaseKey(467, 'tbq3k0', RELEASE_OPS.comment)],
    ])
    const event = releaseEventAction(input, 'why')
    expect(event).toMatchObject({ kind: 'event', rule: 'R1', class: 'free', issue: 467, key: releaseKey(467, 'tbq3k0', RELEASE_OPS.event) })
    expect(effects.concat(event).map(a => releaseClaimOf(467, a.key))).toEqual(['tbq3k0', 'tbq3k0', 'tbq3k0', 'tbq3k0'])
    expect([releaseClaimOf(46, event.key), releaseClaimOf(467, 'tell:stalled:x'), releaseClaimOf(467, claimKey(467, 'tbq3k0'))]).toEqual([null, null, null])
    const at = { key: event.key, issue: 467 }
    expect(isReleaseEntry({ ...at, kind: 'event', rule: 'R1' })).toBe(true)
    expect(isReleaseEntry({ ...at, kind: 'event', rule: 'S3' })).toBe(false)
    expect(isReleaseEntry({ ...at, kind: 'label', rule: 'R1' })).toBe(false)
    // the effects' keys, another issue's, and the intervention the release is (R1's too) are not it
    expect(effects.map(a => isReleaseEntry({ key: a.key, issue: 467, kind: 'event', rule: 'R1' }))).toEqual([false, false, false])
    expect(isReleaseEntry({ ...at, issue: 46, kind: 'event', rule: 'R1' })).toBe(false)
    expect(isReleaseEntry({ key: interventionKey(event.key), issue: 467, kind: 'event', rule: 'R1' })).toBe(false)
  })
})

describe('lives (v2 SPEC 3.2, 6.4)', () => {
  const at = (h: number) => lifeOf(NOW - h * HOUR)
  const closed = (h: number, lives: number, why: IssueRecord['why'], notes: string[] = []) => record({ issue: 490, life: at(h), state: 'closed', step: null, why, notes, since: NOW - (h - 1) * HOUR, lives })
  const released = (h: number, outcome: ReleaseOutcome) => entry(releaseKey(490, at(h), outcome), 'label', { issue: 490, rule: 'R1', startedAt: NOW - (h - 1) * HOUR, endedAt: NOW - (h - 1) * HOUR })

  test('the lives the loop knows: one per record, one per R1 release begun for a claim no record holds, oldest first', () => {
    const lives = knownLives([closed(10, 1, 'dropped', ['dropped']), record({ issue: 491, life: at(9) })], [released(5, 'requeue'), released(10, 'leave'), entry('i490/reconcile/x/event', 'event', { issue: 490, rule: 'R1' })], 490)
    expect(lives.map(l => [l.life, l.lives, l.ended, l.rejected])).toEqual([
      [at(10), 1, 'dropped', false],
      [at(5), null, 'released: a live claim with no record, put back in the queue', false],
    ])
  })

  test('a record\'s count stands, a release counts one more; a rejection starts the count again; pruned lives are named', () => {
    expect(livesBefore([], [], 490, at(1))).toEqual({ count: 0, ended: [], afterReject: false })
    const two = livesBefore([closed(10, 1, 'claim-lost')], [released(5, 'requeue')], 490, at(1))
    expect(two).toMatchObject({ count: 2, afterReject: false })
    expect(two.ended).toEqual([expect.stringMatching(/^life 1, claimed .* UTC: another device claimed it$/), expect.stringMatching(/^life 2, claimed .* UTC: released: .* put back in the queue$/)])
    // only lives before the claim count, and not the claim itself
    expect(livesBefore([closed(10, 1, 'dropped')], [released(5, 'requeue')], 490, at(5)).count).toBe(1)
    // after a rejection: the next claim is a first life again, and says so
    expect(livesBefore([closed(10, 1, 'dropped')], [released(5, 'reject')], 490, at(1))).toEqual({ count: 0, ended: [], afterReject: true })
    const after = livesBefore([closed(3, 1, 'dropped', ['dropped'])], [released(5, 'reject')], 490, at(1))
    expect(after).toMatchObject({ count: 1, afterReject: false })
    // a record whose count says earlier lives were pruned
    const pruned = livesBefore([closed(3, 3, 'split')], [], 490, at(1))
    expect(pruned.count).toBe(3)
    expect(pruned.ended[0]).toBe('lives 1 to 2: no longer in the loop\'s records')
  })

  test('S0 counts the life: after earlier lives its record carries the next number; the first claim after a rejection is life 1, via unreject, a person\'s intervention', () => {
    const life = lifeOf(NOW - MIN)
    const done = entry(claimKey(492, life), 'claim', { issue: 492, startedAt: NOW - MIN, endedAt: NOW - MIN, outcome: { kind: 'claim', result: 'claimed' } })
    const s0 = (records: IssueRecord[], ledger: LedgerEntry[]) =>
      planV2(world({ issues: [issue(492, { holder: DEVICE, state: 'designing', stateSince: NOW - MIN })], records, ledger: [...ledger, done] }), CFG).actions.find(a => a.kind === 'transition' && a.issue === 492)
    const earlier = record({ issue: 492, life: at(10), state: 'closed', step: null, why: 'dropped', since: NOW - 9 * HOUR, lives: 1 })
    expect(s0([earlier], [])).toMatchObject({ next: { lives: 2 }, via: 'claim' })
    expect(s0([], [])).toMatchObject({ next: { lives: 1 }, via: 'claim' })
    const rejected = entry(releaseKey(492, at(5), 'reject'), 'label', { issue: 492, rule: 'R1', startedAt: NOW - 4 * HOUR, endedAt: NOW - 4 * HOUR })
    const back = s0([earlier], [rejected])
    expect(back).toMatchObject({ next: { lives: 1 }, via: 'unreject' })
    // its done transition is the owner's intervention, cause unreject
    const t = entry(back?.key ?? '', 'transition', { issue: 492, rule: 'S1', startedAt: NOW, endedAt: NOW, outcome: { kind: 'transition', row: 'S0', event: 'ok', cause: null, from: null, to: 'queued', step: null, stored: true, via: 'unreject' } })
    const next = back?.kind === 'transition' ? back.next : record()
    const ivs = planV2(world({ records: [earlier, next], ledger: [rejected, done, t] }), config({ mode: 'act' })).actions.filter(isIv)
    expect(ivs.map(a => (a.kind === 'event' && a.event.state === 'intervention' ? [a.event.who, a.event.cause] : []))).toContainEqual(['person', 'unreject'])
  })

  test('S1 never claims an issue carrying factory:rejected, whatever else it carries', () => {
    const s = world({ issues: [issue(493, { labels: ['ready', 'factory:rejected'] })] })
    const result = planV2({ ...s, queue: [493] }, CFG)
    expect(result.actions.filter(a => a.kind === 'claim')).toEqual([])
    expect(result.skipped.filter(x => x.rule === 'S1' && x.issue === 493).map(x => x.why)).toEqual(['label factory:rejected: the owner removes it to try again'])
  })

  test('releaseOutcomeOf: the outcome a release began with, by its label entry', () => {
    for (const o of RELEASE_OUTCOMES) expect(releaseOutcomeOf(k => k === releaseKey(494, 'tbq3k0', o), 494, 'tbq3k0')).toBe(o)
    expect(releaseOutcomeOf(() => false, 494, 'tbq3k0')).toBeNull()
    expect(lifeAt(lifeOf(NOW))).toBe(Math.floor(NOW / 1000) * 1000)
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
      case 'fabriek-factory-state':
        return { stdout: factoryDoc([{ issue: ghostIssue, state: 'building', state_since: iso(NOW - 3 * HOUR), holder: DEVICE, pr: null, stuck: null, github: null }], [], NOW) }
      case 'dev-query':
        return { stdout: (s.stdin ?? '').includes('workers_status') ? QUIET_BEATS : NO_EVENTS }
      case `${TOOLS}/queue-watch.sh`:
        return { stdout: 'queue known=none now=none\n' }
      case `${TOOLS}/usage-check.sh`:
        return { stdout: USAGE }
      case 'fabriek-issue-read':
        if (args.includes('--list')) return { stdout: JSON.stringify({ issues: [], stripped: 0 }) }
        return args.join(' ') === `--json ${ghostIssue}` ? { stdout: JSON.stringify(issueJson) } : { stdout: JSON.stringify({ issues: [], stripped: 0 }) }
      case 'treehouse':
        return { stdout: '[]' }
    }
    return undefined
  }
}

describe('R1 in the driver', () => {
  test('observe mode with planner v2: the release of a ghost is planned and logged, and nothing of it runs', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: { repo: REPO, checkout: '/work' }, run: driverWorld(470) })
    await $.session.start(START)
    await clock.advance(6_000)
    // a second pass, once the issue's labels have been read
    await clock.advance(61_000)
    const line = h.last()
    expect(line).toMatchObject({ mode: 'observe', executed: false })
    const actions = line.actions as { kind: string; rule: string; issue: number | null; reason: string }[]
    expect(actions.filter(a => a.rule === 'R1').map(a => [a.kind, a.issue])).toEqual([['label', 470]])
    expect(actions.find(a => a.rule === 'R1')?.reason).toMatch(/^ghost #470: a live claim of this device in building for \d+ min with no record: back in the queue \(ready on, its factory labels off\)$/)
    const ran = h.commands().map(c => c.argv.join(' '))
    expect(ran.filter(c => c.startsWith('gh issue edit') || c.startsWith('fabriek-event'))).toEqual([])
    expect([...h.store.keys()].filter(k => k.startsWith('records:'))).toEqual([])
    expect(h.store.get(`ledger:${REPO}`)).toBeUndefined()
  })
})

// ctxOf: the context R1 works in for a state, for the pure helpers' own tests.
function ctxOf(s: State): V2Ctx {
  const base = newCtx(s, CFG, tierOf(s.usage, CFG, s.control.usageOverride, s.now), V2_OWNER_TELLS, GITHUB_V2)
  return Object.assign(base, { v2: s.v2 as V2State })
}
