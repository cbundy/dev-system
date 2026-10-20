// Refused jobs under planner v2 (docs/factory-loop/v2/SPEC.md 8.5, "Refused jobs"): a failed Actions
// job GitHub did not start for the account's sake (sources-prs.ts classifies it) is held by the review
// step and the merge queue's head instead of re-run, fixed or told per issue; one repo-wide spell tells
// the owner once, probes with a re-run every PROBE_MS, and resumes by itself. The source's
// classification is tested in v2-queue.test.ts. Plans are driven through planV2 itself.
import { describe, expect, test } from 'claude-code/testing'

import type { Action, LedgerEntry, PlanResult, State } from '../hooks/types'
import { interventionKey, lifeKey, lifeOf, prKey, prepareKey, refusedGoKey, refusedProbeKey, rerunKey, reviewKey } from '../hooks/v2/keys'
import { emptyV2State } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { PROBE_MS } from '../hooks/v2/rules-refused'
import type { CheckRun, PrView } from '../hooks/v2/sources-prs'
import { madeRecord } from '../hooks/v2/table'
import { SLOT_STATES, V2_OWNER_TELLS } from '../hooks/v2/types'
import type { IssueRecord, Lease, V2State } from '../hooks/v2/types'
import { MIN, NOW, config, entry, state as baseState } from './fixtures'
import { REPO } from './host'

const HOUR = 60 * MIN
const CFG = config({ mode: 'act', maxInFlightIssues: 3 })
const LIFE = lifeOf(NOW - 4 * HOUR)
const HEAD = '9e01b77c0ffee000000000000000000000000001'
const PATCH = 'f00dfeed00000000000000000000000000000001'
const MAIN = 'd'.repeat(40)
const WHY = "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings"
// the real case: plant-console job 117959454359 of run 39222065849
const RUN = '39222065849'
const JOB = '117959454359'
const RUN2 = '39222065850'
const JOB2 = '117959454400'
const OK = { ok: true, at: NOW }

// the review record (issue 800, PR 810) and the queue's head (issue 802, PR 812)
function rec(n: number, queue: boolean, over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    ...madeRecord({ issue: n, life: LIFE, branch: `issue-${n}`, pr: 10 + n, others: [] }, NOW - 3 * HOUR),
    seq: 5,
    seqAt: NOW - 3 * HOUR,
    since: NOW - 3 * HOUR,
    state: queue ? 'merge-queue' : 'reviewing',
    step: queue ? 'queue' : 'review',
    round: 1,
    head: HEAD,
    approvedPatch: queue ? PATCH : null,
    brief: `https://github.com/${REPO}/issues/${n}#issuecomment-${1000 + n}`,
    ...over,
  }
}

const refusedCheck = (run = RUN, job = JOB, over: Partial<CheckRun> = {}): CheckRun => ({
  name: 'plant-console',
  state: 'FAILURE',
  bucket: 'refused',
  startedAt: NOW - 2 * HOUR,
  completedAt: NOW - 2 * HOUR + 3000,
  runId: run,
  link: `https://github.com/${REPO}/actions/runs/${run}/job/${job}`,
  refusedWhy: WHY,
  ...over,
})
const plain = (bucket: CheckRun['bucket'], over: Partial<CheckRun> = {}): CheckRun => ({ ...refusedCheck(), name: 'lint', bucket, refusedWhy: undefined, runId: '1801', link: `https://github.com/${REPO}/actions/runs/1801/job/3`, ...over })

function view(r: IssueRecord, checks: CheckRun[]): PrView {
  return { pr: r.pr ?? 0, issue: r.issue, state: 'open', head: HEAD, mergedHead: null, closedAt: null, mergeable: 'clean', author: 'cbundy', base: MAIN, baseRef: 'main', labels: [], checks, patch: PATCH, readAt: NOW }
}

const leaseFor = (r: Pick<IssueRecord, 'issue' | 'life'>): Lease => ({ path: `/slots/${r.issue}`, lease: `L${r.issue}`, holder: `factory-loop:${r.issue}:${r.life}`, issue: r.issue, life: r.life, status: 'leased', busy: false })

function world(records: IssueRecord[], prs: PrView[], ledger: LedgerEntry[] = [], v2: Partial<V2State> = {}): State {
  const s = baseState()
  return {
    ...s,
    ledger: [...s.ledger, ...ledger],
    v2: {
      ...emptyV2State(NOW, records),
      sources: { store: OK, leases: OK, prs: OK, interventions: OK, comments: OK, dualWrite: OK },
      leases: records.filter(r => SLOT_STATES.includes(r.state)).map(leaseFor),
      prs: { prs, main: { branch: 'main', sha: MAIN } },
      // each head first seen three hours ago, long past ciStartMs
      heads: { [HEAD]: { pr: 810, at: NOW - 3 * HOUR } },
      reads: Object.fromEntries(records.map(r => [r.issue, { at: NOW, open: true, labels: [] as string[] }])),
      ...v2,
    },
  }
}

const plan = (s: State): PlanResult => planV2(s, CFG)
const of = (p: PlanResult, n: number): Action[] => p.actions.filter(a => a.issue === n && a.kind !== 'title')
const said = (p: PlanResult, n: number) => p.skipped.filter(s => s.issue === n).map(s => s.why)
const transitionOf = (p: PlanResult, n: number) => p.actions.find((a): a is Extract<Action, { kind: 'transition' }> => a.kind === 'transition' && a.issue === n)
const reruns = (p: PlanResult) => p.actions.filter((a): a is Extract<Action, { kind: 'ci-rerun' }> => a.kind === 'ci-rerun')
const tells = (p: PlanResult, name: string) => p.actions.filter((a): a is Extract<Action, { kind: 'tell' }> => a.kind === 'tell' && a.wake === name)

const ended = (key: string, kind: LedgerEntry['kind'], over: Partial<LedgerEntry> = {}): LedgerEntry => entry(key, kind, { startedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN, ...over })
// the review record's ledger up to an approved review of the head's patch
function reviewed(r: IssueRecord): LedgerEntry[] {
  return [
    ended(prKey(r, 'ensure'), 'pr', { issue: r.issue, startedAt: NOW - 3 * HOUR, endedAt: NOW - 3 * HOUR + 1000, outcome: { kind: 'pr', pr: r.pr ?? 0, created: true, reopened: false } }),
    ended(prepareKey(r, r.attempt), 'slot', { issue: r.issue, maxAttempts: 1, startedAt: NOW - 3 * HOUR, endedAt: NOW - 3 * HOUR + 1000 }),
    ended(reviewKey(r, PATCH, r.round, 1), 'agent-step', {
      issue: r.issue,
      class: 'drive',
      step: 'review',
      agentId: 'agent-1',
      startedAt: NOW - 2 * HOUR,
      endedAt: NOW - 2 * HOUR + 1000,
      outcome: { kind: 'step', step: 'review', result: { event: 'ok', reason: null, why: null, head: null, choice: null, data: { verdict: 'approve', findings: [], summary: 'ok', bump: 'patch', round: 1, patch: PATCH, head: HEAD, pr: r.pr ?? 0, reviewer: 'adjudicator', answer: '/x.json' } } },
    }),
  ]
}

// settled: the state with the review's writes (its comment and `reviewed` event) done, as the act step
// leaves them: a review's result is taken only once they are (rules-review.ts)
function settled(s: State): State {
  const ran = plan(s).actions.filter(a => a.kind === 'comment' || a.kind === 'event').map(a => ended(a.key, a.kind, { issue: a.issue }))
  return { ...s, ledger: [...s.ledger, ...ran] }
}

const rv = rec(800, false)
const rq = rec(802, true)
const both = (rvChecks: CheckRun[], rqChecks: CheckRun[]) => [view(rv, rvChecks), view(rq, rqChecks)]

describe('a refused check is held, never red, never re-run in the round, never fixed', () => {
  test('review: the only failed check refused plans no round re-run, no fixer, no park and no github-wait, however long it has been (the regression)', () => {
    const s = settled(world([rv], [view(rv, [refusedCheck(), plain('pass')])], reviewed(rv)))
    const p = plan(s)
    expect(reruns(p).filter(a => a.key === rerunKey(rv, 1, RUN))).toEqual([])
    expect(transitionOf(p, 800)).toBeUndefined()
    expect(of(p, 800).filter(a => a.kind === 'agent-step' || a.kind === 'slot')).toEqual([])
    const line = said(p, 800).find(w => w.startsWith('review: GitHub did not start'))
    expect(line).toContain('"plant-console"')
    expect(line).toContain(`run ${RUN}`)
    expect(line).toContain(`job ${JOB}`)
    expect(line).toContain('The job was not started because recent account payments have failed')
    // the same check as a plain failure is the old behaviour: one re-run of its run
    const failed = plan(settled(world([rv], [view(rv, [refusedCheck(RUN, JOB, { bucket: 'fail', refusedWhy: null }), plain('pass')])], reviewed(rv))))
    expect(reruns(failed)).toEqual([expect.objectContaining({ key: rerunKey(rv, 1, RUN) })])
  })

  test('review: a real failure beside a refused check is still re-run once and goes red after it', () => {
    const real = (over: Partial<CheckRun> = {}) => plain('fail', over)
    const first = plan(settled(world([rv], [view(rv, [refusedCheck(), real()])], reviewed(rv))))
    expect(reruns(first)).toEqual([expect.objectContaining({ key: rerunKey(rv, 1, '1801') })])
    const rerun = ended(rerunKey(rv, 1, '1801'), 'ci-rerun', { issue: 800, startedAt: NOW - 3 * MIN })
    const again = plan(settled(world([rv], [view(rv, [refusedCheck(), real({ completedAt: NOW - MIN })])], [...reviewed(rv), rerun])))
    expect(transitionOf(again, 800)).toMatchObject({ row: 'T9', via: 'fix:ci' })
  })

  test('the queue head: a refused check holds with GitHub\'s message, past the CI bounds, with no re-run, fixer or unknown', () => {
    const s = world([rq], [view(rq, [refusedCheck(), plain('pass')])])
    const p = plan(s)
    expect(reruns(p).filter(a => a.key === rerunKey(rq, 1, RUN))).toEqual([])
    expect(transitionOf(p, 802)).toBeUndefined()
    expect(of(p, 802).filter(a => a.kind === 'queue-merge' || a.kind === 'queue-update' || a.kind === 'agent-step')).toEqual([])
    expect(said(p, 802).find(w => w.startsWith('merge queue: GitHub did not start'))).toContain(`job ${JOB}`)
    // a real failure beside it goes red after its re-run as before
    const rerun = ended(rerunKey(rq, 1, '1801'), 'ci-rerun', { issue: 802, startedAt: NOW - 3 * MIN })
    const red = plan(world([rq], [view(rq, [refusedCheck(), plain('fail', { completedAt: NOW - MIN })])], [rerun]))
    expect(transitionOf(red, 802)).toMatchObject({ row: 'T9', via: 'fix:ci' })
  })
})

describe('the refusal spell (rules-refused.ts)', () => {
  const tellKey = `tell:actions-refused:${JOB}`
  const spell = (at: number, extra: LedgerEntry[] = []): LedgerEntry[] => [entry(tellKey, 'tell', { wake: 'actions-refused', rule: 'S2', startedAt: at, endedAt: at + 1000 }), ...extra]
  // two PRs refused at once: the review record's job is the later, the queue head's the earlier one
  const twoRefused = (ledger: LedgerEntry[] = [], extra: Partial<{ rvChecks: CheckRun[]; rqChecks: CheckRun[] }> = {}) =>
    world([rv, rq], both(extra.rvChecks ?? [refusedCheck(RUN2, JOB2, { completedAt: NOW - 90 * MIN })], extra.rqChecks ?? [refusedCheck(RUN, JOB)]), [...reviewed(rv), ...ledger])

  test('two refused PRs plan one repo-wide tell, keyed by the earliest job, for no issue, with the message; no second one once it is told', () => {
    const p = plan(twoRefused())
    const [tell, ...rest] = tells(p, 'actions-refused')
    expect(rest).toEqual([])
    expect(tell).toMatchObject({ key: tellKey, issue: null, loopData: { decision: 'hold' } })
    expect(tell?.loopData?.decision_reason).toContain('The job was not started')
    expect(tell?.context.join(' ')).toContain('the account')
    expect(tell?.context.join(' ')).toContain('#812')
    expect(tell?.context.join(' ')).toContain('#810')
    expect(V2_OWNER_TELLS).toContain('actions-refused')
    // nothing parks or fixes either issue
    expect(p.actions.filter(a => a.kind === 'transition')).toEqual([])
    const later = plan(twoRefused(spell(NOW - 5 * MIN)))
    expect(tells(later, 'actions-refused')).toEqual([])
    expect(reruns(later)).toEqual([])
  })

  test('each refused run is logged once as a ci-refused intervention naming its jobs, head and GitHub\'s message', () => {
    const p = plan(twoRefused())
    const ivs = p.actions.flatMap(a => (a.kind === 'event' && a.event.state === 'intervention' && a.event.cause === 'ci-refused' ? [a] : []))
    expect(ivs.map(a => a.key).sort()).toEqual([interventionKey(`${lifeKey(rv)}/refused/${RUN2}`), interventionKey(`${lifeKey(rq)}/refused/${RUN}`)].sort())
    const q = ivs.find(a => a.issue === 802)
    expect(q?.event).toMatchObject({ who: 'loop', cause: 'ci-refused', pr: 812, failed_jobs: ['plant-console'], head: HEAD })
    expect(q?.event.state === 'intervention' ? q.event.reason : '').toContain('The job was not started')
  })

  test('a probe after each 30 minutes, for the queue head\'s run alone; none before the first period', () => {
    expect(reruns(plan(twoRefused(spell(NOW - 29 * MIN))))).toEqual([])
    const p = plan(twoRefused(spell(NOW - PROBE_MS - MIN)))
    expect(reruns(p)).toEqual([expect.objectContaining({ key: refusedProbeKey(rq, RUN, 1), runId: RUN, issue: 802, pr: 812 })])
    // the rerunKey of the round stays free
    expect(reruns(p).map(a => a.key)).not.toContain(rerunKey(rq, 1, RUN))
    // period 1 done: the next period probes again; a probe GitHub refused leaves the spell open
    const refusedProbe = ended(refusedProbeKey(rq, RUN, 1), 'ci-rerun', { issue: 802, status: 'failed', attempts: 1, maxAttempts: 3, summary: 'GitHub refused the re-run of run x: HTTP 403' })
    const next = plan(twoRefused(spell(NOW - 2 * PROBE_MS - MIN, [refusedProbe])))
    expect(reruns(next).map(a => a.key)).toEqual([refusedProbeKey(rq, RUN, 2)])
    expect(tells(next, 'actions-resumed')).toEqual([])
  })

  test('a job that started after the spell opened ends it: one notice, and each refused run re-run once; a refused job is no proof', () => {
    const started = plain('pass', { startedAt: NOW - 2 * MIN, completedAt: NOW - MIN })
    const refusedLater = refusedCheck(RUN2, JOB2, { startedAt: NOW - 2 * MIN })
    const noProof = plan(twoRefused(spell(NOW - 10 * MIN), { rvChecks: [refusedLater] }))
    expect(tells(noProof, 'actions-resumed')).toEqual([])
    const p = plan(twoRefused(spell(NOW - 10 * MIN), { rvChecks: [refusedCheck(RUN2, JOB2), started] }))
    const [notice, ...rest] = tells(p, 'actions-resumed')
    expect(rest).toEqual([])
    expect(notice).toMatchObject({ key: `tell:actions-resumed:${tellKey}`, issue: null, loopData: { decision: 'resume' } })
    expect(V2_OWNER_TELLS).not.toContain('actions-resumed')
    expect(reruns(p).map(a => a.key).sort()).toEqual([refusedGoKey(rv, RUN2), refusedGoKey(rq, RUN)].sort())
    // done: no second notice, no second re-run, no new spell for the runs it re-ran
    const resumed = [
      entry(`tell:actions-resumed:${tellKey}`, 'tell', { wake: 'actions-resumed', startedAt: NOW - MIN, endedAt: NOW - MIN }),
      ended(refusedGoKey(rv, RUN2), 'ci-rerun', { issue: 800, startedAt: NOW - MIN }),
      ended(refusedGoKey(rq, RUN), 'ci-rerun', { issue: 802, startedAt: NOW - MIN }),
    ]
    const after = plan(twoRefused([...spell(NOW - 10 * MIN), ...resumed], { rvChecks: [refusedCheck(RUN2, JOB2)] }))
    expect(tells(after, 'actions-resumed')).toEqual([])
    expect(tells(after, 'actions-refused')).toEqual([])
    expect(reruns(after)).toEqual([])
  })

  test('a run refused again after the resume opens a new spell, keyed by its new job', () => {
    const resumed = entry(`tell:actions-resumed:${tellKey}`, 'tell', { wake: 'actions-resumed', startedAt: NOW - 20 * MIN, endedAt: NOW - 20 * MIN })
    const again = refusedCheck(RUN, '117959999999', { startedAt: NOW - 5 * MIN, completedAt: NOW - 5 * MIN + 1000 })
    const p = plan(twoRefused([...spell(NOW - HOUR), resumed], { rvChecks: [again], rqChecks: [plain('pass')] }))
    expect(tells(p, 'actions-refused').map(t => t.key)).toEqual(['tell:actions-refused:117959999999'])
  })
})

describe('the refused re-runs in the logs (rules-interventions.ts, rules-flakes.ts)', () => {
  const tellKey = `tell:actions-refused:${JOB}`
  test('probe and go re-runs log ci-refused:probe and ci-refused:rerun, not ci-rerun', () => {
    const ledger = [
      entry(tellKey, 'tell', { wake: 'actions-refused', startedAt: NOW - 2 * HOUR }),
      ended(refusedProbeKey(rq, RUN, 1), 'ci-rerun', { issue: 802 }),
      ended(refusedGoKey(rq, RUN), 'ci-rerun', { issue: 802 }),
      ended(rerunKey(rq, 1, '1801'), 'ci-rerun', { issue: 802 }),
    ]
    const p = plan(world([rq], [view(rq, [plain('pass')])], ledger))
    const causes = Object.fromEntries(p.actions.flatMap(a => (a.kind === 'event' && a.event.state === 'intervention' ? [[a.key, a.event.cause]] : [])))
    expect(causes[interventionKey(refusedProbeKey(rq, RUN, 1))]).toBe('ci-refused:probe')
    expect(causes[interventionKey(refusedGoKey(rq, RUN))]).toBe('ci-refused:rerun')
    expect(causes[interventionKey(rerunKey(rq, 1, '1801'))]).toBe('ci-rerun')
  })

  test('a run that was refused and passes on its re-run is not a CI flake', () => {
    const go = ended(refusedGoKey(rq, RUN), 'ci-rerun', { issue: 802, startedAt: NOW - 10 * MIN })
    const passed = refusedCheck(RUN, '117959999999', { bucket: 'pass', refusedWhy: undefined, completedAt: NOW - 2 * MIN })
    const p = plan(world([rq], [view(rq, [passed])], [go]))
    expect(p.actions.filter(a => a.key.endsWith('/flake'))).toEqual([])
    // the control: a round re-run that turned the run green is one
    const round = ended(rerunKey(rq, 1, RUN), 'ci-rerun', { issue: 802, startedAt: NOW - 10 * MIN })
    const flaky = plan(world([rq], [view(rq, [passed])], [round]))
    expect(flaky.actions.filter(a => a.key.endsWith('/flake'))).toHaveLength(1)
  })
})
