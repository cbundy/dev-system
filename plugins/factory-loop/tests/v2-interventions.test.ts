// The interventions (docs/factory-loop/v2/SPEC.md 7.2, property 13 of 17.1): every unplanned
// step-in, by a person or by the loop, is one `intervention` event, derived from a fact the loop
// already holds and logged once for it; the happy path logs none; no interleaving of the loop's
// own writes and delayed reads makes a person intervention without a person's action. The facts
// are generated: ledgers of transitions by row and event, step entries, PR reads with stale and
// fresh heads, the companion's log, and the owner's files between passes.
import { describe, expect, test } from 'claude-code/testing'

import { GITHUB_V2, newCtx } from '../hooks/foundation'
import type { Runtime } from '../hooks/observe'
import type { Action, Control, LedgerEntry, State } from '../hooks/types'
import { logEvent, logOwnerOp, opInterventions } from '../hooks/v2/act-events'
import type { InterventionEvent } from '../hooks/v2/events'
import { claimKey, factKey, interventionKey, keyParts, reclaimKey, reconcileKey, rerunKey, stepKey, transitionKey } from '../hooks/v2/keys'
import { emptyV2State } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { interventionRules, interventionsOf } from '../hooks/v2/rules-interventions'
import type { Planned } from '../hooks/v2/rules-interventions'
import { COMPANION_WINDOW_MS, SETTLE_MS, companionLines, controlDiff, newMemory, noteOpLanded, readInterventions } from '../hooks/v2/sources-interventions'
import type { InterventionFacts, Memory } from '../hooks/v2/sources-interventions'
import type { PrView } from '../hooks/v2/sources-prs'
import { V2_OWNER_TELLS } from '../hooks/v2/types'
import type { EventKind, HeadSeen, IssueRecord, IssueState, OutsideCause, StepKind, StepResult, UnknownWhy, V2Ctx, V2Outcome, V2State } from '../hooks/v2/types'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, control, entry, state } from './fixtures'
import { LOOP_DIR, REPO, TOOLS } from './host'

const N = 571
const LIFE = (Math.floor(NOW / 1000) - 3 * 3600).toString(36)
const BEGAN = Math.floor(NOW / 1000) * 1000 - 3 * 3600 * 1000
const H = (c: string) => c.repeat(40)

// --- builders --------------------------------------------------------------------------------------

function record(over: Partial<IssueRecord> = {}): IssueRecord {
  return {
    issue: N,
    life: LIFE,
    seq: 5,
    seqAt: NOW - 30 * MIN,
    state: 'reviewing',
    since: NOW - 30 * MIN,
    resumeTo: null,
    branch: `issue-${N}`,
    pr: 621,
    head: H('a'),
    approvedPatch: null,
    brief: null,
    step: 'review',
    attempt: 1,
    cut: false,
    triages: 0,
    fixes: 0,
    round: 1,
    question: null,
    why: null,
    notes: [],
    prClosedAt: null,
    ...over,
  }
}

type T = { row: string; event: EventKind; from: IssueState | null; to: IssueState; step?: StepKind | null; cause?: OutsideCause | null; stored?: boolean }

// t: the done transition entry of seq `seq`, at minute `at` before now.
function t(seq: number, x: T, at = 60 - seq, issue = N, life = LIFE): LedgerEntry {
  const outcome: V2Outcome = { kind: 'transition', row: x.row, event: x.event, cause: x.cause ?? null, from: x.from, to: x.to, step: x.step ?? null, stored: x.stored ?? true }
  return entry(transitionKey({ issue, life, seq }), 'transition', { issue, rule: 'S3', startedAt: NOW - at * MIN, endedAt: NOW - at * MIN + 1000, outcome })
}

function result(event: StepResult['event'], over: Partial<StepResult> = {}): StepResult {
  return { event, reason: null, why: null, head: null, choice: null, data: null, ...over }
}

// step: an agent step's entry in seq `seq`, started at minute `at` before now.
function step(seq: number, kind: 'design' | 'build' | 'review' | 'fix' | 'triage', at: number, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return entry(stepKey({ issue: N, life: LIFE, seq }, kind, 1), 'agent-step', { issue: N, step: kind, startedAt: NOW - at * MIN, endedAt: NOW - at * MIN + 30_000, agentId: `agent-${seq}`, ...over })
}

function pr(over: Partial<PrView> = {}): PrView {
  return { pr: 621, issue: N, state: 'open', head: H('a'), mergedHead: null, closedAt: null, mergeable: 'clean', author: 'cbundy', checks: [], patch: null, readAt: NOW, ...over }
}

type World = { ledger?: LedgerEntry[]; records?: IssueRecord[]; prs?: PrView[]; heads?: Record<string, HeadSeen>; facts?: InterventionFacts; control?: Control; loadedAt?: number; out?: Action[] }

function v2Of(w: World): V2State {
  return {
    ...emptyV2State(NOW, w.records ?? []),
    prs: { prs: w.prs ?? [] },
    heads: w.heads ?? {},
    interventions: w.facts ?? { companion: [], controlDigest: null, configDigest: null, changes: [] },
  }
}

function stateOf(w: World): State {
  const s = state({ loadedAt: w.loadedAt ?? NOW - 120 * MIN, control: w.control ?? control() })
  return { ...s, ledger: [...s.ledger, ...(w.ledger ?? [])], v2: v2Of(w) }
}

function ctxOf(w: World): V2Ctx {
  const s = stateOf(w)
  const base = newCtx(s, config({ planner: 'v2', mode: 'act' }), { tier: 'normal', overridden: false }, V2_OWNER_TELLS, GITHUB_V2)
  base.out.push(...(w.out ?? []))
  return Object.assign(base, { v2: s.v2 as V2State })
}

const ivs = (w: World) => interventionsOf(ctxOf(w))
const causes = (w: World) => ivs(w).map(p => `${p.event.who} ${p.event.cause}`)
const ivActions = (s: State) => planV2(s, config({ planner: 'v2', mode: 'act' })).actions.filter((a): a is Extract<Action, { kind: 'event' }> => a.kind === 'event' && a.key.startsWith('iv/'))

// done: the ledger entry an intervention leaves once logged.
const done = (p: Planned): LedgerEntry => entry(p.key, 'event', { issue: p.event.issue, startedAt: NOW - MIN, endedAt: NOW - MIN + 100 })

// --- the happy path ------------------------------------------------------------------------------

// A whole life with nothing unplanned: claimed, designed, built, reviewed and approved with green
// CI, merged by the queue.
function happyLife(): LedgerEntry[] {
  return [
    entry(claimKey(N, LIFE), 'claim', { issue: N, startedAt: NOW - 59 * MIN, endedAt: NOW - 59 * MIN }),
    t(0, { row: 'S0', event: 'ok', from: null, to: 'queued', step: 'lease' }, 58),
    t(1, { row: 'T1', event: 'ok', from: 'queued', to: 'designing', step: 'design' }, 55),
    step(1, 'design', 54, { outcome: { kind: 'step', step: 'design', result: result('ok') } }),
    t(2, { row: 'T2', event: 'ok', from: 'designing', to: 'building', step: 'build' }, 50),
    step(2, 'build', 49, { outcome: { kind: 'step', step: 'build', result: result('ok', { head: H('a') }) } }),
    t(3, { row: 'T5', event: 'ok', from: 'building', to: 'reviewing', step: 'review' }, 30),
    entry(`i${N}/l${LIFE}/review/aaaaaaa/r1/a1`, 'agent-step', { issue: N, step: 'review', startedAt: NOW - 29 * MIN, agentId: 'r1', outcome: { kind: 'step', step: 'review', result: result('ok') } }),
    t(4, { row: 'T8', event: 'ok', from: 'reviewing', to: 'merge-queue', step: 'queue' }, 20),
    entry(`i${N}/l${LIFE}/queue/merge/aaaaaaa`, 'queue-merge', { issue: N, startedAt: NOW - 19 * MIN, outcome: { kind: 'queue', op: 'merge', merged: true, head: H('a'), failClass: null, lines: [] } }),
    t(5, { row: 'T13', event: 'ok', from: 'merge-queue', to: 'closed', step: null }, 18),
  ]
}

describe('the happy path logs no intervention (property 13)', () => {
  test('design, build, an approving review, green CI and a merge: nothing', () => {
    const w: World = { ledger: happyLife(), records: [record({ seq: 5, state: 'closed', why: 'merged', step: null })], prs: [pr({ checks: [] })], heads: { [H('a')]: { pr: 621, at: NOW - 30 * MIN } } }
    expect(ivs(w)).toEqual([])
    expect(ivActions(stateOf(w))).toEqual([])
  })

  test('the planned work is no intervention: a fixer for review findings, a fixer chosen by triage, a decline, a claim lost, a drop, a split, a triage retry', () => {
    const rows: T[] = [
      { row: 'T9', event: 'not-ok', from: 'reviewing', to: 'fixing', step: 'fix' },
      { row: 'X2', event: 'triage', from: 'building', to: 'fixing', step: 'fix' },
      { row: 'X1', event: 'triage', from: 'building', to: 'building', step: 'build' },
      { row: 'X3', event: 'triage', from: 'building', to: 'designing', step: 'design' },
      { row: 'T12', event: 'not-ok', from: 'fixing', to: 'reviewing', step: 'review' },
      { row: 'E5', event: 'claim-lost', from: 'building', to: 'closed' },
      { row: 'E1', event: 'drop', from: 'building', to: 'closed' },
      { row: 'T4', event: 'not-ok', from: 'designing', to: 'closed' },
      { row: 'X5', event: 'triage', from: 'reviewing', to: 'closed' },
      { row: 'T11', event: 'ok', from: 'fixing', to: 'reviewing', step: 'review' },
    ]
    for (const x of rows) {
      const review = step(1, 'review', 40, { key: `i${N}/l${LIFE}/review/bbbbbbb/r1/a1`, outcome: { kind: 'step', step: 'review', result: result('not-ok', { reason: 'changes' }) } })
      expect([x.row, causes({ ledger: [t(1, { row: 'T1', event: 'ok', from: 'queued', to: 'reviewing' }, 50), review, t(2, x, 30)] })]).toEqual([x.row, []])
    }
  })

  test('a transition the executor did not store (its trigger no longer held) is no fact', () => {
    expect(ivs({ ledger: [t(3, { row: 'U2', event: 'unknown', from: 'building', to: 'building', step: 'build', stored: false })] })).toEqual([])
  })
})

// --- each loop intervention, once for its fact ----------------------------------------------------

describe('each intervention of 7.2 comes from its fact and is logged exactly once (property 13)', () => {
  // one world holding one fact of every kind the ledger, the records and the State give
  function everything(): World {
    const era = NOW - 200 * MIN
    return {
      loadedAt: NOW - 10 * MIN,
      ledger: [
        t(1, { row: 'S0', event: 'ok', from: null, to: 'queued' }, 200),
        t(2, { row: 'U1', event: 'unknown', from: 'building', to: 'building', step: 'build', cause: 'load' }, 50),
        step(2, 'build', 52, { status: 'lost', agentId: 'x' }),
        t(3, { row: 'U2', event: 'unknown', from: 'building', to: 'building', step: 'build' }, 45),
        step(3, 'build', 49, { outcome: { kind: 'step', step: 'build', result: result('unknown', { why: 'bad-answer' }) } }),
        t(4, { row: 'U3', event: 'unknown', from: 'building', to: 'building', step: 'triage' }, 40),
        step(4, 'build', 44, { status: 'failed', agentId: undefined }),
        t(5, { row: 'T6', event: 'not-ok', from: 'building', to: 'building', step: 'triage' }, 35),
        step(5, 'triage', 33, { status: 'lost', endedAt: NOW - 31 * MIN }),
        t(6, { row: 'U4', event: 'unknown', from: 'building', to: 'parked' }, 30),
        t(7, { row: 'T14', event: 'not-ok', from: 'merge-queue', to: 'reviewing', step: 'review' }, 25),
        t(8, { row: 'E2', event: 'issue-closed', from: 'reviewing', to: 'closed' }, 20),
        t(1, { row: 'E3', event: 'pr-merged', from: 'merge-queue', to: 'closed' }, 20, 572, 'abc'),
        t(1, { row: 'E4', event: 'pr-closed', from: 'reviewing', to: 'parked' }, 20, 573, 'abc'),
        t(1, { row: 'T9', event: 'not-ok', from: 'merge-queue', to: 'fixing', step: 'fix' }, 20, 574, 'abc'),
        entry('i574/labc/queue/merge/ccccccc', 'queue-merge', { issue: 574, startedAt: NOW - 22 * MIN, outcome: { kind: 'queue', op: 'merge', merged: false, head: H('c'), failClass: 'checks', lines: [] } }),
        entry(rerunKey({ issue: N, life: LIFE }, 2, '18342299123'), 'ci-rerun', { issue: N }),
        entry(`i${N}/l${LIFE}/s7/pr/body/a1`, 'pr', { issue: N }),
        entry(reclaimKey({ issue: N, life: LIFE }, 'zz1'), 'claim', { issue: N }),
        entry(reconcileKey(600, 'ss1x2k', 'event'), 'event', { issue: 600 }),
        entry('tell:breaker:steps:1', 'tell', { wake: 'breaker', startedAt: era + MIN }),
        entry('tell:stalled:i571/lx/s3/label', 'tell', { issue: N, wake: 'stalled', startedAt: era + MIN }),
        entry('tell:checkout:1', 'tell', { wake: 'checkout', startedAt: era + MIN }),
        entry('tell:workspace:1', 'tell', { wake: 'workspace', startedAt: era + MIN }),
        entry('judge:sequence:1', 'judge', { wake: 'sequence', startedAt: era + MIN }),
      ],
      records: [record({ seq: 9, state: 'reviewing', head: H('a'), pr: 621 })],
      prs: [pr({ head: H('9') })],
      heads: { [H('a')]: { pr: 621, at: NOW - 30 * MIN }, [H('9')]: { pr: 621, at: NOW - 5 * MIN } },
      facts: {
        companion: [{ at: NOW - 3 * MIN, issue: N, life: LIFE, seq: 9, cause: 'guard:push', reason: 'a force push to issue-571' }],
        controlDigest: null,
        configDigest: null,
        changes: [{ what: 'config', at: NOW - 4 * MIN, issues: [], detail: 'settings changed with no op: maxInFlightIssues' }],
      },
    }
  }

  const EXPECTED = [
    'loop free:load',
    'loop unknown:bad-answer',
    'loop unknown:spawn',
    'loop triage',
    'loop triage',
    'loop unknown:agent-dead',
    'loop park',
    'loop queue:patch',
    'person issue-closed',
    'person hand-merge',
    'person pr-closed',
    'loop park',
    'loop fix:ci',
    'loop ci-rerun',
    'loop queue:linkage',
    'loop reclaim',
    'loop reconcile',
    'loop breaker',
    'loop stalled',
    'loop tripwire',
    'loop workspace',
    'loop wake',
    'person push',
    'person restart',
    'loop guard:push',
    'person config-file',
  ]

  test('every cause, by its fact', () => {
    expect(causes(everything()).sort()).toEqual([...EXPECTED].sort())
  })

  test('each has its own key, iv/<the fact\'s key>, and names its issue when it has one', () => {
    const all = ivs(everything())
    expect(new Set(all.map(p => p.key)).size).toBe(all.length)
    for (const p of all) {
      expect(p.key).toBe(interventionKey(p.event.fact) === p.key ? p.key : `iv/${p.event.fact}/${p.event.cause}`)
      expect(p.key.startsWith(`iv/${p.event.fact}`)).toBe(true)
    }
    const fleet = all.filter(p => p.event.issue === null).map(p => p.event.cause).sort()
    expect(fleet).toEqual(['breaker', 'config-file', 'restart', 'tripwire', 'wake', 'workspace'])
    const triage = all.find(p => p.event.cause === 'triage' && p.event.fact === transitionKey({ issue: N, life: LIFE, seq: 4 }))
    expect(triage?.key).toBe(`iv/${transitionKey({ issue: N, life: LIFE, seq: 4 })}/triage`)
  })

  test('planned once: with every intervention logged, the next pass plans none of them again', () => {
    const w = everything()
    const first = ivActions(stateOf(w))
    expect(first.map(a => a.key).sort()).toEqual(ivs(w).map(p => p.key).sort())
    const after = stateOf({ ...w, ledger: [...(w.ledger ?? []), ...ivs(w).map(done)] })
    expect(ivActions(after)).toEqual([])
    // and an event's action is the intervention itself, free, attached to its issue
    for (const a of first) expect(a).toMatchObject({ class: 'free', issue: a.event.state === 'intervention' ? a.event.issue : null })
  })

  test('an intervention event that used up its attempts is a skip line, never an owner item or a held record', () => {
    const w = everything()
    const restart = ivs(w).find(p => p.event.cause === 'restart') as Planned
    const failed = { ...w, ledger: [...(w.ledger ?? []), entry(restart.key, 'event', { status: 'failed', attempts: 3 })] }
    const ctx = ctxOf(failed)
    interventionRules(ctx)
    expect(ctx.out.some(a => a.key === restart.key)).toBe(false)
    expect(ctx.skipped).toContainEqual({ rule: 'R2', issue: null, why: `exhausted: ${restart.key}: the intervention person restart is not logged` })
    expect(ctx.exhausted).toEqual([])
    expect(planV2(stateOf(failed), config({ planner: 'v2', mode: 'act' })).actions.some(a => a.kind === 'tell')).toBe(false)
  })

  test('a free re-run is logged as unknown only once its attempt\'s free re-run is spent (rate-limited)', () => {
    const w: World = {
      ledger: [
        t(2, { row: 'U1', event: 'unknown', from: 'fixing', to: 'fixing', step: 'fix', cause: 'usage' }, 40),
        t(3, { row: 'U2', event: 'unknown', from: 'fixing', to: 'fixing', step: 'fix' }, 30),
        step(3, 'fix', 39, { outcome: { kind: 'step', step: 'fix', result: result('unknown', { why: 'rate-limited' }) } }),
      ],
    }
    expect(causes(w)).toEqual(['loop free:usage', 'loop unknown:rate-limited'])
  })
})

// --- why a step went unknown -------------------------------------------------------------------------

describe('unknown:<why> from the step\'s own entry', () => {
  const unknownAt = (from: IssueState, stepEntries: LedgerEntry[], event: EventKind = 'unknown') =>
    causes({ ledger: [t(2, { row: 'T1', event: 'ok', from: 'queued', to: from }, 50), ...stepEntries, t(3, { row: 'U2', event, from, to: from }, 30)] })

  test('the result\'s why, for every why', () => {
    for (const why of ['timeout', 'agent-dead', 'bad-answer', 'api', 'rate-limited', 'spawn', 'cli', 'github-wait'] as UnknownWhy[]) {
      expect(unknownAt('building', [step(2, 'build', 40, { outcome: { kind: 'step', step: 'build', result: result('unknown', { why }) } })])).toEqual([`loop unknown:${why}`])
    }
  })

  test('a step still running when it ended timed out; a timed-out entry too; the timeout event says so itself', () => {
    expect(unknownAt('fixing', [step(2, 'fix', 40, { status: 'running', endedAt: null })])).toEqual(['loop unknown:timeout'])
    expect(unknownAt('fixing', [step(2, 'fix', 40, { status: 'timed-out' })])).toEqual(['loop unknown:timeout'])
    expect(unknownAt('fixing', [], 'timeout')).toEqual(['loop unknown:timeout'])
  })

  test('an agent that never started is a spawn; one that failed or was lost is dead; a CLI step that failed is cli', () => {
    expect(unknownAt('designing', [step(2, 'design', 40, { status: 'failed', agentId: undefined })])).toEqual(['loop unknown:spawn'])
    expect(unknownAt('designing', [step(2, 'design', 40, { status: 'lost' })])).toEqual(['loop unknown:agent-dead'])
    expect(unknownAt('merge-queue', [entry(`i${N}/l${LIFE}/queue/update/1234567`, 'queue-update', { issue: N, status: 'failed', startedAt: NOW - 40 * MIN, endedAt: NOW - 39 * MIN })])).toEqual(['loop unknown:cli'])
    expect(unknownAt('building', [entry(`i${N}/l${LIFE}/s2/prepare/a1`, 'slot', { issue: N, status: 'failed', startedAt: NOW - 40 * MIN, endedAt: NOW - 39 * MIN })])).toEqual(['loop unknown:cli'])
  })

  test('with no entry of its own: a wait on GitHub in reviewing or at the queue\'s head; cli elsewhere', () => {
    expect(unknownAt('reviewing', [])).toEqual(['loop unknown:github-wait'])
    expect(unknownAt('merge-queue', [])).toEqual(['loop unknown:github-wait'])
    expect(unknownAt('building', [])).toEqual(['loop unknown:cli'])
  })

  test('another seq\'s or another life\'s step is not this step', () => {
    const other = step(1, 'build', 70, { outcome: { kind: 'step', step: 'build', result: result('unknown', { why: 'api' }) } })
    const otherLife = entry(stepKey({ issue: N, life: 'zzz', seq: 2 }, 'build', 1), 'agent-step', { issue: N, startedAt: NOW - 40 * MIN, outcome: { kind: 'step', step: 'build', result: result('unknown', { why: 'api' }) } })
    expect(unknownAt('building', [other, otherLife])).toEqual(['loop unknown:cli'])
  })
})

// --- fixers for red CI or a conflict ------------------------------------------------------------------

describe('fix:ci and fix:conflict (T9): something did not merge as it should', () => {
  const t9 = (from: IssueState) => t(2, { row: 'T9', event: 'not-ok', from, to: 'fixing', step: 'fix' }, 30)
  const fixRequested = (note: string): Action => ({
    kind: 'event',
    key: `i${N}/l${LIFE}/s2/event/fix_requested`,
    class: 'free',
    rule: 'S3',
    reason: 'entry',
    issue: N,
    event: { state: 'fix_requested', issue: N, branch: `issue-${N}`, pr: 621, head: null, note },
  })

  test('the seq\'s own fix_requested says what for', () => {
    expect(causes({ ledger: [t9('reviewing')], out: [fixRequested('ci')] })).toEqual(['loop fix:ci'])
    expect(causes({ ledger: [t9('reviewing')], out: [fixRequested('conflict')] })).toEqual(['loop fix:conflict'])
    expect(causes({ ledger: [t9('reviewing')], out: [fixRequested('review')], prs: [pr({ mergeable: 'dirty' })] })).toEqual([])
  })

  test('else the queue\'s guard class, else the PR as read', () => {
    const merge = (failClass: 'conflict' | 'checks') =>
      entry(`i${N}/l${LIFE}/queue/merge/aaaaaaa`, 'queue-merge', { issue: N, startedAt: NOW - 35 * MIN, outcome: { kind: 'queue', op: 'merge', merged: false, head: H('a'), failClass, lines: [] } })
    expect(causes({ ledger: [merge('conflict'), t9('merge-queue')] })).toEqual(['loop fix:conflict'])
    expect(causes({ ledger: [merge('checks'), t9('merge-queue')] })).toEqual(['loop fix:ci'])
    expect(causes({ ledger: [t9('reviewing')], records: [record({ seq: 2, state: 'fixing' })], prs: [pr({ mergeable: 'dirty' })] })).toEqual(['loop fix:conflict'])
    const failed = { name: 'ci', state: 'FAILURE', bucket: 'fail' as const, startedAt: null, completedAt: null, runId: '1', link: null }
    expect(causes({ ledger: [t9('reviewing')], records: [record({ seq: 2, state: 'fixing' })], prs: [pr({ checks: [failed] })] })).toEqual(['loop fix:ci'])
  })
})

// --- what a person did, as GitHub and the owner's files show it ---------------------------------------

describe('person interventions', () => {
  test('an unpark by the label is a person\'s; an unpark by /factory resume is the op\'s own', () => {
    const ledger = [t(2, { row: 'T3', event: 'not-ok', from: 'designing', to: 'parked' }, 50), t(3, { row: 'P1', event: 'unpark', from: 'parked', to: 'queued' }, 10)]
    expect(causes({ ledger })).toEqual(['loop park', 'person unpark'])
    const resumed = control({ resumed: [{ subject: `issue:${N}`, at: NOW - 20 * MIN }] })
    expect(causes({ ledger, control: resumed })).toEqual(['loop park'])
    // a resume from before the park is not this unpark's
    const old = control({ resumed: [{ subject: `issue:${N}`, at: NOW - 55 * MIN }] })
    expect(causes({ ledger, control: old })).toEqual(['loop park', 'person unpark'])
  })

  test('E4 is a person\'s close of the PR and the park it causes', () => {
    const ivs4 = ivs({ ledger: [t(2, { row: 'E4', event: 'pr-closed', from: 'reviewing', to: 'parked' }, 10)], records: [record({ seq: 2, state: 'parked', question: 'PR #621 was closed by hand; a resume reopens it' })] })
    expect(ivs4.map(p => [p.event.who, p.event.cause])).toEqual([
      ['person', 'pr-closed'],
      ['loop', 'park'],
    ])
    expect(ivs4[1]?.event.reason).toContain('PR #621 was closed by hand')
  })

  test('a restart is a module load with no restart of the loop\'s own around it, logged while it is recent', () => {
    expect(causes({ loadedAt: NOW - 5 * MIN })).toEqual(['person restart'])
    expect(causes({ loadedAt: NOW - 2 * 60 * MIN })).toEqual([])
    const own = (over: Partial<LedgerEntry>) => entry('restart:1', 'restart-self', { rule: 'R2', ...over })
    expect(causes({ loadedAt: NOW - 5 * MIN, ledger: [own({ status: 'done', endedAt: NOW - 9 * MIN })] })).toEqual([])
    expect(causes({ loadedAt: NOW - 5 * MIN, ledger: [own({ status: 'lost', endedAt: NOW - 5 * MIN })] })).toEqual([])
    expect(causes({ loadedAt: NOW - 5 * MIN, ledger: [own({ status: 'failed', endedAt: NOW - 9 * MIN })] })).toEqual(['person restart'])
    expect(causes({ loadedAt: NOW - 5 * MIN, ledger: [own({ status: 'done', endedAt: NOW - 3 * 60 * MIN })] })).toEqual(['person restart'])
  })

  test('an intervention is no work a restart would cut: it is written first, and R2 restarts in the same pass', () => {
    const s = stateOf({ loadedAt: NOW - 5 * MIN, control: control({ updateDue: { reason: 'image', at: NOW - MIN } }) })
    const kinds = planV2(s, config({ planner: 'v2', mode: 'act' })).actions.map(a => `${a.kind} ${a.key}`)
    expect(kinds.at(-1)).toBe(`restart-self restart:${NOW - MIN}`)
    expect(kinds.some(k => k.startsWith('event iv/restart/fleet/'))).toBe(true)
  })

  test('a hand edit of the owner\'s files is attached to each issue whose entries changed, else to none', () => {
    const facts: InterventionFacts = {
      companion: [],
      controlDigest: 'x',
      configDigest: 'y',
      changes: [
        { what: 'control', at: NOW - 5 * MIN, issues: [571, 572], detail: 'control changed with no op: paused' },
        { what: 'control', at: NOW - 4 * MIN, issues: [], detail: 'control changed with no op: the OFF file was created' },
      ],
    }
    expect(ivs({ facts }).map(p => [p.event.cause, p.event.issue])).toEqual([
      ['control-file', 571],
      ['control-file', 572],
      ['control-file', null],
    ])
  })

  test('the owner\'s ops: one intervention per issue named, else one for the fleet; status and help are none', () => {
    const resume = opInterventions({ text: 'resume 571 572 "go on"', name: 'resume', issues: [571, 572], at: NOW })
    expect(resume.map(e => [e.who, e.cause, e.issue, e.reason])).toEqual([
      ['person', 'op:resume', 571, 'resume 571 572 "go on"'],
      ['person', 'op:resume', 572, 'resume 571 572 "go on"'],
    ])
    expect(resume[0]?.fact).toBe(factKey('op:resume', 'i571', NOW.toString(36)))
    expect(opInterventions({ text: 'mode act', name: 'mode', issues: [], at: NOW }).map(e => [e.cause, e.issue])).toEqual([['op:mode', null]])
    for (const name of ['status', 'help']) expect(opInterventions({ text: name, name, issues: [], at: NOW })).toEqual([])
    // two ops a millisecond apart are two facts
    expect(opInterventions({ text: 'pause', name: 'pause', issues: [], at: NOW + 1 })[0]?.fact).not.toBe(opInterventions({ text: 'pause', name: 'pause', issues: [], at: NOW })[0]?.fact)
  })
})

// --- pushes, against delayed reads ---------------------------------------------------------------

describe('a push no loop step produced is a person\'s; the loop\'s own heads and late reads never are (property 13)', () => {
  // The loop's own life on a PR: the builder's head A (T5), a fixer's head B (T11), the queue's
  // update C (Q1). Every head GitHub ever reports is one of them, in any order, seen at any time
  // after the life began, with the update running or done.
  function loopWorld(g: () => number): World {
    const heads = [H('a'), H('b'), H('c')]
    const seenAt = heads.map(() => NOW - Math.floor(g() * 50) * MIN)
    const shown = heads[Math.floor(g() * 3)] as string
    const updateDone = g() < 0.6
    const state = g() < 0.5 ? 'reviewing' : 'merge-queue'
    const recordHead = g() < 0.5 ? H('b') : H('c')
    return {
      ledger: [
        step(2, 'build', 55, { outcome: { kind: 'step', step: 'build', result: result('ok', { head: H('a') }) } }),
        step(4, 'fix', 45, { outcome: { kind: 'step', step: 'fix', result: result('ok', { head: H('b') }) } }),
        entry(`i${N}/l${LIFE}/queue/update/1234567`, 'queue-update', {
          issue: N,
          startedAt: NOW - 60 * MIN,
          status: updateDone ? 'done' : 'running',
          endedAt: updateDone ? NOW - 20 * MIN : null,
          outcome: updateDone ? { kind: 'queue', op: 'update', merged: false, head: H('c'), failClass: null, lines: [] } : undefined,
        }),
      ],
      records: [record({ seq: 6, state, head: recordHead })],
      prs: [pr({ head: shown })],
      heads: Object.fromEntries(heads.map((h, i) => [h, { pr: 621, at: seenAt[i] as number }])),
    }
  }

  test('no interleaving of the loop\'s writes and late reads gives a push', () => {
    let s = 1
    const g = () => {
      s = (Math.imul(s, 48271) + 11) % 2147483647
      return s / 2147483647
    }
    for (let i = 0; i < 400; i += 1) expect(causes(loopWorld(g))).toEqual([])
  })

  test('a person\'s head, first seen in this life, is one push, keyed by the head', () => {
    const w: World = { records: [record({ head: H('a') })], prs: [pr({ head: H('9') })], heads: { [H('a')]: { pr: 621, at: NOW - 40 * MIN }, [H('9')]: { pr: 621, at: NOW - 2 * MIN } } }
    const p = ivs(w)
    expect(p.map(x => [x.event.who, x.event.cause, x.key])).toEqual([['person', 'push', interventionKey(factKey('push', `i${N}`, '9999999'))]])
    expect(ivs({ ...w, ledger: p.map(done) }).length).toBe(1)
    expect(ivActions(stateOf({ ...w, ledger: p.map(done) }))).toEqual([])
  })

  test('an adopted PR\'s head when the life began, or the first one seen in it, is the loop\'s start, not a push', () => {
    const adopted = record({ head: null, state: 'reviewing' })
    expect(causes({ records: [adopted], prs: [pr({ head: H('1') })], heads: { [H('1')]: { pr: 621, at: BEGAN - MIN } } })).toEqual([])
    expect(causes({ records: [adopted], prs: [pr({ head: H('1') })], heads: { [H('1')]: { pr: 621, at: NOW - 20 * MIN } } })).toEqual([])
    expect(causes({ records: [adopted], prs: [pr({ head: H('2') })], heads: { [H('1')]: { pr: 621, at: NOW - 20 * MIN }, [H('2')]: { pr: 621, at: NOW - 2 * MIN } } })).toEqual(['person push'])
  })

  test('a head not yet in the heads first seen, a closed PR, or a record in building or fixing is not judged', () => {
    expect(causes({ records: [record()], prs: [pr({ head: H('9') })] })).toEqual([])
    expect(causes({ records: [record()], prs: [pr({ head: H('9'), state: 'closed' })], heads: { [H('9')]: { pr: 621, at: NOW - MIN } } })).toEqual([])
    for (const state of ['building', 'fixing'] as const) expect(causes({ records: [record({ state })], prs: [pr({ head: H('9') })], heads: { [H('9')]: { pr: 621, at: NOW - MIN } } })).toEqual([])
  })

  test('a queue update that ended with no head read may have made any head seen after it started', () => {
    const update = entry(`i${N}/l${LIFE}/queue/update/1234567`, 'queue-update', { issue: N, status: 'failed', startedAt: NOW - 10 * MIN })
    const w: World = { ledger: [update], records: [record({ state: 'merge-queue' })], prs: [pr({ head: H('9') })], heads: { [H('9')]: { pr: 621, at: NOW - 5 * MIN } } }
    expect(causes(w)).toEqual([])
    expect(causes({ ...w, heads: { [H('9')]: { pr: 621, at: NOW - 15 * MIN } } })).toEqual(['person push'])
  })
})

// --- v1's leftovers and the companion -------------------------------------------------------------

describe('what v1 left in the ledger, and the companion\'s log', () => {
  test('a notice or a wake from before v2\'s first transition is not v2\'s intervention', () => {
    const v1 = [entry('tell:breaker:spawn:1', 'tell', { wake: 'breaker', startedAt: NOW - 100 * MIN }), entry('judge:sequence:1', 'judge', { wake: 'sequence', startedAt: NOW - 100 * MIN })]
    expect(causes({ ledger: v1 })).toEqual([])
    expect(causes({ ledger: [...v1, t(1, { row: 'S0', event: 'ok', from: null, to: 'queued' }, 50)] })).toEqual([])
    expect(causes({ ledger: [t(1, { row: 'S0', event: 'ok', from: null, to: 'queued' }, 200), ...v1] }).sort()).toEqual(['loop breaker', 'loop wake'])
  })

  test('the release task and the tells for waiting states are planned, and no notice about an intervention is one', () => {
    const era = t(1, { row: 'S0', event: 'ok', from: null, to: 'queued' }, 200)
    expect(causes({ ledger: [era, entry('task:release:3:none', 'task', { wake: 'release' }), entry('tell:waiting:i5', 'tell', { wake: 'waiting' }), entry('tell:stalled:iv/i5/lx/s3/t', 'tell', { wake: 'stalled' })] })).toEqual([])
  })

  test('the companion\'s lines: each refusal and each gate that could not run, once per line', () => {
    const text = [
      JSON.stringify({ at: NOW - MIN, issue: N, life: LIFE, seq: 3, cause: 'guard:write', reason: 'wrote outside its slot' }),
      JSON.stringify({ at: new Date(NOW - 2 * MIN).toISOString(), issue: null, life: null, seq: null, cause: 'gate-unknown', reason: 'npm test could not start' }),
      'not json',
      JSON.stringify({ at: NOW - MIN, issue: N, cause: 'guard:teleport', reason: 'no such cause' }),
      JSON.stringify({ at: NOW - COMPANION_WINDOW_MS - MIN, issue: N, cause: 'guard:push', reason: 'too old' }),
      JSON.stringify({ at: NOW - 3 * MIN, issue: N, life: LIFE, seq: 4, cause: 'guard:command', reason: 'gh pr merge' }),
      '',
    ].join('\n')
    const lines = companionLines(text, NOW)
    expect(lines.map(l => [l.cause, l.issue])).toEqual([
      ['guard:write', N],
      ['gate-unknown', null],
      ['guard:command', N],
    ])
    const p = ivs({ facts: { companion: lines, controlDigest: null, configDigest: null } })
    expect(p.map(x => [x.event.who, x.event.cause, x.event.issue])).toEqual([
      ['loop', 'guard:write', N],
      ['loop', 'gate-unknown', null],
      ['loop', 'guard:command', N],
    ])
    expect(new Set(p.map(x => x.key)).size).toBe(3)
  })
})

// --- the owner's files between passes (sources-interventions.ts) -------------------------------------

describe('hand edits of control.json, the OFF file and the settings', () => {
  const BASE = LOOP_DIR.replace(/\/[^/]+$/, '')
  function rtOf(over: Partial<Runtime> = {}, cfg = config({ planner: 'v2' })): Runtime {
    return { mode: 'act', repo: REPO, device: DEVICE, runSource: 'local', poolSize: 16, cwd: '/work', loopDir: LOOP_DIR, sink: null, env: {}, toolsDir: TOOLS, pluginRoot: PLUGIN_ROOT, config: cfg, configProblems: [], ...over }
  }
  // a pass's read over these files, at this minute
  async function pass(mem: Memory, files: Record<string, string>, at: number, rt: Runtime = rtOf()) {
    const r = await readInterventions(
      {
        now: NOW + at * MIN,
        rt,
        run: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
        readFile: async (path: string) => files[path] ?? null,
        state: state(),
        records: [],
        heads: {},
        prBudget: 0,
        limited: () => false,
      },
      mem,
    )
    return r.read.changes ?? []
  }
  const ctl = (c: Partial<Control>) => ({ [`${LOOP_DIR}/control.json`]: JSON.stringify({ ...control(), ...c }) })

  test('a change no op explains is judged once it settles, with the issues it touched', async () => {
    const mem = newMemory()
    expect(await pass(mem, ctl({}), 0)).toEqual([])
    expect(await pass(mem, ctl({ paused: [571], skip: [9] }), 1)).toEqual([])
    const judged = await pass(mem, ctl({ paused: [571], skip: [9] }), 1 + SETTLE_MS / MIN)
    expect(judged.map(c => [c.what, c.issues])).toEqual([['control', [9, 571]]])
    expect(judged[0]?.detail).toContain('paused')
    expect((await pass(mem, ctl({ paused: [571], skip: [9] }), 10)).length).toBe(1)
  })

  test('an op that landed between the two reads explains its change', async () => {
    const mem = newMemory()
    await pass(mem, ctl({}), 0)
    noteOpLanded(NOW + 0.5 * MIN, mem)
    await pass(mem, ctl({ paused: [571] }), 1)
    expect(await pass(mem, ctl({ paused: [571] }), 5)).toEqual([])
  })

  test('the loop\'s own clearing of a done update is no hand edit; the kill switch is a fleet-level one', async () => {
    const mem = newMemory()
    await pass(mem, ctl({ updateDue: { reason: 'image', at: 1 } }), 0)
    await pass(mem, ctl({ updateDue: null }), 1)
    expect(await pass(mem, ctl({ updateDue: null }), 5)).toEqual([])
    await pass(mem, { ...ctl({ updateDue: null }), [`${BASE}/OFF`]: '' }, 6)
    const off = await pass(mem, { ...ctl({ updateDue: null }), [`${BASE}/OFF`]: '' }, 10)
    expect(off.map(c => [c.what, c.issues, c.detail])).toEqual([['control', [], 'control changed with no op: the OFF file was created']])
  })

  test('a pass that does not act starts the comparison over: nothing seen in observe, under v1 or across a mode change is logged', async () => {
    const mem = newMemory()
    await pass(mem, ctl({}), 0)
    await pass(mem, ctl({ paused: [1] }), 1, rtOf({ mode: 'observe' }))
    await pass(mem, ctl({ paused: [1, 2] }), 2, rtOf({}, config({ planner: 'v1' })))
    await pass(mem, ctl({ paused: [1, 2, 3] }), 3)
    expect(await pass(mem, ctl({ paused: [1, 2, 3] }), 9)).toEqual([])
  })

  test('a settings change no op explains is a config-file change; a pass that could not read origin\'s settings judges none', async () => {
    const mem = newMemory()
    const ws = { [`${BASE}/config.json`]: '{"mode":"act"}' }
    await pass(mem, ws, 0)
    await pass(mem, ws, 1, rtOf({ configProblems: ["settings: origin's default branch not read (x); the main checkout's file is used"] }, config({ planner: 'v2', maxInFlightIssues: 9 })))
    expect(await pass(mem, ws, 5)).toEqual([])
    await pass(mem, ws, 6, rtOf({}, config({ planner: 'v2', maxInFlightIssues: 2 })))
    const judged = await pass(mem, ws, 10, rtOf({}, config({ planner: 'v2', maxInFlightIssues: 2 })))
    expect(judged.map(c => [c.what, c.detail])).toEqual([['config', 'settings changed with no op: maxInFlightIssues']])
    await pass(mem, { [`${BASE}/config.json`]: '{"mode":"act","binDir":"/x"}' }, 11, rtOf({}, config({ planner: 'v2', maxInFlightIssues: 2 })))
    const both = await pass(mem, {}, 20, rtOf({}, config({ planner: 'v2', maxInFlightIssues: 2 })))
    expect(both.map(c => c.detail)).toEqual(['settings changed with no op: maxInFlightIssues', 'settings changed with no op: the workspace config.json'])
  })

  test('controlDiff names the fields and the issues whose entries came or went', () => {
    const text = (c: Partial<Control>, off = false) => `${off ? 'OFF' : 'on'}\n${JSON.stringify({ ...control(), ...c })}`
    expect(controlDiff(text({}), text({}))).toBeNull()
    expect(controlDiff(text({ resumed: [{ subject: 'issue:7', at: 1 }] }), text({ resumed: [] }))).toEqual({ fields: ['resumed'], issues: [7] })
    expect(controlDiff(text({}), text({ dropped: [{ issue: 3, at: 1 }], notes: [{ issue: null, text: 'x', at: 1 }] }))).toEqual({ fields: ['dropped', 'notes'], issues: [3] })
    expect(controlDiff(text({ serial: false }), text({ serial: true }, true))).toEqual({ fields: ['the OFF file was created', 'serial'], issues: [] })
    expect(controlDiff(text({ updateDue: null }), text({ updateDue: { reason: 'x', at: 2 } }))).toEqual({ fields: ['updateDue'], issues: [] })
  })
})

// --- the op's events -------------------------------------------------------------------------------------

describe('logOwnerOp writes each op\'s interventions through events.ts', () => {
  test('one callum-flow-event per issue, with the acting runtime\'s environment; a failed write is a note, not a throw', async () => {
    const runs: { argv: string[]; env: Record<string, string> }[] = []
    let exit = 0
    const io = {
      run: async (argv: string[], init: { env: Record<string, string> }) => {
        runs.push({ argv, env: init.env })
        return { exitCode: exit, stdout: '', stderr: exit === 0 ? '' : 'callum-flow-event: bad note' }
      },
    }
    const rt = { cwd: '/work', env: { CALLUM_FLOW_REPO: REPO } } as unknown as Runtime
    const commands: string[] = []
    const env = { io: io as never, rt, commands }
    expect(await logOwnerOp(env, { text: 'drop 571', name: 'drop', issues: [571], at: NOW })).toEqual([])
    expect(runs.map(r => r.argv.slice(0, 4))).toEqual([['callum-flow-event', 'intervention', '--issue', '571']])
    expect(runs[0]?.argv.at(-1)).toBe(`who=person cause=op:drop life=none fact=op:drop/i571/${NOW.toString(36)} reason=drop%20571`)
    expect(runs[0]?.env).toEqual({ CALLUM_FLOW_REPO: REPO })
    expect(commands.length).toBe(1)
    exit = 2
    const notes = await logOwnerOp(env, { text: 'mode act', name: 'mode', issues: [], at: NOW })
    expect(notes).toEqual(['intervention op:mode not logged: callum-flow-event intervention: exit 2: callum-flow-event: bad note'])
    // the shared writer throws as ExecCtx.event does, with the exit, so an executor never retries a usage error
    const cmd = (argv: string[]) => io.run(argv, { env: {} })
    let thrown: unknown = null
    await logEvent(cmd as never, { state: 'verdict', issue: 5, branch: null, pr: 9, head: null, note: 'WRONG: r1-2 not a bug' }).catch(e => {
      thrown = e
    })
    expect((thrown as { exitCode?: number }).exitCode).toBe(2)
    expect(runs.at(-1)?.argv).toEqual(['callum-flow-event', 'verdict', '--issue', '5', '--pr', '9', '--actor', 'fixer', '--note', 'WRONG: r1-2 not a bug'])
  })
})

// every intervention this file builds is a well-formed event
test('every intervention has a who, a cause of 7.2 and a one-line reason', () => {
  const families = ['op', 'unpark', 'push', 'hand-merge', 'pr-closed', 'issue-closed', 'control-file', 'config-file', 'restart', 'reconcile', 'rescue', 'triage', 'unknown', 'free', 'park', 'fix', 'ci-rerun', 'queue', 'guard', 'gate-unknown', 'tripwire', 'breaker', 'stalled', 'workspace', 'reclaim', 'wake']
  const check = (e: InterventionEvent) => {
    expect(families).toContain(e.cause.split(':')[0])
    expect(e.reason).not.toMatch(/\n/)
    expect(e.reason.length).toBeLessThanOrEqual(200)
    if (e.issue !== null) expect(keyParts(`i${e.issue}/lx`)).not.toBeNull()
  }
  for (const p of interventionsOf(ctxOf({ ledger: [t(2, { row: 'U4', event: 'unknown', from: 'fixing', to: 'parked' }, 10)], loadedAt: NOW }))) check(p.event)
})
