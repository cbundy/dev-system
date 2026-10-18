// The interventions (docs/factory-loop/v2/SPEC.md 7.2, property 13 of 17.1): every unplanned
// step-in, by a person or by the loop, is one `intervention` event, derived from a fact the loop
// already holds and logged once for it; the happy path logs none; no interleaving of the loop's
// own writes and delayed reads makes a person intervention without a person's action. The facts
// are generated: ledgers of transitions by row, event and via, step entries, PR reads with stale and
// fresh heads, the companion's log, and the owner's files against the versions the loop kept.
import { describe, expect, mock, test } from 'claude-code/testing'

import { GITHUB_V2, newCtx } from '../hooks/foundation'
import { REBUILD_DAYS } from '../hooks/observe'
import type { Runtime } from '../hooks/observe'
import type { Action, Control, LedgerEntry, State } from '../hooks/types'
import { logEvent, logOwnerOp, opInterventions } from '../hooks/v2/act-events'
import { eventNote, intervention, noteToken } from '../hooks/v2/events'
import type { InterventionEvent } from '../hooks/v2/events'
import { claimKey, factKey, interventionKey, keyParts, reclaimKey, reconcileKey, rerunKey, stepKey, transitionKey } from '../hooks/v2/keys'
import { emptyV2State } from '../hooks/v2/observe'
import { planV2 } from '../hooks/v2/plan'
import { opLanded } from '../hooks/v2/ops'
import { FACT_WINDOW_MS, controlDiff, digest, editFacts, fileFacts, interventionRules, interventionsOf } from '../hooks/v2/rules-interventions'
import type { Planned } from '../hooks/v2/rules-interventions'
import { COMPANION_WINDOW_MS, EMPTY_FILES, companionLines, filesKey, keepFiles, readInterventions, seenOf } from '../hooks/v2/sources-interventions'
import type { FilesSeen, InterventionFacts } from '../hooks/v2/sources-interventions'
import type { PrView } from '../hooks/v2/sources-prs'
import { newV2Live, noteKillSwitch, noteWritten, notingIo } from '../hooks/v2/store'
import type { V2StoreIo } from '../hooks/v2/store'
import { normalize, rowFor, viaOf } from '../hooks/v2/table'
import { V2_OWNER_TELLS } from '../hooks/v2/types'
import type { EventKind, HeadSeen, IssueRecord, IssueState, OutsideCause, StepKind, StepResult, TableEvent, UnknownWhy, V2Ctx, V2Outcome, V2State } from '../hooks/v2/types'
import { DEVICE, MIN, NOW, PLUGIN_ROOT, config, control, entry, state } from './fixtures'
import { CFG_DIR, LOOP_DIR, NO_EVENTS, QUIET_BEATS, REPO, TOOLS, factoryDoc, host, iso, ENGINE_TEST } from './host'

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
    wait: null,
    lives: 1,
    ...over,
  }
}

type T = { row: string; event: EventKind; from: IssueState | null; to: IssueState; step?: StepKind | null; cause?: OutsideCause | null; via?: string; stored?: boolean }

// t: the done transition entry of seq `seq`, at minute `at` before now. Its via is the code the row
// gave (table.ts viaOf); with none given, the row's id, as the executor records an action that
// carried none.
function t(seq: number, x: T, at = 60 - seq, issue = N, life = LIFE): LedgerEntry {
  const outcome: V2Outcome = { kind: 'transition', row: x.row, event: x.event, cause: x.cause ?? null, via: x.via ?? x.row, from: x.from, to: x.to, step: x.step ?? null, stored: x.stored ?? true }
  return entry(transitionKey({ issue, life, seq }), 'transition', { issue, rule: 'S3', startedAt: NOW - at * MIN, endedAt: NOW - at * MIN + 1000, outcome })
}

// codeOf: the via code the table gives this event on this record, as rules-state.ts plans it
const codeOf = (r: IssueRecord, e: TableEvent) => viaOf(rowFor(r, e, config()), normalize(r, e))

function result(event: StepResult['event'], over: Partial<StepResult> = {}): StepResult {
  return { event, reason: null, why: null, head: null, choice: null, data: null, ...over }
}

// step: an agent step's entry in seq `seq`, started at minute `at` before now.
function step(seq: number, kind: 'design' | 'build' | 'review' | 'fix' | 'triage', at: number, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return entry(stepKey({ issue: N, life: LIFE, seq }, kind, 1), 'agent-step', { issue: N, step: kind, startedAt: NOW - at * MIN, endedAt: NOW - at * MIN + 30_000, agentId: `agent-${seq}`, ...over })
}

function pr(over: Partial<PrView> = {}): PrView {
  return { pr: 621, issue: N, state: 'open', head: H('a'), mergedHead: null, closedAt: null, mergeable: 'clean', author: 'cbundy', base: null, baseRef: 'main', checks: [], patch: null, readAt: NOW, ...over }
}

type World = { ledger?: LedgerEntry[]; records?: IssueRecord[]; prs?: PrView[]; heads?: Record<string, HeadSeen>; facts?: InterventionFacts; control?: Control; loadedAt?: number; out?: Action[] }

function v2Of(w: World): V2State {
  return {
    ...emptyV2State(NOW, w.records ?? []),
    prs: { prs: w.prs ?? [] },
    heads: w.heads ?? {},
    interventions: w.facts ?? { companion: [], controlDigest: null, configDigest: null },
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
      { row: 'T9', event: 'not-ok', from: 'reviewing', to: 'fixing', step: 'fix', via: 'fix:review' },
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
      const ctx = ctxOf({ ledger: [t(1, { row: 'T1', event: 'ok', from: 'queued', to: 'reviewing' }, 50), review, t(2, x, 30)] })
      expect([x.row, interventionsOf(ctx)]).toEqual([x.row, []])
      expect([x.row, ctx.skipped]).toEqual([x.row, []])
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
        t(2, { row: 'U1', event: 'unknown', from: 'building', to: 'building', step: 'build', cause: 'load', via: 'free:load' }, 50),
        t(3, { row: 'U2', event: 'unknown', from: 'building', to: 'building', step: 'build', via: 'unknown:bad-answer' }, 45),
        t(4, { row: 'U3', event: 'unknown', from: 'building', to: 'building', step: 'triage', via: 'unknown:spawn' }, 40),
        t(5, { row: 'T6', event: 'not-ok', from: 'building', to: 'building', step: 'triage' }, 35),
        t(6, { row: 'U4', event: 'unknown', from: 'building', to: 'parked', via: 'unknown:agent-dead' }, 30),
        t(7, { row: 'T14', event: 'not-ok', from: 'merge-queue', to: 'reviewing', step: 'review', via: 'patch' }, 25),
        t(8, { row: 'E2', event: 'issue-closed', from: 'reviewing', to: 'closed' }, 20),
        t(1, { row: 'E3', event: 'pr-merged', from: 'merge-queue', to: 'closed' }, 20, 572, 'abc'),
        t(1, { row: 'E4', event: 'pr-closed', from: 'reviewing', to: 'parked' }, 20, 573, 'abc'),
        t(1, { row: 'T9', event: 'not-ok', from: 'merge-queue', to: 'fixing', step: 'fix', via: 'fix:ci' }, 20, 574, 'abc'),
        entry(rerunKey({ issue: N, life: LIFE }, 2, '18342299123'), 'ci-rerun', { issue: N }),
        entry(`i${N}/l${LIFE}/s7/pr/body/a1`, 'pr', { issue: N }),
        entry(reclaimKey({ issue: N, life: LIFE }, 'zz1'), 'claim', { issue: N }),
        entry(reconcileKey(600, 'ss1x2k', 'event'), 'event', { issue: 600, rule: 'R1' }),
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
        settings: seenOf('{"maxInFlightIssues":2}'),
        seen: { ...EMPTY_FILES, settings: seenOf('{"maxInFlightIssues":2}'), edits: [{ what: 'config', at: NOW - MIN, issues: [], detail: 'settings changed with no op: maxInFlightIssues' }] },
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
        t(2, { row: 'U1', event: 'unknown', from: 'fixing', to: 'fixing', step: 'fix', cause: 'usage', via: 'free:usage' }, 40),
        t(3, { row: 'U2', event: 'unknown', from: 'fixing', to: 'fixing', step: 'fix', via: 'unknown:rate-limited' }, 30),
      ],
    }
    expect(causes(w)).toEqual(['loop free:usage', 'loop unknown:rate-limited'])
  })
})

// --- why a step went unknown, and what a fixer was sent for: the transition's own via ----------------

describe('unknown:<why> is the transition\'s own via', () => {
  // unknownAt: a U2 whose via code is `unknown:<why>`, or the row's id when it recorded no why
  const unknownAt = (from: IssueState, why: UnknownWhy | null, event: EventKind = 'unknown', more: LedgerEntry[] = []) =>
    ctxOf({ ledger: [t(2, { row: 'T1', event: 'ok', from: 'queued', to: from }, 50), ...more, t(3, { row: 'U2', event, from, to: from, ...(why === null ? {} : { via: `unknown:${why}` }) }, 30)] })

  test('every why, as the transition\'s via code recorded it (table.ts viaOf); a timeout says so itself', () => {
    for (const why of ['timeout', 'agent-dead', 'bad-answer', 'api', 'rate-limited', 'spawn', 'cli', 'github-wait'] as UnknownWhy[]) {
      expect(interventionsOf(unknownAt('building', why)).map(p => p.event.cause)).toEqual([`unknown:${why}`])
    }
    expect(interventionsOf(unknownAt('fixing', null, 'timeout')).map(p => p.event.cause)).toEqual(['unknown:timeout'])
    // the code as the table makes it, for a running step's timeout (rules-state.ts)
    expect(codeOf(record({ state: 'building', step: 'build', attempt: 1 }), { kind: 'unknown', why: 'timeout' })).toBe('unknown:timeout')
  })

  test('other entries of the seq never change it: a reviewer\'s agent-dead stays so beside a later re-run or PR entry (no inference)', () => {
    const later = [
      entry(rerunKey({ issue: N, life: LIFE }, 1, '1'), 'ci-rerun', { issue: N, status: 'failed', startedAt: NOW - 35 * MIN, endedAt: NOW - 34 * MIN }),
      entry(`i${N}/l${LIFE}/s2/pr/ensure/a1`, 'pr', { issue: N, status: 'running', startedAt: NOW - 33 * MIN, endedAt: null }),
    ]
    expect(interventionsOf(unknownAt('reviewing', 'agent-dead', 'unknown', later)).map(p => p.event.cause)).toEqual(['unknown:agent-dead'])
  })

  test('an unknown is logged whatever its why: one the transition did not record is cli, and a recent one is named in the decision log', () => {
    const ctx = unknownAt('building', null)
    expect(interventionsOf(ctx).map(p => [p.event.cause, p.event.reason])).toEqual([['unknown:cli', 'the step in building ended unknown (no why recorded)']])
    expect(ctx.skipped).toEqual([{ rule: 'S3', issue: N, why: `${transitionKey({ issue: N, life: LIFE, seq: 3 })} (U2) recorded no why (via U2): its unknown is logged as unknown:cli` }])
    // an old one is not named again
    const old = ctxOf({ ledger: [t(3, { row: 'U2', event: 'unknown', from: 'building', to: 'building', via: 'nonsense' }, 90)] })
    expect(interventionsOf(old).map(p => p.event.cause)).toEqual(['unknown:cli'])
    expect(old.skipped).toEqual([])
  })
})

describe('fix:ci and fix:conflict (T9): something did not merge as it should', () => {
  const t9 = (from: IssueState, via?: string) => t(2, { row: 'T9', event: 'not-ok', from, to: 'fixing', step: 'fix', ...(via === undefined ? {} : { via }) }, 30)

  test('the transition\'s via code says what the fixer is for: red CI or a conflict are interventions, review findings are not', () => {
    for (const from of ['reviewing', 'merge-queue'] as const) {
      expect(causes({ ledger: [t9(from, 'fix:ci')] })).toEqual(['loop fix:ci'])
      expect(causes({ ledger: [t9(from, 'fix:conflict')] })).toEqual(['loop fix:conflict'])
      expect(causes({ ledger: [t9(from, 'fix:review')], prs: [pr({ mergeable: 'dirty' })] })).toEqual([])
    }
    // the codes as the table makes them from the reviewer's not-ok reasons
    const r = record({ state: 'reviewing', step: 'review' })
    const codes = ['ci-red', 'conflict', 'changes'].map(reason => codeOf(r, { kind: 'not-ok', reason }))
    expect(codes).toEqual(['fix:ci', 'fix:conflict', 'fix:review'])
  })

  test('a T9 that recorded no via is named in the decision log, not guessed from the PR as read', () => {
    const ctx = ctxOf({ ledger: [t9('reviewing')], prs: [pr({ mergeable: 'dirty' })] })
    expect(interventionsOf(ctx)).toEqual([])
    expect(ctx.skipped.map(x => x.why)).toEqual([`${transitionKey({ issue: N, life: LIFE, seq: 2 })} (T9) recorded no via (T9): whether its fixer is for red CI or a conflict is not known`])
  })
})

// --- what a person did, as GitHub and the owner's files show it ---------------------------------------

describe('person interventions', () => {
  test('an unpark by the label is a person\'s; an unpark by /factory resume is the op\'s own: P1\'s via code says which', () => {
    const park = t(2, { row: 'T3', event: 'not-ok', from: 'designing', to: 'parked', via: 'question' }, 50)
    const unpark = (via?: string) => t(3, { row: 'P1', event: 'unpark', from: 'parked', to: 'queued', ...(via === undefined ? {} : { via }) }, 10)
    expect(causes({ ledger: [park, unpark('unpark:label')] })).toEqual(['loop park', 'person unpark'])
    // a resume op, whatever control.json says of it
    expect(causes({ ledger: [park, unpark('unpark:op')] })).toEqual(['loop park'])
    expect(causes({ ledger: [park, unpark('unpark:op')], control: control({ resumed: [] }) })).toEqual(['loop park'])
    // the codes as the table makes them
    const parked = record({ state: 'parked', step: null, resumeTo: 'designing' })
    expect(['label', 'op'].map(reason => codeOf(parked, { kind: 'unpark', reason }))).toEqual(['unpark:label', 'unpark:op'])
    // one that recorded neither is named in the decision log, never guessed
    const ctx = ctxOf({ ledger: [park, unpark()] })
    expect(interventionsOf(ctx).map(p => p.event.cause)).toEqual(['park'])
    expect(ctx.skipped.map(x => x.why)).toEqual([`${transitionKey({ issue: N, life: LIFE, seq: 3 })} (P1) recorded no via (P1): whether factory:parked was removed by hand is not known`])
  })

  test('E4 is a person\'s close of the PR and the park it causes', () => {
    const ivs4 = ivs({ ledger: [t(2, { row: 'E4', event: 'pr-closed', from: 'reviewing', to: 'parked' }, 10)], records: [record({ seq: 2, state: 'parked', question: 'PR #621 was closed by hand; a resume reopens it' })] })
    expect(ivs4.map(p => [p.event.who, p.event.cause])).toEqual([
      ['person', 'pr-closed'],
      ['loop', 'park'],
    ])
    expect(ivs4[1]?.event.reason).toContain('PR #621 was closed by hand')
  })

  test('a park of a multi-line question gives one line: the decision sentence alone (#856)', () => {
    const question = 'Which API?\n\n#### Context\n\nTwo shapes.\n\n#### Options\n\n- [ ] **A** - v1\n- [ ] **B** - v2'
    const ivs3 = ivs({ ledger: [t(2, { row: 'T3', event: 'not-ok', from: 'designing', to: 'parked', via: 'question' }, 10)], records: [record({ seq: 2, state: 'parked', question })] })
    expect(ivs3.find(p => p.event.cause === 'park')?.event.reason).toBe('parked from designing (T3): Which API?')
  })

  test('a restart is a module load after an earlier run, with no restart of the loop\'s own around it, logged while it is recent', () => {
    // an earlier run: the ledger the load found holds an entry from before it
    const earlier = entry('sweep:before', 'sweep', { startedAt: NOW - 30 * MIN, endedAt: NOW - 30 * MIN })
    expect(causes({ loadedAt: NOW - 5 * MIN, ledger: [earlier] })).toEqual(['person restart'])
    expect(causes({ loadedAt: NOW - 2 * 60 * MIN, ledger: [earlier] })).toEqual([])
    // the first start of a loop restarts nothing: every entry is this run's own
    expect(causes({ loadedAt: NOW - 5 * MIN })).toEqual([])
    const own = (over: Partial<LedgerEntry>) => entry('restart:1', 'restart-self', { rule: 'R2', ...over })
    expect(causes({ loadedAt: NOW - 5 * MIN, ledger: [own({ status: 'done', endedAt: NOW - 9 * MIN })] })).toEqual([])
    expect(causes({ loadedAt: NOW - 5 * MIN, ledger: [own({ status: 'lost', endedAt: NOW - 5 * MIN })] })).toEqual([])
    expect(causes({ loadedAt: NOW - 5 * MIN, ledger: [own({ status: 'failed', endedAt: NOW - 9 * MIN })] })).toEqual(['person restart'])
    expect(causes({ loadedAt: NOW - 5 * MIN, ledger: [own({ status: 'done', endedAt: NOW - 3 * 60 * MIN })] })).toEqual(['person restart'])
  })

  test('an intervention is no work a restart would cut: it is written first, and R2 restarts in the same pass', () => {
    const earlier = entry('sweep:before', 'sweep', { startedAt: NOW - 30 * MIN, endedAt: NOW - 30 * MIN })
    const s = stateOf({ loadedAt: NOW - 5 * MIN, ledger: [earlier], control: control({ updateDue: { reason: 'image', at: NOW - MIN } }) })
    const kinds = planV2(s, config({ planner: 'v2', mode: 'act' })).actions.map(a => `${a.kind} ${a.key}`)
    expect(kinds.at(-1)).toBe(`restart-self restart:${NOW - MIN}`)
    expect(kinds.some(k => k.startsWith('event iv/restart/fleet/'))).toBe(true)
  })

  test('a hand edit of the owner\'s files is attached to each issue whose entries changed, else to none', () => {
    const ctl = (c: Partial<Control>) => seenOf(JSON.stringify({ ...control(), ...c }))
    const facts: InterventionFacts = {
      companion: [],
      controlDigest: null,
      configDigest: null,
      control: ctl({ paused: [571, 572] }),
      seen: {
        ...EMPTY_FILES,
        control: ctl({}),
        edits: [
          { what: 'control', at: NOW - 4 * MIN, issues: [], detail: 'the OFF file was created' },
          { what: 'control', at: NOW - MIN, issues: [571, 572], detail: 'control.json changed with no op: paused' },
        ],
      },
    }
    expect(ivs({ facts }).map(p => [p.event.cause, p.event.issue, p.event.fact])).toEqual([
      ['control-file', null, `control-file/fleet/${(NOW - 4 * MIN).toString(36)}`],
      ['control-file', 571, `control-file/i571/${(NOW - MIN).toString(36)}`],
      ['control-file', 572, `control-file/i572/${(NOW - MIN).toString(36)}`],
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
    // a landed `config set|unset` is the settings file changed through the loop
    const cfg = opInterventions({ text: 'config set maxInFlightIssues 3', name: 'config', issues: [], at: NOW })
    expect(cfg.map(e => [e.who, e.cause, e.issue, e.reason])).toEqual([['person', 'config-file', null, 'config set maxInFlightIssues 3']])
    for (const name of ['status', 'help']) expect(opInterventions({ text: name, name, issues: [], at: NOW })).toEqual([])
    // two ops a millisecond apart are two facts
    expect(opInterventions({ text: 'pause', name: 'pause', issues: [], at: NOW + 1 })[0]?.fact).not.toBe(opInterventions({ text: 'pause', name: 'pause', issues: [], at: NOW })[0]?.fact)
  })

  test('an op is an intervention when v2 acts before it or after it: the ops that turn the loop on and off are logged, those far from it are not', () => {
    const landed = (planner: 'v1' | 'v2', mode: 'off' | 'observe' | 'act', text: string) => {
      const [name, word] = text.split(' ')
      const op = (name === 'mode' ? { op: 'mode', mode: word } : name === 'planner' ? { op: 'planner', planner: word } : { op: 'pause', issues: [] }) as never
      return opLanded({ planner, mode }, op, text, [], NOW)?.name ?? null
    }
    expect(landed('v2', 'observe', 'mode act')).toBe('mode')
    expect(landed('v1', 'act', 'planner v2')).toBe('planner')
    expect(landed('v2', 'act', 'mode observe')).toBe('mode')
    expect(landed('v2', 'act', 'planner v1')).toBe('planner')
    expect(landed('v2', 'act', 'pause')).toBe('pause')
    expect(landed('v1', 'observe', 'mode act')).toBeNull()
    expect(landed('v1', 'act', 'pause')).toBeNull()
    expect(landed('v2', 'observe', 'planner v1')).toBeNull()
    expect(opLanded({ planner: 'v2', mode: 'act' }, { op: 'status' } as never, null, [], NOW)).toBeNull()
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

  // A writer that pushed D and then ended with no head read (unknown, lost or failed), so no step
  // outcome names D; the record then waits (parked by U4 or triage, or in review or the queue)
  // with D on its PR, first seen at any time after the writer started. Or a later writer read its
  // own head B, and D was seen before B's step ended, or within a read's lag of it.
  function headlessWorld(g: () => number): World {
    const ended = g()
    const unknown = { kind: 'step' as const, step: 'fix' as const, result: result('unknown', { why: 'agent-dead' }) }
    const writer = step(4, g() < 0.5 ? 'build' : 'fix', 45, ended < 0.4 ? { outcome: unknown } : ended < 0.7 ? { status: 'lost' } : { status: 'failed', agentId: undefined })
    const later = g() < 0.5
    const dSeen = later ? NOW - 45 * MIN + Math.floor(g() * 29 * MIN) : NOW - 45 * MIN + Math.floor(g() * 45 * MIN)
    const states = ['reviewing', 'merge-queue', 'parked'] as const
    return {
      ledger: [
        step(2, 'build', 55, { outcome: { kind: 'step', step: 'build', result: result('ok', { head: H('a') }) } }),
        writer,
        ...(later ? [step(6, 'fix', 25, { endedAt: NOW - 20 * MIN, outcome: { kind: 'step', step: 'fix', result: result('ok', { head: H('b') }) } })] : []),
      ],
      records: [record({ seq: 7, state: states[Math.floor(g() * 3)] as IssueState, step: null, head: later ? H('b') : H('a') })],
      prs: [pr({ head: later && g() < 0.5 ? H('b') : H('d') })],
      heads: { [H('a')]: { pr: 621, at: NOW - 50 * MIN }, [H('d')]: { pr: 621, at: dSeen }, ...(later ? { [H('b')]: { pr: 621, at: NOW - 19 * MIN } } : {}) },
    }
  }

  test('no interleaving of the loop\'s writes and late reads gives a push: writers that read their head, writers that ended unknown, queue updates', () => {
    let s = 1
    const g = () => {
      // unsigned, so every draw is in [0, 1)
      s = ((Math.imul(s, 48271) + 11) >>> 0) % 2147483647
      return s / 2147483647
    }
    for (let i = 0; i < 400; i += 1) expect(causes(loopWorld(g))).toEqual([])
    for (let i = 0; i < 400; i += 1) expect(causes(headlessWorld(g))).toEqual([])
  })

  test('a builder or fixer that ended unknown, then the record parked with its head on the PR: the loop\'s, not a push', () => {
    const fixer = step(4, 'fix', 45, { outcome: { kind: 'step', step: 'fix', result: result('unknown', { why: 'agent-dead' }) } })
    const w: World = { ledger: [fixer], records: [record({ state: 'parked', step: null, head: H('a') })], prs: [pr({ head: H('d') })], heads: { [H('a')]: { pr: 621, at: NOW - 50 * MIN }, [H('d')]: { pr: 621, at: NOW - 5 * MIN } } }
    expect(causes(w)).toEqual([])
    // a later writer that read its own head bounds it: a new head seen well after that one ended is a person's
    const later = step(6, 'fix', 30, { endedAt: NOW - 25 * MIN, outcome: { kind: 'step', step: 'fix', result: result('ok', { head: H('b') }) } })
    expect(causes({ ...w, ledger: [fixer, later], records: [record({ state: 'reviewing', head: H('b') })] })).toEqual(['person push'])
    // and a head seen before the writer started is not its own
    expect(causes({ ...w, heads: { ...w.heads, [H('d')]: { pr: 621, at: NOW - 46 * MIN } } })).toEqual(['person push'])
  })

  test('a head first seen longer ago than the ledger keeps an intervention\'s key is not judged again', () => {
    const life = (Math.floor(NOW / 1000) - 8 * 24 * 3600).toString(36)
    const w = (at: number): World => ({ records: [record({ life, head: H('a') })], prs: [pr({ head: H('9') })], heads: { [H('9')]: { pr: 621, at } } })
    expect(causes(w(NOW - FACT_WINDOW_MS + MIN))).toEqual(['person push'])
    expect(causes(w(NOW - FACT_WINDOW_MS - MIN))).toEqual([])
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
      JSON.stringify({ at: NOW - 4 * MIN, issue: N, life: LIFE, seq: 4, cause: 'prompt-denied', reason: 'Bash: factory-loop-workspace: this Bash call would wait on a person nobody watches' }),
      '',
    ].join('\n')
    const lines = companionLines(text, NOW)
    expect(lines.map(l => [l.cause, l.issue])).toEqual([
      ['guard:write', N],
      ['gate-unknown', null],
      ['guard:command', N],
      ['prompt-denied', N],
    ])
    const p = ivs({ facts: { companion: lines, controlDigest: null, configDigest: null } })
    expect(p.map(x => [x.event.who, x.event.cause, x.event.issue])).toEqual([
      ['loop', 'guard:write', N],
      ['loop', 'gate-unknown', null],
      ['loop', 'guard:command', N],
      ['loop', 'prompt-denied', N],
    ])
    expect(new Set(p.map(x => x.key)).size).toBe(4)
  })

  test('a fact is judged only while the rebuild of a wiped store reads whether it is logged, so it cannot log it twice (R4-F5)', () => {
    expect(FACT_WINDOW_MS).toBeLessThan(REBUILD_DAYS * 24 * 60 * MIN)
    expect(COMPANION_WINDOW_MS).toBe(FACT_WINDOW_MS)
  })
})

// --- the owner's files against the versions the loop kept (sources-interventions.ts, store.ts) ---------

describe('hand edits of control.json, the OFF file and the settings', () => {
  const BASE = LOOP_DIR.replace(/\/[^/]+$/, '')
  const CONTROL = `${LOOP_DIR}/control.json`
  const WORKSPACE = `${BASE}/config.json`
  function rtOf(over: Partial<Runtime> = {}, cfg = config({ planner: 'v2' })): Runtime {
    return { mode: 'act', repo: REPO, device: DEVICE, runSource: 'local', poolSize: 16, cwd: '/work', loopDir: LOOP_DIR, sink: null, env: {}, toolsDir: TOOLS, pluginRoot: PLUGIN_ROOT, config: cfg, configProblems: [], ...over }
  }
  // one pass's read over these files
  async function read(files: Record<string, string>, rt: Runtime = rtOf(), fail: string[] = []) {
    return readInterventions({
      now: NOW,
      rt,
      run: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
      readFile: async (path: string) => {
        if (fail.includes(path)) throw new Error('EACCES')
        return files[path] ?? null
      },
      state: state(),
      records: [],
      heads: {},
      prBudget: 0,
      limited: () => false,
      unread: [],
      kept: [],
    })
  }
  const ctl = (c: Partial<Control>) => JSON.stringify({ ...control(), ...c })
  // the facts a pass would plan from, with what the loop kept
  async function factsOf(files: Record<string, string>, seen: FilesSeen | null, rt?: Runtime) {
    return { ...(await read(files, rt)).read, seen }
  }
  // the version a pass would keep at NOW, with every intervention it found logged (or none)
  const kept = (facts: InterventionFacts, logged: boolean) => keepFiles(facts.seen ?? null, facts, NOW, () => logged)
  // the hand edits a pass's read gives, logged from the next pass on (none logged yet)
  const editsAfter = (facts: InterventionFacts) => fileFacts({ ...facts, seen: kept(facts, false) ?? facts.seen ?? null })
  const causesOf = (facts: InterventionFacts) => editsAfter(facts).map(f => [f.cause, f.issue, f.detail])
  function memStore(init: Record<string, unknown> = {}) {
    const m = new Map<string, unknown>(Object.entries(init))
    const io: V2StoreIo = { get: async k => m.get(k), set: async (k, v) => void m.set(k, v), now: async () => NOW }
    return { m, io }
  }

  test('the read: control.json, the workspace file and the repo-local settings file as they are', async () => {
    const r = await read({ [CONTROL]: ctl({}), [WORKSPACE]: '{"mode":"act","passEvery":"2m"}' }, rtOf({ repoSettings: { maxInFlightIssues: 2 } }, config({ planner: 'v2', maxInFlightIssues: 2, passEveryMs: 120_000 })))
    expect(r.source).toEqual({ ok: true, at: NOW })
    expect(r.read.control).toEqual(seenOf(ctl({})))
    expect(r.read.workspace?.text).toBe('{"mode":"act","passEvery":"2m"}')
    expect(r.read.settings).toEqual(seenOf('{"maxInFlightIssues":2}'))
    expect(r.read.controlDigest).toBe(digest(ctl({})))
    // a missing file reads as empty; one that cannot be read is unknown, and the source says why
    expect((await read({})).read.control).toEqual(seenOf(''))
    const failed = await read({ [CONTROL]: ctl({}) }, rtOf(), [CONTROL])
    expect(failed.read.control).toBeNull()
    expect(failed.source).toMatchObject({ ok: false, error: expect.stringContaining('EACCES') })
    // settings not read from origin's default branch stand in for this pass only: not compared
    expect((await read({}, rtOf({ repoSettings: null }))).read.settings).toBeNull()
  })

  test('a change against the version kept is one intervention per issue whose entries changed, else one for the fleet, keyed by when it was found', async () => {
    const seen: FilesSeen = { ...EMPTY_FILES, control: seenOf(ctl({})) }
    const facts = await factsOf({ [CONTROL]: ctl({ paused: [571], skip: [9] }) }, seen)
    expect(causesOf(facts)).toEqual([
      ['control-file', 9, 'control.json changed with no op: paused, skip'],
      ['control-file', 571, 'control.json changed with no op: paused, skip'],
    ])
    expect(editsAfter(facts)[0]?.fact).toBe(`control-file/i9/${NOW.toString(36)}`)
    expect(causesOf(await factsOf({ [CONTROL]: ctl({ serial: true }) }, seen))).toEqual([['control-file', null, 'control.json changed with no op: serial']])
    // no version kept yet, a change of layout only, or the loop's own clearing of a done update: none
    expect(causesOf(await factsOf({ [CONTROL]: ctl({ paused: [1] }) }, null))).toEqual([])
    expect(causesOf(await factsOf({ [CONTROL]: JSON.stringify({ ...control() }, null, 2) }, seen))).toEqual([])
    const due: FilesSeen = { ...EMPTY_FILES, control: seenOf(ctl({ updateDue: { reason: 'image', at: 1 } })) }
    expect(causesOf(await factsOf({ [CONTROL]: ctl({ updateDue: null }) }, due))).toEqual([])
  })

  test('a settings change is one fleet-level config-file, from the workspace file or the repo-local settings file', async () => {
    const before = await factsOf({ [WORKSPACE]: '{"mode":"act"}' }, null, rtOf({ repoSettings: { maxInFlightIssues: 3 } }))
    const seen = kept(before, true) as FilesSeen
    const repo = await factsOf({ [WORKSPACE]: '{"mode":"act"}' }, seen, rtOf({ repoSettings: { maxInFlightIssues: 2 } }))
    expect(causesOf(repo)).toEqual([['config-file', null, 'settings changed with no op: maxInFlightIssues']])
    const hand = await factsOf({ [WORKSPACE]: '{"mode":"observe","binDir":"/x"}' }, seen, rtOf({ repoSettings: { maxInFlightIssues: 3 } }))
    expect(causesOf(hand)).toEqual([['config-file', null, 'settings changed with no op: config.json binDir, config.json mode']])
    // a pass whose settings were not read keeps the settings it had and logs the workspace edit once;
    // the next pass that reads them finds no edit of its own
    const blind = await factsOf({ [WORKSPACE]: '{"mode":"observe","binDir":"/x"}' }, seen, rtOf({ repoSettings: null }))
    const afterBlind = kept(blind, false) as FilesSeen
    expect(afterBlind.settings).toEqual(seen.settings)
    expect(afterBlind.edits).toEqual([{ what: 'config', at: NOW, issues: [], detail: 'settings changed with no op: config.json binDir, config.json mode' }])
    const sighted = await factsOf({ [WORKSPACE]: '{"mode":"observe","binDir":"/x"}' }, afterBlind, rtOf({ repoSettings: { maxInFlightIssues: 3 } }))
    expect((keepFiles(afterBlind, sighted, NOW + 1, () => false) ?? afterBlind).edits).toEqual(afterBlind.edits)
  })

  // drill run 2 (R2-F6): a change back to a version logged before was taken as logged, its fact
  // keyed by the new version's digest
  test('the version read is kept at once, with its change as an edit kept until logged; a change back is an edit again', async () => {
    const seen: FilesSeen = { ...EMPTY_FILES, control: seenOf(ctl({})) }
    const facts = await factsOf({ [CONTROL]: ctl({ paused: [5] }) }, seen)
    const next = kept(facts, false) as FilesSeen
    expect(next.control).toEqual(seenOf(ctl({ paused: [5] })))
    expect(next.edits).toEqual([{ what: 'control', at: NOW, issues: [5], detail: 'control.json changed with no op: paused' }])
    // the next pass plans it, and keeps it until it is logged; then it goes
    const again = await factsOf({ [CONTROL]: ctl({ paused: [5] }) }, next)
    expect(fileFacts(again).map(f => f.fact)).toEqual([`control-file/i5/${NOW.toString(36)}`])
    expect(keepFiles(next, again, NOW + 1, () => false)).toBeNull()
    const done = keepFiles(next, again, NOW + 1, () => true) as FilesSeen
    expect(done.edits).toEqual([])
    // a change back to the version before is an edit of its own, with its own key
    const back = keepFiles(done, await factsOf({ [CONTROL]: ctl({}) }, done), NOW + 2, () => true) as FilesSeen
    expect(back.control).toEqual(seenOf(ctl({})))
    expect(back.edits.flatMap(editFacts).map(f => f.fact)).toEqual([`control-file/i5/${(NOW + 2).toString(36)}`])
    // the first acting read keeps what it reads, with no edit
    expect(kept(await factsOf({ [CONTROL]: ctl({}) }, null), false)).toMatchObject({ control: seenOf(ctl({})), edits: [] })
    // an op that wrote since the pass read keeps the op's version, and no edit (the op keeps what it found)
    const op = { ...seen, control: seenOf(ctl({ serial: true })) }
    expect(keepFiles(op, facts, NOW, () => true)).toMatchObject({ control: op.control, edits: [] })
  })

  test('an op\'s write is the loop\'s own: the next read finds no edit; one it found already changed by hand is kept and logged once', async () => {
    const { m, io } = memStore({ [filesKey(REPO)]: { ...EMPTY_FILES, control: seenOf(ctl({})) } })
    const live = newV2Live()
    const files: Record<string, string> = { [CONTROL]: ctl({}) }
    const fio = notingIo({ readFile: async p => files[p] ?? null, writeFile: async (p, b) => void (files[p] = b) }, noteWritten(live, io, rtOf()))
    await fio.writeFile(CONTROL, ctl({ paused: [7] }))
    const afterOp = m.get(filesKey(REPO)) as FilesSeen
    expect(afterOp.control).toEqual(seenOf(ctl({ paused: [7] })))
    expect(afterOp.edits).toEqual([])
    expect(causesOf(await factsOf(files, afterOp))).toEqual([])
    // a person adds a skip by hand, then an op writes over it: the hand edit is kept to log
    files[CONTROL] = ctl({ paused: [7], skip: [8] })
    await fio.writeFile(CONTROL, ctl({ paused: [7, 9], skip: [8] }))
    const afterHand = m.get(filesKey(REPO)) as FilesSeen
    expect(afterHand.edits).toEqual([{ what: 'control', at: NOW, issues: [8], detail: 'control.json changed with no op: skip' }])
    const facts = await factsOf(files, afterHand)
    expect(causesOf(facts)).toEqual([['control-file', 8, 'control.json changed with no op: skip']])
    // once logged, the edit goes
    expect(kept(facts, true)?.edits).toEqual([])
    // the workspace file the same way; another path is not an owner's file
    files[WORKSPACE] = '{"mode":"act"}'
    await fio.writeFile(WORKSPACE, '{"mode":"observe"}')
    expect((m.get(filesKey(REPO)) as FilesSeen).workspace).toEqual(seenOf('{"mode":"observe"}'))
    await fio.writeFile(`${LOOP_DIR}/other.json`, '{}')
    // nothing is kept before the loop keeps any
    const empty = memStore()
    await notingIo({ readFile: async () => null, writeFile: async () => undefined }, noteWritten(newV2Live(), empty.io, rtOf())).writeFile(CONTROL, ctl({}))
    expect(empty.m.size).toBe(0)
  })

  test('the kill switch is a person\'s edit, kept once per use, only while v2 acts', async () => {
    const { m, io } = memStore()
    const live = newV2Live()
    expect(await noteKillSwitch(live, io, rtOf(), true)).toBe(true)
    expect(await noteKillSwitch(live, io, rtOf(), true)).toBe(true)
    const f = m.get(filesKey(REPO)) as FilesSeen
    expect([f.off, f.edits]).toEqual([true, [{ what: 'control', at: NOW, issues: [], detail: 'the OFF file was created' }]])
    expect(causesOf({ companion: [], controlDigest: null, configDigest: null, seen: f })).toEqual([['control-file', null, 'the OFF file was created']])
    // the next acting pass clears the flag; the edit goes once logged
    const facts = await factsOf({ [CONTROL]: ctl({}) }, f)
    expect(kept(facts, false)).toMatchObject({ off: false, edits: f.edits })
    expect(kept(facts, true)).toMatchObject({ off: false, edits: [] })
    // off, observe or planner v1: not kept
    for (const rt of [rtOf({ mode: 'observe' }), rtOf({}, config({ planner: 'v1' }))]) {
      const other = memStore()
      expect(await noteKillSwitch(newV2Live(), other.io, rt, true)).toBe(true)
      expect(other.m.size).toBe(0)
    }
    expect(await noteKillSwitch(newV2Live(), memStore().io, rtOf(), false)).toBe(false)
  })

  test('controlDiff names the fields and the issues whose entries came or went', () => {
    const text = (c: Partial<Control>) => JSON.stringify({ ...control(), ...c })
    expect(controlDiff(text({}), text({}))).toBeNull()
    expect(controlDiff(text({ resumed: [{ subject: 'issue:7', at: 1 }] }), text({ resumed: [] }))).toEqual({ fields: ['resumed'], issues: [7] })
    expect(controlDiff(text({}), text({ dropped: [{ issue: 3, at: 1 }], notes: [{ issue: null, text: 'x', at: 1 }] }))).toEqual({ fields: ['dropped', 'notes'], issues: [3] })
    expect(controlDiff(text({ updateDue: null }), text({ updateDue: { reason: 'x', at: 2 } }))).toEqual({ fields: ['updateDue'], issues: [] })
    expect(controlDiff('', text({}))).toMatchObject({ fields: expect.arrayContaining(['paused']) })
  })
})

// --- the driver: the kill switch, an op, a hand edit (register.ts, v2 SPEC 7.2) ------------------------

describe('the owner\'s files in the pass driver', () => {
  const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
  const OFF = `${CFG_DIR}/factory-loop/OFF`
  const USAGE = 'five_hour=40 resets_at=2026-10-13T05:00:00Z resets_in=1 seven_day=60 seven_day_resets_at=2026-10-16T11:00:00Z seven_day_resets_in=1 source=oauth'
  const quiet = (argv: string[], s: { stdin?: string }) => {
    switch (argv[0]) {
      case 'callum-flow-factory-state':
        return { stdout: factoryDoc([]) }
      case 'dev-query':
        return { stdout: (s.stdin ?? '').includes('workers_status') ? QUIET_BEATS : NO_EVENTS }
      case `${TOOLS}/queue-watch.sh`:
        return { stdout: 'queue known=none now=none\n' }
      case `${TOOLS}/usage-check.sh`:
        return { stdout: USAGE }
      case 'callum-flow-issue-read':
        return { stdout: JSON.stringify({ issues: [], stripped: 0 }) }
      case 'treehouse':
        return { stdout: '[]' }
    }
    return undefined
  }
  const ACT_V2 = { repo: REPO, mode: 'act', checkout: '/work', planner: 'v2' }
  const fileIvs = (line: Record<string, unknown>) => (line.actions as { key: string }[]).map(a => a.key).filter(k => /^iv\/(control|config)-file\//.test(k))

  test('the kill switch on for a pass, then off: exactly one control-file intervention, the next acting pass\'s', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: ACT_V2, run: quiet, files: { [OFF]: '' } })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.titles).toEqual(['🔄 dev-system · off'])
    await clock.advance(60_000)
    h.files.delete(OFF)
    await clock.advance(60_000)
    expect(h.last()).toMatchObject({ executed: true, planner: 'v2' })
    expect(fileIvs(h.last())).toEqual([`iv/control-file/fleet/${(NOW + 5_000).toString(36)}`])
    expect((h.store.get(filesKey(REPO)) as FilesSeen).off).toBe(false)
  })

  test('an op\'s write is no hand edit; a hand edit between passes is one', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const h = host(on, { config: ACT_V2, run: quiet })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(fileIvs(h.last())).toEqual([])
    const r = await $.command.run({ command: 'factory', args: 'pause 12', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    expect(r.text).toStartWith('Paused #12')
    await clock.advance(61_000)
    expect(fileIvs(h.last())).toEqual([])
    // by hand: a skip added to control.json
    const path = `${LOOP_DIR}/control.json`
    h.files.set(path, JSON.stringify({ ...JSON.parse(h.files.get(path) ?? '{}'), skip: [13] }))
    await clock.advance(61_000)
    // the pass that finds it keeps it; the next logs it
    expect(fileIvs(h.last())).toEqual([])
    await clock.advance(61_000)
    expect(fileIvs(h.last())).toEqual([expect.stringMatching(/^iv\/control-file\/i13\//)])
  })

  // fault drill 1 (2026-10-15): the operator's hand edit of config.json, mode off -> act, was not
  // logged: the loop had kept no version of the file, so the first acting read had nothing to
  // compare against
  test('a hand edit that turns the loop on is one config-file intervention, found by the first acting pass; an op that turns it on is not', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const path = `${CFG_DIR}/factory-loop/config.json`
    const h = host(on, { config: { ...ACT_V2, mode: 'off' }, run: quiet })
    await $.session.start(START)
    await clock.advance(6_000)
    expect(h.titles).toEqual(['🔄 dev-system · off'])
    // by hand: mode off -> act
    h.files.set(path, JSON.stringify(ACT_V2))
    await clock.advance(60_000)
    expect(h.last()).toMatchObject({ executed: true, planner: 'v2' })
    expect(fileIvs(h.last())).toEqual([])
    await clock.advance(60_000)
    expect(fileIvs(h.last())).toEqual([expect.stringMatching(/^iv\/config-file\/fleet\//)])
    const iv = h.events().find(e => e[1] === 'intervention' && (e.at(-1) ?? '').includes('cause=config-file'))
    expect(iv?.at(-1)).toContain('reason=settings%20changed%20with%20no%20op:%20config.json%20mode')
    // once
    await clock.advance(60_000)
    expect(fileIvs(h.last())).toEqual([])
    // the op: observe, then `/factory mode act`, logged as the op alone
    const r = await $.command.run({ command: 'factory', args: 'mode observe', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    expect(JSON.parse(h.files.get(path) ?? '{}').mode).toBe('observe')
    expect(r.text).not.toBe('')
    await clock.advance(60_000)
    expect(h.last()).toMatchObject({ mode: 'observe', executed: false })
    await $.command.run({ command: 'factory', args: 'mode act', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    await clock.advance(60_000)
    expect(h.last()).toMatchObject({ mode: 'act', executed: true })
    expect(fileIvs(h.last())).toEqual([])
    expect(h.events().filter(e => (e.at(-1) ?? '').includes('cause=config-file'))).toHaveLength(1)
  })

  // drill run 2 (R2-F1): a new build that adds a setting's default (maxLives) was logged as a
  // person's edit of the settings, which no one had changed. What is kept and compared is the
  // repo-local file as written (origin's under planner v2), never the settings this build resolves
  // from it; a pass that cannot read origin's file compares none.
  test('the settings compared are origin\'s file as written: a kept version without the defaults is no edit, one key changed is one', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const written = JSON.stringify({ planner: 'v2', readyLabel: 'from-origin' })
    let origin: { exitCode?: number; stdout?: string; stderr?: string } = { stdout: written }
    const h = host(on, {
      config: ACT_V2,
      run: (argv, s) => (argv.join(' ') === 'git show origin/main:.claude/factory-loop.json' ? origin : quiet(argv, s)),
      files: { '/work/.claude/factory-loop.json': JSON.stringify({ planner: 'v2', readyLabel: 'from-tree' }) },
      store: { [filesKey(REPO)]: { ...EMPTY_FILES, settings: seenOf(written) } },
    })
    const logged = () => h.events().filter(e => (e.at(-1) ?? '').includes('cause=config-file'))
    const passes = async (n: number) => {
      for (let i = 0; i < n; i += 1) await clock.advance(60_000)
    }
    await $.session.start(START)
    await clock.advance(6_000)
    await passes(2)
    expect(h.last()).toMatchObject({ executed: true, planner: 'v2' })
    expect(logged()).toEqual([])
    // origin's branch not read (past githubEveryMs): the checkout's file stands, and is not compared
    origin = { exitCode: 128, stderr: "fatal: invalid object name 'origin/main'." }
    await passes(6)
    expect(h.last().config).toEqual([expect.stringContaining("settings: origin's default branch not read")])
    expect(logged()).toEqual([])
    // read again, one key changed: one config-file, naming that key alone
    origin = { stdout: JSON.stringify({ planner: 'v2', readyLabel: 'go' }) }
    await passes(6)
    expect(logged()).toHaveLength(1)
    expect(logged()[0]?.at(-1)).toContain('reason=settings%20changed%20with%20no%20op:%20readyLabel')
  })

  // drill run 2 (R2-F3, R2-F6): an edit back to a version logged before (mode act -> off -> act, a
  // lowered setting restored) was taken as logged, its fact keyed by the new version's digest
  test('every hand edit is one config-file intervention, an edit back to an earlier version too', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const path = `${CFG_DIR}/factory-loop/config.json`
    const h = host(on, { config: { ...ACT_V2, mode: 'off' }, run: quiet })
    await $.session.start(START)
    await clock.advance(6_000)
    const logged = () => h.events().filter(e => (e.at(-1) ?? '').includes('cause=config-file')).length
    const byHand = async (cfg: Record<string, unknown>) => {
      h.files.set(path, JSON.stringify(cfg))
      for (let i = 0; i < 3; i += 1) await clock.advance(60_000)
    }
    await byHand(ACT_V2)
    expect(logged()).toBe(1)
    await byHand({ ...ACT_V2, usageSlowPct: 10 })
    expect(logged()).toBe(2)
    await byHand(ACT_V2)
    expect(logged()).toBe(3)
    // off is not seen by an acting pass; the edit that turns the loop on again is
    await byHand({ ...ACT_V2, mode: 'off' })
    await byHand(ACT_V2)
    expect(logged()).toBe(4)
  })

  // drill run 4 (R4-F5, drill 9): the store wiped, #38's guard interventions, still in
  // companion.jsonl, were logged a second time: "logged once" lived in the ledger alone
  test('after a wiped store, a fact the event log already holds is not logged again; a new one is logged once (drill run 4, R4-F5)', ENGINE_TEST, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const line = (ago: number, cause: string, reason: string) => ({ at: NOW - ago, issue: 38, life: 'tmz7hm', seq: 7, cause, reason })
    // logged 4 days ago: past the facts read's 3 days, within the rebuild's week
    const before = line(4 * 24 * 60 * MIN, 'guard:push', 'a push to main')
    const fresh = line(2 * MIN, 'guard:write', 'wrote outside its slot')
    const factOf = (l: ReturnType<typeof line>) => factKey(l.cause, 'i38', Math.trunc(l.at).toString(36))
    // the event log: the first line's intervention, logged before the wipe, which only the week read holds
    const note = eventNote(intervention('loop', before.cause, factOf(before), before.reason, { issue: 38, life: before.life, pr: null }))
    const events = `${NO_EVENTS}${iso(before.at + 5_000)},intervention,38,,,,,"${note}",agent,${DEVICE}\n`
    const h = host(on, {
      config: ACT_V2,
      run: (argv, s) => (argv[0] === 'dev-query' && !(s.stdin ?? '').includes('workers_status') ? { stdout: argv.includes(`days=${REBUILD_DAYS}`) ? events : NO_EVENTS } : quiet(argv, s)),
      files: { [`${LOOP_DIR}/companion.jsonl`]: `${[before, fresh].map(l => JSON.stringify(l)).join('\n')}\n` },
    })
    await $.session.start(START)
    await clock.advance(6_000)
    await clock.advance(60_000)
    expect(h.last()).toMatchObject({ executed: true, planner: 'v2' })
    expect(h.events().filter(e => e[1] === 'intervention').map(e => noteToken(e.at(-1) ?? '', 'fact'))).toEqual([factOf(fresh)])
    // the ledger holds the logged one again, settled with no write
    expect(h.entry(interventionKey(factOf(before)))).toMatchObject({ status: 'done', summary: 'intervention already in the event log' })
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
  const families = ['op', 'unpark', 'push', 'hand-merge', 'pr-closed', 'issue-closed', 'control-file', 'config-file', 'restart', 'reconcile', 'rescue', 'triage', 'unknown', 'free', 'park', 'fix', 'ci-rerun', 'queue', 'guard', 'gate-unknown', 'prompt-denied', 'tripwire', 'breaker', 'stalled', 'workspace', 'reclaim', 'wake']
  const check = (e: InterventionEvent) => {
    expect(families).toContain(e.cause.split(':')[0])
    expect(e.reason).not.toMatch(/\n/)
    expect(e.reason.length).toBeLessThanOrEqual(200)
    if (e.issue !== null) expect(keyParts(`i${e.issue}/lx`)).not.toBeNull()
  }
  for (const p of interventionsOf(ctxOf({ ledger: [t(2, { row: 'U4', event: 'unknown', from: 'fixing', to: 'parked' }, 10)], loadedAt: NOW }))) check(p.event)
})
