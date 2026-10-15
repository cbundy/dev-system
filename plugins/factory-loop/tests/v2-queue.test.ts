// The merge queue under planner v2 (docs/factory-loop/v2/SPEC.md 9, 4.2, 4.4, 8.4, 8.5): its order,
// the head's step (Q1's update, Q2's merge, the one CI re-run, the waits on GitHub and their
// bound), the results the table takes from it, the properties of 17.1 it owns (8 head only, 9
// patch-keyed approval, 14 the queue moves), the executors (act-queue.ts) and the prs source
// (sources-prs.ts). Plans are driven through planV2 itself; actions are found by kind and by the
// key codec (keys.ts, steps-queue.ts), never by literal keys.
import { describe, expect, test } from 'claude-code/testing'

import { ctxOf, dispatch } from '../hooks/act'
import type { ActEnv } from '../hooks/act'
import type { ActIo, RunResult } from '../hooks/exec'
import { start } from '../hooks/ledger'
import type { Runtime } from '../hooks/observe'
import type { Action, LedgerEntry, PlanResult, State } from '../hooks/types'
import { failClassOf, failLines, refusalClass } from '../hooks/v2/act-queue'
import { interventionKey, lifeKey, lifeOf, prKey, rerunKey, transitionKey } from '../hooks/v2/keys'
import { emptyV2State } from '../hooks/v2/observe'
import type { SourceCtx } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { MERGE_TRIES, queueOf } from '../hooks/v2/rules-queue'
import { RERUN_ATTEMPTS, RERUN_REFUSED } from '../hooks/v2/rules-review'
import { checksOf, headsOf, pullOf, readPrs } from '../hooks/v2/sources-prs'
import type { CheckRun, PrView } from '../hooks/v2/sources-prs'
import { mergeKey, queueKeyParts, updateKey } from '../hooks/v2/steps-queue'
import { madeRecord } from '../hooks/v2/table'
import { SLOT_STATES } from '../hooks/v2/types'
import type { GuardClass, IssueRecord, Lease, V2State } from '../hooks/v2/types'
import { executorBreaker } from '../hooks/foundation'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, control, entry, state as baseState } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const HOUR = 60 * MIN
const CFG = config({ planner: 'v2', mode: 'act', maxInFlightIssues: 3 })
const LIFE = lifeOf(NOW - 2 * HOUR)
const sha = (c: string) => c.repeat(40)
const HEAD = sha('a')
const HEAD2 = sha('b')
const PATCH = sha('c')
const OTHER_PATCH = sha('e')
const MAIN = sha('d')
const MAIN2 = sha('f')

// rec: a record of one life in the merge queue on its queue step, its patch approved in round 1.
function rec(n: number, over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    ...madeRecord({ issue: n, life: LIFE, branch: `issue-${n}`, pr: null, others: [] }, NOW - HOUR),
    seq: 5,
    seqAt: NOW - 20 * MIN,
    since: NOW - 20 * MIN,
    state: 'merge-queue',
    step: 'queue',
    pr: 600 + n,
    head: HEAD,
    approvedPatch: PATCH,
    round: 1,
    ...over,
  }
}

const leaseFor = (r: Pick<IssueRecord, 'issue' | 'life'>): Lease => ({ path: `/slots/${r.issue}`, lease: `L${r.issue}`, holder: `factory-loop:${r.issue}:${r.life}`, issue: r.issue, life: r.life, status: 'leased', busy: false })

// check: one check run on the head, passed two minutes ago by default.
function check(over: Partial<CheckRun> = {}): CheckRun {
  return { name: 'ci', state: 'SUCCESS', bucket: 'pass', startedAt: NOW - 5 * MIN, completedAt: NOW - 2 * MIN, runId: '9001', link: `https://github.com/${REPO}/actions/runs/9001/job/1`, ...over }
}

// view: the record's open PR as the prs source reads it: clean, green, at HEAD with the approved
// patch.
function view(r: IssueRecord, over: Partial<PrView> = {}): PrView {
  return { pr: r.pr ?? 0, issue: r.issue, state: 'open', head: HEAD, mergedHead: null, closedAt: null, mergeable: 'clean', author: 'cbundy', checks: [check()], patch: PATCH, readAt: NOW, ...over }
}

const OK = { ok: true, at: NOW }

// world: these records, each holding its slot, their PRs read as given (main's head read), every
// v2 source read, and each PR head first seen 15 minutes ago.
function world(records: IssueRecord[], prs: PrView[] = records.map(r => view(r)), over: Partial<State> = {}, v2: Partial<V2State> = {}): State {
  const s = baseState(over)
  const heads = Object.fromEntries(prs.flatMap(p => (p.head === null ? [] : [[p.head, { pr: p.pr, at: NOW - 15 * MIN }]])))
  return {
    ...s,
    v2: {
      ...emptyV2State(NOW, records),
      sources: { store: OK, leases: OK, prs: OK, interventions: OK, comments: OK },
      leases: records.filter(r => SLOT_STATES.includes(r.state)).map(leaseFor),
      prs: { prs, main: { branch: 'main', sha: MAIN } },
      heads,
      ...v2,
    },
  }
}

const withLedger = (s: State, extra: LedgerEntry[]): State => ({ ...s, ledger: [...s.ledger, ...extra] })
const plan = (s: State, cfg = CFG): PlanResult => planV2(s, cfg)
const of = (r: PlanResult, n: number): Action[] => r.actions.filter(a => a.issue === n && a.kind !== 'title')
const said = (r: PlanResult, n: number) => r.skipped.filter(s => s.issue === n).map(s => s.why)
const transitionOf = (r: PlanResult, n: number) => r.actions.find((a): a is Extract<Action, { kind: 'transition' }> => a.kind === 'transition' && a.issue === n)
const queueActions = (r: PlanResult) => r.actions.filter((a): a is Extract<Action, { kind: 'queue-update' | 'queue-merge' }> => a.kind === 'queue-update' || a.kind === 'queue-merge')
const ivs = (r: PlanResult, n: number) => of(r, n).flatMap(a => (a.kind === 'event' && a.event.state === 'intervention' ? [`${a.event.who} ${a.event.cause}`] : []))

// tried: a queue action of the record's current seq that ended, with the outcome the executor
// records.
function tried(r: IssueRecord, op: 'update' | 'merge', over: { status?: LedgerEntry['status']; head?: string; base?: string; k?: number; merged?: boolean; failClass?: GuardClass | null; lines?: string[]; newHead?: string | null; at?: number } = {}): LedgerEntry {
  const head = over.head ?? HEAD
  const key = op === 'update' ? updateKey(r, over.base ?? MAIN) : mergeKey(r, head, over.k ?? 1)
  const at = over.at ?? NOW - 3 * MIN
  return entry(key, op === 'update' ? 'queue-update' : 'queue-merge', {
    issue: r.issue,
    pr: r.pr,
    head,
    status: over.status ?? 'done',
    startedAt: at,
    endedAt: at + 30_000,
    outcome: { kind: 'queue', op, merged: over.merged ?? false, head: op === 'update' ? (over.newHead ?? null) : head, failClass: over.failClass ?? null, lines: over.lines ?? [] },
  })
}

// refusal: the guard's answer to a merge try: done, not merged, with its class and FAIL lines.
const refusal = (lines: string[], cls: GuardClass) => ({ status: 'done' as const, failClass: cls, lines })

// --- the order (9.1) ------------------------------------------------------------------------------------

describe('the order (v2 SPEC 9.1)', () => {
  test('the queue is the merge-queue records on their queue step, oldest seq first, ties by issue; paused issues and a record on triage are not in it', () => {
    const records = [
      rec(3, { seqAt: NOW - 5 * MIN }),
      rec(1, { seqAt: NOW - 10 * MIN }),
      rec(2, { seqAt: NOW - 10 * MIN }),
      rec(4, { seqAt: NOW - 30 * MIN, step: 'triage', triages: 1 }),
      rec(5, { seqAt: NOW - 40 * MIN }),
      rec(6, { state: 'reviewing', step: 'review', seqAt: NOW - 50 * MIN }),
    ]
    expect(queueOf(records, [5]).map(r => r.issue)).toEqual([1, 2, 3])
    expect(queueOf(records, []).map(r => r.issue)).toEqual([5, 1, 2, 3])
  })

  test('only the head is touched: the records behind it wait untouched with a skip line naming the head, and are told after the queue\'s wait (E6)', () => {
    const head = rec(1, { seqAt: NOW - 30 * MIN })
    const behind = rec(2, { seqAt: NOW - 20 * MIN })
    const last = rec(3, { seqAt: NOW - 10 * MIN, since: NOW - 3 * HOUR })
    // every PR is behind main: only the head's is updated
    const r = plan(world([head, behind, last], [head, behind, last].map(x => view(x, { mergeable: 'behind' }))))
    expect(queueActions(r).map(a => [a.kind, a.issue, a.pr])).toEqual([['queue-update', 1, 601]])
    expect(said(r, 2)).toEqual(['merge queue: waits behind #1 (2 of 3)'])
    expect(said(r, 3)).toEqual(['merge queue: waits behind #1 (3 of 3)'])
    // behind the head 3 hours, past the queue's 2: told once per period, as E6's waiting tell
    expect(of(r, 3)).toEqual([expect.objectContaining({ kind: 'tell', wake: 'waiting', rule: 'S6' })])
    expect(of(r, 2)).toEqual([])
  })

  test('a paused head is passed over: the next record is the head, and the paused one says why', () => {
    const paused = rec(1, { seqAt: NOW - 30 * MIN })
    const next = rec(2, { seqAt: NOW - 20 * MIN })
    const r = plan(world([paused, next], undefined, { control: control({ paused: [1] }) }))
    expect(queueActions(r).map(a => a.issue)).toEqual([2])
    expect(said(r, 1)).toContain('merge queue: paused by the owner, so the queue moves past it')
  })
})

// --- Q2: the merge (9.3) ------------------------------------------------------------------------------------

describe('Q2: the head is merged when it is clean, green and its patch is the approved one (v2 SPEC 9.3)', () => {
  test('a clean, green head with the approved patch is merged through the guard, with the approved patch, keyed by its head; nothing else of it is planned', () => {
    const r = rec(10)
    const p = plan(world([r]))
    const merges = queueActions(p)
    expect(merges).toEqual([expect.objectContaining({ kind: 'queue-merge', rule: 'Q2', class: 'free', pr: 610, head: HEAD, patch: PATCH, maxAttempts: 1 })])
    expect(queueKeyParts(merges[0]?.key ?? '')).toEqual({ op: 'merge', sha: HEAD.slice(0, 7), seq: 5, k: 1 })
    expect(said(p, 10)).toEqual([])
    // planned again with the merge running: it runs, nothing new
    const runningMerge = { ...tried(r, 'merge'), status: 'running' as const, endedAt: null, outcome: undefined }
    const again = plan(withLedger(world([r]), [runningMerge]))
    expect(queueActions(again)).toEqual([])
    expect(transitionOf(again, 10)).toBeUndefined()
    // a queue action that runs past the wait's bound is the head's unknown (timeout), never a tell
    const hung = plan(withLedger(world([r]), [{ ...runningMerge, startedAt: NOW - 11 * MIN }]))
    expect(transitionOf(hung, 10)).toMatchObject({ row: 'U2', via: 'unknown:timeout', trigger: { kind: 'entry', key: runningMerge.key, status: 'running' } })
  })

  test('merged is ok: T13 closes the record as merged; a merge the loop made is never a hand merge', () => {
    const r = rec(11)
    const t = transitionOf(plan(withLedger(world([r]), [tried(r, 'merge', { merged: true })])), 11)
    expect(t).toMatchObject({ row: 'T13', event: 'ok', rule: 'S3', next: { state: 'closed', why: 'merged' } })
    // the PR read as merged at the head a lost try named: still the queue's own merge
    const lost = { ...tried(r, 'merge'), status: 'lost' as const, outcome: undefined }
    const merged = world([r], [view(r, { state: 'merged', mergedHead: HEAD })])
    expect(transitionOf(plan(withLedger(merged, [lost])), 11)).toMatchObject({ row: 'T13', next: { why: 'merged' } })
  })

  test('the guard\'s FAIL classes, one outcome each: policy parks with its lines, patch goes back to review, conflict to a fixer, read is unknown', () => {
    const r = rec(12)
    const run = (cls: GuardClass, lines: string[]) => transitionOf(plan(withLedger(world([r]), [tried(r, 'merge', refusal(lines, cls))])), 12)
    expect(run('policy', ['GUARD author FAIL PR #612 was not opened by a trusted author class=policy'])).toMatchObject({
      row: 'T15',
      next: { state: 'parked', resumeTo: 'merge-queue', question: expect.stringContaining('not opened by a trusted author') },
    })
    expect(run('patch', ['GUARD patch FAIL head x has patch y, not the approved z class=patch'])).toMatchObject({ row: 'T14', next: { state: 'reviewing', approvedPatch: null, round: 2 } })
    expect(run('conflict', ['GUARD mergeable FAIL conflicts with main class=conflict'])).toMatchObject({
      row: 'T9',
      via: 'fix:conflict',
      next: { state: 'fixing', fixes: 1, notes: [expect.stringContaining('merge origin/main into issue-12')] },
    })
    expect(run('read', ['GUARD author FAIL cannot verify the author of PR #612 (reader exit 1) class=read'])).toMatchObject({ row: 'U2', event: 'unknown', next: { state: 'merge-queue', step: 'queue', attempt: 2 } })
    // a CLI failure, or a refusal GitHub gave no reason for, is unknown too
    expect(transitionOf(plan(withLedger(world([r]), [tried(r, 'merge', { status: 'failed', failClass: null, lines: ['callum-flow-merge: GitHub refused the merge'] })])), 12)).toMatchObject({ row: 'U2' })
  })

  test('behind and checks are no transition: the head is read afresh, and updated or merged again under a key of its own, at most MERGE_TRIES times', () => {
    const r = rec(13)
    const behindFail = tried(r, 'merge', refusal(['GUARD mergeable FAIL behind main class=behind'], 'behind'))
    const behind = plan(withLedger(world([r], [view(r, { mergeable: 'behind' })]), [behindFail]))
    expect(transitionOf(behind, 13)).toBeUndefined()
    expect(queueActions(behind)).toEqual([expect.objectContaining({ kind: 'queue-update', base: MAIN })])
    const checksFail = tried(r, 'merge', refusal(['GUARD checks FAIL ci=pending class=checks'], 'checks'))
    const green = plan(withLedger(world([r]), [checksFail]))
    expect(transitionOf(green, 13)).toBeUndefined()
    expect(queueActions(green).map(a => queueKeyParts(a.key)?.k)).toEqual([2])
    // the guard refusing a head the loop reads as ready, try after try: unknown
    const tries = Array.from({ length: MERGE_TRIES }, (_, i) => tried(r, 'merge', { ...refusal(['GUARD checks FAIL ci=pending class=checks'], 'checks'), k: i + 1, at: NOW - (10 - i) * MIN }))
    expect(transitionOf(plan(withLedger(world([r]), tries)), 13)).toMatchObject({ row: 'U2', event: 'unknown' })
  })

  test('linkage: the body is written again once per attempt with the builder\'s words, then the merge runs again; a second linkage FAIL is policy', () => {
    const r = rec(14)
    const build = entry(`${lifeKey(r)}/s3/build/a1`, 'agent-step', {
      issue: 14,
      step: 'build',
      class: 'develop',
      startedAt: NOW - 50 * MIN,
      endedAt: NOW - 45 * MIN,
      outcome: { kind: 'step', step: 'build', result: { event: 'ok', reason: null, why: null, head: HEAD, choice: null, data: { title: 'Fix the queue', summary: 'It merges.', evidence: 'npm test' } } },
    })
    const linkage = tried(r, 'merge', { ...refusal(['GUARD linkage FAIL MISMATCH #614 issue=#14 expect=closing class=linkage'], 'linkage'), at: NOW - 6 * MIN })
    const first = plan(withLedger(world([r]), [build, linkage]))
    expect(transitionOf(first, 14)).toBeUndefined()
    expect(of(first, 14).filter(a => a.kind === 'pr')).toEqual([
      expect.objectContaining({ kind: 'pr', op: 'body', key: prKey(r, 'body', 1), rule: 'Q2', pr: 614, branch: 'issue-14', base: 'main', title: 'Fix the queue', summary: 'It merges.', evidence: 'npm test' }),
    ])
    expect(queueActions(first)).toEqual([])
    const body = entry(prKey(r, 'body', 1), 'pr', { issue: 14, startedAt: NOW - 5 * MIN, endedAt: NOW - 4 * MIN })
    const second = plan(withLedger(world([r]), [build, linkage, body]))
    expect(queueActions(second).map(a => queueKeyParts(a.key)?.k)).toEqual([2])
    const again = tried(r, 'merge', { ...refusal(['GUARD linkage FAIL MISMATCH #614 issue=#14 expect=closing class=linkage'], 'linkage'), k: 2, at: NOW - 3 * MIN })
    expect(transitionOf(plan(withLedger(world([r]), [build, linkage, body, again])), 14)).toMatchObject({
      row: 'T15',
      next: { state: 'parked', question: expect.stringContaining('the linkage still fails after the body was written again') },
    })
  })

  test('linkage: a body write that failed is written again after its backoff, then the merge runs again; one that used up its attempts is stalled and told, never a silent hold', () => {
    const r = rec(16)
    const linkage = tried(r, 'merge', { ...refusal(['GUARD linkage FAIL MISMATCH #616 issue=#16 expect=closing class=linkage'], 'linkage'), at: NOW - 8 * MIN })
    const lost = entry(prKey(r, 'body', 1), 'pr', { issue: 16, status: 'failed', summary: 'gh pr edit: HTTP 502', startedAt: NOW - 6 * MIN, endedAt: NOW - 6 * MIN + 1000 })
    // the next pass, past the backoff: the body is written again, and the merge waits for it
    const retry = plan(withLedger(world([r]), [linkage, lost]))
    expect(transitionOf(retry, 16)).toBeUndefined()
    expect(of(retry, 16).filter(a => a.kind === 'pr')).toEqual([expect.objectContaining({ kind: 'pr', op: 'body', key: prKey(r, 'body', 1) })])
    expect(queueActions(retry)).toEqual([])
    // inside the backoff: held, and says so
    const soon = plan(withLedger(world([r]), [linkage, { ...lost, endedAt: NOW - 30_000 }]))
    expect(of(soon, 16).filter(a => a.kind === 'pr')).toEqual([])
    expect(said(soon, 16)).toContain('merge queue: the body of PR #616 runs again after its backoff')
    // written on the second try: the merge runs again
    const written = { ...lost, status: 'done' as const, attempts: 2, endedAt: NOW - 2 * MIN }
    expect(queueActions(plan(withLedger(world([r]), [linkage, written]))).map(a => queueKeyParts(a.key)?.k)).toEqual([2])
    // used up: an effect that holds its record as stalled (4.5), and the owner hears once
    const spent = plan(withLedger(world([r]), [linkage, { ...lost, attempts: 3 }]))
    expect(transitionOf(spent, 16)).toBeUndefined()
    expect(said(spent, 16)).toContain(`stalled: ${lost.key}: gh pr edit: HTTP 502`)
    expect(of(spent, 16)).toContainEqual(expect.objectContaining({ kind: 'tell', wake: 'stalled' }))
  })

  test('a try at a head the PR no longer has says nothing of the head it has now', () => {
    const r = rec(15)
    const old = tried(r, 'merge', refusal(['GUARD mergeable FAIL conflicts with main class=conflict'], 'conflict'))
    const moved = plan(withLedger(world([r], [view(r, { head: HEAD2 })]), [old]))
    expect(transitionOf(moved, 15)).toBeUndefined()
    expect(queueActions(moved)).toEqual([expect.objectContaining({ kind: 'queue-merge', head: HEAD2 })])
  })
})

// --- what the head's read says (4.2, 8.4, 8.5) ---------------------------------------------------------------

describe('the head as read: patch, conflict and CI (v2 SPEC 4.2, 8.4, 8.5, 9.5)', () => {
  test('a head whose patch is not the approved one goes back to review (T14) and is never merged; a conflict goes to a fixer at once, never updated', () => {
    const r = rec(20)
    const changed = plan(world([r], [view(r, { patch: OTHER_PATCH, mergeable: 'behind' })]))
    expect(queueActions(changed)).toEqual([])
    expect(transitionOf(changed, 20)).toMatchObject({ row: 'T14', next: { state: 'reviewing', approvedPatch: null } })
    expect(ivs(withLedgerDone(changed, r), 20)).toEqual(['loop queue:patch'])
    const dirty = plan(world([r], [view(r, { mergeable: 'dirty' })]))
    expect(queueActions(dirty)).toEqual([])
    expect(transitionOf(dirty, 20)).toMatchObject({ row: 'T9', via: 'fix:conflict', next: { state: 'fixing' } })
    // at the fix cap, the conflict parks with the question
    expect(transitionOf(plan(world([{ ...r, fixes: 3 }], [view(r, { mergeable: 'dirty' })])), 20)).toMatchObject({ row: 'T10', next: { state: 'parked', resumeTo: 'fixing' } })
  })

  test('a failed check gets one re-run per round, by its run; failed again after it, the head goes to a fixer with the check\'s name and link (ci-red); no hold for a red main', () => {
    const r = rec(21)
    const red = check({ name: 'ci', bucket: 'fail', state: 'FAILURE', completedAt: NOW - 5 * MIN })
    const first = plan(world([r], [view(r, { checks: [red, check({ name: 'lint', runId: '9002' })] })]))
    expect(transitionOf(first, 21)).toBeUndefined()
    expect(of(first, 21).filter(a => a.kind === 'ci-rerun')).toEqual([expect.objectContaining({ kind: 'ci-rerun', key: rerunKey(r, 1, '9001'), runId: '9001', round: 1, pr: 621, class: 'free' })])
    expect(queueActions(first)).toEqual([])
    const rerun = entry(rerunKey(r, 1, '9001'), 'ci-rerun', { issue: 21, startedAt: NOW - 4 * MIN, endedAt: NOW - 4 * MIN + 5000 })
    // the read from before the re-run is stale: it waits
    const stale = plan(withLedger(world([r], [view(r, { checks: [red] })]), [rerun]))
    expect(transitionOf(stale, 21)).toBeUndefined()
    expect(said(stale, 21)).toEqual([expect.stringContaining('CI runs on aaaaaaa')])
    const again = { ...red, completedAt: NOW - MIN }
    const t = transitionOf(plan(withLedger(world([r], [view(r, { checks: [again] })]), [rerun])), 21)
    expect(t).toMatchObject({ row: 'T9', via: 'fix:ci', next: { state: 'fixing', notes: [`check ci failed after its one re-run (run 9001): ${red.link}`] } })
    // a check with no run to re-run counts at once; a cancelled one is re-run too
    expect(transitionOf(plan(world([r], [view(r, { checks: [{ ...red, runId: null, link: null }] })])), 21)).toMatchObject({ row: 'T9', via: 'fix:ci' })
    expect(of(plan(world([r], [view(r, { checks: [{ ...red, bucket: 'cancel' }] })])), 21).map(a => a.kind)).toContain('ci-rerun')
  })

  test('a re-run whose call failed on a transient error re-ran nothing: never red; it is tried again after its backoff, and once used up the step is unknown; a lost or timed-out one, or one GitHub took anyway, is awaited', () => {
    const r = rec(26)
    const red = check({ name: 'ci', bucket: 'fail', state: 'FAILURE', completedAt: NOW - 5 * MIN })
    const reds = [view(r, { checks: [red] })]
    const broken = (over: Partial<LedgerEntry>) => entry(rerunKey(r, 1, '9001'), 'ci-rerun', { issue: 26, status: 'failed', summary: 'gh run rerun: HTTP 502', startedAt: NOW - 4 * MIN, endedAt: NOW - 4 * MIN + 5000, ...over })
    // a transient failure: the same key again, with the review step's cap (8.5)
    const p = plan(withLedger(world([r], reds), [broken({})]))
    expect(transitionOf(p, 26)).toBeUndefined()
    expect(of(p, 26).filter(a => a.kind === 'ci-rerun')).toEqual([expect.objectContaining({ key: rerunKey(r, 1, '9001'), maxAttempts: RERUN_ATTEMPTS })])
    expect(RERUN_ATTEMPTS).toBe(3)
    // lost or timed out: GitHub may have started it, so it is awaited, not run again
    for (const status of ['timed-out', 'lost'] as const) {
      const w = plan(withLedger(world([r], reds), [broken({ status })]))
      expect({ status, t: transitionOf(w, 26), reruns: of(w, 26).filter(a => a.kind === 'ci-rerun') }).toEqual({ status, t: undefined, reruns: [] })
      expect(said(w, 26)).toEqual(['merge queue: CI runs on aaaaaaa (0 of 1 checks done)'])
    }
    // one GitHub never took: the wait is bounded, unknown (github-wait), never ci-red
    const old = { ...red, completedAt: NOW - 14 * MIN }
    const never = plan(withLedger(world([r], [view(r, { checks: [old] })]), [broken({ status: 'lost', startedAt: NOW - 12 * MIN, endedAt: NOW - 12 * MIN + 5000 })]))
    expect(transitionOf(never, 26)).toMatchObject({ row: 'U2', event: 'unknown', via: 'unknown:github-wait' })
    // a failed call GitHub took anyway: a check of the run ended since, so its result counts
    const took = plan(withLedger(world([r], [view(r, { checks: [{ ...red, completedAt: NOW - MIN }] })]), [broken({})]))
    expect(of(took, 26).filter(a => a.kind === 'ci-rerun')).toEqual([])
    expect(transitionOf(took, 26)).toMatchObject({ row: 'T9', via: 'fix:ci' })
    // inside its backoff it waits, and says so
    const soon = plan(withLedger(world([r], reds), [broken({ endedAt: NOW - 30_000 })]))
    expect(transitionOf(soon, 26)).toBeUndefined()
    expect(of(soon, 26).filter(a => a.kind === 'ci-rerun')).toEqual([])
    expect(said(soon, 26)).toContain('merge queue: the re-run of run 9001 runs again after its backoff')
    // used up: unknown (cli), triggered by the re-run's entry, never ci-red
    const spent = broken({ attempts: RERUN_ATTEMPTS })
    expect(transitionOf(plan(withLedger(world([r], reds), [spent])), 26)).toMatchObject({ row: 'U2', event: 'unknown', via: 'unknown:cli', trigger: { kind: 'entry', key: spent.key } })
  })

  test('GitHub\'s own refusal of the re-run counts the check failed at once, named in the fixer\'s notes; a run with a job still going is not re-run until it finishes', () => {
    const r = rec(29)
    const red = check({ name: 'ci', bucket: 'fail', state: 'FAILURE', completedAt: NOW - 5 * MIN })
    const summary = `${RERUN_REFUSED} of run 9001: run 9001 cannot be rerun; its workflow file may be broken`
    const no = entry(rerunKey(r, 1, '9001'), 'ci-rerun', { issue: 29, status: 'failed', attempts: 1, maxAttempts: RERUN_ATTEMPTS, summary, startedAt: NOW - 4 * MIN, endedAt: NOW - 4 * MIN + 5000 })
    const refused = plan(withLedger(world([r], [view(r, { checks: [red] })]), [no]))
    expect(of(refused, 29).filter(a => a.kind === 'ci-rerun')).toEqual([])
    expect(transitionOf(refused, 29)).toMatchObject({ row: 'T9', via: 'fix:ci', next: { state: 'fixing', notes: [`check ci failed, and GitHub refused its one re-run (${summary}): ${red.link}`] } })
    // a job of the failed check's run still going: GitHub would refuse the re-run, so it waits
    const going = check({ name: 'lint', bucket: 'pending', state: 'IN_PROGRESS', completedAt: null })
    const busy = plan(world([r], [view(r, { checks: [red, going] })]))
    expect(transitionOf(busy, 29)).toBeUndefined()
    expect(of(busy, 29).filter(a => a.kind === 'ci-rerun')).toEqual([])
    expect(said(busy, 29)).toEqual(['merge queue: CI runs on aaaaaaa (0 of 2 checks done)'])
    // once it finishes, the run gets its one re-run
    const finished = plan(world([r], [view(r, { checks: [red, { ...going, bucket: 'pass', state: 'SUCCESS', completedAt: NOW - MIN }] })]))
    expect(of(finished, 29).filter(a => a.kind === 'ci-rerun')).toEqual([expect.objectContaining({ key: rerunKey(r, 1, '9001'), runId: '9001' })])
  })

  test('waits on GitHub are bounded (4.4): a check running past ciRunMs, or nothing started ciStartMs after the latest of the head\'s sighting, its coming to the front, its last action and the last check', () => {
    const r = rec(22)
    const pending = check({ bucket: 'pending', state: 'IN_PROGRESS', startedAt: NOW - 5 * MIN, completedAt: null })
    const runs = plan(world([r], [view(r, { checks: [pending] })]))
    expect(transitionOf(runs, 22)).toBeUndefined()
    expect(said(runs, 22)).toEqual(['merge queue: CI runs on aaaaaaa (0 of 1 checks done)'])
    const long = plan(world([r], [view(r, { checks: [{ ...pending, startedAt: NOW - 31 * MIN }] })]))
    expect(transitionOf(long, 22)).toMatchObject({ row: 'U2', event: 'unknown', reason: 'U2: unknown (github-wait)', via: 'unknown:github-wait' })
    // blocked with nothing to run: unknown 10 minutes after the last check finished
    const blocked = (done: number) => plan(world([r], [view(r, { mergeable: 'blocked', checks: [check({ completedAt: NOW - done * MIN })] })]))
    expect(transitionOf(blocked(5), 22)).toBeUndefined()
    expect(said(blocked(5), 22)).toEqual(['merge queue: CI is green on aaaaaaa, and GitHub shows it blocked'])
    expect(transitionOf(blocked(11), 22)).toMatchObject({ row: 'U2', via: 'unknown:github-wait' })
    // a record that waited behind another for an hour counts from when the head before it left
    const left = entry(transitionKey({ issue: 99, life: LIFE, seq: 8 }), 'transition', { issue: 99, endedAt: NOW - 2 * MIN, outcome: { kind: 'transition', row: 'T13', event: 'ok', cause: null, from: 'merge-queue', to: 'closed', step: 'queue', stored: true, via: 'merged' } })
    const waited = { ...r, seqAt: NOW - HOUR }
    expect(transitionOf(plan(withLedger(world([waited], [view(waited, { mergeable: 'blocked', checks: [check({ completedAt: NOW - 50 * MIN })] })]), [left])), 22)).toBeUndefined()
    // a GitHub backoff holds the wait with no clock, as admission holds a step
    const backoff = plan(world([r], [view(r, { checks: [{ ...pending, startedAt: NOW - 3 * HOUR }] })], { githubBackoffUntil: NOW + 5 * MIN }))
    expect(transitionOf(backoff, 22)).toBeUndefined()
  })

  test('a head whose PR did not read waits on GitHub, bounded: unknown past ciStartMs, so the queue moves on; a rate limit that cut the reads holds it with no clock; an untrusted author is policy', () => {
    const r = rec(27)
    const next = rec(28, { seqAt: NOW - MIN })
    const failing = (seqAt: number, over: Partial<V2State['prs']> = {}) =>
      world([{ ...r, seqAt }, next], [view(next)], {}, {
        sources: { store: OK, leases: OK, prs: { ok: false, at: NOW, error: 'PR #627: gh pr checks exit 1: HTTP 502' }, interventions: OK, comments: OK },
        prs: { prs: [view(next)], main: null, unread: [{ pr: 627, issue: 27, why: 'gh pr checks exit 1: HTTP 502', untrusted: false }], ...over },
      })
    // within the bound: held, and nothing behind it is touched
    const fresh = plan(failing(NOW - 5 * MIN))
    expect(transitionOf(fresh, 27)).toBeUndefined()
    expect(said(fresh, 27)).toEqual(['merge queue: PR #627 did not read: gh pr checks exit 1: HTTP 502'])
    expect(queueActions(fresh)).toEqual([])
    // past it: unknown (github-wait), and the head goes to the back
    const stuck = plan(failing(NOW - 3 * HOUR))
    const t = transitionOf(stuck, 27)
    expect(t).toMatchObject({ row: 'U2', event: 'unknown', via: 'unknown:github-wait' })
    expect(queueOf([t?.next ?? r, next], []).map(x => x.issue)).toEqual([28, 27])
    // a PR the source left out for no reason it gives is bounded the same way
    const missing = world([{ ...r, seqAt: NOW - 3 * HOUR }], [])
    expect(transitionOf(plan(missing), 27)).toMatchObject({ row: 'U2', via: 'unknown:github-wait' })
    // a rate limit cut the reads before it: held with no clock, however long
    const cut = plan(failing(NOW - 3 * HOUR, { unread: undefined, cut: 'GitHub rate limit: no PR is read this pass' }))
    expect(transitionOf(cut, 27)).toBeUndefined()
    expect(said(cut, 27)).toEqual(['merge queue: PR #627 was not read: GitHub rate limit: no PR is read this pass'])
    // as does a GitHub backoff on a failed read
    expect(transitionOf(plan({ ...failing(NOW - 3 * HOUR), githubBackoffUntil: NOW + 5 * MIN }), 27)).toBeUndefined()
    // an untrusted author is a fact: policy parks it with the reason (T15), at once
    const untrusted = plan(failing(NOW - 5 * MIN, { unread: [{ pr: 627, issue: 27, why: 'not by a trusted author (callum-flow-issue-read exit 3)', untrusted: true }] }))
    expect(transitionOf(untrusted, 27)).toMatchObject({ row: 'T15', next: { state: 'parked', resumeTo: 'merge-queue', question: expect.stringContaining('not opened by a trusted author') } })
  })

  test('a patch id not computed holds the head, never guesses: no merge, unknown once the wait is past its bound', () => {
    const r = rec(23)
    const p = plan(world([r], [view(r, { patch: null })]))
    expect(queueActions(p)).toEqual([])
    expect(said(p, 23)).toEqual(['merge queue: the patch id of aaaaaaa is not computed'])
    const past = plan(world([{ ...r, seqAt: NOW - HOUR }], [view(r, { patch: null, checks: [check({ completedAt: NOW - HOUR })] })], {}, { heads: { [HEAD]: { pr: 623, at: NOW - HOUR } } }))
    expect(transitionOf(past, 23)).toMatchObject({ row: 'U2', via: 'unknown:github-wait' })
  })

  test('a PR a person closed, once the park was resumed, is reopened by the loop\'s ensure before anything else', () => {
    const r = rec(24, { prClosedAt: '2026-10-13T02:00:00Z' })
    const p = plan(world([r], [view(r, { state: 'closed', closedAt: '2026-10-13T02:00:00Z' })]))
    expect(transitionOf(p, 24)).toBeUndefined()
    expect(of(p, 24).filter(a => a.kind === 'pr')).toEqual([expect.objectContaining({ kind: 'pr', op: 'ensure', pr: 624, branch: 'issue-24', key: prKey(r, 'ensure') })])
    expect(queueActions(p)).toEqual([])
  })

  test('the head\'s step starts only once its entry actions are done: its transition event, its label and its merge_ready event', () => {
    const r = rec(25)
    const t = entry(transitionKey(r), 'transition', { issue: 25, outcome: { kind: 'transition', row: 'T8', event: 'ok', cause: null, from: 'reviewing', to: 'merge-queue', step: 'review', stored: true, via: 'approve' } })
    const first = plan(withLedger(world([r]), [t]))
    expect(queueActions(first)).toEqual([])
    expect(of(first, 25).map(a => (a.kind === 'event' ? `event ${a.event.state}` : a.kind))).toEqual(['event transition', 'label', 'event merge_ready'])
    expect(said(first, 25)).toContain('its transition event of seq 5 is not logged yet')
    const logged = entry(`${transitionKey(r).slice(0, -2)}/event/transition`, 'event', { issue: 25 })
    const second = plan(withLedger(world([r]), [t, logged]))
    expect(queueActions(second)).toEqual([])
    expect(said(second, 25)).toContain('its entry actions run first')
    const rest = ['label', 'event/merge_ready'].map(a => entry(`${transitionKey(r).slice(0, -2)}/${a}`, a === 'label' ? 'label' : 'event', { issue: 25 }))
    expect(queueActions(plan(withLedger(world([r]), [t, logged, ...rest])))).toEqual([expect.objectContaining({ kind: 'queue-merge' })])
  })
})

// withLedgerDone: a plan's transition taken as done, for the interventions the next pass logs.
function withLedgerDone(p: PlanResult, r: IssueRecord): PlanResult {
  const t = transitionOf(p, r.issue)
  if (t === undefined) return p
  const done = entry(t.key, 'transition', { issue: r.issue, endedAt: NOW - 1000, outcome: { kind: 'transition', row: t.row, event: t.event, cause: null, from: r.state, to: t.next.state, step: r.step, stored: true, via: t.via ?? t.row } })
  return plan(withLedger(world([t.next]), [done]))
}

// --- Q1: the update (9.2) -----------------------------------------------------------------------------------

describe('Q1: the head is updated when it is behind (v2 SPEC 9.2)', () => {
  test('a head behind main is updated, keyed by main\'s head: once per base, again when main moves', () => {
    const r = rec(30)
    const behind = [view(r, { mergeable: 'behind' })]
    const first = plan(world([r], behind))
    const update = queueActions(first)
    expect(update).toEqual([expect.objectContaining({ kind: 'queue-update', rule: 'Q1', class: 'free', pr: 630, base: MAIN, head: HEAD, maxAttempts: 1 })])
    expect(queueKeyParts(update[0]?.key ?? '')).toMatchObject({ op: 'update', sha: MAIN.slice(0, 7), seq: 5 })
    // done, and GitHub still shows it behind the same main: no second update, it waits
    const done = tried(r, 'update', { newHead: HEAD2 })
    const lag = plan(withLedger(world([r], behind), [done]))
    expect(queueActions(lag)).toEqual([])
    expect(said(lag, 30)).toEqual([`merge queue: PR #630 was updated onto ${MAIN.slice(0, 7)}; waits for GitHub to show its new head`])
    // an outside merge moved main: one more update, under the new base
    const moved = plan(withLedger(world([r], behind, {}, { prs: { prs: behind, main: { branch: 'main', sha: MAIN2 } } }), [done]))
    expect(queueActions(moved)).toEqual([expect.objectContaining({ kind: 'queue-update', base: MAIN2 })])
    // the updated head, clean and green, merges: its patch is unchanged
    const merged = plan(withLedger(world([r], [view(r, { head: HEAD2 })]), [done]))
    expect(queueActions(merged)).toEqual([expect.objectContaining({ kind: 'queue-merge', head: HEAD2, patch: PATCH })])
  })

  test('an update that conflicts goes to a fixer; one that failed otherwise is unknown, unless GitHub applied it after all', () => {
    const r = rec(31)
    const behind = [view(r, { mergeable: 'behind' })]
    const conflict = tried(r, 'update', { failClass: 'conflict', lines: ['cannot update PR branch due to conflicts'] })
    expect(transitionOf(plan(withLedger(world([r], behind), [conflict])), 31)).toMatchObject({ row: 'T9', via: 'fix:conflict', next: { state: 'fixing' } })
    const stuck = tried(r, 'update', { status: 'failed', lines: ['the head did not move'] })
    expect(transitionOf(plan(withLedger(world([r], behind), [stuck])), 31)).toMatchObject({ row: 'U2', via: 'unknown:cli' })
    expect(transitionOf(plan(withLedger(world([r], [view(r, { head: HEAD2 })]), [stuck])), 31)).toBeUndefined()
  })

  test('main\'s head not read holds the update, bounded like any wait', () => {
    const r = rec(32)
    const p = plan(world([r], [view(r, { mergeable: 'behind' })], {}, { prs: { prs: [view(r, { mergeable: 'behind' })], main: null } }))
    expect(queueActions(p)).toEqual([])
    expect(said(p, 32)).toEqual(['merge queue: PR #632 is behind, and main\'s head on origin is not read'])
  })
})

// --- the properties (17.1: 8, 9, 14) ---------------------------------------------------------------------------

// A small deterministic generator, so a failing case is reproducible.
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}
const pick = <T,>(g: () => number, xs: readonly T[]): T => xs[Math.floor(g() * xs.length)] as T

// queueWorld: a generated queue of merge-queue records with PRs in any state.
function queueWorld(g: () => number): State {
  const n = 1 + Math.floor(g() * 4)
  const records: IssueRecord[] = []
  const prs: PrView[] = []
  for (let i = 0; i < n; i++) {
    // each came into the queue before this pass
    const r = rec(40 + i, { seqAt: NOW - (1 + Math.floor(g() * 60)) * MIN, step: g() < 0.15 ? 'triage' : 'queue', triages: 1 })
    records.push(r)
    const bucket = pick(g, ['pass', 'pass', 'fail', 'pending', 'cancel'] as const)
    prs.push(
      view(r, {
        head: pick(g, [HEAD, HEAD2]),
        mergeable: pick(g, ['clean', 'behind', 'dirty', 'blocked', 'unknown', 'unstable', null]),
        patch: pick(g, [PATCH, PATCH, OTHER_PATCH, null]),
        checks: g() < 0.1 ? [] : [check({ bucket, completedAt: bucket === 'pending' ? null : NOW - Math.floor(g() * 30) * MIN })],
      }),
    )
  }
  const paused = records.filter(() => g() < 0.1).map(r => r.issue)
  return world(records, prs, { control: control({ paused }) })
}

describe('the queue\'s properties (v2 SPEC 17.1: 8, 9, 14)', () => {
  test('property 8, head only: no plan updates or merges a record that is not the head, and only the head\'s own PR; no action closes a PR or makes a branch', () => {
    const g = rng(8)
    for (let i = 0; i < 300; i++) {
      const s = queueWorld(g)
      const p = plan(s)
      const head = queueOf(s.v2?.records ?? [], s.control.paused)[0]
      for (const a of queueActions(p)) expect({ i, issue: a.issue, pr: a.pr }).toEqual({ i, issue: head?.issue, pr: head?.pr })
      const touched = p.actions.filter(a => a.kind === 'queue-update' || a.kind === 'queue-merge' || a.kind === 'ci-rerun' || a.kind === 'pr')
      for (const a of touched) expect({ i, issue: a.issue }).toEqual({ i, issue: head?.issue })
      for (const a of p.actions) if (a.kind === 'pr') expect(a.branch).toBe(`issue-${a.issue}`)
    }
  })

  test('property 9, patch-keyed approval: Q2 never plans a merge when the head\'s patch is not the approved one', () => {
    const g = rng(9)
    let merges = 0
    for (let i = 0; i < 300; i++) {
      const s = queueWorld(g)
      for (const a of plan(s).actions) {
        if (a.kind !== 'queue-merge') continue
        merges += 1
        const pv = s.v2?.prs.prs.find(v => v.pr === a.pr)
        const r = s.v2?.records.find(x => x.issue === a.issue)
        expect({ i, patch: pv?.patch, head: pv?.head }).toEqual({ i, patch: r?.approvedPatch, head: a.head })
        expect(a.patch).toBe(r?.approvedPatch)
      }
    }
    expect(merges).toBeGreaterThan(10)
  })

  test('property 14, the queue moves: a head whose step ends other than ok is not the head on the next pass while another record waits', () => {
    const g = rng(14)
    let moved = 0
    for (let i = 0; i < 300; i++) {
      const s = queueWorld(g)
      const records = s.v2?.records ?? []
      const queue = queueOf(records, s.control.paused)
      const head = queue[0]
      if (head === undefined || queue.length < 2) continue
      const t = transitionOf(plan(s), head.issue)
      if (t === undefined || t.row === 'T13') continue
      moved += 1
      const after = records.map(r => (r.issue === head.issue ? t.next : r))
      expect({ i, row: t.row, head: queueOf(after, s.control.paused)[0]?.issue === head.issue }).toEqual({ i, row: t.row, head: false })
    }
    expect(moved).toBeGreaterThan(10)
  })

  test('a happy path logs no intervention: the update and the merge are the queue\'s planned work; a changed patch and a conflict are interventions', () => {
    const r = rec(50)
    const update = tried(r, 'update', { newHead: HEAD2 })
    const merged = tried(r, 'merge', { head: HEAD2, merged: true })
    const s = withLedger(world([r], [view(r, { head: HEAD2 })], {}, { heads: { [HEAD2]: { pr: 650, at: NOW - 2 * MIN } } }), [update, merged])
    const p = plan(s)
    expect(transitionOf(p, 50)).toMatchObject({ row: 'T13' })
    expect(ivs(p, 50)).toEqual([])
    const closed = withLedgerDone(p, r)
    expect(ivs(closed, 50)).toEqual([])
    const patch = withLedgerDone(plan(world([r], [view(r, { patch: OTHER_PATCH })])), r)
    expect(ivs(patch, 50)).toEqual(['loop queue:patch'])
    const conflict = withLedgerDone(plan(world([r], [view(r, { mergeable: 'dirty' })])), r)
    expect(ivs(conflict, 50)).toEqual(['loop fix:conflict'])
    expect(interventionKey('x')).toBe('iv/x')
  })
})

// --- the executors (act-queue.ts) ---------------------------------------------------------------------------

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

type Reply = Partial<RunResult>

// actWorld: an act step over a recording ActIo whose clock moves `tick` per read, answering each
// command with `reply`.
function actWorld(reply: (argv: string[]) => Reply, tick = 0) {
  const argvs: string[][] = []
  let clock = NOW
  const io: ActIo = {
    now: async () => {
      clock += tick
      return clock
    },
    run: async argv => {
      argvs.push([...argv])
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
  return { argvs, run }
}

const pullJson = (over: Record<string, unknown> = {}) => JSON.stringify({ pr: { state: 'open', merged: false, head: { sha: HEAD }, user: { login: 'cbundy' }, mergeable_state: 'clean', base: { ref: 'main' }, ...over }, stripped: 0 })
const r60 = rec(60)
const UPDATE: Action = { kind: 'queue-update', key: updateKey(r60, MAIN), class: 'free', rule: 'Q1', reason: 'x', issue: 60, pr: 660, base: MAIN, head: HEAD, maxAttempts: 1 }
const MERGE: Action = { kind: 'queue-merge', key: mergeKey(r60, HEAD, 1), class: 'free', rule: 'Q2', reason: 'x', issue: 60, pr: 660, head: HEAD, patch: PATCH, maxAttempts: 1 }
const reads = (argvs: string[][]) => argvs.filter(a => a[0] === 'callum-flow-issue-read').length

describe('the executors (act-queue.ts, v2 SPEC 9.2, 9.3)', () => {
  test('queue-update: gh pr update-branch on the head\'s PR alone, then the PR read until its head moves; the new head is the outcome\'s', async () => {
    let n = 0
    const w = actWorld(argv => (argv[0] === 'callum-flow-issue-read' ? { stdout: pullJson({ head: { sha: ++n < 3 ? HEAD : HEAD2 } }) } : {}), 1000)
    expect(await w.run(UPDATE)).toEqual({ status: 'done', outcome: { kind: 'queue', op: 'update', merged: false, head: HEAD2, failClass: null, lines: [] }, summary: `PR #660 updated onto ${MAIN.slice(0, 7)}: aaaaaaa -> bbbbbbb` })
    expect(w.argvs[0]).toEqual(['gh', 'pr', 'update-branch', '660', '--repo', REPO])
    expect(w.argvs.filter(a => a[0] === 'sleep')).toEqual([['sleep', '2'], ['sleep', '2']])
    expect(reads(w.argvs)).toBe(3)
  })

  test('queue-update: a conflict is answered (done) with its class; a head that never moves fails with none, within 30 s and a bounded number of reads; up to date is done at the head; any other failure is the CLI\'s', async () => {
    const conflict = actWorld(argv => (argv[0] === 'gh' ? { exitCode: 1, stderr: 'X Cannot update PR branch due to conflicts' } : {}))
    expect(await conflict.run(UPDATE)).toMatchObject({ status: 'done', outcome: { kind: 'queue', op: 'update', head: null, failClass: 'conflict', lines: ['X Cannot update PR branch due to conflicts'] } })
    const still = actWorld(argv => (argv[0] === 'callum-flow-issue-read' ? { stdout: pullJson() } : {}), 3000)
    expect(await still.run(UPDATE)).toMatchObject({ status: 'failed', outcome: { failClass: null, head: null }, summary: expect.stringContaining('its head did not move from aaaaaaa in 30 s') })
    expect(reads(still.argvs)).toBeLessThanOrEqual(11)
    // a clock that never moves still stops reading
    const frozen = actWorld(argv => (argv[0] === 'callum-flow-issue-read' ? { stdout: pullJson() } : {}), 0)
    expect(await frozen.run(UPDATE)).toMatchObject({ status: 'failed' })
    expect(reads(frozen.argvs)).toBe(16)
    const current = actWorld(argv => (argv[0] === 'gh' ? { stderr: '✓ PR branch already up-to-date' } : {}))
    expect(await current.run(UPDATE)).toMatchObject({ status: 'done', outcome: { head: HEAD, failClass: null } })
    expect(reads(current.argvs)).toBe(0)
    const limited = actWorld(argv => (argv[0] === 'gh' ? { exitCode: 1, stderr: 'HTTP 403: API rate limit exceeded' } : {}))
    expect(await limited.run(UPDATE)).toMatchObject({ status: 'failed', rateLimited: true, outcome: { kind: 'cli', exit: 1 } })
  })

  test('queue-merge: callum-flow-merge with the approved patch; merged is done; a refusal is answered (done, not merged) with the guard\'s FAIL lines and the class that decides', async () => {
    const ok = actWorld(() => ({}))
    expect(await ok.run(MERGE)).toMatchObject({ status: 'done', outcome: { kind: 'queue', op: 'merge', merged: true, head: HEAD, failClass: null } })
    expect(ok.argvs).toEqual([['callum-flow-merge', '660', '--patch', PATCH]])
    const lines = ['GUARD checks FAIL ci=pending class=checks', 'GUARD mergeable FAIL behind main class=behind', 'GUARD author FAIL PR #660 was not opened by a trusted author class=policy']
    const refused = actWorld(argv => (argv[0] === 'callum-flow-merge' ? { exitCode: 1, stdout: `GUARD test-weakening WARN abc1234 step=x\n${lines.join('\n')}\n` } : {}))
    expect(await refused.run(MERGE)).toMatchObject({ status: 'done', outcome: { kind: 'queue', op: 'merge', merged: false, head: HEAD, failClass: 'policy', lines } })
    // the refusal's lines are read, never the PR: nothing merged
    expect(reads(refused.argvs)).toBe(0)
  })

  test('queue-merge: a refusal after the guard passed names its merge state; one with no reason, or a merge cut off, is read back from the PR; exit 2 is a usage error', async () => {
    const behind = actWorld(argv => (argv[0] === 'callum-flow-merge' ? { exitCode: 1, stderr: 'callum-flow-merge: GitHub refused: merge state BEHIND (branch rule) - see the guard\'s mergeable action' } : {}))
    expect(await behind.run(MERGE)).toMatchObject({ status: 'done', outcome: { merged: false, failClass: 'behind' } })
    const mergedAnyway = actWorld(argv => (argv[0] === 'callum-flow-merge' ? { exitCode: 1, stderr: 'GitHub refused the merge' } : argv[0] === 'callum-flow-issue-read' ? { stdout: pullJson({ state: 'closed', merged: true }) } : {}))
    expect(await mergedAnyway.run(MERGE)).toMatchObject({ status: 'done', outcome: { merged: true, head: HEAD } })
    const notMerged = actWorld(argv => (argv[0] === 'callum-flow-merge' ? { exitCode: 1, stderr: 'GitHub refused the merge' } : argv[0] === 'callum-flow-issue-read' ? { stdout: pullJson() } : {}))
    expect(await notMerged.run(MERGE)).toMatchObject({ status: 'failed', outcome: { failClass: null, merged: false, lines: ['GitHub refused the merge'] } })
    const usage = actWorld(argv => (argv[0] === 'callum-flow-merge' ? { exitCode: 2, stderr: 'callum-flow-merge-guard: unknown option \'--patch\'' } : {}))
    expect(await usage.run(MERGE)).toMatchObject({ status: 'failed', noRetry: true })
  })

  test('queue-merge: the class is read from the whole FAIL lines, before the outcome caps them: a long line, and a FAIL after the twentieth line, keep their class', async () => {
    const warns = Array.from({ length: 25 }, (_, i) => `GUARD test-weakening WARN abc${i} step=x`)
    const long = `GUARD checks FAIL ${Array.from({ length: 80 }, (_, i) => `check-${i}=fail`).join(' ')} class=checks`
    const late = 'GUARD patch FAIL head x has patch y, not the approved z class=patch'
    const w = actWorld(argv => (argv[0] === 'callum-flow-merge' ? { exitCode: 1, stdout: `${warns.join('\n')}\n${long}\n${late}\n` } : {}))
    const out = await w.run(MERGE)
    expect(out).toMatchObject({ status: 'done', outcome: { merged: false, failClass: 'patch' } })
    const kept = out.status === 'done' && out.outcome?.kind === 'queue' ? out.outcome.lines : []
    expect(kept).toHaveLength(2)
    expect(kept[0]?.length).toBe(500)
    expect(kept[1]).toBe(late)
    expect(reads(w.argvs)).toBe(0)
    expect(failLines(`${warns.join('\n')}\n${long}\n`)).toEqual([long])
    expect(failClassOf([long])).toBe('checks')
  })

  test('the breaker: refusals with a class are answers, so three in a row across the factory never open the executor breaker; three failed commands do', async () => {
    const answers: LedgerEntry[] = []
    const cases = ['GUARD linkage FAIL MISMATCH class=linkage', 'GUARD linkage FAIL MISMATCH class=linkage', 'GUARD mergeable FAIL behind main class=behind']
    for (const [i, line] of cases.entries()) {
      const w = actWorld(argv => (argv[0] === 'callum-flow-merge' ? { exitCode: 1, stdout: `${line}\n` } : {}))
      const out = await w.run(MERGE)
      expect(out.status).toBe('done')
      answers.push(entry(`${MERGE.key}/${i}`, 'queue-merge', { issue: 60 + i, status: 'done', startedAt: NOW - (5 - i) * MIN, endedAt: NOW - (4 - i) * MIN, outcome: out.status === 'done' ? out.outcome : undefined }))
    }
    const conflict = await actWorld(argv => (argv[0] === 'gh' ? { exitCode: 1, stderr: 'X Cannot update PR branch due to conflicts' } : {})).run(UPDATE)
    expect(conflict.status).toBe('done')
    const updates = [0, 1, 2].map(i => entry(`${UPDATE.key}/${i}`, 'queue-update', { issue: 70 + i, status: 'done', startedAt: NOW - (5 - i) * MIN, endedAt: NOW - (4 - i) * MIN, outcome: conflict.status === 'done' ? conflict.outcome : undefined }))
    const s = baseState({ ledger: [...answers, ...updates] })
    expect(executorBreaker(s, 'queue-merge')).toBeNull()
    expect(executorBreaker(s, 'queue-update')).toBeNull()
    // a refusal is never the loop's merge, so GitHub's merge after it is a hand merge
    const r = rec(17)
    const refused = tried(r, 'merge', refusal(['GUARD checks FAIL ci=pending class=checks'], 'checks'))
    const hand = plan(withLedger(world([r], [view(r, { state: 'merged', mergedHead: HEAD })]), [refused]))
    expect(transitionOf(hand, 17)).toMatchObject({ event: 'pr-merged' })
    // three unclassified failures are a broken executor
    const broken = [0, 1, 2].map(i => ({ ...answers[i], status: 'failed' as const }) as LedgerEntry)
    expect(executorBreaker(baseState({ ledger: broken }), 'queue-merge')).not.toBeNull()
  })

  test('the classes: the guard\'s FAIL lines by their class token, the one that decides first; a merge state from a refusal', () => {
    expect(failClassOf(['GUARD checks FAIL ci=fail class=checks', 'GUARD mergeable FAIL conflicts with main class=conflict'])).toBe('conflict')
    expect(failClassOf(['GUARD author FAIL cannot verify class=read', 'GUARD checks FAIL x class=checks'])).toBe('checks')
    expect(failClassOf(['GUARD patch FAIL head x class=patch', 'GUARD linkage FAIL MISMATCH class=linkage'])).toBe('patch')
    expect(failClassOf(['GUARD head FAIL run=x (no class)', 'GUARD x FAIL y class=bogus'])).toBeNull()
    expect(refusalClass('GitHub refused: merge state DIRTY (branch rule)')).toBe('conflict')
    expect(refusalClass('head moved since the check')).toBeNull()
  })

  test('property 8 for the executors: no argv rebases, force-pushes or closes a PR, and every gh call names the repo', async () => {
    const all: string[][] = []
    for (const reply of [() => ({}), (a: string[]) => (a[0] === 'callum-flow-issue-read' ? { stdout: pullJson({ head: { sha: HEAD2 } }) } : {})]) {
      for (const action of [UPDATE, MERGE]) {
        const w = actWorld(reply, 1000)
        await w.run(action)
        all.push(...w.argvs)
      }
    }
    for (const argv of all) {
      expect(argv.some(a => /^--(rebase|force|force-with-lease)$/.test(a) || a === 'close')).toBe(false)
      if (argv[0] === 'gh') expect(argv.slice(argv.indexOf('--repo'), argv.indexOf('--repo') + 2)).toEqual(['--repo', REPO])
    }
  })
})

// --- the prs source (sources-prs.ts) ------------------------------------------------------------------------

// sourceCtx: what observeV2 gives the source, over a fake run.
function sourceCtx(records: IssueRecord[], reply: (argv: string[]) => Reply, over: Partial<SourceCtx> = {}): { ctx: SourceCtx; argvs: string[][] } {
  const argvs: string[][] = []
  const ctx: SourceCtx = {
    now: NOW,
    rt: runtime(),
    run: async argv => {
      argvs.push([...argv])
      return { exitCode: 0, stdout: '', stderr: '', ...reply(argv) }
    },
    readFile: async () => null,
    state: baseState(),
    records,
    heads: {},
    prBudget: 3,
    limited: () => false,
    ...over,
  }
  return { ctx, argvs }
}

const CHECKS_JSON = JSON.stringify([
  { name: 'ci', state: 'SUCCESS', bucket: 'pass', startedAt: '2026-10-13T02:40:00Z', completedAt: '2026-10-13T02:43:00Z', link: 'https://github.com/cbundy/dev-system/actions/runs/123/job/9' },
  { name: 'image', state: 'QUEUED', bucket: 'pending', startedAt: '0001-01-01T00:00:00Z', completedAt: '0001-01-01T00:00:00Z', link: '' },
])

function prReply(heads: Record<string, string>, extra: (argv: string[]) => Reply | undefined = () => undefined) {
  return (argv: string[]): Reply => {
    const own = extra(argv)
    if (own !== undefined) return own
    if (argv[0] === 'callum-flow-issue-read') return { stdout: pullJson({ head: { sha: heads[argv[3] ?? ''] ?? HEAD }, mergeable_state: 'behind' }) }
    if (argv[0] === 'gh' && argv[2] === 'checks') return { exitCode: 8, stdout: CHECKS_JSON }
    if (argv[0] === 'callum-flow-patch-id') return { stdout: `${PATCH}\n` }
    if (argv[0] === 'git') return { stdout: `${MAIN}\trefs/heads/main\n` }
    return {}
  }
}

describe('the prs source (sources-prs.ts, v2 SPEC 2.4)', () => {
  test('the queue\'s head first, then reviewing and the queue, at most the budget; each PR, its checks, its patch id against the default branch, and main\'s head when a queue PR is behind', async () => {
    const records = [
      rec(70, { state: 'reviewing', step: 'review', seqAt: NOW - 50 * MIN }),
      rec(71, { seqAt: NOW - 10 * MIN }),
      rec(72, { state: 'building', step: 'build' }),
      rec(73, { state: 'parked', step: null }),
      rec(74, { state: 'reviewing', step: 'review', seqAt: NOW - 40 * MIN }),
    ]
    const heads = { '670': sha('1'), '671': sha('2'), '674': sha('3') }
    const { ctx, argvs } = sourceCtx(records, prReply(heads))
    const r = await readPrs(ctx)
    expect(r.source).toEqual({ ok: true, at: NOW })
    expect(r.read.prs.map(v => v.pr)).toEqual([671, 670, 674])
    expect(argvs.filter(a => a[0] === 'callum-flow-issue-read')).toEqual([671, 670, 674].map(n => ['callum-flow-issue-read', '--json', '--pr', String(n)]))
    expect(argvs).toContainEqual(['gh', 'pr', 'checks', '671', '--repo', REPO, '--json', 'name,state,bucket,startedAt,completedAt,link'])
    expect(argvs).toContainEqual(['callum-flow-patch-id', sha('2'), 'main'])
    expect(argvs.filter(a => a[0] === 'git')).toEqual([['git', 'ls-remote', 'origin', 'refs/heads/main']])
    expect(r.read.main).toEqual({ branch: 'main', sha: MAIN })
    expect(r.read.prs[0]).toEqual({
      pr: 671,
      issue: 71,
      state: 'open',
      head: sha('2'),
      mergedHead: null,
      closedAt: null,
      mergeable: 'behind',
      author: 'cbundy',
      checks: [
        { name: 'ci', state: 'SUCCESS', bucket: 'pass', startedAt: Date.parse('2026-10-13T02:40:00Z'), completedAt: Date.parse('2026-10-13T02:43:00Z'), runId: '123', link: 'https://github.com/cbundy/dev-system/actions/runs/123/job/9' },
        { name: 'image', state: 'QUEUED', bucket: 'pending', startedAt: null, completedAt: null, runId: null, link: null },
      ],
      patch: PATCH,
      readAt: NOW,
    })
    // heads first seen now; a budget of one reads the head's PR alone
    expect(r.heads).toEqual({ [sha('1')]: { pr: 670, at: NOW }, [sha('2')]: { pr: 671, at: NOW }, [sha('3')]: { pr: 674, at: NOW } })
    const one = sourceCtx(records, prReply(heads), { prBudget: 1 })
    expect((await readPrs(one.ctx)).read.prs.map(v => v.pr)).toEqual([671])
  })

  test('a head\'s patch id is computed once, and again when the head moves; one that does not compute is null and named', async () => {
    const r = rec(75, { state: 'reviewing', step: 'review' })
    const head = { '675': sha('4') }
    const first = sourceCtx([r], prReply(head))
    await readPrs(first.ctx)
    const kept = sourceCtx([r], prReply(head), { heads: { [sha('4')]: { pr: 675, at: NOW - MIN } } })
    expect((await readPrs(kept.ctx)).read.prs[0]?.patch).toBe(PATCH)
    expect(kept.argvs.filter(a => a[0] === 'callum-flow-patch-id')).toEqual([])
    const moved = sourceCtx([r], prReply({ '675': sha('5') }, a => (a[0] === 'callum-flow-patch-id' ? { exitCode: 1, stderr: 'callum-flow-patch-id: no merge base between origin/main and x' } : undefined)))
    const out = await readPrs(moved.ctx)
    expect(out.read.prs[0]?.patch).toBeNull()
    expect(out.source).toMatchObject({ ok: false, error: expect.stringContaining('the patch id of PR #675 at 5555555 did not compute: callum-flow-patch-id: no merge base') })
  })

  test('a closed or merged PR is read without its checks; heads go when their PR closes or their record does', async () => {
    const r = rec(76)
    const merged = sourceCtx([r], prReply({}, a => (a[0] === 'callum-flow-issue-read' ? { stdout: pullJson({ state: 'closed', merged: true, closed_at: '2026-10-13T02:59:00Z' }) } : undefined)), {
      heads: { [HEAD]: { pr: 676, at: NOW - HOUR }, [HEAD2]: { pr: 999, at: NOW - HOUR } },
    })
    const out = await readPrs(merged.ctx)
    expect(out.read.prs[0]).toMatchObject({ state: 'merged', mergedHead: HEAD, closedAt: '2026-10-13T02:59:00Z', checks: [], patch: null })
    expect(merged.argvs.map(a => a[0])).toEqual(['callum-flow-issue-read'])
    // the merged PR's head goes; one no record names stays
    expect(out.heads).toEqual({ [HEAD2]: { pr: 999, at: NOW - HOUR } })
    expect(headsOf({ [HEAD]: { pr: 676, at: 1 } }, [r], [], NOW)).toEqual({ [HEAD]: { pr: 676, at: 1 } })
    expect(headsOf({ [HEAD]: { pr: 676, at: 1 } }, [{ ...r, state: 'closed' }], [], NOW)).toEqual({})
    // records not read (none at all): no head is forgotten
    expect(headsOf({ [HEAD]: { pr: 676, at: 1 } }, [], [], NOW)).toEqual({ [HEAD]: { pr: 676, at: 1 } })
  })

  test('nothing is read with no budget or after a rate limit; a PR that does not read is left out and named; an untrusted author too', async () => {
    const records = [rec(77), rec(78, { seqAt: NOW - HOUR })]
    const none = sourceCtx(records, prReply({}), { prBudget: 0 })
    expect(await readPrs(none.ctx)).toMatchObject({ read: { prs: [] }, source: { ok: false, error: 'GitHub rate limit: no PR is read this pass' } })
    expect(none.argvs).toEqual([])
    const limited = sourceCtx(records, prReply({}), { limited: () => true })
    expect((await readPrs(limited.ctx)).read.prs).toEqual([])
    expect(limited.argvs).toEqual([])
    const bad = sourceCtx(records, prReply({}, a => (a[0] === 'callum-flow-issue-read' && a[3] === '678' ? { exitCode: 3 } : undefined)))
    const out = await readPrs(bad.ctx)
    expect(out.read.prs.map(v => v.pr)).toEqual([677])
    expect(out.source).toMatchObject({ ok: false, error: expect.stringContaining('PR #678: not by a trusted author') })
    // no record in reviewing or the queue: nothing to read, and nothing wrong
    expect((await readPrs(sourceCtx([rec(79, { state: 'fixing', step: 'fix' })], prReply({})).ctx)).source).toEqual({ ok: true, at: NOW })
  })

  test('the parsers: the REST pull and gh pr checks, whose exit 8 and 1 still carry the list; no checks yet is an empty list', () => {
    expect(pullOf(pullJson({ state: 'closed', merged: false, closed_at: 'T' }))).toMatchObject({ state: 'closed', mergedHead: null, closedAt: 'T', base: 'main' })
    expect(pullOf(JSON.stringify({ comments: [] }))).toBeNull()
    expect(pullOf('not json')).toBeNull()
    expect(checksOf({ exitCode: 1, stdout: '', stderr: 'no checks reported on the \'issue-7\' branch' })).toEqual([])
    expect(checksOf({ exitCode: 1, stdout: '', stderr: 'HTTP 502' })).toBeNull()
    expect(checksOf({ exitCode: 1, stdout: JSON.stringify([{ name: 'ci', bucket: 'fail', link: 'https://x/actions/runs/77/job/1' }]), stderr: '' })).toEqual([
      { name: 'ci', state: '', bucket: 'fail', startedAt: null, completedAt: null, runId: '77', link: 'https://x/actions/runs/77/job/1' },
    ])
  })
})
