// The merge train (docs/factory-loop/v2/SPEC.md 9.8, rules Q3 and the train merge of Q2): the rules
// (rules-train.ts, driven through planV2 itself), the executors (act-train.ts, and the flags of
// act-queue.ts's merge) over a fake command runner, the train source (sources-train.ts) and the keys.
// Real git is out of reach of the plugin test host (a hooks module imports no node module), so the
// executors' commands are checked here as argv against a fake that answers as git does; the same
// executors run against real git and a local bare origin in tests/factory-loop-train.test.js.
import { describe, expect, test } from 'claude-code/testing'

import { ctxOf, dispatch } from '../hooks/act'
import type { ActEnv } from '../hooks/act'
import type { ActIo, RunInit, RunResult } from '../hooks/exec'
import { start } from '../hooks/ledger'
import type { Runtime } from '../hooks/observe'
import type { Action, LedgerEntry, PlanResult, State } from '../hooks/types'
import { trainDropOf } from '../hooks/v2/act-queue'
import * as ARGV from '../hooks/v2/argv'
import { trainDeleteKey, trainKey, trainKeyParts, trainSweepKey } from '../hooks/v2/keys'
import { emptyV2State } from '../hooks/v2/observe'
import type { SourceCtx } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { queueOf } from '../hooks/v2/rules-queue'
import { SWEEP_MS, trainsOf } from '../hooks/v2/rules-train'
import type { CheckRun, PrView } from '../hooks/v2/sources-prs'
import { checkRunsOf, readTrain, treeOf } from '../hooks/v2/sources-train'
import { mergeKey, updateKey } from '../hooks/v2/steps-queue'
import { EMPTY_TRAIN, TRAIN_DROPS, TRAIN_PREFIX } from '../hooks/v2/train-types'
import type { TrainDrop, TrainOutcome, TrainRead } from '../hooks/v2/train-types'
import { madeRecord } from '../hooks/v2/table'
import { DONT_MERGE_LABEL, SLOT_STATES } from '../hooks/v2/types'
import type { IssueRecord, Lease, V2State } from '../hooks/v2/types'
import { lifeOf } from '../hooks/v2/keys'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, entry, state as baseState } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const HOUR = 60 * MIN
const OFF = config({ mode: 'act', maxInFlightIssues: 4 })
const ON = config({ mode: 'act', maxInFlightIssues: 4, mergeTrain: true })
const LIFE = lifeOf(NOW - 2 * HOUR)
const sha = (c: string) => c.repeat(40)
const HH = sha('1') // the head's updated commit H'
const NH = sha('2') // the next record's head N
const NH2 = sha('3') // N after a push
const MAIN = sha('d')
const MAIN2 = sha('f') // main after the head's merge
const PATCH = sha('c')
const OTHER_PATCH = sha('e')
const TREE_H = sha('7') // the tree of H', and of main once the head merged
const TREE_T = sha('8') // the tree of the train: merge-tree(H', N)
const TREE_OTHER = sha('6')
const TS = sha('9') // the train commit

function rec(n: number, over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    ...madeRecord({ issue: n, life: LIFE, branch: `issue-${n}`, pr: null, others: [] }, NOW - HOUR),
    seq: 5,
    seqAt: NOW - (40 - 10 * n) * MIN,
    since: NOW - 20 * MIN,
    state: 'merge-queue',
    step: 'queue',
    pr: 600 + n,
    head: sha('a'),
    approvedPatch: PATCH,
    round: 1,
    ...over,
  }
}
const H = rec(1)
const N = rec(2)
const T3 = rec(3)

const leaseFor = (r: Pick<IssueRecord, 'issue' | 'life'>): Lease => ({ path: `/slots/${r.issue}`, lease: `L${r.issue}`, holder: `factory-loop:${r.issue}:${r.life}`, issue: r.issue, life: r.life, status: 'leased', busy: false })
const green = (over: Partial<CheckRun> = {}): CheckRun => ({ name: 'ci', state: 'SUCCESS', bucket: 'pass', startedAt: NOW - 5 * MIN, completedAt: NOW - 2 * MIN, runId: '9001', link: `https://github.com/${REPO}/actions/runs/9001/job/1`, ...over })
const running = (): CheckRun => green({ state: 'IN_PROGRESS', bucket: 'pending', completedAt: null })
const red = (): CheckRun => green({ state: 'FAILURE', bucket: 'fail', runId: null })
const OK = { ok: true, at: NOW }

function view(r: IssueRecord, over: Partial<PrView> = {}): PrView {
  return { pr: r.pr ?? 0, issue: r.issue, state: 'open', head: sha('a'), mergedHead: null, closedAt: null, mergeable: 'clean', author: 'cbundy', base: MAIN, baseRef: 'main', labels: [], checks: [green()], patch: PATCH, readAt: NOW, ...over }
}

function trainRead(checks: TrainRead['checks'] = {}, trees: TrainRead['trees'] = {}): TrainRead {
  return { checks, trees, at: NOW, source: OK }
}

function world(records: IssueRecord[], prs: PrView[], over: Partial<State> = {}, v2: Partial<V2State> = {}, main = MAIN): State {
  const s = baseState(over)
  const heads = Object.fromEntries(prs.flatMap(p => (p.head === null ? [] : [[p.head, { pr: p.pr, at: NOW - 15 * MIN }]])))
  return {
    ...s,
    v2: {
      ...emptyV2State(NOW, records),
      sources: { store: OK, leases: OK, prs: OK, interventions: OK, comments: OK, dualWrite: OK },
      leases: records.filter(r => SLOT_STATES.includes(r.state)).map(leaseFor),
      prs: { prs, main: { branch: 'main', sha: main } },
      heads,
      reads: Object.fromEntries(records.map(r => [r.issue, { at: NOW, open: true, labels: [] as string[] }])),
      ...v2,
    },
  }
}
const withLedger = (s: State, extra: LedgerEntry[]): State => ({ ...s, ledger: [...s.ledger, ...extra] })
const plan = (s: State, cfg = ON): PlanResult => planV2(s, cfg)
const trainActions = (p: PlanResult) => p.actions.filter((a): a is Extract<Action, { kind: 'queue-train' }> => a.kind === 'queue-train')
const builds = (p: PlanResult) => trainActions(p).filter(a => a.op === 'build')
const deletes = (p: PlanResult) => trainActions(p).flatMap(a => (a.op === 'delete' ? [a] : []))
const sweeps = (p: PlanResult) => trainActions(p).flatMap(a => (a.op === 'sweep' ? [a] : []))
const queueActions = (p: PlanResult) => p.actions.filter((a): a is Extract<Action, { kind: 'queue-update' | 'queue-merge' }> => a.kind === 'queue-update' || a.kind === 'queue-merge')
const merges = (p: PlanResult) => p.actions.filter((a): a is Extract<Action, { kind: 'queue-merge' }> => a.kind === 'queue-merge')
const said = (p: PlanResult, n: number) => p.skipped.filter(s => s.issue === n).map(s => s.why)
const transitionOf = (p: PlanResult, n: number) => p.actions.find((a): a is Extract<Action, { kind: 'transition' }> => a.kind === 'transition' && a.issue === n)

// --- the facts a train rests on --------------------------------------------------------------------------------

// updated: the head's queue-update of its seq, which produced H'.
const updated = (r: IssueRecord = H): LedgerEntry =>
  entry(updateKey(r, MAIN), 'queue-update', {
    issue: r.issue,
    pr: r.pr,
    head: sha('a'),
    startedAt: NOW - 12 * MIN,
    endedAt: NOW - 11 * MIN,
    outcome: { kind: 'queue', op: 'update', merged: false, head: HH, failClass: null, lines: [] },
  })

const BRANCH = (n: IssueRecord) => `${TRAIN_PREFIX}i${n.issue}-${TREE_T.slice(0, 7)}`
const buildKey = (n: IssueRecord = N) => trainKey(n, HH, NH, MAIN)

// built: the done build of the train for N, its commit pushed.
function built(n: IssueRecord = N, over: Partial<Extract<TrainOutcome, { op: 'build' }>> = {}, e: Partial<LedgerEntry> = {}): LedgerEntry {
  return entry(buildKey(n), 'queue-train', {
    issue: n.issue,
    pr: n.pr,
    head: HH,
    startedAt: NOW - 6 * MIN,
    endedAt: NOW - 5 * MIN,
    outcome: { kind: 'train', op: 'build', tree: TREE_T, train: TS, branch: BRANCH(n), headIssue: 1, head: HH, rider: NH, main: MAIN, drop: null, ...over },
    ...e,
  })
}
const deleted = (end: string, n: IssueRecord = N): LedgerEntry =>
  entry(trainDeleteKey(buildKey(n), end), 'queue-train', { issue: n.issue, outcome: { kind: 'train', op: 'delete', branch: BRANCH(n), end: end as TrainDrop } })

// tried: a merge try of N that fell back from the train.
function dropped(drop: TrainDrop, k = 1, n: IssueRecord = N): LedgerEntry {
  return entry(mergeKey(n, NH, k), 'queue-merge', {
    issue: n.issue,
    pr: n.pr,
    head: NH,
    startedAt: NOW - (4 - k) * MIN,
    endedAt: NOW - (4 - k) * MIN + 30_000,
    outcome: { kind: 'queue', op: 'merge', merged: false, head: NH, failClass: null, lines: ['GUARD tree FAIL merging gives another tree class=behind'], drop },
  })
}

// While the head is in CI: H updated onto main and running, N green and behind nothing yet.
function midCi(over: { ledger?: LedgerEntry[]; hv?: Partial<PrView>; nv?: Partial<PrView>; records?: IssueRecord[]; reads?: V2State['reads'] } = {}): State {
  const records = over.records ?? [H, N]
  const prs = [view(H, { head: HH, checks: [running()], ...over.hv }), view(N, { head: NH, ...over.nv })]
  const s = world(records, prs, {}, over.reads === undefined ? {} : { reads: over.reads })
  return withLedger(s, over.ledger ?? [updated()])
}

// After the head merged: N alone, main moved to the head's merge, N still based on the old main.
function afterMerge(over: { ledger?: LedgerEntry[]; nv?: Partial<PrView>; train?: TrainRead; main?: string; records?: IssueRecord[] } = {}): State {
  const train = over.train ?? trainRead({ [TS]: [green()] }, { [MAIN2]: TREE_H, [HH]: TREE_H })
  const s = world(over.records ?? [N], [view(N, { head: NH, mergeable: 'behind', ...over.nv })], {}, { train }, over.main ?? MAIN2)
  return withLedger(s, over.ledger ?? [built()])
}

// --- the happy path ----------------------------------------------------------------------------------------------

describe('the merge train, happy path (v2 SPEC 9.8)', () => {
  test('Q3: with the head updated onto main and in CI, one build for the record behind it; neither PR is touched', () => {
    const p = plan(midCi())
    expect(builds(p)).toHaveLength(1)
    expect(builds(p)[0]).toMatchObject({
      kind: 'queue-train',
      op: 'build',
      key: buildKey(),
      class: 'free',
      rule: 'Q3',
      issue: 2,
      pr: 602,
      branch: 'issue-2',
      rider: NH,
      headIssue: 1,
      headPr: 601,
      headBranch: 'issue-1',
      head: HH,
      main: MAIN,
      maxAttempts: 1,
    })
    // the head waits for its CI, the record behind waits untouched
    expect(queueActions(p)).toEqual([])
    expect(said(p, 2)).toEqual(['merge queue: waits behind #1 (2 of 2)'])
    // a build is never beside a sweep that could remove the branch it is about to push
    expect(sweeps(p)).toEqual([])
    // and it also builds when the head's CI is already green
    expect(builds(plan(midCi({ hv: { checks: [green()] } })))).toHaveLength(1)
  })

  test('the build is planned once: the done build is its key\'s, so the next pass plans none; the live train is not rebuilt', () => {
    const p = plan(midCi({ ledger: [updated(), built()] }))
    expect(builds(p)).toEqual([])
    expect(deletes(p)).toEqual([])
    // the sweep keeps the live train's branch
    expect(sweeps(p).map(a => a.keep)).toEqual([[BRANCH(N)]])
  })

  test('Q2 for the record behind, now the head: main is the head\'s merge with the head\'s tree and the train is green, so it merges with the tested tree, no update and no CI run of its own', () => {
    const p = plan(afterMerge())
    expect(queueActions(p).map(a => [a.kind, a.issue])).toEqual([['queue-merge', 2]])
    expect(merges(p)[0]).toMatchObject({ issue: 2, pr: 602, head: NH, patch: PATCH, testedTree: TREE_T })
    expect(merges(p)[0]?.trainDropped).toBeUndefined()
    expect(merges(p)[0]?.key).toBe(mergeKey(N, NH, 1))
    expect(ARGV.queueMergeArgv(602, PATCH, 2, { testedTree: TREE_T })).toEqual(['callum-flow-merge', '602', '--patch', PATCH, '--issue', '2', '--tested-tree', TREE_T])
    expect(deletes(plan(afterMerge()))).toEqual([])
  })

  test('once the record merged on the train, the branch is deleted, and its key says it merged', () => {
    const merged = entry(mergeKey(N, NH, 1), 'queue-merge', { issue: 2, pr: 602, head: NH, outcome: { kind: 'queue', op: 'merge', merged: true, head: NH, failClass: null, lines: [] } })
    const p = plan(afterMerge({ ledger: [built(), merged] }))
    expect(deletes(p)).toEqual([expect.objectContaining({ op: 'delete', branch: BRANCH(N), end: 'merged', key: trainDeleteKey(buildKey(), 'merged'), issue: 2, rule: 'Q3', maxAttempts: 3 })])
    expect(trainKeyParts(deletes(p)[0]?.key ?? '')).toEqual({ build: buildKey(), seq: 5, end: 'merged' })
    // the delete done, the train is over: no more of it
    expect(deletes(plan(afterMerge({ ledger: [built(), merged, deleted('merged')] })))).toEqual([])
    expect(trainsOf([built(), deleted('merged')])).toEqual([])
  })

  test('waits, with no Q1, while the train\'s CI runs or its checks or the trees are not read', () => {
    const running1 = plan(afterMerge({ train: trainRead({ [TS]: [running()] }, { [MAIN2]: TREE_H, [HH]: TREE_H }) }))
    expect(queueActions(running1)).toEqual([])
    expect(said(running1, 2)).toEqual([expect.stringContaining(`CI runs on the train ${TS.slice(0, 7)}`)])
    const unreadChecks = plan(afterMerge({ train: trainRead({ [TS]: null }, { [MAIN2]: TREE_H, [HH]: TREE_H }) }))
    expect(queueActions(unreadChecks)).toEqual([])
    const unreadTrees = plan(afterMerge({ train: trainRead({ [TS]: [green()] }, {}) }))
    expect(queueActions(unreadTrees)).toEqual([])
    expect(said(unreadTrees, 2)).toEqual([expect.stringContaining('main\'s tree is not read yet')])
  })

  test('the record\'s own CI still gates the train merge: red or running checks of its own are the queue\'s as ever', () => {
    const pending = plan(afterMerge({ nv: { checks: [running()] } }))
    expect(merges(pending)).toEqual([])
    const failing = plan(afterMerge({ nv: { checks: [red()] } }))
    expect(merges(failing)).toEqual([])
    expect(transitionOf(failing, 2)).toMatchObject({ event: 'not-ok' })
  })
})

// --- Q3's conditions -------------------------------------------------------------------------------------------

describe('the build\'s conditions (Q3)', () => {
  test('nothing is built unless every condition holds', () => {
    const cases: [string, State][] = [
      ['the head was not updated by a queue-update of its seq', midCi({ ledger: [] })],
      ['the update was of an older seq', midCi({ ledger: [updated({ ...H, seq: 4 })] })],
      ['the head is not on main (its base is not main\'s head)', midCi({ hv: { base: sha('b') } })],
      ['the head\'s CI is red', midCi({ hv: { checks: [red()] } })],
      ['no check has started on the head', midCi({ hv: { checks: [] } })],
      ['the head conflicts', midCi({ hv: { mergeable: 'dirty' } })],
      ['the record\'s checks run', midCi({ nv: { checks: [running()] } })],
      ['the record\'s checks are red', midCi({ nv: { checks: [red()] } })],
      ['the record conflicts', midCi({ nv: { mergeable: 'dirty' } })],
      ['the record\'s patch is not the approved one', midCi({ nv: { patch: OTHER_PATCH } })],
      ['the record is held by the owner', midCi({ reads: { 1: { at: NOW, open: true, labels: [] }, 2: { at: NOW, open: true, labels: [DONT_MERGE_LABEL] } } })],
      ['the record behind has no PR read', world([H, N], [view(H, { head: HH, checks: [running()] })]) as State],
      ['the head is alone in the queue', midCi({ records: [H] })],
    ]
    for (const [why, s] of cases) expect({ why, builds: builds(plan(s)) }).toEqual({ why, builds: [] })
    // each case differs from the building one by that fact alone
    expect(builds(plan(midCi()))).toHaveLength(1)
  })

  test('depth 2: three approved PRs plan one train, for the second; the third gets none, while one is live or not', () => {
    const three = (ledger: LedgerEntry[]) => withLedger(world([H, N, T3], [view(H, { head: HH, checks: [running()] }), view(N, { head: NH }), view(T3, { head: sha('4') })]), ledger)
    const p = plan(three([updated()]))
    expect(builds(p).map(a => a.issue)).toEqual([2])
    expect(queueActions(p)).toEqual([])
    const live = plan(three([updated(), built()]))
    expect(builds(live)).toEqual([])
    expect(said(live, 3)).toEqual(['merge queue: waits behind #1 (3 of 3)'])
  })

  test('a train that was already tried by a merge in this seq is not built again for the record', () => {
    expect(builds(plan(midCi({ ledger: [updated(), dropped('tree-mismatch')] })))).toEqual([])
  })
})

// --- every invalidation drops the train and the record takes today's path --------------------------------------

describe('every invalidation drops the train (v2 SPEC 9.8)', () => {
  // each: the pass in which it shows, and the record's merge once it is the head on main with the delete done
  const settled = (end: string, extra: LedgerEntry[] = []): State =>
    withLedger(world([N], [view(N, { head: NH, base: MAIN2, mergeable: 'clean' })], {}, {}, MAIN2), [built(), deleted(end), ...extra])

  const cases: [TrainDrop, State, string][] = [
    ['head-moved', midCi({ ledger: [updated(), built()], nv: { head: NH2 } }), 'N pushed again'],
    ['outside-merge', world([H, N], [view(H, { head: HH, checks: [running()] }), view(N, { head: NH })], {}, { train: trainRead({ [TS]: [green()] }, { [MAIN2]: TREE_OTHER, [HH]: TREE_H }) }, MAIN2), 'main moved to another tree'],
    ['train-red', withLedger(midCi({ ledger: [] }), [updated(), built()]), 'red train CI'],
    ['left-queue', withLedger(world([{ ...H, state: 'parked', step: null }, N], [view(N, { head: NH })]), [updated(), built()]), 'the head left the queue'],
    ['tree-mismatch', afterMerge({ ledger: [built(), dropped('tree-mismatch')], nv: { mergeable: 'behind' } }), 'a GUARD tree FAIL'],
    ['refused', afterMerge({ ledger: [built(), dropped('refused')] }), 'exit 2 or a BEHIND refusal'],
  ]
  // the red train: the train source read a failed check
  cases[2] = ['train-red', world([H, N], [view(H, { head: HH, checks: [running()] }), view(N, { head: NH })], {}, { train: trainRead({ [TS]: [red()] }) }), 'red train CI']
  cases[2][1] = withLedger(cases[2][1], [updated(), built()])
  cases[1][1] = withLedger(cases[1][1], [updated(), built()])

  for (const [end, s, why] of cases) {
    test(`${end} (${why}): no train merge, the branch deleted with the reason in its key; the record goes through Q1, its own CI and Q2, and its merge says why`, () => {
      const p = plan(s)
      expect(merges(p).filter(a => a.testedTree !== undefined)).toEqual([])
      expect(deletes(p).map(a => [a.end, a.branch, a.key])).toEqual([[end, BRANCH(N), trainDeleteKey(buildKey(), end)]])
      // a record that is the head takes Q1 when it is behind main, else Q2, and never a merge on the dropped train
      const head = queueOf(s.v2?.records ?? [], [])[0]
      const nv = s.v2?.prs.prs.find(v => v.issue === 2)
      if (head?.issue === 2) {
        const behind = nv?.base !== s.v2?.prs.main?.sha
        expect(queueActions(p).map(a => [a.kind, a.issue])).toEqual([[behind ? 'queue-update' : 'queue-merge', 2]])
        if (!behind) expect(merges(p)[0]).toMatchObject({ trainDropped: end })
      }
      // later, up to date on main with the delete done: the merge is the ordinary one with --train-dropped
      const later = plan(settled(end, end === 'tree-mismatch' || end === 'refused' ? [dropped(end)] : []))
      expect(merges(later)).toHaveLength(1)
      expect(merges(later)[0]).toMatchObject({ issue: 2, trainDropped: end })
      expect(merges(later)[0]?.testedTree).toBeUndefined()
      expect(ARGV.queueMergeArgv(602, PATCH, 2, { trainDropped: end })).toEqual(['callum-flow-merge', '602', '--patch', PATCH, '--issue', '2', '--train-dropped', end])
    })
  }

  test('conflict: a build that found a conflict made no train; the record goes its own path and its merge says conflict', () => {
    const conflict = built(N, { tree: null, train: null, branch: null, drop: 'conflict' })
    const s = midCi({ ledger: [updated(), conflict] })
    const p = plan(s)
    expect(builds(p)).toEqual([])
    expect(deletes(p)).toEqual([])
    expect(trainsOf(s.ledger)).toEqual([])
    const later = plan(withLedger(world([N], [view(N, { head: NH, base: MAIN2 })], {}, {}, MAIN2), [conflict]))
    expect(merges(later)[0]).toMatchObject({ issue: 2, trainDropped: 'conflict' })
  })

  test('a delete that failed keeps the reason, plans no second delete of the train, and leaves its branch to the next sweep', () => {
    // the record's patch is no longer the approved one, so no new train is built for its new head
    const s = midCi({ ledger: [updated(), built()], nv: { head: NH2, patch: OTHER_PATCH } })
    const failed = entry(trainDeleteKey(buildKey(), 'head-moved'), 'queue-train', { issue: 2, status: 'failed', attempts: 1 })
    const p = plan(withLedger(s, [failed]))
    expect(deletes(p)).toEqual([])
    expect(trainsOf(withLedger(s, [failed]).ledger)).toEqual([])
    // the sweep names no train live, so the branch goes with the next one
    expect(sweeps(p).map(a => a.keep)).toEqual([[]])
    // and the reason is still the record's when it merges
    const later = withLedger(world([N], [view(N, { head: NH, base: MAIN2 })], {}, {}, MAIN2), [built(), failed])
    expect(merges(plan(later))[0]).toMatchObject({ trainDropped: 'head-moved' })
  })

  test('the drops the executors record never count toward the merge guard\'s tries: three of them leave the record able to merge, not unknown', () => {
    const tries = [dropped('tree-mismatch', 1), dropped('refused', 2), dropped('tree-mismatch', 3)]
    const s = withLedger(world([N], [view(N, { head: NH, base: MAIN2 })], {}, {}, MAIN2), [built(), deleted('tree-mismatch'), ...tries])
    const p = plan(s)
    expect(transitionOf(p, 2)).toBeUndefined()
    expect(merges(p).map(a => a.key)).toEqual([mergeKey(N, NH, 4)])
    expect(merges(p)[0]).toMatchObject({ trainDropped: 'tree-mismatch' })
  })

  test('the stale train: no check ever started, or one that never ends, drops it as red; a train whose CI did not run is no hold on the record', () => {
    const start = (over: Partial<LedgerEntry>, checks: CheckRun[] | null) => {
      const s = withLedger(midCi({ ledger: [] }), [updated(), built(N, {}, over)])
      return { ...s, v2: { ...(s.v2 as V2State), train: trainRead({ [TS]: checks }) } }
    }
    // no check started on the train in the 10 minutes CI has to start
    expect(deletes(plan(start({ endedAt: NOW - 11 * MIN }, []))).map(a => a.end)).toEqual(['train-red'])
    expect(deletes(plan(start({ endedAt: NOW - 2 * MIN }, [])))).toEqual([])
    // checks that cannot be read for that long
    expect(deletes(plan(start({ endedAt: NOW - 11 * MIN }, null))).map(a => a.end)).toEqual(['train-red'])
    expect(deletes(plan(start({ endedAt: NOW - 2 * MIN }, null)))).toEqual([])
    // a check that runs has the 30 minutes more CI may take
    expect(deletes(plan(start({ endedAt: NOW - 11 * MIN }, [running()])))).toEqual([])
    expect(deletes(plan(start({ endedAt: NOW - 45 * MIN }, [running()]))).map(a => a.end)).toEqual(['train-red'])
  })
})

// --- the setting off ---------------------------------------------------------------------------------------------

describe('with the setting off (the default)', () => {
  test('no train is built or read, no queue-train action is planned, and the queue is the queue as it was', () => {
    const p = plan(midCi(), OFF)
    expect(trainActions(p)).toEqual([])
    const after = plan(afterMerge({ ledger: [] }), OFF)
    expect(trainActions(after)).toEqual([])
    // the record behind main takes Q1, never a train merge
    expect(queueActions(after).map(a => [a.kind, a.issue])).toEqual([['queue-update', 2]])
    expect(merges(after)).toEqual([])
  })

  test('a train built before it was turned off is dropped, its branch deleted, and no merge rides it or says it was dropped', () => {
    const s = afterMerge({ train: trainRead({ [TS]: [green()] }, { [MAIN2]: TREE_H, [HH]: TREE_H }) })
    const p = plan(s, OFF)
    expect(deletes(p).map(a => a.end)).toEqual(['left-queue'])
    expect(merges(p)).toEqual([])
    expect(builds(p)).toEqual([])
    // every train branch on origin is swept, none kept
    expect(sweeps(p).map(a => a.keep)).toEqual([[]])
    const settled = withLedger(world([N], [view(N, { head: NH, base: MAIN2 })], {}, {}, MAIN2), [built(), deleted('left-queue')])
    const later = plan(settled, OFF)
    expect(merges(later)).toHaveLength(1)
    expect(merges(later)[0]?.testedTree).toBeUndefined()
    expect(merges(later)[0]?.trainDropped).toBeUndefined()
  })

  test('once the sweep ran, nothing is owed: no further queue-train action; with the setting on the sweep runs once per window', () => {
    const swept = entry(trainSweepKey(Math.floor(NOW / SWEEP_MS)), 'queue-train', { startedAt: NOW - MIN, endedAt: NOW - 30_000, outcome: { kind: 'train', op: 'sweep', removed: [BRANCH(N)], kept: [] } })
    const clean = withLedger(world([N], [view(N, { head: NH, base: MAIN, mergeable: 'clean' })]), [built(N, {}, { startedAt: NOW - 10 * MIN, endedAt: NOW - 9 * MIN }), deleted('left-queue'), swept])
    expect(trainActions(plan(clean, OFF))).toEqual([])
    // on: the sweep of this window is done; the next window plans another
    expect(sweeps(plan(clean, ON))).toEqual([])
    const later = { ...clean, now: NOW + SWEEP_MS }
    expect(sweeps(plan(later, ON)).map(a => a.key)).toEqual([trainSweepKey(Math.floor(NOW / SWEEP_MS) + 1)])
  })

  test('on, with no train at all, the sweep still runs once per window and keeps nothing', () => {
    const p = plan(world([N], [view(N, { head: NH })]), ON)
    expect(sweeps(p)).toEqual([expect.objectContaining({ op: 'sweep', keep: [], key: trainSweepKey(Math.floor(NOW / SWEEP_MS)), issue: null, class: 'free', rule: 'Q3' })])
    expect(trainActions(plan(world([N], [view(N, { head: NH })]), OFF))).toEqual([])
  })
})

// --- the properties (v2 SPEC 17.1: 8 amended, and the tree) ---------------------------------------------------

// The model of git's merge-tree: a pure function of the two sides, so the property can say what "the
// tree CI passed" and "the tree of merging the head onto main" are without a repository.
const mt = (a: string, b: string) => `merge(${a},${b})`

describe('the properties of 17.1 with the train on', () => {
  // every combination of the facts a train rests on
  const combos: { main: string; headIn: boolean; nHead: string; nBehind: boolean; trainCi: 'green' | 'red' | 'pending' | 'unread'; mainTree: string; tried: boolean }[] = []
  for (const main of [MAIN, MAIN2])
    for (const headIn of [true, false])
      for (const nHead of [NH, NH2])
        for (const nBehind of [true, false])
          for (const trainCi of ['green', 'red', 'pending', 'unread'] as const)
            for (const mainTree of [TREE_H, TREE_OTHER])
              for (const tried of [false, true]) combos.push({ main, headIn, nHead, nBehind, trainCi, mainTree, tried })

  function scenario(c: (typeof combos)[number]): State {
    const records = c.headIn ? [H, N] : [N]
    const nBase = c.nBehind ? MAIN : c.main
    const prs = [...(c.headIn ? [view(H, { head: HH, checks: [running()], base: MAIN })] : []), view(N, { head: c.nHead, base: nBase, mergeable: c.nBehind ? 'behind' : 'clean' })]
    const checks: TrainRead['checks'] = c.trainCi === 'unread' ? { [TS]: null } : { [TS]: c.trainCi === 'green' ? [green()] : c.trainCi === 'red' ? [red()] : [running()] }
    const train = trainRead(checks, { [c.main]: c.mainTree, [HH]: TREE_H })
    const b = built(N, { tree: mt(TREE_H, NH) })
    const s = world(records, prs, {}, { train }, c.main)
    return withLedger(s, [updated(), b, ...(c.tried ? [dropped('refused')] : [])])
  }

  test('property 8, amended: only the head is updated or merged; a train is built for the record right behind the head alone and merges only with its tested tree', () => {
    let trainMerges = 0
    let ordinary = 0
    for (const c of combos) {
      const s = scenario(c)
      const p = plan(s)
      const queue = queueOf(s.v2?.records ?? [], [])
      for (const a of queueActions(p)) expect({ c, issue: a.issue }).toEqual({ c, issue: queue[0]?.issue })
      for (const a of builds(p)) expect({ c, issue: a.issue, pr: a.pr }).toEqual({ c, issue: queue[1]?.issue, pr: queue[1]?.pr })
      for (const a of p.actions) if (a.kind === 'pr' || a.kind === 'ci-rerun') expect({ c, issue: a.issue }).toEqual({ c, issue: queue[0]?.issue })
      for (const a of merges(p)) {
        if (a.testedTree !== undefined) trainMerges += 1
        else ordinary += 1
      }
      // at most one train is ever live, and the sweep never names a train that ended
      expect(trainsOf(s.ledger).length).toBeLessThanOrEqual(1)
    }
    expect(trainMerges).toBeGreaterThan(0)
    expect(ordinary).toBeGreaterThan(0)
  })

  test('the tree property: every queue-merge is either the head at main\'s head after Q1, or carries a tested tree equal to merge-tree(main, head)', () => {
    let tested = 0
    let direct = 0
    for (const c of combos) {
      const s = scenario(c)
      const p = plan(s)
      const trees: Record<string, string> = { [c.main]: c.mainTree, [HH]: TREE_H }
      for (const a of merges(p)) {
        const v = s.v2?.prs.prs.find(x => x.pr === a.pr)
        const atMain = v?.base === c.main && v.mergeable === 'clean'
        if (a.testedTree === undefined) {
          expect({ c, atMain }).toEqual({ c, atMain: true })
          direct += 1
        } else {
          // the tree CI passed on the train is what merging the head onto main gives now
          expect({ c, ok: a.testedTree === mt(trees[c.main] ?? '', v?.head ?? '') }).toEqual({ c, ok: true })
          expect(c.trainCi).toBe('green')
          expect(a.head).toBe(NH)
          tested += 1
        }
      }
    }
    expect(tested).toBeGreaterThan(0)
    expect(direct).toBeGreaterThan(0)
  })
})

// --- the executors: the merge's flags (act-queue.ts) ---------------------------------------------------------------

function runtime(): Runtime {
  return { mode: 'act', repo: REPO, device: DEVICE, runSource: 'local', poolSize: 16, cwd: '/work', loopDir: LOOP_DIR, sink: null, env: { CALLUM_FLOW_REPO: REPO }, toolsDir: TOOLS, pluginRoot: PLUGIN_ROOT, config: ON, configProblems: [] }
}
type Reply = Partial<RunResult>
type Call = { argv: string[]; env: Record<string, string> | undefined }

function actWorld(reply: (argv: string[]) => Reply) {
  const calls: Call[] = []
  const io: ActIo = {
    now: async () => NOW,
    run: async (argv, init: RunInit) => {
      calls.push({ argv: [...argv], env: init.env })
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
  const run = (action: Action) => dispatch(ctxOf(env, world([], []), start([], action, NOW).entry), action)
  return { calls, argvs: () => calls.map(c => c.argv), run }
}

const MERGE_TRAIN: Action = { kind: 'queue-merge', key: mergeKey(N, NH, 1), class: 'free', rule: 'Q2', reason: 'x', issue: 2, pr: 602, head: NH, patch: PATCH, testedTree: TREE_T, maxAttempts: 1 }
const MERGE_PLAIN: Action = { ...MERGE_TRAIN, key: mergeKey(N, NH, 2), testedTree: undefined, trainDropped: 'train-red' } as Action

describe('the merge on a train (act-queue.ts)', () => {
  test('callum-flow-merge gets --tested-tree for a train merge and --train-dropped for one that says why it has none', async () => {
    const a = actWorld(() => ({}))
    expect(await a.run(MERGE_TRAIN)).toMatchObject({ status: 'done', outcome: { kind: 'queue', op: 'merge', merged: true, head: NH } })
    expect(a.argvs()).toEqual([['callum-flow-merge', '602', '--patch', PATCH, '--issue', '2', '--tested-tree', TREE_T]])
    const b = actWorld(() => ({}))
    await b.run(MERGE_PLAIN)
    expect(b.argvs()).toEqual([['callum-flow-merge', '602', '--patch', PATCH, '--issue', '2', '--train-dropped', 'train-red']])
  })

  test('exit 2 on a train merge (an image that does not know --tested-tree) is the drop refused: answered, never a fault, never retried as unknown', async () => {
    const w = actWorld(argv => (argv[0] === 'callum-flow-merge' ? { exitCode: 2, stderr: 'usage: callum-flow-merge-guard: unknown option --tested-tree' } : {}))
    const out = await w.run(MERGE_TRAIN)
    expect(out).toMatchObject({ status: 'done', outcome: { kind: 'queue', op: 'merge', merged: false, head: NH, failClass: null, drop: 'refused' } })
    expect(out).not.toHaveProperty('noRetry')
    // the same exit 2 without a tested tree is still the loop's bug, never retried
    const plain = actWorld(argv => (argv[0] === 'callum-flow-merge' ? { exitCode: 2, stderr: 'usage' } : {}))
    expect(await plain.run({ ...MERGE_TRAIN, testedTree: undefined } as Action)).toMatchObject({ status: 'failed', noRetry: true })
  })

  test('a GUARD tree FAIL (another tree, or a conflict with main) is the drop tree-mismatch, whatever else the guard said; a tree check that could not read is no drop', async () => {
    for (const cls of ['behind', 'conflict']) {
      const line = `GUARD tree FAIL merging ${NH} onto origin/main gives tree x, not the tested ${TREE_T} class=${cls}`
      const w = actWorld(argv => (argv[0] === 'callum-flow-merge' ? { exitCode: 1, stdout: `${line}\nGUARD checks FAIL ci=pending class=checks\n` } : {}))
      const out = await w.run(MERGE_TRAIN)
      expect(out).toMatchObject({ status: 'done', outcome: { merged: false, failClass: null, drop: 'tree-mismatch', lines: [line, 'GUARD checks FAIL ci=pending class=checks'] } })
      // the PR is not read back for a refusal the guard answered
      expect(w.argvs().filter(a => a[0] === 'callum-flow-issue-read')).toEqual([])
    }
    const unread = actWorld(argv => (argv[0] === 'callum-flow-merge' ? { exitCode: 1, stdout: 'GUARD tree FAIL cannot fetch origin/main class=read\n' } : {}))
    const out = await unread.run(MERGE_TRAIN)
    expect(out).toMatchObject({ status: 'failed', outcome: { failClass: 'read' } })
    expect(out.status === 'failed' && out.outcome?.kind === 'queue' ? out.outcome.drop : 'none').toBeUndefined()
  })

  test('a BEHIND refusal after the guard passed (strict protection still on) is the drop refused; without a tested tree it is the class behind, as before', async () => {
    const reply = (argv: string[]): Reply => (argv[0] === 'callum-flow-merge' ? { exitCode: 1, stderr: 'callum-flow-merge: GitHub refused: merge state BEHIND (branch rule)' } : {})
    expect(await actWorld(reply).run(MERGE_TRAIN)).toMatchObject({ status: 'done', outcome: { merged: false, failClass: null, drop: 'refused' } })
    const plain = await actWorld(reply).run({ ...MERGE_TRAIN, testedTree: undefined } as Action)
    expect(plain).toMatchObject({ status: 'done', outcome: { merged: false, failClass: 'behind' } })
    expect(plain.status === 'done' && plain.outcome?.kind === 'queue' ? plain.outcome.drop : 'none').toBeUndefined()
  })

  test('trainDropOf reads only the tree check\'s behind or conflict, or a BEHIND refusal with no FAIL line', () => {
    expect(trainDropOf(['GUARD tree FAIL x class=behind'], '')).toBe('tree-mismatch')
    expect(trainDropOf(['GUARD tree FAIL x class=conflict'], '')).toBe('tree-mismatch')
    expect(trainDropOf(['GUARD tree FAIL x class=read'], '')).toBeNull()
    expect(trainDropOf(['GUARD mergeable FAIL behind main class=behind'], '')).toBeNull()
    expect(trainDropOf([], 'GitHub refused: merge state BEHIND')).toBe('refused')
    expect(trainDropOf(['GUARD checks FAIL x class=checks'], 'GitHub refused: merge state BEHIND')).toBeNull()
    expect(trainDropOf([], 'GitHub refused: merge state DIRTY')).toBeNull()
  })
})

// --- the executors: build, delete, sweep (act-train.ts) ---------------------------------------------------------

const BUILD: Action = { kind: 'queue-train', key: buildKey(), class: 'free', rule: 'Q3', reason: 'x', issue: 2, pr: 602, op: 'build', branch: 'issue-2', rider: NH, headIssue: 1, headPr: 601, headBranch: 'issue-1', head: HH, main: MAIN, maxAttempts: 1 }

// git answers as it does: a fetch of a branch leaves its tip in FETCH_HEAD, the merge makes a tree, the commit a sha.
function git(tips: Record<string, string>, over: (argv: string[]) => Reply | undefined = () => undefined) {
  let fetched = ''
  return (argv: string[]): Reply => {
    const own = over(argv)
    if (own !== undefined) return own
    if (argv[1] === 'fetch') fetched = (argv.at(-1) ?? '').replace('refs/heads/', '')
    if (argv[1] === 'rev-parse') return { stdout: `${tips[fetched] ?? ''}\n` }
    if (argv[1] === 'merge-tree') return { stdout: `${TREE_T}\n` }
    if (argv[1] === 'commit-tree') return { stdout: `${TS}\n` }
    return {}
  }
}
const TIPS = { 'issue-1': HH, 'issue-2': NH }

describe('the build (act-train.ts)', () => {
  test('fetches both tips into FETCH_HEAD, merges their trees with no working tree, commits the train with both as parents and pushes it as factory-train/i<N>-<tree7>', async () => {
    const w = actWorld(git(TIPS))
    const out = await w.run(BUILD)
    expect(w.argvs()).toEqual([
      ['git', 'fetch', '--quiet', '--no-tags', 'origin', 'refs/heads/issue-1'],
      ['git', 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'],
      ['git', 'fetch', '--quiet', '--no-tags', 'origin', 'refs/heads/issue-2'],
      ['git', 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'],
      ['git', 'merge-tree', '--write-tree', '--no-messages', HH, NH],
      ['git', 'commit-tree', TREE_T, '-p', HH, '-p', NH, '-m', expect.stringContaining('factory train: PR #602 on #601')],
      ['git', 'push', '--quiet', 'origin', `${TS}:refs/heads/${BRANCH(N)}`],
    ] as never)
    expect(out).toEqual({
      status: 'done',
      outcome: { kind: 'train', op: 'build', tree: TREE_T, train: TS, branch: BRANCH(N), headIssue: 1, head: HH, rider: NH, main: MAIN, drop: null },
      summary: expect.stringContaining(`pushed as ${BRANCH(N)}`),
    })
    // the commit is the same commit however often it is made: a fixed identity and date, no config read
    const commit = w.calls.find(c => c.argv[1] === 'commit-tree')
    expect(commit?.env).toMatchObject({ GIT_AUTHOR_NAME: 'factory-loop', GIT_COMMITTER_NAME: 'factory-loop', GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z', GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z' })
    // nothing but these five git verbs runs: no checkout, switch, merge, reset, rebase, add or commit, so no branch of N or of the head changes
    expect([...new Set(w.argvs().map(a => a[1]))]).toEqual(['fetch', 'rev-parse', 'merge-tree', 'commit-tree', 'push'])
    // and the only ref pushed is the train's
    expect(w.argvs().filter(a => a[1] === 'push').flatMap(a => a.filter(x => x.includes(':')))).toEqual([`${TS}:refs/heads/factory-train/i2-${TREE_T.slice(0, 7)}`])
  })

  test('a branch that is no longer at the sha the plan read is the drop head-moved: a done try with no train, and nothing is merged or pushed', async () => {
    const moved = actWorld(git({ 'issue-1': HH, 'issue-2': NH2 }))
    expect(await moved.run(BUILD)).toMatchObject({ status: 'done', outcome: { kind: 'train', op: 'build', tree: null, train: null, branch: null, drop: 'head-moved' } })
    expect(moved.argvs().filter(a => ['merge-tree', 'commit-tree', 'push'].includes(a[1] ?? ''))).toEqual([])
    const headMoved = actWorld(git({ 'issue-1': sha('5'), 'issue-2': NH }))
    expect(await headMoved.run(BUILD)).toMatchObject({ status: 'done', outcome: { drop: 'head-moved' } })
    const gone = actWorld(git(TIPS, argv => (argv[1] === 'fetch' ? { exitCode: 128, stderr: 'fatal: couldn\'t find remote ref refs/heads/issue-2' } : undefined)))
    expect(await gone.run(BUILD)).toMatchObject({ status: 'done', outcome: { drop: 'head-moved' } })
  })

  test('merge-tree exiting 1 is the drop conflict: no commit and no push', async () => {
    const w = actWorld(git(TIPS, argv => (argv[1] === 'merge-tree' ? { exitCode: 1, stdout: `${TREE_T}\nCONFLICT (content)\n` } : undefined)))
    expect(await w.run(BUILD)).toMatchObject({ status: 'done', outcome: { kind: 'train', op: 'build', train: null, drop: 'conflict' } })
    expect(w.argvs().filter(a => ['commit-tree', 'push'].includes(a[1] ?? ''))).toEqual([])
  })

  test('any other failure (a fetch, merge-tree, commit-tree or the push) is a failed command, with no outcome of a train, for the breaker to count', async () => {
    for (const verb of ['fetch', 'rev-parse', 'merge-tree', 'commit-tree', 'push']) {
      const w = actWorld(git(TIPS, argv => (argv[1] === verb ? { exitCode: 128, stderr: `fatal: ${verb} broke` } : undefined)))
      const out = await w.run(BUILD)
      expect({ verb, status: out.status, kind: out.status === 'failed' ? out.outcome?.kind : null }).toEqual({ verb, status: 'failed', kind: 'cli' })
    }
    const garbled = actWorld(git(TIPS, argv => (argv[1] === 'merge-tree' ? { stdout: 'not a tree\n' } : undefined)))
    expect(await garbled.run(BUILD)).toMatchObject({ status: 'failed' })
  })

  test('delete removes one train branch, tolerating one already gone, and never any other branch', async () => {
    const DEL: Action = { kind: 'queue-train', key: trainDeleteKey(buildKey(), 'merged'), class: 'free', rule: 'Q3', reason: 'x', issue: 2, op: 'delete', branch: BRANCH(N), end: 'merged', maxAttempts: 3 }
    const w = actWorld(() => ({}))
    expect(await w.run(DEL)).toMatchObject({ status: 'done', outcome: { kind: 'train', op: 'delete', branch: BRANCH(N), end: 'merged' } })
    expect(w.argvs()).toEqual([['git', 'push', '--quiet', 'origin', '--delete', `refs/heads/${BRANCH(N)}`]])
    const gone = actWorld(() => ({ exitCode: 1, stderr: 'error: unable to delete \'x\': remote ref does not exist' }))
    expect(await gone.run(DEL)).toMatchObject({ status: 'done' })
    const broken = actWorld(() => ({ exitCode: 128, stderr: 'fatal: unable to access' }))
    expect(await broken.run(DEL)).toMatchObject({ status: 'failed' })
    for (const branch of ['main', 'issue-2', 'factory-train', 'refs/heads/main']) {
      const refused = actWorld(() => ({}))
      expect(await refused.run({ ...DEL, branch } as Action)).toMatchObject({ status: 'failed', noRetry: true })
      expect(refused.argvs()).toEqual([])
    }
  })

  test('the sweep removes the train branches on origin that no live train names, and only those', async () => {
    const SWEEP: Action = { kind: 'queue-train', key: trainSweepKey(1), class: 'free', rule: 'Q3', reason: 'x', issue: null, op: 'sweep', keep: ['factory-train/i2-1234567'], maxAttempts: 1 }
    const ls = [
      `${sha('a')}\trefs/heads/factory-train/i2-1234567`,
      `${sha('b')}\trefs/heads/factory-train/i9-7654321`,
      `${sha('c')}\trefs/heads/factory-train/i10-aaaaaaa`,
      // never listed by the pattern, and never removed if it were
      `${sha('d')}\trefs/heads/issue-9`,
      `${sha('e')}\trefs/heads/main`,
    ].join('\n')
    const w = actWorld(argv => (argv[1] === 'ls-remote' ? { stdout: `${ls}\n` } : {}))
    expect(await w.run(SWEEP)).toMatchObject({ status: 'done', outcome: { kind: 'train', op: 'sweep', removed: ['factory-train/i9-7654321', 'factory-train/i10-aaaaaaa'], kept: ['factory-train/i2-1234567'] } })
    expect(w.argvs()).toEqual([
      ['git', 'ls-remote', '--heads', 'origin', 'refs/heads/factory-train/*'],
      ['git', 'push', '--quiet', 'origin', '--delete', 'refs/heads/factory-train/i9-7654321', 'refs/heads/factory-train/i10-aaaaaaa'],
    ])
    // nothing stale: no push at all
    const clean = actWorld(argv => (argv[1] === 'ls-remote' ? { stdout: `${sha('a')}\trefs/heads/factory-train/i2-1234567\n` } : {}))
    expect(await clean.run(SWEEP)).toMatchObject({ status: 'done', outcome: { removed: [] } })
    expect(clean.argvs().map(a => a[1])).toEqual(['ls-remote'])
    // many are removed in chunks of twenty
    const many = Array.from({ length: 45 }, (_, i) => `${sha('a')}\trefs/heads/factory-train/i${i + 100}-1234567`).join('\n')
    const big = actWorld(argv => (argv[1] === 'ls-remote' ? { stdout: many } : {}))
    await big.run({ ...SWEEP, keep: [] } as Action)
    expect(big.argvs().filter(a => a[1] === 'push').map(a => a.length - 5)).toEqual([20, 20, 5])
  })
})

// --- the source (sources-train.ts) -------------------------------------------------------------------------------

const runsJson = (runs: unknown[], total = runs.length) => JSON.stringify({ total_count: total, check_runs: runs })
const RUN = (over: Record<string, unknown> = {}) => ({ name: 'ci', status: 'completed', conclusion: 'success', started_at: '2026-10-25T01:00:00Z', completed_at: '2026-10-25T01:05:00Z', html_url: `https://github.com/${REPO}/actions/runs/777/job/5`, ...over })

describe('the train source (sources-train.ts, v2 SPEC 2.4)', () => {
  test('check runs read as gh pr checks reads a head\'s: passed, skipped, failed, cancelled and pending, with their run ids; a list cut short, or one that does not parse, is not read', () => {
    const r = (stdout: string, exitCode = 0): RunResult => ({ exitCode, stdout, stderr: '' })
    const list = checkRunsOf(r(runsJson([RUN(), RUN({ name: 'a', conclusion: 'neutral' }), RUN({ name: 'b', conclusion: 'skipped' }), RUN({ name: 'c', conclusion: 'failure' }), RUN({ name: 'd', conclusion: 'timed_out' }), RUN({ name: 'e', conclusion: 'cancelled' }), RUN({ name: 'f', status: 'in_progress', conclusion: null, completed_at: null }), RUN({ name: 'g', status: 'queued', conclusion: null, started_at: null, completed_at: null, html_url: null })])))
    expect(list?.map(c => [c.name, c.bucket])).toEqual([['ci', 'pass'], ['a', 'pass'], ['b', 'skipping'], ['c', 'fail'], ['d', 'fail'], ['e', 'cancel'], ['f', 'pending'], ['g', 'pending']])
    expect(list?.[0]).toMatchObject({ runId: '777', link: `https://github.com/${REPO}/actions/runs/777/job/5`, startedAt: Date.parse('2026-10-25T01:00:00Z'), completedAt: Date.parse('2026-10-25T01:05:00Z') })
    expect(list?.[7]).toMatchObject({ startedAt: null, completedAt: null, runId: null, link: null })
    expect(checkRunsOf(r(runsJson([])))).toEqual([])
    expect(checkRunsOf(r(runsJson([RUN()], 2)))).toBeNull()
    expect(checkRunsOf(r('nope'))).toBeNull()
    expect(checkRunsOf(r(runsJson([{ status: 'completed' }])))).toBeNull()
    expect(checkRunsOf(r(runsJson([RUN()]), 1))).toBeNull()
    expect(treeOf(r(`${TREE_H}\n`))).toBe(TREE_H)
    expect(treeOf(r('x\n'))).toBeNull()
    expect(treeOf(r(`${TREE_H}\n`, 1))).toBeNull()
  })

  function sourceCtx(ledger: LedgerEntry[], reply: (argv: string[]) => Reply, cfg = ON, over: Partial<SourceCtx> = {}): { ctx: SourceCtx; argvs: string[][] } {
    const argvs: string[][] = []
    const ctx: SourceCtx = {
      now: NOW,
      rt: { ...runtime(), config: cfg },
      run: async argv => {
        argvs.push([...argv])
        return { exitCode: 0, stdout: '', stderr: '', ...reply(argv) }
      },
      readFile: async () => null,
      state: baseState({ ledger }),
      records: [N],
      heads: {},
      prBudget: 3,
      limited: () => false,
      unread: [],
      kept: [],
      tag: null,
      tags: {},
      ...over,
    }
    return { ctx, argvs }
  }
  const answer = (argv: string[]): Reply => (argv.includes('--jq') ? { stdout: `${argv[2]?.endsWith(MAIN2) ? TREE_H : TREE_H}\n` } : { stdout: runsJson([RUN()]) })

  test('nothing is read with the setting off or no live train, however many trains the ledger once held', async () => {
    const off = sourceCtx([built()], answer, OFF)
    expect(await readTrain(off.ctx, EMPTY_TRAIN, MAIN2)).toBe(EMPTY_TRAIN)
    expect(off.argvs).toEqual([])
    const none = sourceCtx([built(), deleted('merged')], answer)
    expect(await readTrain(none.ctx, EMPTY_TRAIN, MAIN2)).toBe(EMPTY_TRAIN)
    expect(none.argvs).toEqual([])
    const dropped1 = sourceCtx([built(N, { tree: null, train: null, branch: null, drop: 'conflict' })], answer)
    expect(await readTrain(dropped1.ctx, EMPTY_TRAIN, MAIN)).toBe(EMPTY_TRAIN)
  })

  test('a live train: its commit\'s check runs; the trees of the head\'s commit and of main only once main is not what the train was built on', async () => {
    const before = sourceCtx([built()], answer)
    const r1 = await readTrain(before.ctx, EMPTY_TRAIN, MAIN)
    expect(before.argvs).toEqual([ARGV.commitChecksArgv(REPO, TS)])
    expect(ARGV.commitChecksArgv(REPO, TS)).toEqual(['gh', 'api', `repos/${REPO}/commits/${TS}/check-runs?per_page=100`])
    expect(r1.checks[TS]).toHaveLength(1)
    expect(r1.trees).toEqual({})
    expect(r1.source).toEqual({ ok: true, at: NOW })
    // main moved: both trees, once; a later pass reads them from the cache
    const after = sourceCtx([built()], answer)
    const r2 = await readTrain(after.ctx, r1, MAIN2)
    expect(after.argvs.filter(a => a.includes('--jq'))).toEqual([ARGV.commitTreeReadArgv(REPO, HH), ARGV.commitTreeReadArgv(REPO, MAIN2)])
    expect(ARGV.commitTreeReadArgv(REPO, HH)).toEqual(['gh', 'api', `repos/${REPO}/commits/${HH}`, '--jq', '.commit.tree.sha'])
    expect(r2.trees).toEqual({ [HH]: TREE_H, [MAIN2]: TREE_H })
    const again = sourceCtx([built()], answer, ON, { now: NOW + 5 * MIN })
    await readTrain(again.ctx, r2, MAIN2)
    expect(again.argvs.filter(a => a.includes('--jq'))).toEqual([])
  })

  test('the checks are read every prEveryMs; not during a GitHub backoff or after a rate limit; a failed read keeps the last reading', async () => {
    const r1 = trainRead({ [TS]: [green()] })
    const soon = sourceCtx([built()], answer)
    expect((await readTrain(soon.ctx, r1, MAIN)).checks[TS]).toEqual([green()])
    expect(soon.argvs).toEqual([])
    const limited = sourceCtx([built()], answer, ON, { limited: () => true, now: NOW + HOUR })
    expect((await readTrain(limited.ctx, r1, MAIN)).checks[TS]).toEqual([green()])
    expect(limited.argvs).toEqual([])
    const backoff = sourceCtx([built()], answer, ON, { now: NOW + HOUR, state: baseState({ ledger: [built()], githubBackoffUntil: NOW + 2 * HOUR }) })
    await readTrain(backoff.ctx, r1, MAIN)
    expect(backoff.argvs).toEqual([])
    const failing = sourceCtx([built()], () => ({ exitCode: 1, stderr: 'HTTP 502' }), ON, { now: NOW + HOUR })
    const r2 = await readTrain(failing.ctx, r1, MAIN)
    expect(r2.checks[TS]).toEqual([green()])
    expect(r2.source.ok).toBe(false)
    // a train that ended is forgotten
    const gone = sourceCtx([built(), deleted('merged')], answer, ON, { now: NOW + HOUR })
    expect(await readTrain(gone.ctx, r1, MAIN)).toBe(EMPTY_TRAIN)
  })
})

// --- the keys (appendix C) ----------------------------------------------------------------------------------------

describe('the train keys (v2 SPEC appendix C)', () => {
  test('the build is i<N>/l<L>/queue/train/<H\'7>-<N7>-<main7>/s<seq>; a delete and a sweep are their own; every drop reason is a closed word', () => {
    expect(buildKey()).toBe(`i2/l${LIFE}/queue/train/${HH.slice(0, 7)}-${NH.slice(0, 7)}-${MAIN.slice(0, 7)}/s5`)
    expect(trainKeyParts(buildKey())).toEqual({ build: buildKey(), seq: 5, end: null })
    expect(trainKeyParts(trainDeleteKey(buildKey(), 'train-red'))).toEqual({ build: buildKey(), seq: 5, end: 'train-red' })
    expect(trainDeleteKey(buildKey(), 'merged')).toBe(`${buildKey()}/del/merged`)
    expect(trainSweepKey(7)).toBe('train/sweep/7')
    expect(trainKeyParts(trainSweepKey(7))).toBeNull()
    expect(trainKeyParts(mergeKey(N, NH, 1))).toBeNull()
    expect(trainKeyParts(updateKey(N, MAIN))).toBeNull()
    expect(TRAIN_DROPS).toEqual(['head-moved', 'outside-merge', 'conflict', 'train-red', 'left-queue', 'tree-mismatch', 'refused'])
    expect(TRAIN_PREFIX).toBe('factory-train/')
  })
})
