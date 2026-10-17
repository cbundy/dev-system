// The park comment's template and the structured question behind it (v2 SPEC 4.5, 11): the
// question fields of the designer's and the triage's contracts, their one canonical rendering, the
// park comment through its template, and the ticks read back from it.
import { describe, expect, test } from 'claude-code/testing'

import { V2_CONTRACTS } from '../hooks/contract.mjs'
import { CONTRACTS as TRIAGE } from '../hooks/v2/contracts-triage.mjs'
import { decisionOf, parkText, tickNote, ticksOf } from '../hooks/v2/park-text'
import { renderQuestion } from '../hooks/v2/question.mjs'
import { parkedTell } from '../hooks/v2/rules-entry'
import { designResult } from '../hooks/v2/steps-work'
import { triageResult } from '../hooks/v2/steps-triage'
import type { IssueRecord } from '../hooks/v2/types'

const design = (input: unknown) => V2_CONTRACTS['design-v2'].check(input, { contract: 'design-v2', purpose: null, repo: 'o/r', issue: 650, branch: 'issue-650' })
const triage = (input: unknown) => TRIAGE.triage.check(input, { contract: 'triage', purpose: null, repo: 'o/r', issue: 650, branch: 'issue-650' })
const problemsOf = (c: { ok: boolean; problems?: string[] }) => (c.ok ? [] : (c.problems ?? []))

// the question of the park comment on #650, as the designer would now word it
const STRUCTURED = {
  kind: 'question',
  question: 'Should the replay script read the old store or the new one?',
  context: 'Both stores hold the same events until the dual write ends. The replay compares them.',
  options: [
    { key: 'A', title: 'Read the old store', detail: 'No change to the script. It stops working when the old store is dropped.' },
    { key: 'B', title: 'Read the new store' },
    { key: 'C', title: 'Read both and report any difference', detail: 'More code.' },
  ],
  recommendation: { key: 'C', reason: 'it proves the stores agree before the old one goes' },
  brief: null,
}

const parked = (question: string, over: Partial<IssueRecord> = {}): IssueRecord => ({ issue: 650, question, resumeTo: 'designing', ...over }) as IssueRecord

describe('the structured question (contracts, question.mjs)', () => {
  test('an answer with only the question is valid and renders as the question alone', () => {
    expect(design({ kind: 'question', question: 'Which API?', brief: null })).toEqual({ ok: true, outcome: { kind: 'question', brief: null, question: 'Which API?', reasons: null, children: [] } })
    expect(triage({ choice: 'park', reason: 'r', question: 'Which API?' })).toEqual({ ok: true, outcome: { choice: 'park', reason: 'r', instructions: null, question: 'Which API?' } })
    expect(renderQuestion({ question: 'Which API?' })).toBe('Which API?')
  })

  test('context, options and a recommendation are carried by the outcome, and render in order', () => {
    const c = design(STRUCTURED)
    expect(c).toMatchObject({ ok: true, outcome: { kind: 'question', options: [{ key: 'A' }, { key: 'B', detail: null }, { key: 'C' }], recommendation: { key: 'C' } } })
    const text = designResult(c.ok ? c.outcome : null).data as { question: string }
    expect(text.question).toBe(
      [
        'Should the replay script read the old store or the new one?',
        '#### Context',
        'Both stores hold the same events until the dual write ends. The replay compares them.',
        '#### Options',
        '- [ ] **A** - Read the old store\n  No change to the script. It stops working when the old store is dropped.\n- [ ] **B** - Read the new store\n- [ ] **C** - Read both and report any difference\n  More code.',
        '_Tick one box and remove the `factory:parked` label. `/factory resume` does not read the ticks: the note you give it is the answer._',
        '#### Recommendation',
        '**C** - it proves the stores agree before the old one goes',
      ].join('\n\n'),
    )
  })

  test('the triage park takes the same fields, and its step renders them', () => {
    const c = triage({ choice: 'park', reason: 'r', question: 'Which store?', options: STRUCTURED.options, recommendation: { key: 'A', reason: 'simplest' } })
    expect(c).toMatchObject({ ok: true })
    const r = triageResult(c.ok ? c.outcome : null)
    expect((r.data as { question: string }).question).toContain('- [ ] **B** - Read the new store')
    expect((r.data as { question: string }).question).toContain('#### Recommendation\n\n**A** - simplest')
  })

  const invalid: [string, Record<string, unknown>, string[]][] = [
    ['one option', { options: [{ key: 'A', title: 'a' }] }, ['options has 1 items; 2 to 6']],
    ['seven options', { options: 'ABCDEFG'.split('').map(key => ({ key, title: key })) }, ['options has 7 items; 2 to 6', 'options[6].key "G" is not one of A, B, C, D, E, F']],
    ['a duplicate key', { options: [{ key: 'A', title: 'a' }, { key: 'A', title: 'b' }] }, ['options[1].key A is given twice']],
    ['a recommendation naming no option', { options: STRUCTURED.options, recommendation: { key: 'E', reason: 'x' } }, ['recommendation.key "E" names no option (the options are A, B, C)']],
    ['a recommendation with no options', { recommendation: { key: 'A', reason: 'x' } }, ['recommendation.key "A" names no option (there are no options)']],
    ['an unknown field of an option', { options: [{ key: 'A', title: 'a', extra: 1 }, { key: 'B', title: 'b' }] }, ['options[0].extra is not a field of an option (only key, title, detail)']],
    ['a multi-line title', { options: [{ key: 'A', title: 'a\nb' }, { key: 'B', title: 'b' }] }, ['options[0].title must be one line']],
    ['a heading in the context', { context: 'text\n#### Options' }, ['context must not hold a heading line (one starting with #)']],
  ]
  for (const [name, extra, expected] of invalid) {
    test(`invalid: ${name}`, () => {
      expect(problemsOf(design({ kind: 'question', question: 'Which?', brief: null, ...extra }))).toEqual(expected)
      expect(problemsOf(triage({ choice: 'park', reason: 'r', question: 'Which?', ...extra }))).toEqual(expected)
    })
  }

  test('a rendered text over the 2000 characters names its length; the decision alone over it keeps its own message', () => {
    const long = { ...STRUCTURED, question: 'q'.repeat(1500), context: 'c'.repeat(800) }
    const rendered = renderQuestion({ ...long, context: long.context })
    expect(rendered.length).toBeGreaterThan(2000)
    expect(problemsOf(design(long))).toEqual([`question comes to ${renderQuestion({ question: long.question, context: long.context, options: STRUCTURED.options.map(o => ({ detail: null, ...o })), recommendation: STRUCTURED.recommendation }).length} characters once rendered with its context, options and recommendation; at most 2000`])
    expect(problemsOf(design({ kind: 'question', question: 'q'.repeat(2001), brief: null }))).toEqual(['question is 2001 characters; at most 2000'])
  })

  test('the new fields are for a question or a park alone', () => {
    expect(problemsOf(design({ kind: 'brief', brief: 'x', context: 'c' }))).toContain('context must be absent or null unless kind is question')
    expect(problemsOf(triage({ choice: 'retry', reason: 'r', instructions: 'i', options: [] }))).toEqual(['options must be absent or null unless the choice is park'])
  })
})

describe('the park comment (parkText)', () => {
  const sections = (body: string) => [...body.matchAll(/^(###|####) .*$/gm)].map(m => m[0])

  test('a structured question: the template in order, one unticked line per option, nothing empty', () => {
    const c = design(STRUCTURED)
    const question = (designResult(c.ok ? c.outcome : null).data as { question: string }).question
    const body = parkText(parked(question), 'designing', 'question')
    expect(sections(body)).toEqual(['### Waiting on the owner', '#### Context', '#### Options', '#### Recommendation', '#### How to resume'])
    expect(body.match(/^- \[ \] \*\*/gm)).toHaveLength(3)
    expect(body).toContain('**Decision needed:** Should the replay script read the old store or the new one?')
    expect(body).toContain('1. Tick one option, or write your answer as a comment.')
    expect(body).toContain('2. Then remove the `factory:parked` label, or run `/factory resume 650 "your answer"`. A comment or a tick alone does not resume.')
    expect(body.trimEnd().split('\n').at(-1)).toBe('It parked from designing (question), and a resume goes on with designing.')
    expect(body).not.toMatch(/^####? .*\n\n(?=####? )/m)
  })

  test('a question with only the decision has no Context, Options or Recommendation', () => {
    const body = parkText(parked('Which API?'), 'designing', 'question')
    expect(sections(body)).toEqual(['### Waiting on the owner', '#### How to resume'])
    expect(body).toContain('**Decision needed:** Which API?')
    expect(body).toContain('1. Write your answer as a comment.')
    expect(body).not.toContain('- [ ]')
  })

  test('a machine-written reason keeps its paragraph breaks and gains no options', () => {
    const body = parkText(parked('the fix cap is reached: r4-0\n\nsee round 1\'s review comment on PR #9', { resumeTo: 'reviewing' }), 'reviewing', 'fix-cap:review')
    expect(body).toContain('**Decision needed:** the fix cap is reached: r4-0\n\nsee round 1\'s review comment on PR #9\n\n#### How to resume')
    expect(sections(body)).toEqual(['### Waiting on the owner', '#### How to resume'])
    expect(body).not.toMatch(/[^.][.;:,];/)
    expect(body).not.toContain('answer.json')
  })

  test('the tell gives the decision sentence alone', () => {
    const c = design(STRUCTURED)
    const question = (designResult(c.ok ? c.outcome : null).data as { question: string }).question
    expect(decisionOf(question)).toBe('Should the replay script read the old store or the new one?')
    expect(decisionOf('plain\n\nwith a break')).toBe('plain\n\nwith a break')
    const tell = parkedTell(parked(question, { state: 'parked', seq: 1 } as Partial<IssueRecord>), 0)
    expect(JSON.stringify(tell)).toContain('question: Should the replay script read the old store or the new one?')
    expect(JSON.stringify(tell)).not.toContain('#### Options')
  })

  test('end to end: the structured #650 question goes through the validator, the renderer and the template', () => {
    const c = design(STRUCTURED)
    expect(c.ok).toBe(true)
    const question = (designResult(c.ok ? c.outcome : null).data as { question: string }).question
    expect(parkText(parked(question), 'designing', 'question')).toBe(
      [
        '### Waiting on the owner',
        '',
        '**Decision needed:** Should the replay script read the old store or the new one?',
        '',
        '#### Context',
        '',
        'Both stores hold the same events until the dual write ends. The replay compares them.',
        '',
        '#### Options',
        '',
        '- [ ] **A** - Read the old store',
        '  No change to the script. It stops working when the old store is dropped.',
        '- [ ] **B** - Read the new store',
        '- [ ] **C** - Read both and report any difference',
        '  More code.',
        '',
        '_Tick one box and remove the `factory:parked` label. `/factory resume` does not read the ticks: the note you give it is the answer._',
        '',
        '#### Recommendation',
        '',
        '**C** - it proves the stores agree before the old one goes',
        '',
        '#### How to resume',
        '',
        '1. Tick one option, or write your answer as a comment.',
        '2. Then remove the `factory:parked` label, or run `/factory resume 650 "your answer"`. A comment or a tick alone does not resume.',
        '',
        'It parked from designing (question), and a resume goes on with designing.',
      ].join('\n'),
    )
  })
})

describe('the owner\'s tick (ticksOf, tickNote)', () => {
  const comment = (ticks: string) => {
    const c = design(STRUCTURED)
    const q = (designResult(c.ok ? c.outcome : null).data as { question: string }).question
    let body = parkText(parked(q), 'designing', 'question')
    for (const k of ticks) body = body.replace(`- [ ] **${k}**`, `- [x] **${k}**`)
    return body
  }

  test('no tick, one tick of either case, several ticks, and a tick on no option', () => {
    expect(tickNote(ticksOf(comment('')))).toBeNull()
    expect(tickNote(ticksOf(comment('B')))).toBe('Owner chose option B: Read the new store')
    expect(tickNote(ticksOf(comment('B').replace('- [x]', '- [X]')))).toBe('Owner chose option B: Read the new store')
    expect(tickNote(ticksOf(comment('AC')))).toBe('Owner ticked 2 options, so none is chosen: A: Read the old store; C: Read both and report any difference')
    const own = comment('').replace('- [ ] **B** - Read the new store', '- [ ] **B** - Read the new store\n- [x] my own idea')
    expect(tickNote(ticksOf(own))).toBe('Owner ticked an option that does not exist, so none is chosen: "my own idea" (not an option)')
  })

  test('only the Options section is read: a tick line in the context or after the recommendation is not a tick', () => {
    const body = comment('').replace('#### Context\n\n', '#### Context\n\n- [x] **A** - quoted\n').replace('#### Recommendation', '#### Recommendation\n\n- [x] **C** - quoted')
    expect(ticksOf(body)).toEqual({ chosen: [], unknown: [] })
    expect(ticksOf('no options here\n- [x] **A** - x')).toEqual({ chosen: [], unknown: [] })
  })
})
