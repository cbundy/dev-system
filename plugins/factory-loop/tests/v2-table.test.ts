// The transition table's properties (docs/factory-loop/v2/SPEC.md 4.3, 4.6, 17.1), over generated
// records (every state, step, attempt, counter, cut flag, PR and head) and events (every kind, with
// every guard input: each not-ok reason, an unknown with and without each outside cause, each
// triage choice with and without commits): totality against 4.3's grid, exclusivity (rowFor throws
// on two rows), reachability, one label, the record's shape after every row, bounded work, the
// unknown path, and the edges of an unpark. No test here asserts an exact ledger key.
import { describe, expect, test } from 'claude-code/testing'

import { renderQuestion } from '../hooks/v2/question.mjs'
import { recordOf } from '../hooks/v2/observe'
import { LIVE_STATES, NOT_OK_REASONS, ROW_IDS, STEP_STATES, TABLE, madeRecord, nextRecord, normalize, rowFor, viaOf, tellPeriodic } from '../hooks/v2/table'
import { EVENT_KINDS, ISSUE_STATES, OUTSIDE_CAUSES, STATE_STEP, TRIAGE_CHOICES, labelOf } from '../hooks/v2/types'
import type { EventKind, IssueRecord, IssueState, StepKind, TableEvent } from '../hooks/v2/types'
import { NOW, config } from './fixtures'

const CFG = config()
const FIX_CAP = CFG.reviewFixCap
const MAX_TRIAGES = CFG.maxTriages
const HEAD = '9e01b77c0ffee0000000000000000000000000aa'

const base: IssueRecord = madeRecord({ issue: 471, life: 'ss1x2k', branch: 'issue-471', pr: null, others: [] }, NOW - 60_000)

// The steps each state may run (4.2): its own, or triage in a step state.
const STEPS_OF: Readonly<Record<IssueState, readonly (StepKind | null)[]>> = {
  queued: ['lease'],
  designing: ['design', 'triage'],
  building: ['build', 'triage'],
  reviewing: ['review', 'triage'],
  fixing: ['fix', 'triage'],
  'merge-queue': ['queue', 'triage'],
  parked: [null],
  waiting: [null],
  closed: [null],
}

// records: every (state, step) with each attempt, cut flag, counter at and past its limit, PR and
// head, and where a queued or parked record resumes.
function records(): IssueRecord[] {
  const out: IssueRecord[] = []
  for (const state of ISSUE_STATES) {
    for (const step of STEPS_OF[state]) {
      for (const attempt of [1, 2]) {
        for (const cut of [false, true]) {
          for (const triages of [0, MAX_TRIAGES - 1, MAX_TRIAGES]) {
            for (const fixes of [0, FIX_CAP - 1, FIX_CAP]) {
              for (const pr of [null, 512]) {
                for (const head of [null, HEAD]) {
                  const resumeTo: IssueState | null = state === 'queued' ? (pr === null ? null : 'reviewing') : state === 'parked' ? 'building' : state === 'waiting' ? 'designing' : null
                  const wait = state === 'waiting' ? [{ kind: 'issue-closed' as const, issue: 57 }, { kind: 'pr-merged' as const, pr: 812 }] : null
                  out.push({ ...base, state, step, attempt, cut, triages, fixes, pr, head, resumeTo, why: state === 'closed' ? 'merged' : null, question: state === 'parked' ? 'which API?' : null, wait })
                }
              }
            }
          }
        }
      }
    }
  }
  return out
}

// events: every kind, with each guard input it can carry.
function eventsOf(kind: EventKind): TableEvent[] {
  switch (kind) {
    case 'not-ok':
      return [...new Set(Object.values(NOT_OK_REASONS).flat()), 'weird', undefined].map(reason => ({ kind, reason, data: { text: 'a reason', conditions: [{ kind: 'issue-closed' as const, issue: 57 }, { kind: 'pr-merged' as const, pr: 812 }] } }))
    case 'unknown':
      return [undefined, ...OUTSIDE_CAUSES].flatMap(cause => ['timeout', 'agent-dead'].map(why => ({ kind, cause, why: why as TableEvent['why'], reason: 'no answer' })))
    case 'triage':
      return TRIAGE_CHOICES.flatMap(choice => [true, false].map(commits => ({ kind, choice, reason: 'the build needs a sharper brief', data: { commits, instructions: 'do it', question: 'which API?' } })))
    case 'timeout':
      // a running step's timeout may come while the tier stops new work or the breaker is open
      return [undefined, ...OUTSIDE_CAUSES].map(cause => ({ kind, cause }))
    // GitHub's PR events name the PR they are about, or none (the life has no PR: E7)
    case 'pr-closed':
      return [{ kind, data: { closedAt: '2026-10-15T10:00:00Z' } }, { kind, data: { closedAt: '2026-10-15T10:00:00Z', pr: 512 } }]
    case 'pr-merged':
      return [{ kind, data: { head: HEAD } }, { kind, data: { head: HEAD, pr: 512 } }]
    case 'unpark':
      return [{ kind, reason: 'op', data: { note: 'use the v2 API' } }]
    default:
      return [{ kind, data: { head: HEAD, brief: 'https://github.com/cbundy/dev-system/issues/471#issuecomment-1', patch: 'f00dfeed', pr: 512 } }]
  }
}

const ALL_EVENTS: TableEvent[] = EVENT_KINDS.flatMap(eventsOf)

// The sweeps over every record and event take a few seconds alone, and more while other suites
// share the machine (npm test runs them side by side): room past the default 5 s, so a busy
// machine never fails them.
const SWEEP = { timeoutMs: 30_000 }

// The rows 4.3's totality grid allows in each cell, by state, whether the record runs its own step
// or triage, and the event kind. A not-ok whose reason the state's own step cannot give is unknown
// (normalize), so U2 to U4 join those cells.
const U_OWN = ['U1', 'U2', 'U3', 'U4']
const U_TRIAGE = ['U1', 'U2', 'U4']
function expected(state: IssueState, onTriage: boolean, kind: EventKind): string[] {
  const owner: Partial<Record<EventKind, string[]>> = {
    drop: ['E1'],
    'issue-closed': ['E2'],
    'pr-merged': ['E3', 'E7'],
    'pr-closed': state === 'parked' ? ['E7'] : ['E4', 'E7'],
    'claim-lost': ['E5'],
    unpark: state === 'parked' || state === 'waiting' ? ['P1'] : ['E7'],
    // every condition of a waiting record holds: C1; nowhere else
    cleared: state === 'waiting' ? ['C1'] : ['E7'],
  }
  if (state === 'closed') return ['E7']
  if (owner[kind] !== undefined) return owner[kind] ?? []
  if (state === 'parked' || state === 'waiting') return kind === 'timeout' ? ['E6'] : ['E7']
  if (state === 'queued') return kind === 'ok' ? ['T1'] : kind === 'timeout' ? ['E6'] : ['E7']
  if (onTriage) {
    if (kind === 'triage') return ['X1', 'X2', 'X3', 'X4', 'X5']
    if (kind === 'unknown' || kind === 'timeout') return U_TRIAGE
    return ['E7']
  }
  const own: Record<string, { ok: string[]; notOk: string[] }> = {
    designing: { ok: ['T2'], notOk: ['T3', 'T4', 'T16', 'T18'] },
    building: { ok: ['T5'], notOk: ['T6', 'T7'] },
    reviewing: { ok: ['T8'], notOk: ['T9', 'T10'] },
    fixing: { ok: ['T11'], notOk: ['T12', 'T17'] },
    'merge-queue': { ok: ['T13'], notOk: ['T9', 'T10', 'T14', 'T15'] },
  }
  const cell = own[state] ?? { ok: [], notOk: [] }
  if (kind === 'ok') return cell.ok
  // a not-ok the step cannot give is its unknown, with no outside cause: never a free re-run
  if (kind === 'not-ok') return [...cell.notOk, 'U2', 'U3', 'U4']
  if (kind === 'unknown') return U_OWN
  // a `timeout` event in the merge queue's own step is a record waiting behind the head (E6); the
  // head's step runs, and a running step's timeout comes as its unknown (why timeout), the
  // unknown cell above: U1 to U4 (rules-state.ts)
  if (kind === 'timeout') return state === 'merge-queue' ? ['E6'] : U_OWN
  return ['E7']
}

describe('the table (v2 SPEC 4.3, 4.6)', () => {
  test('38 rows, the spec\'s, held as data; S0 and S7 make a record and rowFor never returns them', SWEEP, () => {
    expect(ROW_IDS).toEqual(['S0', 'S7', 'T1', 'T2', 'T3', 'T4', 'T16', 'T18', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12', 'T17', 'T13', 'T14', 'T15', 'U1', 'U2', 'U3', 'U4', 'X1', 'X2', 'X3', 'X4', 'X5', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'C1', 'P1', 'E7'].sort((a, b) => ROW_IDS.indexOf(a) - ROW_IDS.indexOf(b)))
    expect(ROW_IDS).toHaveLength(38)
    // the event schema's table_row pattern (docs/factory-events/schemas/transition.v1.json)
    for (const id of ROW_IDS) expect({ id, ok: /^([A-Z][0-9]+|recovered)$/.test(id) }).toEqual({ id, ok: true })
    // E7 has one row for each event kind: every event has a row with no meaning in every state
    expect(TABLE.filter(r => r.id === 'E7').map(r => r.on).sort()).toEqual([...EVENT_KINDS].sort())
    const made = madeRecord({ issue: 7, life: 'ss1x2k', branch: 'issue-7', pr: null, others: [] }, NOW)
    expect(made).toMatchObject({ state: 'queued', step: 'lease', seq: 1, seqAt: NOW, since: NOW, resumeTo: null, attempt: 1, cut: false, triages: 0, fixes: 0, round: 0 })
    expect(madeRecord({ issue: 7, life: 'ss1x2k', branch: 'feat/issue-7-x', pr: 621, others: [619] }, NOW)).toMatchObject({ resumeTo: 'reviewing', pr: 621, branch: 'feat/issue-7-x', notes: [expect.stringContaining('#619')] })
    // S7: a split child's claim carrying a park makes the parked record, resumeTo designing (8.7)
    const parked = madeRecord({ issue: 8, life: 'ss1x2k', branch: 'issue-8', pr: null, others: [], park: { question: 'Which API?', parent: 7 } }, NOW)
    expect(parked).toMatchObject({ state: 'parked', step: null, resumeTo: 'designing', question: 'Which API?', pr: null, notes: [expect.stringContaining('#7')] })
    for (const r of records()) for (const e of ALL_EVENTS) expect(['S0', 'S7']).not.toContain(rowFor(r, e, CFG).id)
  })

  test('property 1, totality: exactly one row for every (state, step, event, guard input), the one 4.3\'s grid names; closed is absorbing', SWEEP, () => {
    const reached = new Map<string, Set<string>>()
    let combos = 0
    for (const r of records()) {
      for (const e of ALL_EVENTS) {
        // rowFor throws when two rows match: the guards are exclusive
        const row = rowFor(r, e, CFG)
        combos += 1
        const cell = `${r.state}|${r.step === 'triage' ? 'triage' : 'own'}|${e.kind}`
        const set = reached.get(cell) ?? new Set<string>()
        set.add(row.id)
        reached.set(cell, set)
        expect({ cell, row: row.id, allowed: expected(r.state, r.step === 'triage', e.kind).includes(row.id) }).toEqual({ cell, row: row.id, allowed: true })
        if (r.state === 'closed') expect(row.id).toBe('E7')
      }
    }
    expect(combos).toBeGreaterThan(50_000)
    // and every row the grid names is reached somewhere in the domain
    for (const [cell, rows] of reached) {
      const [state, step, kind] = cell.split('|') as [IssueState, string, EventKind]
      expect({ cell, rows: [...rows].sort() }).toEqual({ cell, rows: [...expected(state, step === 'triage', kind)].sort() })
    }
  })

  test('a hung merge-queue head is the unknown path, never a tell: its running step\'s timeout comes as unknown (why timeout) and takes U1 to U4', SWEEP, () => {
    const head = { ...base, state: 'merge-queue' as const, step: 'queue' as const, pr: 512 }
    const timedOut: TableEvent = { kind: 'unknown', why: 'timeout', reason: 'queue ran past its 30 min' }
    expect(rowFor(head, timedOut, CFG).id).toBe('U2')
    expect(rowFor(head, { ...timedOut, cause: 'load' }, CFG).id).toBe('U1')
    expect(rowFor({ ...head, attempt: 2 }, timedOut, CFG).id).toBe('U3')
    expect(rowFor({ ...head, attempt: 2, triages: MAX_TRIAGES }, timedOut, CFG).id).toBe('U4')
    // a record behind the head waits: its period's tell
    expect(rowFor(head, { kind: 'timeout' }, CFG).id).toBe('E6')
  })

  test('every state but closed has a timeout or a tell period: a running step\'s timeout is unknown, a waiting state\'s is E6', SWEEP, () => {
    for (const state of LIVE_STATES) {
      for (const step of STEPS_OF[state]) {
        const r = { ...base, state, step }
        const row = rowFor(r, { kind: 'timeout' }, CFG)
        expect({ state, step, row: row.id }).toEqual({ state, step, row: tellPeriodic(r) ? 'E6' : expect.stringMatching(/^U[124]$/) })
        if (!tellPeriodic(r)) expect(normalize(r, { kind: 'timeout' })).toMatchObject({ kind: 'unknown', why: 'timeout' })
      }
    }
  })
})

// next: a changing row's record, or null for a side row.
function next(r: IssueRecord, e: TableEvent, now = NOW): IssueRecord | null {
  const row = rowFor(r, e, CFG)
  return row.id === 'E6' || row.id === 'E7' ? null : nextRecord(r, row, e, now)
}

// The shape a reachable record keeps: the state's own step (or triage, in a step state), counters
// in their bounds, a question only while parked, a why only when closed.
function wellFormed(r: IssueRecord): boolean {
  const ownOrTriage = r.step === STATE_STEP[r.state] || (STEP_STATES.includes(r.state) && r.step === 'triage')
  return (
    ownOrTriage &&
    r.attempt >= 1 &&
    r.attempt <= 2 &&
    r.triages <= MAX_TRIAGES &&
    r.fixes <= FIX_CAP &&
    (r.state === 'parked') === (r.question !== null) &&
    (r.state === 'waiting') === (r.wait !== null) &&
    (r.state === 'closed') === (r.why !== null) &&
    recordOf(JSON.parse(JSON.stringify(r))) !== null
  )
}

const stateKey = (r: IssueRecord) => JSON.stringify([r.state, r.step, r.attempt, r.cut, r.triages, r.fixes, r.pr !== null, r.head !== null, r.resumeTo])

// reachable: every record the table reaches from a new claim, over every event (bounded by its
// counters; round is left out of the key, as it is counted and never capped).
function reachable(): IssueRecord[] {
  const seen = new Map<string, IssueRecord>()
  const todo: IssueRecord[] = [base, { ...base, pr: 512, resumeTo: 'reviewing' }]
  while (todo.length > 0) {
    const r = todo.pop() as IssueRecord
    const k = stateKey(r)
    if (seen.has(k)) continue
    seen.set(k, r)
    for (const e of ALL_EVENTS) {
      const n = next(r, e)
      if (n !== null) todo.push(n)
    }
  }
  return [...seen.values()]
}

describe('properties over the reachable records (v2 SPEC 17.1)', () => {
  const REACHED = reachable()

  test('property 2, reachability: every state from queued, and closed from every state', SWEEP, () => {
    expect(new Set(REACHED.map(r => r.state))).toEqual(new Set(ISSUE_STATES))
    for (const r of REACHED.filter(x => x.state !== 'closed')) expect(next(r, { kind: 'drop' })?.state).toBe('closed')
  })

  test('property 4, one label: every reachable record but a closed one has exactly its state\'s factory label', SWEEP, () => {
    for (const r of REACHED) {
      const label = labelOf(r.state)
      if (r.state === 'closed') expect(label).toBeNull()
      else expect(label).toBe(`factory:${r.state}`)
    }
  })

  test('every row keeps the record well formed: seq + 1 at now, since moved only with the state, counters within bounds, and the store reads it back', SWEEP, () => {
    for (const r of REACHED) {
      expect({ r: stateKey(r), ok: wellFormed(r) }).toEqual({ r: stateKey(r), ok: true })
      for (const e of ALL_EVENTS) {
        const n = next(r, e, NOW + 1000)
        if (n === null) continue
        expect(n.seq).toBe(r.seq + 1)
        expect(n.seqAt).toBe(NOW + 1000)
        expect(n.since).toBe(n.state === r.state ? r.since : NOW + 1000)
        expect({ via: viaOf(rowFor(r, e, CFG), normalize(r, e)) }).toEqual({ via: expect.stringMatching(/^[a-z-]+(:[a-z-]+)?$/) })
      }
    }
  })

  test('a triage answer other than park or drop starts a step that is not triage: the state\'s own, at attempt 1 (retry: 2), with no cut, even when the answer leads to the state the record is in', SWEEP, () => {
    const onTriage = REACHED.filter(r => r.step === 'triage')
    expect(new Set(onTriage.map(r => r.state))).toEqual(new Set(STEP_STATES))
    for (const r of onTriage) {
      for (const e of eventsOf('triage')) {
        const row = rowFor(r, e, CFG)
        const n = next(r, e)
        if (n === null || row.id === 'X4' || row.id === 'X5') continue
        expect({ from: r.state, row: row.id, step: n.step, attempt: n.attempt, cut: n.cut }).toEqual({ from: r.state, row: row.id, step: STATE_STEP[n.state], attempt: row.id === 'X1' ? 2 : 1, cut: false })
      }
    }
  })

  test('property 12, edges: from every reachable parked record an unpark reaches queued, its target kept and its budgets reset; a resumed record is not parked again for the same hand close', SWEEP, () => {
    const parked = REACHED.filter(r => r.state === 'parked')
    expect(parked.length).toBeGreaterThan(0)
    for (const r of parked) {
      const closed = { ...r, pr: 512, prClosedAt: '2026-10-15T10:00:00Z' }
      const n = next(closed, { kind: 'unpark', reason: 'label', data: { note: 'go on', closedAt: '2026-10-15T10:00:00Z' } })
      expect(n).toMatchObject({ state: 'queued', resumeTo: r.resumeTo, attempt: 1, triages: 0, fixes: 0, cut: false, notes: ['go on'], prClosedAt: '2026-10-15T10:00:00Z', question: null })
      // the PR's close is already handled: pr-closed is an edge on its closedAt, never present again
      expect(((n as IssueRecord).prClosedAt ?? '') >= '2026-10-15T10:00:00Z').toBe(true)
    }
  })

  test('T16, C1, P1: a wait enters waiting with its conditions and resumes to designing; every condition cleared leads to queued with the cleared note; an owner resume does too', SWEEP, () => {
    const designing: IssueRecord = { ...base, state: 'designing', step: 'design', since: NOW - 3_600_000 }
    const conditions = [
      { kind: 'issue-closed' as const, issue: 57 },
      { kind: 'pr-merged' as const, pr: 812 },
    ]
    const waiting = next(designing, { kind: 'not-ok', reason: 'wait', data: { text: 'blocked on #57 and PR #812', conditions } }, NOW) as IssueRecord
    expect(rowFor(designing, { kind: 'not-ok', reason: 'wait' }, CFG).id).toBe('T16')
    expect(waiting).toMatchObject({ state: 'waiting', step: null, resumeTo: 'designing', wait: conditions, question: null, notes: ['blocked on #57 and PR #812'], since: NOW })
    // a triage step cannot wait: only the designer's own step gives it
    expect(rowFor({ ...designing, step: 'triage' }, { kind: 'not-ok', reason: 'wait' }, CFG).id).toBe('E7')
    // C1: the cleared note names each condition; the budgets are reset and the target kept
    const cleared = next({ ...waiting, attempt: 2, triages: 1, cut: true }, { kind: 'cleared' }) as IssueRecord
    expect(rowFor(waiting, { kind: 'cleared' }, CFG).id).toBe('C1')
    expect(cleared).toMatchObject({ state: 'queued', step: 'lease', resumeTo: 'designing', attempt: 1, triages: 0, cut: false, wait: null, notes: ['The loop resumed this: #57 closed, PR #812 merged; every condition holds.'] })
    // P1: the owner's resume, with the owner's note
    expect(next(waiting, { kind: 'unpark', reason: 'op', data: { note: 'go on' } })).toMatchObject({ state: 'queued', resumeTo: 'designing', wait: null, notes: ['go on'] })
    expect(rowFor(waiting, { kind: 'unpark', reason: 'op' }, CFG).id).toBe('P1')
    // E4 parks a waiting record, as any live one; it keeps its target
    expect(next({ ...waiting, pr: 512 }, { kind: 'pr-closed', data: { pr: 512, closedAt: '2026-10-15T10:00:00Z' } })).toMatchObject({ state: 'parked', resumeTo: 'designing', wait: null })
    // E6 changes nothing: the tell
    expect(rowFor(waiting, { kind: 'timeout' }, CFG).id).toBe('E6')
  })

  test('each distinct note is kept and asked once: a conflict whose text is also its note parks with it once (drill run 3, #22)', SWEEP, () => {
    const note = 'PR #24 conflicts with main: merge origin/main into issue-471, resolve the conflicts and push'
    const conflict: TableEvent = { kind: 'not-ok', reason: 'conflict', data: { pr: 512, text: note, notes: [note] } }
    const queue: IssueRecord = { ...base, state: 'merge-queue', step: 'queue', pr: 512, head: HEAD, notes: [note] }
    const parked = next({ ...queue, fixes: FIX_CAP }, conflict)
    expect(parked).toMatchObject({ state: 'parked' })
    expect((parked?.question ?? '').split(note).length - 1).toBe(1)
    expect(next(queue, { ...conflict, data: { pr: 512, notes: [note, 'other', note] } })?.notes).toEqual(['other', note])
  })
})

// --- bounded work (property 7) and the unknown path (property 10) ------------------------------------

// A seeded walk: no outside event (no unpark, no outside push, so no changed patch), each pass the
// record's own step or its triage gives a result, any result.
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)] as T
}

function stepResult(r: IssueRecord, rand: () => number): TableEvent {
  if (r.state === 'queued') return { kind: 'ok' }
  const unknown = (): TableEvent => ({ kind: 'unknown', why: 'agent-dead', reason: 'no answer', cause: rand() < 0.5 ? pick(rand, OUTSIDE_CAUSES) : undefined })
  if (r.step === 'triage') return rand() < 0.4 ? unknown() : { kind: 'triage', choice: pick(rand, TRIAGE_CHOICES), reason: 'r', data: { instructions: 'i', question: 'q' } }
  const reasons = NOT_OK_REASONS[r.state].filter(x => x !== 'patch')
  const roll = rand()
  if (roll < 0.35) return { kind: 'ok', data: { head: HEAD, patch: 'f00dfeed', pr: 512 } }
  if (roll < 0.6 && reasons.length > 0) return { kind: 'not-ok', reason: pick(rand, reasons) }
  return unknown()
}

const AGENT: readonly (StepKind | null)[] = ['design', 'build', 'review', 'fix', 'triage']

describe('bounded work and the unknown path (v2 SPEC 5.1, 17.1)', () => {
  test('property 7: with no outside event, every life ends parked, waiting or closed, and its agent steps stay under the bound from fixCap, maxTriages and one free re-run per attempt', SWEEP, () => {
    // each entry to a step state runs its own step at most twice, each with one free re-run (4);
    // the entries: designing and building once and once per redesign (1 + M each), reviewing once
    // per build and per fix (1 + M + F), fixing once per fix (F); each triage grant runs triage at
    // most 4 times and gives one more attempt (2)
    const bound = 4 * (2 * (1 + MAX_TRIAGES) + (1 + MAX_TRIAGES + FIX_CAP) + FIX_CAP) + MAX_TRIAGES * (4 + 2)
    for (let seed = 1; seed <= 400; seed++) {
      const rand = rng(seed)
      let r: IssueRecord = seed % 2 === 0 ? base : { ...base, pr: 512, resumeTo: 'reviewing' }
      let agentSteps = 0
      let transitions = 0
      while (r.state !== 'parked' && r.state !== 'waiting' && r.state !== 'closed') {
        const e = stepResult(r, rand)
        if (AGENT.includes(r.step)) agentSteps += 1
        const n = next(r, e)
        if (n === null) throw new Error(`seed ${seed}: ${e.kind} changed nothing in ${r.state}/${r.step}`)
        r = n
        transitions += 1
        if (transitions > 10 * bound) throw new Error(`seed ${seed}: no end after ${transitions} transitions`)
      }
      expect({ seed, within: agentSteps <= bound }).toEqual({ seed, within: true })
    }
  })

  test('property 10: from any unknown, a free re-run at most once per attempt, then a retry, then triage, then a park, in that order', SWEEP, () => {
    const rows = (start: IssueRecord, outside: boolean) => {
      const out: string[] = []
      let r = start
      while (r.state !== 'parked' && out.length < 20) {
        const e: TableEvent = { kind: 'unknown', why: 'agent-dead', reason: 'no answer', cause: outside ? 'load' : undefined }
        out.push(rowFor(r, e, CFG).id)
        r = nextRecord(r, rowFor(r, e, CFG), e, NOW)
      }
      return out
    }
    for (const state of STEP_STATES) {
      const r = { ...base, state, step: STATE_STEP[state] }
      // every unknown caused outside the issue: each attempt gets its one free re-run
      expect(rows(r, true)).toEqual(['U1', 'U2', 'U1', 'U3', 'U1', 'U2', 'U1', 'U4'])
      expect(rows(r, false)).toEqual(['U2', 'U3', 'U2', 'U4'])
      // with every triage of the life spent, the second unknown parks
      expect(rows({ ...r, triages: MAX_TRIAGES }, false)).toEqual(['U2', 'U4'])
    }
    // an invalid triage answer is the triage's unknown: one more triage attempt, then a park
    const triage = { ...base, state: 'building' as const, step: 'triage' as const, triages: 1 }
    expect(rows(triage, false)).toEqual(['U2', 'U4'])
    const parked = nextRecord({ ...triage, attempt: 2 }, rowFor({ ...triage, attempt: 2 }, { kind: 'unknown', why: 'bad-answer' }, CFG), { kind: 'unknown', why: 'bad-answer' }, NOW)
    expect(parked).toMatchObject({ state: 'parked', resumeTo: 'building', question: expect.stringContaining('the triage of building') })
  })

  describe('a park stores the agent\'s question as markdown (#856)', () => {
    const asked = renderQuestion({ question: 'Which API?', context: 'Two shapes exist.', options: [{ key: 'A', title: 'v1', detail: 'old\n\nmore' }, { key: 'B', title: 'v2' }], recommendation: { key: 'B', reason: 'newer' } })
    const designing = { ...base, state: 'designing' as const, step: 'design' as const }
    const building = { ...base, state: 'building' as const, step: 'triage' as const, triages: 1 }
    const t3 = (data?: { question?: string; text?: string }, reason = 'question') => next(designing, { kind: 'not-ok', reason, ...(data ? { data } : {}) }) as IssueRecord
    const x4 = (event: Partial<TableEvent>, r = building) => next(r, { kind: 'triage', ...event } as TableEvent) as IssueRecord

    test('T3 and the triage park of X4 keep the question\'s newlines, blank lines and indentation', () => {
      expect(t3({ question: `  ${asked}\n` }).question).toBe(asked)
      expect(asked).toMatch(/^#### Options$/m)
      expect(asked).toMatch(/^  old$/m)
      expect(x4({ choice: 'park', reason: 'r', data: { question: asked } }).question).toBe(asked)
    })

    test('a question over the cap is cut to it by length alone, keeping its newlines, and ends with ...', () => {
      const long = `Which?\n\n${'line\n'.repeat(600)}`
      for (const q of [t3({ question: long }).question, x4({ choice: 'park', data: { question: long } }).question]) {
        expect(q).toHaveLength(2000)
        expect(q?.endsWith('...')).toBe(true)
        expect(q).toContain('\nline\n')
      }
    })

    test('with no question, the text and the machine reasons stay one clipped line', () => {
      expect(t3({ text: 'asks\n  about   the\nAPI' }).question).toBe('asks about the API')
      expect(t3(undefined, 'question').question).toBe('question')
      expect(x4({ choice: 'park', reason: 'needs\nthe owner' }).question).toBe('needs the owner')
      expect(x4({ choice: 'fix', reason: 'a\nb' }).question).toBe('the triage chose a fixer, which is not possible here (the branch has no commits beyond the base): a b')
    })
  })

  test('a triage retry gives exactly one more attempt; a fix with no commits or at the cap parks with the triage\'s reason; a drop closes the life', SWEEP, () => {
    const triage = { ...base, state: 'building' as const, step: 'triage' as const, triages: 1 }
    const retry = next(triage, { kind: 'triage', choice: 'retry', reason: 'flaky', data: { instructions: 'run the tests in the foreground' } }) as IssueRecord
    expect(retry).toMatchObject({ state: 'building', step: 'build', attempt: 2, notes: ['run the tests in the foreground'] })
    expect(rowFor(retry, { kind: 'unknown', why: 'timeout' }, CFG).id).toBe('U3')
    expect(next(triage, { kind: 'triage', choice: 'fix', reason: 'needs a fixer' })).toMatchObject({ state: 'parked', question: expect.stringContaining('no commits beyond the base') })
    expect(next({ ...triage, head: HEAD }, { kind: 'triage', choice: 'fix', reason: 'needs a fixer', data: { instructions: 'fix the parser' } })).toMatchObject({ state: 'fixing', fixes: 1, notes: ['fix the parser'] })
    expect(next({ ...triage, head: HEAD, fixes: FIX_CAP }, { kind: 'triage', choice: 'fix', reason: 'needs a fixer' })).toMatchObject({ state: 'parked', question: expect.stringContaining('fix cap') })
    expect(next(triage, { kind: 'triage', choice: 'drop', reason: 'obsolete' })).toMatchObject({ state: 'closed', why: 'dropped', notes: ['triage: obsolete'] })
    expect(next(triage, { kind: 'triage', choice: 'redesign', reason: 'wrong brief', data: { instructions: 'design the v2 API' } })).toMatchObject({ state: 'designing', step: 'design', notes: ['design the v2 API'] })
  })

  test('a triage answer that leads to the state the record is in starts that state\'s own step: redesign from designing runs the designer, fix from fixing runs the fixer', SWEEP, () => {
    const designing = { ...base, state: 'designing' as const, step: 'triage' as const, attempt: 2, cut: true, triages: 1, since: NOW - 3_600_000, notes: ['attempt 2 of design ended unknown (timeout): no answer'] }
    const redesign = next(designing, { kind: 'triage', choice: 'redesign', reason: 'wrong brief', data: { instructions: 'design the v2 API' } }, NOW + 1000)
    expect(rowFor(designing, { kind: 'triage', choice: 'redesign' }, CFG).id).toBe('X3')
    expect(redesign).toMatchObject({ state: 'designing', step: 'design', attempt: 1, cut: false, triages: 1, notes: ['design the v2 API'], seq: designing.seq + 1, since: designing.since })
    const fixing = { ...base, state: 'fixing' as const, step: 'triage' as const, attempt: 2, cut: true, triages: 1, fixes: 1, head: HEAD, pr: 512, since: NOW - 3_600_000 }
    const fix = next(fixing, { kind: 'triage', choice: 'fix', reason: 'the fixer missed a finding', data: { instructions: 'fix the parser' } }, NOW + 1000)
    expect(rowFor(fixing, { kind: 'triage', choice: 'fix' }, CFG).id).toBe('X2')
    expect(fix).toMatchObject({ state: 'fixing', step: 'fix', attempt: 1, cut: false, fixes: 2, notes: ['fix the parser'], since: fixing.since })
    // bounded: a triage that keeps answering redesign never runs triage again without a step between
    let r: IssueRecord = designing
    for (let i = 0; i < 5; i++) {
      r = next(r, { kind: 'triage', choice: 'redesign', reason: 'again' }) as IssueRecord
      expect(r.step).toBe('design')
      r = { ...r, step: 'triage' }
    }
  })

  test('the fix cap: a fixer per round until fixCap, then the next not-ok parks and resumes fixing; a decline costs a round, not a fix', SWEEP, () => {
    let r: IssueRecord = { ...base, state: 'reviewing', step: 'review', round: 1, pr: 512 }
    for (let i = 1; i <= FIX_CAP; i++) {
      r = next(r, { kind: 'not-ok', reason: 'changes', data: { notes: ['r1-1 a defect'] } }) as IssueRecord
      expect(r).toMatchObject({ state: 'fixing', fixes: i, notes: ['r1-1 a defect'] })
      r = next(r, { kind: 'not-ok', reason: 'declined', data: { notes: ['r1-1 is not a defect'] } }) as IssueRecord
      expect(r).toMatchObject({ state: 'reviewing', fixes: i, round: 1 + i, notes: ['r1-1 is not a defect'] })
    }
    expect(next(r, { kind: 'not-ok', reason: 'ci-red', data: { text: 'test failed' } })).toMatchObject({ state: 'parked', resumeTo: 'fixing', question: expect.stringContaining('fix cap') })
  })
})
