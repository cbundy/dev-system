// The parts of a structured park question (v2 SPEC 3.2, 7.1, 11): which parks set them, the
// note's five tokens, the new log's payload and the stored record. The park comment's text is
// pinned by v2-park-text.test.ts and does not move.
import { describe, expect, test } from 'claude-code/testing'

import { V2_CONTRACTS } from '../hooks/contract.mjs'
import type { LedgerEntry } from '../hooks/types'
import { CONTRACTS as TRIAGE } from '../hooks/v2/contracts-triage.mjs'
import { eventArgv, parseTransition } from '../hooks/v2/events'
import type { TransitionEvent } from '../hooks/v2/events'
import { recordOf } from '../hooks/v2/observe'
import { partsOfData, partsOfStored, partsOfTokens, partsTokens } from '../hooks/v2/park-parts'
import { recordsFromNewRows } from '../hooks/v2/record'
import { renderQuestion } from '../hooks/v2/question.mjs'
import { designOf } from '../hooks/v2/rules-work'
import { triageResult } from '../hooks/v2/steps-triage'
import { designResult } from '../hooks/v2/steps-work'
import { madeRecord, nextRecord, rowFor } from '../hooks/v2/table'
import type { IssueRecord, ParkParts, TableEvent } from '../hooks/v2/types'
import { NOW, config, transitionRow } from './fixtures'

const CFG = config()
const PARTS: ParkParts = {
  decision: 'Which API, at 100%? a=b none',
  context: 'none',
  options: [
    { key: 'A', title: 'v1 = old', detail: 'keeps 100% of callers' },
    { key: 'B', title: 'none', detail: null },
  ],
  recommended: 'B',
  recommendation: 'newer, simpler',
}
const base = madeRecord({ issue: 471, life: 'ss1x2k', branch: 'issue-471', pr: null, others: [] }, NOW - 60_000)
const next = (r: IssueRecord, e: TableEvent): IssueRecord => nextRecord(r, rowFor(r, e, CFG), e, NOW)

const ANSWER = {
  kind: 'question',
  question: 'Which API shape?',
  context: 'Two callers differ.',
  options: [{ key: 'A', title: 'One call' }, { key: 'B', title: 'Two calls', detail: 'More trips.' }],
  recommendation: { key: 'A', reason: 'Simpler.' },
  brief: null,
}
const EXPECTED: ParkParts = {
  decision: 'Which API shape?',
  context: 'Two callers differ.',
  options: [{ key: 'A', title: 'One call', detail: null }, { key: 'B', title: 'Two calls', detail: 'More trips.' }],
  recommended: 'A',
  recommendation: 'Simpler.',
}

describe('which parks set parts', () => {
  const designing = { ...base, state: 'designing' as const, step: 'design' as const }
  const building = { ...base, state: 'building' as const, step: 'triage' as const, triages: 1 }

  test('T3: the designer\'s raw sentence is the decision and question is the rendering', () => {
    const c = V2_CONTRACTS['design-v2'].check(ANSWER, { contract: 'design-v2', purpose: null, repo: 'o/r', issue: 471, branch: 'issue-471' })
    const result = designResult(c.ok ? c.outcome : null)
    const data = result.data as { question: string; decision: string }
    expect(data.decision).toBe('Which API shape?')
    expect(data.question).toBe(renderQuestion({ question: 'Which API shape?', context: 'Two callers differ.', options: EXPECTED.options, recommendation: { key: 'A', reason: 'Simpler.' } }))
    const entry = { outcome: { kind: 'step', step: 'design', result: { data } } } as unknown as LedgerEntry
    const d = designOf(entry)
    expect(d?.parts).toEqual(EXPECTED)
    const r = next(designing, { kind: 'not-ok', reason: 'question', data: { question: data.question, parts: d?.parts } })
    expect(r).toMatchObject({ state: 'parked', question: data.question, parts: EXPECTED })
  })

  test('a design entry without a decision (from before) gives null parts; a bare question gives only the decision', () => {
    const old = { outcome: { kind: 'step', step: 'design', result: { data: { kind: 'question', question: 'q?' } } } } as unknown as LedgerEntry
    expect(designOf(old)?.parts).toBeNull()
    const bare = { outcome: { kind: 'step', step: 'design', result: { data: { kind: 'question', question: 'q?', decision: 'q?' } } } } as unknown as LedgerEntry
    expect(designOf(bare)?.parts).toEqual({ decision: 'q?', context: null, options: null, recommended: null, recommendation: null })
    expect(next(designing, { kind: 'not-ok', reason: 'question', data: { question: 'q?' } }).parts).toBeNull()
  })

  test('X4 park sets parts from the triage answer; the fixer fallback gives null', () => {
    const c = TRIAGE.triage.check({ choice: 'park', reason: 'r', question: ANSWER.question, context: ANSWER.context, options: ANSWER.options, recommendation: ANSWER.recommendation }, { contract: 'triage', purpose: null, repo: 'o/r', issue: 471, branch: 'issue-471' })
    const result = triageResult(c.ok ? c.outcome : null)
    expect((result.data as { parts: ParkParts }).parts).toEqual(EXPECTED)
    const parked = next(building, { kind: 'triage', choice: 'park', reason: 'r', data: result.data as never })
    expect(parked.parts).toEqual(EXPECTED)
    expect(next(building, { kind: 'triage', choice: 'fix', reason: 'needs a fixer' })).toMatchObject({ state: 'parked', parts: null })
  })

  test('S7: a claim park with parts sets them, one without gives null; a plain claim gives null', () => {
    const claim = { issue: 602, life: 'ss1x2k', branch: 'issue-602', pr: null, others: [] }
    expect(madeRecord({ ...claim, park: { question: 'Q', parent: 330, parts: EXPECTED } }, NOW).parts).toEqual(EXPECTED)
    expect(madeRecord({ ...claim, park: { question: 'Q', parent: 330 } }, NOW).parts).toBeNull()
    expect(madeRecord(claim, NOW).parts).toBeNull()
  })

  test('other parks, every exit from parked and a re-asked question carry no parts', () => {
    const asked = next(designing, { kind: 'not-ok', reason: 'question', data: { question: 'Q', parts: EXPECTED } })
    expect(asked.parts).toEqual(EXPECTED)
    for (const e of [{ kind: 'unpark', reason: 'op' }, { kind: 'drop' }] as TableEvent[]) expect(next(asked, e).parts).toBeNull()
    // a same-state parked row that sets a new question without parts
    const row = rowFor(asked, { kind: 'unknown' }, CFG)
    expect(nextRecord({ ...asked, parts: EXPECTED }, { ...row, next: 'same', change: () => ({ question: 'newer' }) }, { kind: 'unknown' }, NOW).parts).toBeNull()
    expect(nextRecord({ ...asked, parts: EXPECTED }, { ...row, next: 'same', change: () => ({}) }, { kind: 'unknown' }, NOW).parts).toEqual(EXPECTED)
    // U4: an unknown past its retries parks with a machine reason and no parts
    const built = { ...base, state: 'building' as const, step: 'build' as const, attempt: 2, cut: true, triages: CFG.maxTriages }
    expect(next({ ...built, parts: EXPECTED }, { kind: 'unknown', why: 'timeout' })).toMatchObject({ state: 'parked', parts: null })
    expect(madeRecord({ issue: 1, life: 'l', branch: 'issue-1', pr: null, others: [] }, NOW).parts).toBeNull()
  })
})

describe('the note tokens', () => {
  const event = (parts: ParkParts | null): TransitionEvent => ({ state: 'transition', row: 'T3', from: 'designing', via: 'question', record: { ...base, state: 'parked', resumeTo: 'designing', step: null, question: 'Q', parts } })
  const noteOf = (e: TransitionEvent) => {
    const argv = eventArgv(e)
    return argv[argv.indexOf('--note') + 1] ?? ''
  }
  const row = (e: TransitionEvent, note = noteOf(e)) => parseTransition({ state: 'transition', issue: 471, branch: 'issue-471', pr: null, head: null, note })

  test('full parts round-trip through the note, texts with spaces, %, = and none included', () => {
    const note = noteOf(event(PARTS))
    expect(note).toContain(' question=Q decision=Which%20API,%20at%20100%25?%20a=b%20none context=%6Eone options=%5B')
    expect(row(event(PARTS))?.record.parts).toEqual(PARTS)
  })

  test('null parts are five none tokens and read back as null', () => {
    expect(partsTokens(null)).toEqual(['decision=none', 'context=none', 'options=none', 'recommended=none', 'recommendation=none'])
    expect(noteOf(event(null))).toContain(' question=Q decision=none context=none options=none recommended=none recommendation=none notes=')
    expect(row(event(null))?.record.parts).toBeNull()
  })

  test('a decision alone round-trips', () => {
    const only: ParkParts = { decision: 'Which?', context: null, options: null, recommended: null, recommendation: null }
    expect(row(event(only))?.record.parts).toEqual(only)
  })

  test('an older note without the tokens reads null; a malformed options token fails the read', () => {
    const note = noteOf(event(null)).replace(/ decision=\S+ context=\S+ options=\S+ recommended=\S+ recommendation=\S+/, '')
    expect(note).not.toContain('decision=')
    expect(row(event(null), note)?.record.parts).toBeNull()
    const bad = (o: string) => row(event(PARTS), noteOf(event(PARTS)).replace(/options=\S+/, `options=${o}`))
    expect(bad('%7Bnope')).toBeNull()
    expect(bad(encodeURIComponent('[{"key":"A","title":"x"}]'))).toBeNull()
    expect(bad(encodeURIComponent('[{"key":"A","title":"x"},{"key":"A","title":"y"}]'))).toBeNull()
    expect(bad(encodeURIComponent('[{"key":"A","title":"x"},{"key":"Z","title":"y"}]'))).toBeNull()
    expect(bad(encodeURIComponent('"x"'))).toBeNull()
    expect(partsOfTokens(k => ({ decision: 'q', options: 'none', recommended: 'A' })[k])).toBeUndefined()
  })
})

describe('the new log and the store', () => {
  const parked = { ...base, state: 'parked' as const, step: null, resumeTo: 'designing' as const, question: 'Q' }

  test('recordsFromNewRows rebuilds parts; absent or null decision gives null; an option without detail reads null', () => {
    const rebuilt = (r: IssueRecord, patch: (d: Record<string, unknown>) => void = () => {}) => {
      const row = transitionRow(r, NOW - 1000)
      const d = JSON.parse(row.data as string) as Record<string, unknown>
      patch(d)
      return recordsFromNewRows([{ ...row, data: JSON.stringify(d) }])[0]
    }
    expect(rebuilt({ ...parked, parts: PARTS })?.parts).toEqual(PARTS)
    expect(rebuilt(parked)?.parts).toBeNull()
    expect(rebuilt({ ...parked, parts: PARTS }, d => (d.decision = null))?.parts).toBeNull()
    expect(rebuilt({ ...parked, parts: PARTS }, d => (d.options = [{ key: 'A', title: 'x' }, { key: 'B', title: 'y' }]))?.parts?.options).toEqual([{ key: 'A', title: 'x', detail: null }, { key: 'B', title: 'y', detail: null }])
    expect(partsOfData({ decision: 'q' })).toEqual({ decision: 'q', context: null, options: null, recommended: null, recommendation: null })
  })

  test('recordOf reads a record without parts as null, round-trips valid parts and refuses a malformed one', () => {
    const stored = JSON.parse(JSON.stringify({ ...parked, parts: PARTS })) as Record<string, unknown>
    expect(recordOf(stored)?.parts).toEqual(PARTS)
    const noParts = { ...stored }
    delete noParts.parts
    expect(recordOf(noParts)?.parts).toBeNull()
    expect(recordOf({ ...stored, parts: null })?.parts).toBeNull()
    for (const bad of [{ ...PARTS, decision: 3 }, { ...PARTS, context: 3 }, { ...PARTS, options: [{ key: 'A', title: 'x', detail: null }] }, { ...PARTS, recommended: 'C' }, { ...PARTS, recommendation: 3 }, 'x', { ...PARTS, options: [{ key: 'A', title: 3, detail: null }, { key: 'B', title: 'y', detail: null }] }]) {
      expect(recordOf({ ...stored, parts: bad })).toBeNull()
    }
    expect(partsOfStored(undefined)).toBeNull()
  })
})
