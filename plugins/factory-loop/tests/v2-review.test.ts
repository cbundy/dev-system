// The review step under planner v2 (docs/factory-loop/v2/SPEC.md 4.2 reviewing, 4.4, 8.1 to 8.6,
// 7.1, property 15): the PR ensured first, the reviewer keyed by patch and round and reused for
// both, the CI half with one re-run per round, a conflict at once, the GitHub waits bounded, the
// step's result through the table, and the review's writes (the PR comment, the `reviewed` event,
// the fixer's `verdict` events); then the reviewer interface and registry, the `review` contract,
// the prompt, the step module through the agent-step executor, and the `ci-rerun` executor; last,
// the step in the pass driver, from T5 through the ensure to the PR's first read (fault drill 1).
// Plans are driven through planV2 itself; actions are found by kind, and keys come from the key
// codec.
import { describe, expect, mock, test } from 'claude-code/testing'

import { ctxOf, dispatch } from '../hooks/act'
import type { ActEnv } from '../hooks/act'
import { V2_CONTRACTS } from '../hooks/contract.mjs'
import type { Job } from '../hooks/contract.mjs'
import type { ActIo, SpawnInput } from '../hooks/exec'
import { start } from '../hooks/ledger'
import { GITHUB_BACKOFF_MS } from '../hooks/observe'
import type { Runtime } from '../hooks/observe'
import type { Action, LedgerEntry, PlanResult, State } from '../hooks/types'
import * as ARGV from '../hooks/v2/argv'
import { eventArgv, parseEvent } from '../hooks/v2/events'
import { entryKey, lifeOf, prKey, prepareKey, rerunKey, reviewKey, reviewPrepareKey, short, stepKey, transitionKey } from '../hooks/v2/keys'
import { emptyV2State, recordsToStore } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { REVIEW_PROMPTS, adjudicatorPrompt } from '../hooks/v2/prompts-review'
import { COMMAND_RULE, TEST_POLICY } from '../hooks/v2/prompts-triage'
import { COMMENT_MAX, FIX_NOTES_MAX, REVIEWERS, dispositionsOf, readReview, reviewComment, reviewDataOf, reviewedEvent, reviewerOf, verdictEvent } from '../hooks/v2/reviewer'
import type { ReviewData, ReviewInput } from '../hooks/v2/reviewer'
import { RERUN_REFUSED, lifePr } from '../hooks/v2/rules-review'
import type { CheckRun, PrView } from '../hooks/v2/sources-prs'
import { stepAnswerPath, stepAnswered, stepExecutor, stepRecordPath } from '../hooks/v2/steps'
import { priorOf, reviewInput, reviewResult } from '../hooks/v2/steps-review'
import { madeRecord } from '../hooks/v2/table'
import { SLOT_STATES, STEP_AGENT, unknownResult } from '../hooks/v2/types'
import type { IssueRecord, Lease, StepResult, V2State } from '../hooks/v2/types'
import { handshakePath } from '../hooks/v2/workspace'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, entry, state as baseState } from './fixtures'
import { CFG_DIR, LOOP_DIR, NO_EVENTS, QUIET_BEATS, REPO, SESSION, TOOLS, factoryDoc, host, iso } from './host'
import type { Seen } from './host'

const HOUR = 60 * MIN
const CFG = config({ planner: 'v2', mode: 'act', maxInFlightIssues: 3 })
const LIFE = lifeOf(NOW - 2 * HOUR)
const HEAD = '9e01b77c0ffee000000000000000000000000001'
const HEAD2 = '7a3c0de1d00d0000000000000000000000000002'
const PATCH = 'f00dfeed00000000000000000000000000000001'
const PATCH2 = 'c0ffee1100000000000000000000000000000002'
const PR = 512
const BRIEF = (n: number) => `https://github.com/${REPO}/issues/${n}#issuecomment-${1000 + n}`

// --- the world ---------------------------------------------------------------------------------------------

// rec: a record of one life in reviewing, its first round, at seq 5 since 20 minutes ago.
function rec(n: number, over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    ...madeRecord({ issue: n, life: LIFE, branch: `issue-${n}`, pr: null, others: [] }, NOW - HOUR),
    seq: 5,
    seqAt: NOW - 20 * MIN,
    state: 'reviewing',
    step: 'review',
    since: NOW - 20 * MIN,
    round: 1,
    head: HEAD,
    brief: BRIEF(n),
    ...over,
  }
}

const leaseFor = (r: Pick<IssueRecord, 'issue' | 'life'>): Lease => ({ path: `/slots/${r.issue}`, lease: `L${r.issue}`, holder: `factory-loop:${r.issue}:${r.life}`, issue: r.issue, life: r.life, status: 'leased', busy: false })

const OK = { ok: true, at: NOW }

// view: the record's PR as the prs source reads it, read a minute ago: open, clean, on HEAD with
// PATCH, and no checks unless a test gives some.
function view(n: number, over: Partial<PrView> = {}): PrView {
  return { pr: PR, issue: n, state: 'open', head: HEAD, mergedHead: null, closedAt: null, mergeable: 'clean', author: 'cbundy', base: null, checks: [], patch: PATCH, readAt: NOW - MIN, ...over }
}

// check: one check run on the head; a pending one has not completed.
function check(name: string, bucket: CheckRun['bucket'], over: Partial<CheckRun> = {}): CheckRun {
  const runId = over.runId === undefined ? '1801' : over.runId
  return {
    name,
    state: bucket,
    bucket,
    startedAt: NOW - 10 * MIN,
    completedAt: bucket === 'pending' ? null : NOW - 8 * MIN,
    runId,
    link: runId === null ? null : `https://github.com/${REPO}/actions/runs/${runId}/job/1`,
    ...over,
  }
}

const GREEN = [check('ci', 'pass'), check('publish-base-image', 'skipping')]

// world: a quiet factory with these records, each holding its slot, every v2 source read, and the
// PRs given.
function world(records: IssueRecord[], prs: PrView[] = [], v2: Partial<V2State> = {}, over: Partial<State> = {}): State {
  const s = baseState(over)
  return {
    ...s,
    v2: {
      ...emptyV2State(NOW, records),
      sources: { store: OK, leases: OK, prs: OK, interventions: OK, comments: OK },
      leases: records.filter(r => SLOT_STATES.includes(r.state)).map(leaseFor),
      prs: { prs },
      ...v2,
    },
  }
}

const withLedger = (s: State, extra: LedgerEntry[]): State => ({ ...s, ledger: [...s.ledger, ...extra] })

const plan = (s: State, cfg = CFG): PlanResult => planV2(s, cfg)
const of = (p: PlanResult, n: number, kind?: Action['kind']): Action[] => p.actions.filter(a => a.issue === n && a.kind !== 'title' && (kind === undefined || a.kind === kind))
const said = (p: PlanResult, n: number) => p.skipped.filter(s => s.issue === n).map(s => s.why)
const transitionOf = (p: PlanResult, n: number) => p.actions.find((a): a is Extract<Action, { kind: 'transition' }> => a.kind === 'transition' && a.issue === n)
const eventsOf = (p: PlanResult, n: number, state: string) => of(p, n, 'event').flatMap(a => (a.kind === 'event' && a.event.state === state ? [a] : []))
const agentSteps = (p: PlanResult, n: number) => of(p, n, 'agent-step') as Extract<Action, { kind: 'agent-step' }>[]

function done(key: string, kind: LedgerEntry['kind'], over: Partial<LedgerEntry> = {}): LedgerEntry {
  return entry(key, kind, { startedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN, ...over })
}

// ensured: the PR's ensure of the record's seq, done.
const ensured = (r: IssueRecord, pr = PR): LedgerEntry => done(prKey(r, 'ensure'), 'pr', { issue: r.issue, startedAt: NOW - 15 * MIN, endedAt: NOW - 14 * MIN, outcome: { kind: 'pr', pr, created: true, reopened: false } })

// prepared: the slot prepared for the record's attempt.
const prepared = (r: IssueRecord): LedgerEntry => done(prepareKey(r, r.attempt), 'slot', { issue: r.issue, maxAttempts: 1, startedAt: NOW - 14 * MIN, endedAt: NOW - 13 * MIN })

// reviewData: what the review step records for a verdict on PATCH at HEAD.
function reviewData(r: IssueRecord, verdict: 'approve' | 'changes', over: Partial<ReviewData> = {}): ReviewData {
  const findings: ReviewData['findings'] =
    verdict === 'approve'
      ? [{ id: `r${r.round}-1`, severity: 'info', file: 'README.md', line: null, text: 'a sentence could be shorter' }]
      : [
          { id: `r${r.round}-1`, severity: 'warning', file: 'hooks/x.ts', line: 3, text: 'a name could be clearer' },
          { id: `r${r.round}-2`, severity: 'error', file: 'hooks/x.ts', line: 40, text: 'a moved HEAD is accepted: `node t.js` exits 0 on a stale head' },
        ]
  return { verdict, findings, summary: 'The loop reads the head again before it merges.', bump: 'patch', round: r.round, patch: PATCH, head: HEAD, pr: PR, reviewer: 'adjudicator', answer: `${LOOP_DIR}/answers/x.answer.json`, ...over }
}

// reviewed: a reviewer of the record's round, k-th for its patch, that ended with this result.
function reviewed(r: IssueRecord, result: Partial<StepResult>, over: Partial<LedgerEntry> = {}, k = 1, patch = PATCH): LedgerEntry {
  const full: StepResult = { event: 'ok', reason: null, why: null, head: null, choice: null, data: null, ...result }
  return done(reviewKey(r, patch, r.round, k), 'agent-step', { issue: r.issue, class: 'drive', step: 'review', agentId: `agent-${k}`, startedAt: NOW - 12 * MIN, endedAt: NOW - 5 * MIN, outcome: { kind: 'step', step: 'review', result: full }, ...over })
}

const approved = (r: IssueRecord, over: Partial<LedgerEntry> = {}, data: Partial<ReviewData> = {}) => reviewed(r, { event: 'ok', data: reviewData(r, 'approve', data) }, over)
const changed = (r: IssueRecord, over: Partial<LedgerEntry> = {}) => reviewed(r, { event: 'not-ok', reason: 'changes', data: reviewData(r, 'changes') }, over)

// settled: the state with the effects this plan planned done, as the act step leaves them.
function settled(s: State, p: PlanResult, kinds: Action['kind'][] = ['comment', 'event']): State {
  const ran = p.actions.filter(a => kinds.includes(a.kind)).map(a => done(a.key, a.kind, { issue: a.issue }))
  return withLedger(s, ran)
}

// --- the PR first (8.1) --------------------------------------------------------------------------------

describe('the review step: the PR first (v2 SPEC 8.1)', () => {
  test('the ensure runs once per seq with the builder\'s title, summary and evidence, the brief and the default branch; nothing else starts until it is done', () => {
    const r = rec(600)
    const build = done(stepKey({ ...r, seq: 3 }, 'build', 1), 'agent-step', {
      issue: 600,
      step: 'build',
      outcome: { kind: 'step', step: 'build', result: { event: 'ok', reason: null, why: null, head: HEAD, choice: null, data: { title: 'Read the head again', summary: 'Re-reads the head.', evidence: 'npm test: ok' } } },
    })
    const p = plan(withLedger(world([r], [view(600)]), [build]))
    expect(of(p, 600)).toEqual([
      expect.objectContaining({ kind: 'pr', op: 'ensure', key: prKey(r, 'ensure'), rule: 'S2', branch: 'issue-600', base: 'main', pr: null, title: 'Read the head again', summary: 'Re-reads the head.', evidence: 'npm test: ok', brief: BRIEF(600) }),
    ])
    // an adopted PR, with no builder's answer: the loop's own title, and the record's PR
    const adopted = plan(world([rec(601, { pr: 77 })], []))
    expect(of(adopted, 601)).toEqual([expect.objectContaining({ kind: 'pr', op: 'ensure', pr: 77, title: 'Factory loop work for #601', summary: '', evidence: null })])
  })

  test('a held step starts nothing: the seq\'s transition event not logged yet holds the ensure, and the skip line says why', () => {
    const r = rec(602)
    const t = done(transitionKey(r), 'transition', { issue: 602, outcome: { kind: 'transition', row: 'T5', event: 'ok', cause: null, from: 'building', to: 'reviewing', step: 'build', stored: true, via: 'build' } })
    const p = plan(withLedger(world([r], [view(602)]), [t]))
    expect(of(p, 602, 'pr')).toEqual([])
    expect(said(p, 602).some(w => w.includes('transition event of seq 5 is not logged yet'))).toBe(true)
  })

  test('the PR is read before anything is judged: no read of the source, of the PR, a read older than the seq, a PR that shows no head, or no patch id holds the step, never a guess', () => {
    const r = rec(603)
    // an ensure that just ended: within the GitHub bound
    const ens = { ...ensured(r), startedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN }
    const hold = (prs: PrView[], v2: Partial<V2State> = {}) => {
      const p = plan(withLedger(world([r], prs, v2), [ens]))
      expect(of(p, 603).filter(a => a.kind !== 'event')).toEqual([])
      return said(p, 603)
    }
    expect(hold([view(603)], { sources: { store: OK, leases: OK, prs: { ok: false, at: null, error: 'not built yet (U7)' }, interventions: OK, comments: OK } })).toEqual(['review: the PRs were not read (not built yet (U7))'])
    expect(hold([])).toEqual([`review: PR #${PR} was not read this pass`])
    // its own read failed: only this record waits, and says why (drill run 3, R3-F3)
    expect(hold([], { prs: { prs: [], unread: [{ pr: PR, issue: 603, why: 'gh pr checks exit 1: HTTP 502', untrusted: false, since: NOW - MIN }] } })).toEqual([`review: PR #${PR} did not read: gh pr checks exit 1: HTTP 502`])
    expect(hold([view(603, { readAt: r.seqAt - MIN })])).toEqual([`review: waits for a read of PR #${PR} newer than seq 5`])
    expect(hold([view(603, { head: null })])).toEqual([`review: PR #${PR} shows no head`])
    expect(hold([view(603, { patch: null })])).toEqual([`review: waits for the patch id of head ${short(HEAD)}`])
  })

  test('a PR whose own read never becomes usable is a bounded GitHub wait (4.4): ciStartMs after the latest of the seq\'s start, the ensure\'s end and its first failed read it is unknown; a backoff or the source not read holds it with no clock', () => {
    // seq 20 min ago, the ensure ended 14 min ago: past ciStartMs (10 min)
    const r = rec(604)
    const old = (prs: PrView[], v2: Partial<V2State> = {}, over: Partial<State> = {}) => plan(withLedger(world([r], prs, v2, over), [ensured(r)]))
    for (const prs of [[], [view(604, { readAt: r.seqAt - MIN })], [view(604, { head: null })], [view(604, { patch: null })]]) {
      const t = transitionOf(old(prs), 604)
      expect(t).toMatchObject({ row: 'U2', via: 'unknown:github-wait', trigger: { kind: 'fact', fact: `github-wait:${PR}/s5` } })
    }
    // a read of its own that keeps failing past the bound too, so it cannot hold its slot for good;
    // the bound counts from its first failed read, so one failed read of an old seq holds
    const failing = (since: number) => ({ prs: [], unread: [{ pr: PR, issue: 604, why: 'the patch id of 9e01b77 did not compute: exit 1', untrusted: false, since }] })
    expect(transitionOf(old([], { prs: failing(NOW - 11 * MIN) }), 604)).toMatchObject({ row: 'U2', via: 'unknown:github-wait' })
    const blip = old([], { prs: failing(NOW) })
    expect(transitionOf(blip, 604)).toBeUndefined()
    expect(said(blip, 604)).toEqual([`review: PR #${PR} did not read: the patch id of 9e01b77 did not compute: exit 1`])
    // the source not read is an admission hold: no clock
    const unread = old([view(604)], { sources: { store: OK, leases: OK, prs: { ok: false, at: null, error: 'gh failed' }, interventions: OK, comments: OK } })
    expect(transitionOf(unread, 604)).toBeUndefined()
    expect(said(unread, 604)).toEqual(['review: the PRs were not read (gh failed)'])
    // a GitHub backoff holds it too
    const backoff = old([], {}, { githubBackoffUntil: NOW + MIN })
    expect(transitionOf(backoff, 604)).toBeUndefined()
    expect(said(backoff, 604)).toEqual([`review: PR #${PR} was not read this pass`])
    // a reviewer of this seq still running keeps its own clock: no wait is read, its timeout is
    const running = { ...reviewed(r, {}), status: 'running' as const, endedAt: null, outcome: undefined, startedAt: NOW - 5 * MIN }
    const busy = plan(withLedger(world([r], [view(604, { patch: null })]), [ensured(r), prepared(r), running]))
    expect(transitionOf(busy, 604)).toBeUndefined()
    expect(said(busy, 604)).toEqual([`review: waits for the patch id of head ${short(HEAD)}`])
    const longer = rec(604, { seqAt: NOW - 40 * MIN, since: NOW - 40 * MIN })
    const hung = plan(withLedger(world([longer], [view(604, { patch: null })]), [ensured(longer), prepared(longer), { ...running, startedAt: NOW - 31 * MIN }]))
    expect(transitionOf(hung, 604)).toMatchObject({ row: 'U2', via: 'unknown:timeout' })
  })
})

// --- the reviewer (8.3, 8.4) -------------------------------------------------------------------------------

describe('the reviewer, keyed by patch and round (v2 SPEC 8.3, 8.4)', () => {
  test('with the PR read, the reviewer runs in the slot: prepared, then spawned as a drive step under the key of the head\'s patch and this round; while it runs nothing more starts', () => {
    const r = rec(610)
    const s = withLedger(world([r], [view(610, { checks: GREEN })]), [ensured(r)])
    expect(of(plan(s), 610)).toEqual([expect.objectContaining({ kind: 'slot', op: 'prepare', key: prepareKey(r, 1), rule: 'S2' })])
    const steps = agentSteps(plan(withLedger(s, [prepared(r)])), 610)
    expect(steps).toEqual([expect.objectContaining({ step: 'review', class: 'drive', rule: 'S2', key: reviewKey(r, PATCH, 1, 1), slot: '/slots/610' })])
    const running = withLedger(s, [prepared(r), { ...reviewed(r, {}), status: 'running', endedAt: null, outcome: undefined, startedAt: NOW - 5 * MIN }])
    const p = plan(running)
    expect(of(p, 610)).toEqual([])
    expect(transitionOf(p, 610)).toBeUndefined()
    // CI's re-runs go on beside it, and a red check waits for its verdict, for one fixer with both
    const red = plan(withLedger(world([r], [view(610, { checks: [check('test', 'fail')] })]), running.ledger.slice(-3)))
    expect(of(red, 610)).toEqual([expect.objectContaining({ kind: 'ci-rerun', runId: '1801', round: 1 })])
    expect(transitionOf(red, 610)).toBeUndefined()
  })

  test('property 15: a done review of the head\'s patch in this round is used, whatever its attempt, seq or head; a new round or a new patch gets its own reviewer', () => {
    // a later seq and attempt (an unknown CI wait went to U2), the head moved with the same patch
    const r = rec(611, { seq: 7, seqAt: NOW - 4 * MIN, since: NOW - 30 * MIN, attempt: 2 })
    const review = approved(r, { startedAt: NOW - 25 * MIN, endedAt: NOW - 20 * MIN }, { head: HEAD })
    const base = withLedger(world([r], [view(611, { head: HEAD2, checks: GREEN, readAt: NOW - 30_000 })]), [ensured(r), prepared(r), review])
    const p = plan(base)
    expect(agentSteps(p, 611)).toEqual([])
    // its writes first, then the approval moves the record
    expect(transitionOf(plan(settled(base, p)), 611)).toMatchObject({ row: 'T8', next: { state: 'merge-queue', approvedPatch: PATCH, pr: PR } })
    // a new round: a reviewer of its own
    const round2 = { ...r, round: 2 }
    expect(agentSteps(plan(withLedger(world([round2], [view(611, { checks: GREEN })]), [ensured(round2), prepared(round2), review])), 611)).toEqual([
      expect.objectContaining({ key: reviewKey(round2, PATCH, 2, 1) }),
    ])
    // a new patch: a reviewer of its own
    expect(agentSteps(plan(withLedger(world([r], [view(611, { head: HEAD2, patch: PATCH2, checks: GREEN })]), [ensured(r), prepared(r), review])), 611)).toEqual([
      expect.objectContaining({ key: reviewKey(r, PATCH2, 1, 1) }),
    ])
  })

  test('property 15, generated: over any history of reviewers, no plan starts one for a patch and round that already has a done review', () => {
    let seed = 7
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T
    let started = 0
    for (let i = 0; i < 400; i += 1) {
      const round = 1 + Math.floor(rand() * 3)
      const seqAt = NOW - pick([2, 10, 30]) * MIN
      const r = rec(612, { round, seq: 4 + Math.floor(rand() * 5), seqAt, attempt: pick([1, 2]) })
      const patch = pick([PATCH, PATCH2])
      const ledger: LedgerEntry[] = [ensured(r), prepared(r)]
      const history = Math.floor(rand() * 4)
      for (let k = 1; k <= history; k += 1) {
        const p = pick([PATCH, PATCH2])
        const rd = pick([1, 2, 3])
        const at = seqAt + pick([-20, -5, 1]) * MIN
        const kind = pick(['approve', 'changes', 'unknown', 'running'] as const)
        const rr = { ...r, round: rd }
        const e =
          kind === 'unknown'
            ? reviewed(rr, unknownResult('bad-answer', 'no answer'), { startedAt: at, endedAt: at + MIN }, k, p)
            : reviewed(rr, { event: kind === 'changes' ? 'not-ok' : 'ok', reason: kind === 'changes' ? 'changes' : null, data: reviewData(rr, kind === 'changes' ? 'changes' : 'approve', { patch: p }) }, { startedAt: at, endedAt: at + MIN }, k, p)
        ledger.push(kind === 'running' ? { ...e, status: 'running', endedAt: null, outcome: undefined } : e)
      }
      const p = plan(withLedger(world([r], [view(612, { patch, checks: pick([[], GREEN]) })]), ledger))
      for (const a of agentSteps(p, 612)) {
        started += 1
        const reviewedAlready = ledger.some(e => e.status === 'done' && e.key.startsWith(`${reviewKey(r, patch, round, 1).slice(0, -1)}`) && reviewDataOf(e.outcome?.kind === 'step' ? e.outcome.result.data : null) !== null)
        expect({ key: a.key, reviewedAlready }).toEqual({ key: a.key, reviewedAlready: false })
        expect(a.key.startsWith(reviewKey(r, patch, round, 1).slice(0, -1))).toBe(true)
      }
    }
    expect(started).toBeGreaterThan(20)
  })

  test('a reviewer that gave no valid answer is the step\'s unknown, logged as a reviewed unknown first; after its free re-run a fresh reviewer starts, not the ended one', () => {
    const r = rec(613)
    const bad = reviewed(r, unknownResult('bad-answer', 'no answer was recorded with the answer script'), { startedAt: NOW - 10 * MIN })
    const s = withLedger(world([r], [view(613, { checks: GREEN })]), [ensured(r), prepared(r), bad])
    const p = plan(s)
    expect(transitionOf(p, 613)).toBeUndefined()
    expect(eventsOf(p, 613, 'reviewed')).toEqual([expect.objectContaining({ event: expect.objectContaining({ verdict: 'unknown', round: 1, patch: PATCH, head: HEAD, pr: PR, errors: 0 }) })])
    expect(transitionOf(plan(settled(s, p)), 613)).toMatchObject({ row: 'U2', via: 'unknown:bad-answer', next: { state: 'reviewing', step: 'review', attempt: 2 } })
    // the free re-run (U1) keeps the attempt; its new seq starts a reviewer of its own
    const cut = rec(613, { seq: 6, seqAt: NOW - 2 * MIN, cut: true })
    const after = withLedger(world([cut], [view(613, { checks: GREEN })]), [ensured(cut), prepared(cut), bad, ...p.actions.filter(a => a.kind === 'event').map(a => done(a.key, 'event'))])
    expect(agentSteps(plan(after), 613)).toEqual([expect.objectContaining({ key: reviewKey(cut, PATCH, 1, 2) })])
  })

  test('property 6: a push that changes the patch mid-review has the running reviewer stopped before the new patch\'s starts, in a slot prepared again; the stopped one gives no review', () => {
    const r = rec(615)
    const stale = { ...reviewed(r, {}), status: 'running' as const, endedAt: null, outcome: undefined, startedAt: NOW - 5 * MIN }
    const moved = [view(615, { head: HEAD2, patch: PATCH2, checks: GREEN })]
    const s = withLedger(world([r], moved), [ensured(r), prepared(r), stale])
    const p = plan(s)
    const stopKey = `${entryKey(r, 'stop')}/review/${short(PATCH)}/r1/a1`
    expect(of(p, 615)).toEqual([expect.objectContaining({ kind: 'stop-agent', key: stopKey, agentId: 'agent-1', entry: stale.key })])
    expect(said(p, 615)).toEqual([`review: the reviewer of patch ${short(PATCH)} (1) still runs; it is stopped before the reviewer of patch ${short(PATCH2)} starts`])
    // stopped, its agent not gone yet: nothing starts, nothing is stopped twice, and its clock runs
    const stop = done(stopKey, 'stop-agent', { issue: 615 })
    expect(of(plan(withLedger(s, [stop])), 615)).toEqual([])
    expect(transitionOf(plan(withLedger(world([r], moved), [ensured(r), prepared(r), { ...stale, startedAt: NOW - 31 * MIN }, stop])), 615)).toMatchObject({ row: 'U2', via: 'unknown:timeout' })
    // ended: its reviewed event is unknown, with no PR comment, even though it answered approve
    const ended = { ...approved(r), startedAt: stale.startedAt }
    const gone = withLedger(world([r], moved), [ensured(r), prepared(r), ended, stop])
    const p3 = plan(gone)
    expect(eventsOf(p3, 615, 'reviewed')).toEqual([expect.objectContaining({ event: expect.objectContaining({ verdict: 'unknown', patch: short(PATCH) }) })])
    expect(of(p3, 615, 'comment')).toEqual([])
    // the new patch's reviewer: the slot prepared again, then the agent, never the old answer
    expect(of(p3, 615, 'slot')).toEqual([expect.objectContaining({ op: 'prepare', key: reviewPrepareKey(r, PATCH2, 1, 1, 1) })])
    expect(agentSteps(p3, 615)).toEqual([])
    const p4 = plan(withLedger(gone, [done(reviewPrepareKey(r, PATCH2, 1, 1, 1), 'slot', { issue: 615, maxAttempts: 1 })]))
    expect(agentSteps(p4, 615)).toEqual([expect.objectContaining({ key: reviewKey(r, PATCH2, 1, 1) })])
    // the head back on the old patch: the stopped reviewer's answer is not used; a fresh one starts
    const back = plan(withLedger(world([r], [view(615, { checks: GREEN })]), [ensured(r), prepared(r), ended, stop]))
    expect(transitionOf(back, 615)).toBeUndefined()
    expect(of(back, 615, 'slot')).toEqual([expect.objectContaining({ op: 'prepare', key: reviewPrepareKey(r, PATCH, 1, 2, 1) })])
  })

  test('property 6, generated: whatever the pushes during review, no pass leaves two reviewers of the record running', () => {
    let seed = 11
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    let stops = 0
    for (let run = 0; run < 40; run += 1) {
      const r = rec(616)
      let ledger: LedgerEntry[] = [ensured(r), prepared(r)]
      let agents = 0
      for (let pass = 0; pass < 12; pass += 1) {
        const at = NOW - (12 - pass) * 10_000
        const patch = rand() < 0.4 ? PATCH2 : PATCH
        const p = plan(withLedger(world([r], [view(616, { patch, head: patch === PATCH ? HEAD : HEAD2, checks: GREEN })]), ledger))
        if (transitionOf(p, 616) !== undefined) break
        for (const a of of(p, 616)) {
          if (a.kind === 'agent-step') {
            agents += 1
            ledger.push({ ...done(a.key, 'agent-step', { issue: 616, class: 'drive', step: 'review', agentId: `agent-${agents}`, startedAt: at }), status: 'running', endedAt: null })
          } else if (a.kind === 'stop-agent') {
            stops += 1
            ledger.push(done(a.key, 'stop-agent', { issue: 616, startedAt: at, endedAt: at }))
            // the agent goes now, or on a later pass
            if (rand() < 0.5) ledger = ledger.map(e => (e.key === a.entry ? { ...e, status: 'failed', endedAt: at, summary: 'agent killed' } : e))
          } else if (a.kind !== 'tell') {
            ledger.push(done(a.key, a.kind, { issue: 616, startedAt: at, endedAt: at, ...(a.kind === 'slot' ? { maxAttempts: 1 } : {}) }))
          }
        }
        // a stopped agent that was left running goes on a later pass
        if (rand() < 0.5) ledger = ledger.map(e => (e.status === 'running' && e.kind === 'agent-step' && ledger.some(x => x.kind === 'stop-agent' && x.key.endsWith(e.key.slice(e.key.indexOf('/review/')))) ? { ...e, status: 'failed', endedAt: at, summary: 'agent killed' } : e))
        const running = ledger.filter(e => e.kind === 'agent-step' && e.status === 'running')
        expect(running.length).toBeLessThanOrEqual(1)
      }
    }
    expect(stops).toBeGreaterThan(5)
  })

  test('the reviewer setting must name a reviewer of the registry; another holds the step with a skip line, starting nothing', () => {
    const r = rec(614)
    const p = plan(withLedger(world([r], [view(614)]), [ensured(r), prepared(r)]), { ...CFG, reviewer: 'no-such' })
    expect(of(p, 614)).toEqual([])
    expect(said(p, 614)).toEqual(['review: the reviewer setting names no reviewer (no-such); known: adjudicator'])
  })
})

// --- the result, and the CI half (8.5, 4.4) -------------------------------------------------------------

describe('the step\'s result: review and CI (v2 SPEC 4.2, 8.5, 4.4)', () => {
  test('approve with every check passed or skipped: the PR comment and the reviewed event first, then T8 with the approved patch and the PR', () => {
    const r = rec(620)
    const s = withLedger(world([r], [view(620, { checks: GREEN })]), [ensured(r), prepared(r), approved(r)])
    const p = plan(s)
    expect(transitionOf(p, 620)).toBeUndefined()
    const [comment] = of(p, 620, 'comment')
    expect(comment).toMatchObject({ kind: 'comment', on: 'pr', number: PR, body: expect.stringContaining('round 1: approved') })
    expect(eventsOf(p, 620, 'reviewed')).toEqual([expect.objectContaining({ event: expect.objectContaining({ verdict: 'approve', round: 1, patch: PATCH, head: HEAD, infos: 1, reviewer: 'adjudicator' }) })])
    const after = plan(settled(s, p))
    expect(transitionOf(after, 620)).toMatchObject({ row: 'T8', rule: 'S3', event: 'ok', next: { state: 'merge-queue', approvedPatch: PATCH, pr: PR } })
    // the writes are not planned again
    expect(of(after, 620, 'comment')).toEqual([])
  })

  test('changes moves at once, CI or not: T9 to fixing, each finding in the notes by id, errors first, the answer file named, within the record\'s notes', () => {
    const r = rec(621)
    const s = withLedger(world([r], [view(621, { checks: [check('ci', 'pending')] })]), [ensured(r), prepared(r), changed(r)])
    const t = transitionOf(plan(settled(s, plan(s))), 621)
    expect(t).toMatchObject({ row: 'T9', via: 'fix:review', next: { state: 'fixing', fixes: 1, pr: PR } })
    const notes = t?.next.notes ?? []
    expect(notes[0]).toContain(`${LOOP_DIR}/answers/x.answer.json`)
    expect(notes.slice(1)).toEqual(['r1-2 [error] hooks/x.ts:40: a moved HEAD is accepted: `node t.js` exits 0 on a stale head', 'r1-1 [warning] hooks/x.ts:3: a name could be clearer'])
    // at the fix cap, the same parks with the findings in the question
    const capped = { ...r, fixes: CFG.reviewFixCap }
    const s2 = withLedger(world([capped], [view(621)]), [ensured(capped), prepared(capped), changed(capped)])
    expect(transitionOf(plan(settled(s2, plan(s2))), 621)).toMatchObject({ row: 'T10', next: { state: 'parked', resumeTo: 'fixing', question: expect.stringContaining('r1-2 [error]') } })
  })

  test('many findings come to at most the record\'s notes: the rest are counted, with where to find them', () => {
    const r = rec(622)
    const findings = Array.from({ length: 20 }, (_, i) => ({ id: `r1-${i + 1}`, severity: 'error' as const, file: `f${i}.ts`, line: i + 1, text: `defect ${i + 1}` }))
    const many = reviewed(r, { event: 'not-ok', reason: 'changes', data: reviewData(r, 'changes', { findings }) })
    const s = withLedger(world([r], [view(622)]), [ensured(r), prepared(r), many])
    const notes = transitionOf(plan(settled(s, plan(s))), 622)?.next.notes ?? []
    expect(notes.length).toBe(FIX_NOTES_MAX)
    expect(notes.at(-1)).toContain('and 14 more')
  })

  test('a conflict ends the step at once, even while the reviewer runs: T9 for the conflict, with the merge to make', () => {
    const r = rec(623)
    const runningReview = { ...reviewed(r, {}), status: 'running' as const, endedAt: null, outcome: undefined, startedAt: NOW - 5 * MIN }
    const p = plan(withLedger(world([r], [view(623, { mergeable: 'dirty' })]), [ensured(r), prepared(r), runningReview]))
    const t = transitionOf(p, 623)
    expect(t).toMatchObject({ row: 'T9', via: 'fix:conflict', next: { state: 'fixing', pr: PR } })
    expect(t?.next.notes[0]).toContain('merge origin/main into issue-623')
    // with no reviewer yet, none starts beside the transition, and no re-run either
    const fresh = plan(withLedger(world([r], [view(623, { mergeable: 'dirty', checks: [check('test', 'fail')] })]), [ensured(r), prepared(r)]))
    expect(transitionOf(fresh, 623)).toMatchObject({ row: 'T9', via: 'fix:conflict' })
    expect(of(fresh, 623).filter(a => a.kind === 'agent-step' || a.kind === 'slot' || a.kind === 'ci-rerun')).toEqual([])
  })

  test('a failed check is re-run once per round, once its run has finished; a fail after the re-run is ci-red; a fail from before it waits', () => {
    const r = rec(624)
    const ledger = [ensured(r), prepared(r), approved(r)]
    const writes = (s: State) => settled(s, plan(s))
    // the run still has a job going: GitHub refuses its re-run until it finishes
    const busy = writes(withLedger(world([r], [view(624, { checks: [check('test', 'fail'), check('lint', 'pending')] })]), ledger))
    expect(of(plan(busy), 624, 'ci-rerun')).toEqual([])
    expect(said(plan(busy), 624)).toEqual([`review: waits for CI on ${short(HEAD)} (1 pending, 1 awaiting a re-run, 0 passed or skipped)`])
    // finished: one re-run of its failed jobs
    const failed = writes(withLedger(world([r], [view(624, { checks: [check('test', 'fail'), check('lint', 'pass')] })]), ledger))
    expect(of(plan(failed), 624, 'ci-rerun')).toEqual([expect.objectContaining({ kind: 'ci-rerun', key: rerunKey(r, 1, '1801'), pr: PR, runId: '1801', round: 1, maxAttempts: 3, rule: 'S2' })])
    const rerun = done(rerunKey(r, 1, '1801'), 'ci-rerun', { issue: 624, startedAt: NOW - 3 * MIN, endedAt: NOW - 3 * MIN })
    // the check still shows the result from before the re-run: it waits
    const stale = withLedger(failed, [rerun])
    expect(transitionOf(plan(stale), 624)).toBeUndefined()
    expect(of(plan(stale), 624, 'ci-rerun')).toEqual([])
    // failed again after it: ci-red, a fixer with the check and its log
    const again = writes(withLedger(world([r], [view(624, { checks: [check('test', 'fail', { completedAt: NOW - MIN })] })]), [...ledger, rerun]))
    const t = transitionOf(plan(again), 624)
    expect(t).toMatchObject({ row: 'T9', via: 'fix:ci', next: { state: 'fixing' } })
    expect(t?.next.notes[1]).toContain('CI check "test" failed on 9e01b77 after its one re-run')
    expect(t?.next.notes[1]).toContain(`gh run view 1801 --log-failed --repo ${REPO}`)
    // a later round gets its own re-run
    const round2 = rec(624, { round: 2 })
    const next = writes(withLedger(world([round2], [view(624, { checks: [check('test', 'fail')] })]), [ensured(round2), prepared(round2), approved(round2), rerun]))
    expect(of(plan(next), 624, 'ci-rerun')).toEqual([expect.objectContaining({ key: rerunKey(round2, 2, '1801'), round: 2 })])
  })

  test('a check that cannot be re-run counts as failed at once: one not from a GitHub Actions run, or one whose re-run GitHub refused', () => {
    const r = rec(625)
    const ledger = [ensured(r), prepared(r), approved(r)]
    const s = withLedger(world([r], [view(625, { checks: [check('external', 'fail', { runId: null })] })]), ledger)
    const t = transitionOf(plan(settled(s, plan(s))), 625)
    expect(t).toMatchObject({ row: 'T9', via: 'fix:ci' })
    expect(t?.next.notes[1]).toContain('not a GitHub Actions run')
    const summary = `${RERUN_REFUSED} of run 1801: run 1801 cannot be rerun; its workflow file may be broken`
    const refused = done(rerunKey(r, 1, '1801'), 'ci-rerun', { issue: 625, status: 'failed', attempts: 3, maxAttempts: 3, summary })
    const s2 = withLedger(world([r], [view(625, { checks: [check('test', 'cancel')] })]), [...ledger, refused])
    const t2 = transitionOf(plan(settled(s2, plan(s2))), 625)
    expect(t2?.next.notes[1]).toContain(`was cancelled on 9e01b77, and GitHub refused its one re-run (${summary})`)
  })

  test('a re-run that failed on a transient error is retried with backoff, never counted red; one that used up its retries holds the record as a stalled effect; a lost one, or one GitHub took, is awaited', () => {
    const r = rec(629)
    const key = rerunKey(r, 1, '1801')
    const ledger = [ensured(r), prepared(r), approved(r)]
    const writes = (s: State) => settled(s, plan(s))
    const red = (extra: LedgerEntry[], checks = [check('test', 'fail')]) => writes(withLedger(world([r], [view(629, { checks })]), [...ledger, ...extra]))
    const blip = (over: Partial<LedgerEntry>) => done(key, 'ci-rerun', { issue: 629, status: 'failed', attempts: 1, maxAttempts: 3, summary: 'gh run rerun: exit 1: HTTP 502: Bad Gateway', ...over })
    // within its backoff: it waits, no transition, no fixer
    const backingOff = plan(red([blip({ startedAt: NOW - MIN, endedAt: NOW - MIN })]))
    expect(transitionOf(backingOff, 629)).toBeUndefined()
    expect(of(backingOff, 629, 'ci-rerun')).toEqual([])
    expect(said(backingOff, 629)).toEqual(['review: the re-run of run 1801 retries after its backoff'])
    // past it: the same key again, once per round still
    const retry = plan(red([blip({ startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN })]))
    expect(transitionOf(retry, 629)).toBeUndefined()
    expect(of(retry, 629, 'ci-rerun')).toEqual([expect.objectContaining({ key, maxAttempts: 3 })])
    // used up on transient errors: a stalled effect, the owner told, no ci-red
    const spent = plan(red([blip({ attempts: 3, startedAt: NOW - 7 * MIN, endedAt: NOW - 7 * MIN })]))
    expect(transitionOf(spent, 629)).toBeUndefined()
    expect(said(spent, 629).some(w => w.startsWith(`stalled: ${key}: gh run rerun: exit 1: HTTP 502`))).toBe(true)
    expect(of(spent, 629, 'tell')).toEqual([expect.objectContaining({ wake: 'stalled' })])
    // lost (a restart during the call): GitHub may have started it, so it is awaited, not run again
    const lost = plan(red([blip({ status: 'lost', startedAt: NOW - 3 * MIN, endedAt: NOW - 2 * MIN })]))
    expect(transitionOf(lost, 629)).toBeUndefined()
    expect(of(lost, 629, 'ci-rerun')).toEqual([])
    // a failed call GitHub took anyway: a check of the run ended since, so its result counts
    const took = plan(red([blip({ startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN })], [check('test', 'fail', { completedAt: NOW - MIN })]))
    expect(of(took, 629, 'ci-rerun')).toEqual([])
    expect(transitionOf(took, 629)).toMatchObject({ row: 'T9', via: 'fix:ci' })
  })

  test('changes and red CI go to one fixer: the review\'s findings and the failed checks together', () => {
    const r = rec(626)
    const rerun = done(rerunKey(r, 1, '1801'), 'ci-rerun', { issue: 626, startedAt: NOW - 3 * MIN })
    const s = withLedger(world([r], [view(626, { checks: [check('test', 'fail', { completedAt: NOW - MIN })] })]), [ensured(r), prepared(r), changed(r), rerun])
    const notes = transitionOf(plan(settled(s, plan(s))), 626)?.next.notes ?? []
    expect(transitionOf(plan(settled(s, plan(s))), 626)).toMatchObject({ row: 'T9', via: 'fix:review' })
    // the errors, then the failed check, then the warnings
    expect(notes.slice(1).map(n => n.slice(0, 22))).toEqual(['r1-2 [error] hooks/x.t', 'CI check "test" failed', 'r1-1 [warning] hooks/x'])
    // many findings: the failed check still comes before every warning, and the overflow line
    // names both the answer file and the PR's checks
    const findings = [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `r1-${i + 1}`, severity: 'error' as const, file: `e${i}.ts`, line: 1, text: `defect ${i + 1}` })),
      ...Array.from({ length: 9 }, (_, i) => ({ id: `r1-${i + 4}`, severity: 'warning' as const, file: `w${i}.ts`, line: 1, text: `nit ${i + 1}` })),
    ]
    const many = reviewed(r, { event: 'not-ok', reason: 'changes', data: reviewData(r, 'changes', { findings }) })
    const sm = withLedger(world([r], [view(626, { checks: [check('test', 'fail', { completedAt: NOW - MIN })] })]), [ensured(r), prepared(r), many, rerun])
    const manyNotes = transitionOf(plan(settled(sm, plan(sm))), 626)?.next.notes ?? []
    expect(manyNotes.length).toBe(FIX_NOTES_MAX)
    expect(manyNotes[4]).toContain('CI check "test" failed on 9e01b77 after its one re-run')
    expect(manyNotes.at(-1)).toContain(`${LOOP_DIR}/answers/x.answer.json, and the PR's checks`)
    // changes move at once: a failed check is not re-run on a head a fixer will replace
    const unrun = withLedger(world([r], [view(626, { checks: [check('test', 'fail')] })]), [ensured(r), prepared(r), changed(r)])
    expect(of(plan(unrun), 626, 'ci-rerun')).toEqual([])
    expect(of(plan(settled(unrun, plan(unrun))), 626, 'ci-rerun')).toEqual([])
  })

  test('the GitHub waits are bounded (4.4): no check started ciStartMs after the latest of the head\'s sighting, the last action and the last completion, or a check running past ciRunMs, is unknown; within them the step waits with a skip line', () => {
    const r = rec(627, { seqAt: NOW - 40 * MIN, since: NOW - 40 * MIN })
    const ledger = [ensured(r), prepared(r), approved(r, { startedAt: NOW - 30 * MIN, endedAt: NOW - 20 * MIN })]
    const ensuredOld = { ...ledger[0], startedAt: NOW - 39 * MIN, endedAt: NOW - 38 * MIN } as LedgerEntry
    const at = (heads: Record<string, { pr: number; at: number }>, checks: CheckRun[]) => {
      const s = withLedger(world([r], [view(627, { checks })], { heads }), [ensuredOld, ...ledger.slice(1)])
      return plan(settled(s, plan(s)))
    }
    expect(transitionOf(at({ [HEAD]: { pr: PR, at: NOW - 25 * MIN } }, []), 627)).toMatchObject({ row: 'U2', via: 'unknown:github-wait' })
    const fresh = at({ [HEAD]: { pr: PR, at: NOW - 5 * MIN } }, [])
    expect(transitionOf(fresh, 627)).toBeUndefined()
    expect(said(fresh, 627)).toEqual([`review: waits for CI on ${short(HEAD)} (no check yet)`])
    // a check queued, none started: the same bound
    expect(transitionOf(at({}, [check('ci', 'pending', { startedAt: null })]), 627)).toMatchObject({ row: 'U2', via: 'unknown:github-wait' })
    // a check running: no start bound, but the running bound
    expect(transitionOf(at({}, [check('ci', 'pending', { startedAt: NOW - 20 * MIN })]), 627)).toBeUndefined()
    expect(transitionOf(at({}, [check('ci', 'pending', { startedAt: NOW - 31 * MIN })]), 627)).toMatchObject({ row: 'U2', via: 'unknown:github-wait' })
  })

  test('no GitHub wait is read while the reviewer runs, however old the head', () => {
    const r = rec(628, { seqAt: NOW - 60 * MIN })
    const runningReview = { ...reviewed(r, {}), status: 'running' as const, endedAt: null, outcome: undefined, startedAt: NOW - 5 * MIN }
    const p = plan(withLedger(world([r], [view(628)], { heads: { [HEAD]: { pr: PR, at: NOW - 60 * MIN } } }), [ensured(r), prepared(r), runningReview]))
    expect(transitionOf(p, 628)).toBeUndefined()
  })
})

// --- the writes (8.3, 7.1) --------------------------------------------------------------------------------

describe('the review\'s writes (v2 SPEC 8.3, 7.1)', () => {
  test('the PR comment: the verdict, the summary and the findings, errors first, within the comment cap; findings past it are counted', () => {
    const r = rec(630)
    const d = reviewData(r, 'changes')
    const body = reviewComment(d)
    expect(body.split('\n')[0]).toBe('**Factory loop review, round 1: changes requested**')
    expect(body).toContain('Patch f00dfee at head 9e01b77, reviewer adjudicator, suggested release patch; 1 error, 1 warning, 0 infos.')
    expect(body.indexOf('r1-2')).toBeLessThan(body.indexOf('r1-1'))
    expect(body).toContain('- **error** r1-2 `hooks/x.ts:40`: a moved HEAD is accepted')
    const findings = Array.from({ length: 50 }, (_, i) => ({ id: `r1-${i + 1}`, severity: 'warning' as const, file: '', line: null, text: 'x'.repeat(1900) }))
    const long = reviewComment({ ...d, verdict: 'approve', findings })
    expect(long.length).toBeLessThanOrEqual(COMMENT_MAX)
    expect(long).toMatch(/- \.\.\. and \d+ more findings not shown here$/)
  })

  test('the reviewed event carries its verdict, round, patch, counts, reviewer and answer, and its note reads back', () => {
    const r = rec(631)
    const e = reviewedEvent({ issue: 631, branch: 'issue-631', pr: PR, head: HEAD, round: 1, patch: PATCH, reviewer: 'adjudicator', answer: '/cfg/answers/a b.json' }, reviewData(r, 'changes'))
    const argv = eventArgv(e)
    expect(argv.slice(0, 10)).toEqual(['callum-flow-event', 'reviewed', '--issue', '631', '--branch', 'issue-631', '--pr', String(PR), '--head', HEAD])
    const note = argv[argv.indexOf('--note') + 1] ?? ''
    expect(parseEvent({ state: 'reviewed', issue: 631, branch: 'issue-631', pr: PR, head: HEAD, note })).toEqual(e)
    expect(e).toMatchObject({ verdict: 'changes', errors: 1, warnings: 1, infos: 0 })
  })

  test('a write that used up its attempts holds the record and tells the owner once; the result waits for it', () => {
    const r = rec(632)
    const s = withLedger(world([r], [view(632, { checks: GREEN })]), [ensured(r), prepared(r), approved(r)])
    const p = plan(s)
    const [comment] = of(p, 632, 'comment')
    const exhausted = withLedger(s, [done(comment?.key ?? '', 'comment', { issue: 632, status: 'failed', attempts: 3, summary: 'gh pr comment: exit 1: HTTP 502' }), ...eventsOf(p, 632, 'reviewed').map(a => done(a.key, 'event'))])
    const held = plan(exhausted)
    expect(transitionOf(held, 632)).toBeUndefined()
    expect(said(held, 632).some(w => w.startsWith(`stalled: ${comment?.key}: gh pr comment: exit 1: HTTP 502`))).toBe(true)
    expect(of(held, 632, 'tell')).toEqual([expect.objectContaining({ wake: 'stalled' })])
  })

  test('a fixer\'s dispositions are verdict events, actor fixer: CORRECT for a finding it fixed, WRONG for one it declined, each once', () => {
    const r = rec(633, { round: 2 })
    const fix = done(stepKey({ ...r, seq: 4 }, 'fix', 1), 'agent-step', {
      issue: 633,
      step: 'fix',
      outcome: {
        kind: 'step',
        step: 'fix',
        result: { event: 'ok', reason: null, why: null, head: HEAD, choice: null, data: { dispositions: [{ id: 'r1-1', fixed: true, reason: 'renamed' }, { id: 'r1-2', disposition: 'declined', reason: 'a stale head is refused by the guard' }, { id: 'r1-2', fixed: true }] } },
      },
    })
    const p = plan(withLedger(world([r], [view(633)]), [ensured(r), fix]))
    const verdicts = eventsOf(p, 633, 'verdict').map(a => (a.kind === 'event' ? a.event : null))
    expect(verdicts).toEqual([
      { state: 'verdict', issue: 633, branch: 'issue-633', pr: PR, head: HEAD, note: 'CORRECT: r1-1 renamed' },
      { state: 'verdict', issue: 633, branch: 'issue-633', pr: PR, head: HEAD, note: 'WRONG: r1-2 a stale head is refused by the guard' },
    ])
    const argv = eventArgv(verdicts[0] as NonNullable<(typeof verdicts)[number]>)
    expect(argv.slice(argv.indexOf('--actor'), argv.indexOf('--actor') + 2)).toEqual(['--actor', 'fixer'])
    // planned again only until done
    const again = plan(withLedger(world([r], [view(633)]), [ensured(r), fix, ...eventsOf(p, 633, 'verdict').map(a => done(a.key, 'event'))]))
    expect(eventsOf(again, 633, 'verdict')).toEqual([])
  })

  test('dispositions read either shape a fixer may give, and skip what is neither', () => {
    expect(dispositionsOf({ findings: [{ id: 'r1-1', disposition: 'fixed', reason: 'x' }, { id: 'r1-2', disposition: 'maybe' }, { reason: 'no id' }] })).toEqual([{ id: 'r1-1', fixed: true, reason: 'x' }])
    expect(dispositionsOf(null)).toEqual([])
    expect(verdictEvent({ issue: 1, branch: 'issue-1', pr: null, head: null }, { id: 'r1-1', fixed: false, reason: '' }).note).toBe('WRONG: r1-1 declined')
  })
})

// --- GitHub's PR events through the life's PR (4.1, E3, E4) ---------------------------------------------------

describe('a PR merged or closed by hand in its first review round (v2 SPEC 4.1, E3, E4)', () => {
  test('the record has no PR yet, but its ensure named one: a hand merge closes it merged-by-hand, a hand close parks it, the PR set', () => {
    const r = rec(640)
    const merged = plan(withLedger(world([r], [view(640, { state: 'merged', mergedHead: HEAD })]), [ensured(r)]))
    expect(transitionOf(merged, 640)).toMatchObject({ row: 'E3', next: { state: 'closed', why: 'merged-by-hand', pr: PR } })
    const closed = plan(withLedger(world([r], [view(640, { state: 'closed', closedAt: '2026-10-13T02:50:00Z' })]), [ensured(r)]))
    expect(transitionOf(closed, 640)).toMatchObject({ row: 'E4', next: { state: 'parked', pr: PR, prClosedAt: '2026-10-13T02:50:00Z', question: `PR #${PR} was closed by hand; a resume reopens it` } })
    // no PR anywhere in the life: nothing to see
    expect(lifePr([], r)).toBeNull()
    expect(lifePr([ensured(r, 9)], { ...r, pr: 3 })).toBe(3)
  })
})

// --- the reviewer interface and the contract (8.2) -----------------------------------------------------------

const JOB = (round: number | null): Job => ({ contract: 'review', purpose: null, repo: REPO, issue: 650, branch: 'issue-650', ...(round === null ? {} : { data: { round } }) })
const check2 = (input: unknown, round: number | null = 2) => V2_CONTRACTS.review.check(input, JOB(round))
const finding = (over: Record<string, unknown> = {}) => ({ id: 'r2-1', severity: 'error', file: 'hooks/x.ts', line: 4, text: 'a defect, shown by `node t.js`', ...over })

describe('the reviewer interface and its contract (v2 SPEC 8.2)', () => {
  test('the contract takes a verdict, findings with ids of this round, a summary and a bump; texts trimmed', () => {
    expect(check2({ verdict: 'changes', findings: [finding({ text: '  a defect  ' }), finding({ id: 'r2-2', severity: 'info', file: '', line: null })], summary: ' fine ', bump: 'minor' })).toEqual({
      ok: true,
      outcome: { verdict: 'changes', findings: [{ id: 'r2-1', severity: 'error', file: 'hooks/x.ts', line: 4, text: 'a defect' }, { id: 'r2-2', severity: 'info', file: '', line: null, text: 'a defect, shown by `node t.js`' }], summary: 'fine', bump: 'minor' },
    })
    expect(check2({ verdict: 'approve', findings: [finding({ severity: 'warning' })], summary: 's', bump: 'patch' })).toMatchObject({ ok: true })
    expect(V2_CONTRACTS.review.summary({ verdict: 'changes', findings: [finding(), finding({ id: 'r2-2', severity: 'info' })] })).toBe('changes, 2 findings (1 error)')
  })

  test('it refuses what a fixer could not act on, naming every problem', () => {
    const problems = (input: unknown, round: number | null = 2) => {
      const c = check2(input, round)
      return c.ok ? [] : c.problems
    }
    expect(problems({ verdict: 'changes', findings: [finding({ severity: 'warning' })], summary: 's', bump: 'patch' })).toEqual(['changes needs at least one error finding: the change a fixer must make'])
    expect(problems({ verdict: 'approve', findings: [finding()], summary: 's', bump: 'patch' })).toEqual(['approve carries no error finding (1 given): answer changes, or make them warnings'])
    expect(problems({ verdict: 'changes', findings: [finding({ id: 'r1-1' }), finding({ id: 'x', severity: 'fatal', line: 0, extra: 1 }), finding()], summary: '', bump: 'huge', more: true })).toEqual([
      'more is not a field of a review answer (only verdict, findings, summary, bump)',
      'findings[0].id r1-1 is not of this review\'s round: ids are r2-1, r2-2, ...',
      'findings[1].extra is not a field of a finding (only id, severity, file, line, text)',
      'findings[1].id "x" is not a finding id such as r2-1',
      'findings[1].severity "fatal" is not one of error, warning, info',
      'findings[1].line 0 must be a line number, or null',
      'summary must say what the change does and why this verdict',
      'bump "huge" is not one of patch, minor, major',
    ])
    expect(problems({ verdict: 'changes', findings: [finding(), finding()], summary: 's', bump: 'patch' })).toEqual(['findings[1].id r2-1 is used twice'])
    expect(problems({ verdict: 'changes', findings: [finding({ text: 'x'.repeat(2001) })], summary: 's', bump: 'patch' })).toEqual(['findings[0].text is 2001 characters; at most 2000'])
    expect(problems({ verdict: 'approve', findings: [], summary: 's', bump: 'patch' }, null)).toEqual(['the job names no review round, so no finding id can be checked (a factory loop bug)'])
    expect(problems('approve')[0]).toContain('one JSON object')
  })

  test('the registry: the interim reviewer is the adjudicator, spawning the review step\'s own agent on reviewerModel; read gives the result, or null', () => {
    expect(Object.keys(REVIEWERS)).toEqual(['adjudicator'])
    const input: ReviewInput = { issue: 650, brief: BRIEF(650), pr: PR, base: 'main', head: HEAD, patch: PATCH, round: 2, prior: [], notes: [] }
    const reviewer = reviewerOf('adjudicator', { model: 'opus' })
    expect(reviewer?.spawn(input)).toEqual({ agentType: STEP_AGENT.review, model: 'opus', prompt: 'adjudicator', input })
    expect(reviewerOf('no-mistakes', { model: 'opus' })).toBeNull()
    expect(Object.keys(REVIEW_PROMPTS)).toContain('adjudicator')
    expect(readReview({ verdict: 'approve', findings: [], summary: 's', bump: 'patch' })).toEqual({ verdict: 'approve', findings: [], summary: 's', bump: 'patch' })
    expect(readReview({ verdict: 'changes', findings: [], summary: 's', bump: 'patch' })).toBeNull()
    expect(readReview({ verdict: 'approve', findings: [finding()], summary: 's', bump: 'patch' })).toBeNull()
  })
})

// --- the prompt (8.3) ----------------------------------------------------------------------------------------

describe('the reviewer\'s prompt (v2 SPEC 8.3)', () => {
  const input: ReviewInput = {
    issue: 660,
    brief: BRIEF(660),
    pr: PR,
    base: 'main',
    head: HEAD,
    patch: PATCH,
    round: 2,
    prior: [{ round: 1, answerPath: `${LOOP_DIR}/answers/r1.answer.json`, fixerPath: `${LOOP_DIR}/answers/fix.answer.json` }],
    notes: ['r1-2 declined: Fixes #12 already, see the guard'],
  }
  const place = { bin: `${PLUGIN_ROOT}/bin/factory-answer`, file: `${LOOP_DIR}/answers/review.answer.json` }
  const text = adjudicatorPrompt(input, { repo: REPO, branch: 'issue-660', slot: '/slots/660', place })

  test('the slot line first, then the issue, the brief and the PR; the three-dot diff of the head; the test-weakening check and the test policy; the command rule', () => {
    expect(text.split('\n')[0]).toBe('factory-slot: /slots/660')
    expect(text).toContain(`issue #660 (https://github.com/${REPO}/issues/660): review round 2 of PR #${PR}`)
    expect(text).toContain(`callum-flow-issue-read --comment ${BRIEF(660)}`)
    expect(text).toContain(`callum-flow-issue-read --pr ${PR}`)
    expect(text).toContain('git fetch origin main issue-660')
    expect(text).toContain(`git diff origin/main...${HEAD}`)
    expect(text).toContain(`callum-flow-test-weakening --base origin/main --head ${HEAD}`)
    expect(text).toContain(TEST_POLICY)
    expect(text).toContain('unless the brief, or the writer\'s stated reason (in the PR\'s summary or a fixer\'s answer), shows the test is absolutely not required: you judge that reason')
    expect(text).not.toMatch(/ask-user|the adjudicator can judge/)
    expect(text).toContain(COMMAND_RULE)
  })

  test('its earlier rounds with the fixer\'s answer, the notes neutralized, and the answer script with ids of this round; nothing of the old pipeline', () => {
    expect(text).toContain(`round 1: review ${LOOP_DIR}/answers/r1.answer.json; fixer ${LOOP_DIR}/answers/fix.answer.json`)
    expect(text).toContain('Fixing #12 already')
    expect(text).not.toMatch(/\bFixes #12/)
    expect(text).toContain(`${place.bin} --to ${place.file} <<'JSON'`)
    expect(text).toContain('"id": "r2-1"')
    expect(text).not.toMatch(/\baxi\b|no-mistakes|implement-issue/)
    // with no brief, it says how to judge
    expect(adjudicatorPrompt({ ...input, brief: null, prior: [], notes: [] }, { repo: REPO, branch: 'issue-660', slot: null, place })).toContain('Brief: none is known.')
  })
})

// --- the step module through the executor (steps.ts, 8.2) -------------------------------------------------------

function runtime(cfg = CFG): Runtime {
  return { mode: 'act', repo: REPO, device: DEVICE, runSource: 'local', poolSize: 16, cwd: '/work', loopDir: LOOP_DIR, sink: null, env: { CALLUM_FLOW_REPO: REPO }, toolsDir: TOOLS, pluginRoot: PLUGIN_ROOT, config: cfg, configProblems: [] }
}

function actWorld(reply: (argv: string[]) => { exitCode?: number; stdout?: string; stderr?: string } = () => ({}), cfg = CFG) {
  const files = new Map<string, string>()
  const spawns: SpawnInput[] = []
  const argvs: string[][] = []
  const io: ActIo = {
    now: async () => NOW,
    run: async argv => {
      argvs.push([...argv])
      return { exitCode: 0, stdout: '', stderr: '', ...reply(argv) }
    },
    spawnAgent: async input => {
      spawns.push(input)
      return { agentId: 'agent-r' }
    },
    stopAgent: async () => ({ stopped: true }),
    submit: async () => undefined,
    rename: async () => undefined,
    usage: async () => ({ fiveHour: 10, sevenDay: 10 }),
    readFile: async path => files.get(path) ?? null,
    writeFile: async (path, text) => void files.set(path, text),
  }
  const env: ActEnv = { io, rt: runtime(cfg), live: { ledger: [] }, commands: [], wakeId: () => 'w1', session: 's', save: async () => true, holds: async () => true, killed: async () => false, problems: [] }
  return { files, spawns, argvs, env }
}

describe('the review step module (v2 SPEC 8.2, 8.3)', () => {
  const r = rec(670, { round: 2 })
  const earlier = reviewed({ ...r, round: 1 }, { event: 'not-ok', reason: 'changes', data: reviewData({ ...r, round: 1 }, 'changes') }, { startedAt: NOW - 50 * MIN, endedAt: NOW - 45 * MIN })
  const fix = done(stepKey({ ...r, seq: 4 }, 'fix', 1), 'agent-step', { issue: 670, step: 'fix', startedAt: NOW - 40 * MIN, endedAt: NOW - 30 * MIN })
  const s = withLedger(world([r], [view(670)]), [ensured(r), earlier, fix])
  const action = (over: Partial<Extract<Action, { kind: 'agent-step' }>> = {}): Extract<Action, { kind: 'agent-step' }> => ({
    kind: 'agent-step',
    key: reviewKey(r, PATCH, 2, 1),
    class: 'drive',
    rule: 'S2',
    reason: 'review attempt 1',
    issue: 670,
    step: 'review',
    life: LIFE,
    seq: 5,
    attempt: 1,
    branch: 'issue-670',
    slot: '/slots/670',
    notes: ['owner: keep it small'],
    ...over,
  })

  test('spawned through the agent-step executor: the reviewer\'s agent on reviewerModel, its prompt, and the job naming the round, patch, head, PR and reviewer', async () => {
    const w = actWorld()
    const a = action()
    const exec = await stepExecutor()(ctxOf(w.env, s, start([], a, NOW).entry), a)
    expect(exec).toMatchObject({ status: 'running', agentId: 'agent-r' })
    expect(w.spawns).toEqual([expect.objectContaining({ subagentType: STEP_AGENT.review, model: 'opus', name: 'review-670-s5-a1' })])
    const prompt = w.spawns[0]?.prompt ?? ''
    expect(prompt.split('\n')[0]).toBe('factory-slot: /slots/670')
    expect(prompt).toContain(`round 1: review ${stepAnswerPath(LOOP_DIR, earlier.key)}; fixer ${stepAnswerPath(LOOP_DIR, fix.key)}`)
    expect(prompt).toContain('owner: keep it small')
    const job = JSON.parse(w.files.get(stepAnswerPath(LOOP_DIR, a.key).replace(/\.answer\.json$/, '.job.json')) ?? '{}')
    expect(job).toMatchObject({ contract: 'review', issue: 670, branch: 'issue-670', data: { round: 2, patch: PATCH, head: HEAD, pr: PR, reviewer: 'adjudicator' } })
    expect(JSON.parse(w.files.get(stepRecordPath(LOOP_DIR, a.key)) ?? '{}')).toMatchObject({ step: 'review', role: 'reader', contract: 'review' })
  })

  test('its answer, read at the turn\'s end: approve is ok, changes is not-ok changes, both with what was reviewed and the answer file; an answer the contract refuses is unknown', async () => {
    const w = actWorld()
    const a = action()
    const e = { ...start([], a, NOW).entry, agentId: 'agent-r' }
    await stepExecutor()(ctxOf(w.env, s, e), a)
    const answer = { verdict: 'changes', findings: [{ id: 'r2-1', severity: 'error', file: 'a.ts', line: 1, text: 'shown by a test' }], summary: 'needs a fix', bump: 'patch' }
    w.files.set(stepAnswerPath(LOOP_DIR, a.key), JSON.stringify({ v: 1, contract: 'review', answer }))
    const taken = await stepAnswered(ctxOf(w.env, s, e), e, { agentId: 'agent-r', answer: 'done', reason: 'answer' })
    const result = taken.exec.status === 'done' && taken.exec.outcome?.kind === 'step' ? taken.exec.outcome.result : null
    expect(result).toMatchObject({ event: 'not-ok', reason: 'changes', data: { verdict: 'changes', round: 2, patch: PATCH, head: HEAD, pr: PR, reviewer: 'adjudicator', answer: stepAnswerPath(LOOP_DIR, a.key) } })
    expect(reviewDataOf(result?.data)).not.toBeNull()
    // an id of another round does not pass: one repair message, then unknown
    w.files.set(stepAnswerPath(LOOP_DIR, a.key), JSON.stringify({ v: 1, contract: 'review', answer: { ...answer, findings: [{ ...answer.findings[0], id: 'r1-1' }] } }))
    const bad = await stepAnswered(ctxOf(w.env, s, e), e, { agentId: 'agent-r', answer: 'done', reason: 'answer' })
    expect(bad.repair).toContain('not of this review\'s round')
    expect(bad.exec).toMatchObject({ status: 'done', outcome: { result: { event: 'unknown', why: 'bad-answer' } } })
    const rec2 = { v: 2 as const, key: a.key, issue: 670, step: 'review' as const, life: LIFE, seq: 5, attempt: 1, branch: 'issue-670', slot: null, role: 'reader' as const, subagentType: STEP_AGENT.review, model: null, contract: 'review' as const, data: { round: 2, patch: PATCH, head: HEAD, pr: PR, reviewer: 'adjudicator' }, answerFile: '/a', prompt: '' }
    expect(reviewResult(ctxOf(w.env, s, e), rec2, { verdict: 'approve', findings: [], summary: 'good', bump: 'patch' })).toMatchObject({ event: 'ok', reason: null, data: { verdict: 'approve', answer: '/a' } })
    expect(reviewResult(ctxOf(w.env, s, e), { ...rec2, data: { ...rec2.data, reviewer: 'gone' } }, {})).toMatchObject({ event: 'unknown', why: 'bad-answer' })
  })

  test('without what the plan had, the spawn refuses, never retried: no record, a key that is not a review\'s, no PR, a patch the key does not name, an unknown reviewer', async () => {
    const refusal = async (state: State, a = action(), cfg = CFG) => {
      const w = actWorld(() => ({}), cfg)
      const exec = await stepExecutor()(ctxOf(w.env, state, start([], a, NOW).entry), a)
      expect(w.spawns).toEqual([])
      return exec.status === 'failed' ? exec.summary : `not refused: ${exec.status}`
    }
    expect(await refusal(withLedger(world([], [view(670)]), [ensured(r)]))).toContain('has no record of life')
    expect(await refusal(s, action({ key: stepKey(r, 'review', 1) }))).toContain('is not a review key')
    expect(await refusal(world([r], []))).toContain('has no PR to review')
    expect(await refusal(withLedger(world([r], [view(670, { patch: PATCH2 })]), [ensured(r)]))).toContain(`not the ${short(PATCH)} its review key names`)
    expect(await refusal(s, action(), { ...CFG, reviewer: 'other' })).toContain('the reviewer setting names no reviewer: other')
  })

  test('its earlier rounds: each round\'s newest review that gave a verdict, with the first fixer after it', () => {
    const w = actWorld()
    const ctx = ctxOf(w.env, s, start([], action(), NOW).entry)
    expect(priorOf(ctx, r, 2)).toEqual([{ round: 1, answerPath: stepAnswerPath(LOOP_DIR, earlier.key), fixerPath: stepAnswerPath(LOOP_DIR, fix.key) }])
    expect(priorOf(ctx, r, 1)).toEqual([])
    expect(reviewInput(ctx, action())).toEqual({ issue: 670, brief: BRIEF(670), pr: PR, base: 'main', head: HEAD, patch: PATCH, round: 2, prior: priorOf(ctx, r, 2), notes: ['owner: keep it small'] })
  })
})

// --- the ci-rerun executor (act-ci.ts, 8.5) -------------------------------------------------------------------

describe('the ci-rerun executor (v2 SPEC 8.5, appendix B)', () => {
  const a: Action = { kind: 'ci-rerun', key: rerunKey({ issue: 680, life: LIFE }, 1, '18342299123'), class: 'free', rule: 'S2', reason: 're-run', issue: 680, pr: PR, runId: '18342299123', round: 1, maxAttempts: 1 }
  const s = world([])

  test('one re-run of the run\'s failed jobs: exactly the argv of argv.ts; a failure is a failed attempt with its output', async () => {
    const ok = actWorld()
    expect(await dispatch(ctxOf(ok.env, s, start([], a, NOW).entry), a)).toMatchObject({ status: 'done', summary: `re-ran the failed jobs of run 18342299123 (PR #${PR}, round 1)` })
    expect(ok.argvs).toEqual([ARGV.runRerunArgv(REPO, '18342299123')])
    expect(ok.argvs[0]).toEqual(['gh', 'run', 'rerun', '18342299123', '--failed', '--repo', REPO])
  })

  test('GitHub\'s own refusal is never retried and is named as such; a transient failure is retried', async () => {
    const run = async (stderr: string) => {
      const w = actWorld(() => ({ exitCode: 1, stderr }))
      return dispatch(ctxOf(w.env, s, start([], a, NOW).entry), a)
    }
    const no = await run('run 18342299123 cannot be rerun; its workflow file may be broken')
    expect(no).toMatchObject({ status: 'failed', noRetry: true, outcome: { kind: 'cli', exit: 1 }, summary: `${RERUN_REFUSED} of run 18342299123: run 18342299123 cannot be rerun; its workflow file may be broken` })
    expect(await run('failed to get run: HTTP 404: Not Found (https://api.github.com/repos/x/y/actions/runs/18342299123)')).toMatchObject({ noRetry: true, summary: expect.stringMatching(new RegExp(`^${RERUN_REFUSED}`)) })
    for (const stderr of ['failed to rerun: HTTP 502: Bad Gateway', 'HTTP 401: Bad credentials', 'API rate limit exceeded for user', 'error connecting to api.github.com']) {
      const t = await run(stderr)
      expect(t.status).toBe('failed')
      expect(t).not.toHaveProperty('noRetry', true)
      expect(t.summary.startsWith(RERUN_REFUSED)).toBe(false)
    }
  })

  test('a run id that is not GitHub\'s number is refused before any command', async () => {
    const w = actWorld()
    const bad: Action = { ...a, kind: 'ci-rerun', pr: PR, round: 1, runId: '--repo' } as Action
    expect(await dispatch(ctxOf(w.env, s, start([], bad, NOW).entry), bad)).toMatchObject({ status: 'failed', noRetry: true })
    expect(w.argvs).toEqual([])
  })
})

// --- the pass driver: a PR the ensure opened is read on the next pass (2.4, 8.1) ------------------------------

describe('the review step in the pass driver (v2 SPEC 2.4, 8.1)', () => {
  const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
  const USAGE = 'five_hour=40 resets_at=2026-10-13T05:00:00Z resets_in=1 seven_day=60 seven_day_resets_at=2026-10-16T11:00:00Z seven_day_resets_in=1 source=oauth'

  // Fault drill 1 on the testbed (2026-10-15): after the ensure opened the PR, every pass skipped
  // the record with "PR #N was not read this pass" and ran no PR read, so the reviewer never
  // started and the wait went unknown (github-wait), then to the breaker and triage.
  test('a record that entered reviewing by T5 has its PR opened by the ensure; the next pass reads that PR and starts the reviewer', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const n = 4
    const pr = 5
    const life = lifeOf(NOW - HOUR)
    // the record T5 made: reviewing, round 1, the build's head, no PR yet
    const r: IssueRecord = { ...madeRecord({ issue: n, life, branch: `issue-${n}`, pr: null, others: [] }, NOW - HOUR), seq: 4, seqAt: NOW - MIN, since: NOW - MIN, state: 'reviewing', step: 'review', round: 1, head: HEAD, brief: BRIEF(n) }
    const t5 = entry(transitionKey(r), 'transition', { issue: n, rule: 'S3', startedAt: NOW - MIN, endedAt: NOW - MIN, outcome: { kind: 'transition', row: 'T5', event: 'ok', cause: null, from: 'building', to: 'reviewing', step: 'build', stored: true, via: 'build' } })
    const slot = { name: '1', path: '/slots/1', status: 'leased', branch: `issue-${n}`, lease_id: 'L1', lease_holder: `factory-loop:${n}:${life}`, leased_at: iso(NOW - HOUR), processes: [] }
    const pull = { pr: { number: pr, state: 'open', merged: false, head: { sha: HEAD, ref: `issue-${n}`, repo: { full_name: REPO } }, base: { ref: 'main' }, user: { login: 'cbundy' }, mergeable_state: 'clean', body: '' }, stripped: 0 }
    let opened = false
    const run = (argv: string[], s: Seen) => {
      const line = argv.join(' ')
      switch (argv[0]) {
        case 'callum-flow-factory-state':
          return { stdout: factoryDoc([{ issue: n, stage: 'reviewing', entered_at: iso(NOW - MIN), holder: DEVICE, run: null, pr: null, stuck: null, github: null }]) }
        case 'dev-query':
          return { stdout: (s.stdin ?? '').includes('workers_status') ? QUIET_BEATS : NO_EVENTS }
        case `${TOOLS}/queue-watch.sh`:
          return { stdout: 'queue known=none now=none\n' }
        case `${TOOLS}/usage-check.sh`:
          return { stdout: USAGE }
        case 'treehouse':
          return { stdout: JSON.stringify([slot]) }
        case 'callum-flow-rollout':
          return { stdout: `ROLLOUT merge source=issue\n` }
        case 'callum-flow-patch-id':
          return { stdout: `${PATCH}\n` }
        case 'callum-flow-issue-read':
          if (line === `callum-flow-issue-read --json --pr ${pr}`) return opened ? { stdout: JSON.stringify(pull) } : { exitCode: 1, stderr: 'HTTP 404: Not Found' }
          return { stdout: JSON.stringify({ issues: [], stripped: 0 }) }
      }
      if (line === ARGV.branchPrsArgv(REPO, `issue-${n}`).join(' ')) return { stdout: opened ? JSON.stringify([{ number: pr, state: 'OPEN', headRefOid: HEAD }]) : '[]' }
      if (line.startsWith('gh pr create ')) {
        opened = true
        return { stdout: `https://github.com/${REPO}/pull/${pr}\n` }
      }
      if (line === ARGV.prChecksArgv(REPO, pr).join(' ')) return { stdout: JSON.stringify([{ name: 'ci', state: 'SUCCESS', bucket: 'pass', startedAt: iso(NOW - MIN), completedAt: iso(NOW), link: `https://github.com/${REPO}/actions/runs/7/job/1` }]) }
      return undefined
    }
    const h = host(on, {
      config: { repo: REPO, mode: 'act', checkout: '/work', planner: 'v2' },
      store: { [`records:${REPO}`]: recordsToStore([r], NOW - MIN), [`ledger:${REPO}`]: { v: 1, savedAt: NOW - MIN, entries: [t5] } },
      run,
    })
    // the companion runs in the session: its handshake, written every minute (10.9)
    let at = NOW
    const pass = async (ms: number) => {
      h.files.set(handshakePath(`${CFG_DIR}/factory-loop`, SESSION), JSON.stringify({ v: 1, session: SESSION, version: '0.38.2', at: iso(at) }))
      at += ms
      await clock.advance(ms)
    }
    await $.session.start(START)
    await pass(6_000)
    // the seq's entry actions, then the ensure, which opens the PR: the ledger names it, the record not yet (8.1)
    for (let i = 0; i < 4 && h.entry(prKey(r, 'ensure'))?.status !== 'done'; i++) await pass(60_000)
    expect(opened).toBe(true)
    expect(h.entry(prKey(r, 'ensure'))).toMatchObject({ status: 'done', outcome: { kind: 'pr', pr, created: true } })
    // the next pass reads the PR, its checks and its patch, and starts the reviewer in the slot
    const before = h.seen.length
    await pass(60_000)
    const ran = h.seen.slice(before).map(c => c.argv.join(' '))
    expect(ran).toContain(`callum-flow-issue-read --json --pr ${pr}`)
    expect(ran).toContain(ARGV.prChecksArgv(REPO, pr).join(' '))
    expect(ran).toContain(ARGV.patchIdArgv(HEAD, 'main').join(' '))
    const line = h.last()
    expect((line.sources as Record<string, string>)['v2.prs']).toBe('ok')
    expect((line.skipped as { why: string }[]).map(x => x.why).filter(w => w.includes(`PR #${pr}`))).toEqual([])
    expect((line.actions as { key: string; kind: string }[]).filter(a => a.kind === 'slot' || a.kind === 'agent-step').map(a => a.key)).toEqual([prepareKey(r, 1)])
  })

  // Drill run 3 (2026-10-16, R3-F3): #33's fixer merged main into its branch, whose change main
  // already had, so the patch id of its head did not compute. That one failure failed the whole prs
  // source, and from 03:32 every record in reviewing and the queue was held "the PRs were not read",
  // #36 too, with no step and no tell.
  test('a PR whose read fails holds only its own record: the other record\'s reviewer starts, and the failed one says why', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const life = lifeOf(NOW - HOUR)
    const prOf = (n: number) => n + 2
    const headOf = (n: number) => (n === 33 ? HEAD : HEAD2)
    const recs = [33, 36].map((n): IssueRecord => ({ ...madeRecord({ issue: n, life, branch: `issue-${n}`, pr: prOf(n), others: [] }, NOW - HOUR), seq: 4, seqAt: NOW - MIN, since: NOW - MIN, state: 'reviewing', step: 'review', round: 1, head: headOf(n), brief: BRIEF(n) }))
    const [failing, other] = recs as [IssueRecord, IssueRecord]
    const t5 = (r: IssueRecord) => entry(transitionKey(r), 'transition', { issue: r.issue, rule: 'S3', startedAt: NOW - MIN, endedAt: NOW - MIN, outcome: { kind: 'transition', row: 'T5', event: 'ok', cause: null, from: 'building', to: 'reviewing', step: 'build', stored: true, via: 'build' } })
    const slot = (r: IssueRecord, name: string) => ({ name, path: `/slots/${name}`, status: 'leased', branch: r.branch, lease_id: `L${name}`, lease_holder: `factory-loop:${r.issue}:${life}`, leased_at: iso(NOW - HOUR), processes: [] })
    const pull = (n: number) => ({ pr: { number: prOf(n), state: 'open', merged: false, head: { sha: headOf(n), ref: `issue-${n}`, repo: { full_name: REPO } }, base: { ref: 'main' }, user: { login: 'cbundy' }, mergeable_state: 'clean', body: '' }, stripped: 0 })
    const empty = `callum-flow-patch-id: ${HEAD} changes nothing against origin/main`
    const run = (argv: string[], s: Seen) => {
      const line = argv.join(' ')
      switch (argv[0]) {
        case 'callum-flow-factory-state':
          return { stdout: factoryDoc(recs.map(r => ({ issue: r.issue, stage: 'reviewing', entered_at: iso(NOW - MIN), holder: DEVICE, run: null, pr: r.pr, stuck: null, github: null }))) }
        case 'dev-query':
          return { stdout: (s.stdin ?? '').includes('workers_status') ? QUIET_BEATS : NO_EVENTS }
        case `${TOOLS}/queue-watch.sh`:
          return { stdout: 'queue known=none now=none\n' }
        case `${TOOLS}/usage-check.sh`:
          return { stdout: USAGE }
        case 'treehouse':
          return { stdout: JSON.stringify([slot(failing, '1'), slot(other, '2')]) }
        case 'callum-flow-rollout':
          return { stdout: 'ROLLOUT merge source=issue\n' }
        case 'callum-flow-patch-id':
          return argv[1] === HEAD ? { exitCode: 1, stderr: empty } : { stdout: `${PATCH2}\n` }
        case 'callum-flow-issue-read': {
          const r = recs.find(x => line === `callum-flow-issue-read --json --pr ${x.pr}`)
          return { stdout: JSON.stringify(r === undefined ? { issues: [], stripped: 0 } : pull(r.issue)) }
        }
      }
      for (const r of recs) {
        if (line === ARGV.branchPrsArgv(REPO, r.branch).join(' ')) return { stdout: JSON.stringify([{ number: r.pr, state: 'OPEN', headRefOid: r.head }]) }
        if (line === ARGV.prChecksArgv(REPO, r.pr ?? 0).join(' ')) return { stdout: JSON.stringify([{ name: 'ci', state: 'SUCCESS', bucket: 'pass', startedAt: iso(NOW - MIN), completedAt: iso(NOW), link: `https://github.com/${REPO}/actions/runs/7/job/1` }]) }
      }
      return undefined
    }
    const h = host(on, {
      config: { repo: REPO, mode: 'act', checkout: '/work', planner: 'v2' },
      store: { [`records:${REPO}`]: recordsToStore(recs, NOW - MIN), [`ledger:${REPO}`]: { v: 1, savedAt: NOW - MIN, entries: recs.map(t5) } },
      run,
    })
    let at = NOW
    const pass = async (ms: number) => {
      h.files.set(handshakePath(`${CFG_DIR}/factory-loop`, SESSION), JSON.stringify({ v: 1, session: SESSION, version: '0.38.2', at: iso(at) }))
      at += ms
      await clock.advance(ms)
    }
    await $.session.start(START)
    await pass(6_000)
    for (let i = 0; i < 4 && recs.some(r => h.entry(prKey(r, 'ensure'))?.status !== 'done'); i++) await pass(60_000)
    expect(recs.map(r => h.entry(prKey(r, 'ensure'))?.status)).toEqual(['done', 'done'])
    // the next pass reads both PRs: #33's patch id fails, #36's reviewer starts all the same
    await pass(60_000)
    const line = h.last()
    expect((line.sources as Record<string, string>)['v2.prs']).toBe('ok')
    expect((line.actions as { key: string; kind: string }[]).filter(a => a.kind === 'slot' || a.kind === 'agent-step').map(a => a.key)).toEqual([prepareKey(other, 1)])
    const said = (n: number) => (line.skipped as { issue: number | null; why: string }[]).filter(x => x.issue === n).map(x => x.why)
    expect(said(36)).toEqual([])
    expect(said(33)).toEqual([`review: PR #35 did not read: the patch id of ${short(HEAD)} did not compute: ${empty}`])
  })

  // A record in reviewing whose seq began, and whose ensure ended, an hour ago, so nothing of its
  // step runs and a wait counted from the seq is long past its bound; `checks` answers its PR's
  // checks read. Review of the R3-F3 fix: one failed read, or one met under a rate limit, ended
  // such a step unknown (github-wait) in the pass it failed.
  function oldReview(on: Parameters<typeof host>[0], checks: { exitCode: number; stderr: string }) {
    const clock = mock.clock(on, { now: NOW })
    const n = 41
    const pr = 43
    const life = lifeOf(NOW - 2 * HOUR)
    const r: IssueRecord = { ...madeRecord({ issue: n, life, branch: `issue-${n}`, pr, others: [] }, NOW - 2 * HOUR), seq: 4, seqAt: NOW - HOUR, since: NOW - HOUR, state: 'reviewing', step: 'review', round: 1, head: HEAD, brief: BRIEF(n) }
    const t5 = entry(transitionKey(r), 'transition', { issue: n, rule: 'S3', startedAt: NOW - HOUR, endedAt: NOW - HOUR, outcome: { kind: 'transition', row: 'T5', event: 'ok', cause: null, from: 'building', to: 'reviewing', step: 'build', stored: true, via: 'build' } })
    const ens = entry(prKey(r, 'ensure'), 'pr', { issue: n, rule: 'S2', pr, startedAt: NOW - HOUR, endedAt: NOW - HOUR, outcome: { kind: 'pr', pr, created: true, reopened: false } })
    const slot = { name: '1', path: '/slots/1', status: 'leased', branch: `issue-${n}`, lease_id: 'L1', lease_holder: `factory-loop:${n}:${life}`, leased_at: iso(NOW - 2 * HOUR), processes: [] }
    const pull = { pr: { number: pr, state: 'open', merged: false, head: { sha: HEAD, ref: `issue-${n}`, repo: { full_name: REPO } }, base: { ref: 'main' }, user: { login: 'cbundy' }, mergeable_state: 'clean', body: '' }, stripped: 0 }
    const run = (argv: string[], s: Seen) => {
      const line = argv.join(' ')
      switch (argv[0]) {
        case 'callum-flow-factory-state':
          return { stdout: factoryDoc([{ issue: n, stage: 'reviewing', entered_at: iso(NOW - HOUR), holder: DEVICE, run: null, pr, stuck: null, github: null }]) }
        case 'dev-query':
          return { stdout: (s.stdin ?? '').includes('workers_status') ? QUIET_BEATS : NO_EVENTS }
        case `${TOOLS}/queue-watch.sh`:
          return { stdout: 'queue known=none now=none\n' }
        case `${TOOLS}/usage-check.sh`:
          return { stdout: USAGE }
        case 'treehouse':
          return { stdout: JSON.stringify([slot]) }
        case 'callum-flow-rollout':
          return { stdout: 'ROLLOUT merge source=issue\n' }
        case 'callum-flow-patch-id':
          return { stdout: `${PATCH}\n` }
        case 'callum-flow-issue-read':
          return { stdout: JSON.stringify(line === `callum-flow-issue-read --json --pr ${pr}` ? pull : { issues: [], stripped: 0 }) }
      }
      if (line === ARGV.branchPrsArgv(REPO, r.branch).join(' ')) return { stdout: JSON.stringify([{ number: pr, state: 'OPEN', headRefOid: HEAD }]) }
      if (line === ARGV.prChecksArgv(REPO, pr).join(' ')) return checks
      return undefined
    }
    const h = host(on, {
      config: { repo: REPO, mode: 'act', checkout: '/work', planner: 'v2' },
      store: { [`records:${REPO}`]: recordsToStore([r], NOW - HOUR), [`ledger:${REPO}`]: { v: 1, savedAt: NOW - HOUR, entries: [t5, ens] } },
      run,
    })
    let at = NOW
    const pass = async (ms: number) => {
      h.files.set(handshakePath(`${CFG_DIR}/factory-loop`, SESSION), JSON.stringify({ v: 1, session: SESSION, version: '0.38.2', at: iso(at) }))
      at += ms
      await clock.advance(ms)
    }
    const said = () => (h.last().skipped as { issue: number | null; why: string }[]).filter(x => x.issue === n).map(x => x.why)
    // the step's end: the transition out of seq 4
    const ended = () => h.entry(transitionKey({ ...r, seq: 5 }))
    return { h, pr, pass, said, ended, checksRead: ARGV.prChecksArgv(REPO, pr).join(' ') }
  }

  test('one failed PR read holds a record long in review; a read that keeps failing ends its step unknown ciStartMs after its first failure', async ($, on) => {
    const w = oldReview(on, { exitCode: 1, stderr: 'HTTP 502: Bad Gateway' })
    await $.session.start(START)
    await w.pass(6_000)
    expect((w.h.last().sources as Record<string, string>)['v2.prs']).toBe('ok')
    expect(w.said()).toEqual([`review: PR #${w.pr} did not read: gh pr checks exit 1: HTTP 502: Bad Gateway`])
    expect(w.ended()).toBeUndefined()
    // it keeps failing: held while the run of failed reads is within ciStartMs (10 min) ...
    for (let i = 0; i < 9; i++) await w.pass(60_000)
    expect(w.said()).toEqual([`review: PR #${w.pr} did not read: gh pr checks exit 1: HTTP 502: Bad Gateway`])
    expect(w.ended()).toBeUndefined()
    // ... and unknown (github-wait) once it is past it, so the record cannot hold its slot for good
    for (let i = 0; i < 2 && w.ended() === undefined; i++) await w.pass(60_000)
    expect(w.ended()).toMatchObject({ status: 'done', outcome: { kind: 'transition', row: 'U2', via: 'unknown:github-wait' } })
  })

  test('a PR read that meets a GitHub rate limit holds a record long in review with no clock: the backoff starts in that pass', async ($, on) => {
    const w = oldReview(on, { exitCode: 1, stderr: 'gh: API rate limit exceeded for user ID 1234. (HTTP 403)' })
    await $.session.start(START)
    await w.pass(6_000)
    expect(w.h.commands().map(c => c.argv.join(' '))).toContain(w.checksRead)
    expect(w.said()).toContain(`review: PR #${w.pr} did not read: gh pr checks exit 1: gh: API rate limit exceeded for user ID 1234. (HTTP 403)`)
    expect(w.ended()).toBeUndefined()
    // the pass's own backoff, kept for the next passes
    expect(w.h.store.get(`backoff:${REPO}`)).toBeGreaterThan(NOW + GITHUB_BACKOFF_MS)
    // the next passes read no PR while the backoff lasts, and the record still holds
    const before = w.h.seen.length
    for (let i = 0; i < 3; i++) await w.pass(60_000)
    expect(w.h.seen.slice(before).map(c => c.argv.join(' '))).not.toContain(w.checksRead)
    expect(w.said()).toContain('review: the PRs were not read (GitHub rate limit: no PR is read this pass)')
    expect(w.ended()).toBeUndefined()
  })
})
