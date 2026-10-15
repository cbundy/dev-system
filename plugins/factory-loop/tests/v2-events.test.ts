// The event seam (docs/factory-loop/v2/SPEC.md 7.1, property 18 of 17.1): every event v2 writes is
// built by hooks/v2/events.ts in today's format, and its note parses back to the same fields and
// stays within LOOP_NOTE_MAX. Properties over generated events, not exact notes: the one exact
// note is the format's own example. tests/factory-loop-v2-events.test.js runs the same argvs
// through the real callum-flow-event.
import { describe, expect, test } from 'claude-code/testing'

import { LOOP_NOTE_MAX } from '../hooks/derive'
import {
  ABANDON_REASONS,
  NOTE_MAX,
  REASON_MAX,
  REUSED_STATES,
  abandonReason,
  dec,
  enc,
  eventArgv,
  eventNote,
  intervention,
  noteToken,
  parseEvent,
  parseIntervention,
  parseTransition,
  tokensOf,
} from '../hooks/v2/events'
import type { EventRow, InterventionEvent, ReleaseEvent, ReusedEvent, ReviewedEvent, TransitionEvent, V2Event } from '../hooks/v2/events'
import { CLOSED_WHYS, ISSUE_STATES, STEP_KINDS } from '../hooks/v2/types'
import type { IssueRecord, IssueState } from '../hooks/v2/types'
import { NOW } from './fixtures'

// --- a seeded generator, so a failure is reproducible ------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)] as T
  return { next, int, pick }
}
type Rng = ReturnType<typeof rng>

// Text that trips a naive codec: spaces, %, commas, =, the word none, empty, newlines and
// percent-encoded-looking runs.
const NASTY = ['none', '', ' ', 'a b', '100%', '%20', 'x,y', 'k=v', 'line\none', 'tab\there', 'ok', 'Closes #12', 'é ü', '%E0%A4%A', ',,', 'none,none']

function text(g: Rng, max: number): string {
  const n = g.int(6)
  let out = ''
  for (let i = 0; i < n && out.length < max; i += 1) out += (i === 0 ? '' : g.pick([' ', '', ',', '%'])) + g.pick(NASTY)
  return out.slice(0, max)
}

function maybe<T>(g: Rng, v: T): T | null {
  return g.next() < 0.3 ? null : v
}

function record(g: Rng, small: boolean): IssueRecord {
  const state = g.pick(ISSUE_STATES)
  const free = small ? 12 : 400
  return {
    issue: 1 + g.int(9999),
    life: (Math.floor(NOW / 1000) - g.int(1e6)).toString(36),
    seq: g.int(40),
    seqAt: NOW - g.int(1e8),
    state,
    since: NOW - g.int(1e8),
    resumeTo: maybe(g, g.pick(ISSUE_STATES)),
    branch: g.pick(['issue-571', 'feat/issue-571-x', 'issue-9']),
    pr: maybe(g, 1 + g.int(999)),
    head: maybe(g, 'abc1234def5678abc1234def5678abc1234def56'),
    approvedPatch: maybe(g, '3fa2c1d0e9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4'),
    brief: maybe(g, `https://github.com/cbundy/dev-system/issues/571#issuecomment-${g.int(1e9)}`),
    step: maybe(g, g.pick(STEP_KINDS)),
    attempt: 1 + g.int(2),
    cut: g.next() < 0.5,
    triages: g.int(3),
    fixes: g.int(4),
    round: g.int(6),
    question: maybe(g, text(g, free)),
    why: state === 'closed' ? g.pick(CLOSED_WHYS) : null,
    notes: Array.from({ length: g.int(small ? 3 : 8) }, () => text(g, free)),
    prClosedAt: maybe(g, '2026-10-15T09:30:00Z'),
  }
}

function transition(g: Rng, small: boolean): TransitionEvent {
  const from: IssueState | null = maybe(g, g.pick(ISSUE_STATES))
  return { state: 'transition', record: record(g, small), row: g.pick(['S0', 'T5', 'U1', 'X4', 'E6', 'P1']), from, via: g.pick(['ok', 'free:load', 'triage:retry', 'none', 'unknown:timeout']) }
}

// rowOf: what the event log keeps of an argv: its state, its columns and its note.
function rowOf(argv: string[]): EventRow {
  const flag = (f: string) => {
    const i = argv.indexOf(f)
    return i < 0 ? null : (argv[i + 1] ?? null)
  }
  const n = (f: string) => (flag(f) === null ? null : Number(flag(f)))
  return { state: argv[1] ?? '', issue: n('--issue'), branch: flag('--branch'), pr: n('--pr'), head: flag('--head'), note: flag('--note') }
}

const roundTrip = (e: V2Event) => parseEvent(rowOf(eventArgv(e)))

// --- the format ----------------------------------------------------------------------------------------

describe('the note format (v2 SPEC 7.1)', () => {
  test('its bound is the loop notes\' bound', () => {
    expect(NOTE_MAX).toBe(LOOP_NOTE_MAX)
  })

  test('a value never holds a space and decodes back to itself', () => {
    const g = rng(7)
    for (let i = 0; i < 300; i += 1) {
      const v = text(g, 60)
      expect(enc(v)).not.toMatch(/\s/)
      expect(dec(enc(v))).toBe(v)
    }
  })

  test('the format\'s own example: tokens in order, a missing value is none, a flag yes or no, a list comma-joined', () => {
    const e: TransitionEvent = {
      state: 'transition',
      row: 'T9',
      from: 'reviewing',
      via: 'ci-red',
      record: {
        issue: 571,
        life: 'ss1x2k',
        seq: 8,
        seqAt: 1_000,
        state: 'fixing',
        since: 1_000,
        resumeTo: null,
        branch: 'issue-571',
        pr: 621,
        head: 'abc1234',
        approvedPatch: null,
        brief: 'https://x/1#c',
        step: 'fix',
        attempt: 1,
        cut: false,
        triages: 0,
        fixes: 1,
        round: 1,
        question: null,
        why: null,
        notes: ['check ci', 'a,b'],
        prClosedAt: null,
      },
    }
    expect(eventNote(e)).toBe(
      'row=T9 life=ss1x2k seq=8 from=reviewing to=fixing seqAt=1000 since=1000 resumeTo=none step=fix attempt=1 cut=no triages=0 fixes=1 round=1 why=none ' +
        'approvedPatch=none prClosedAt=none via=ci-red brief=https://x/1#c question=none notes=check%20ci,a%2Cb',
    )
  })
})

// --- property 18: every note parses back, and fits ----------------------------------------------------

describe('every event events.ts builds parses back to the same fields and stays within LOOP_NOTE_MAX (property 18)', () => {
  test('transitions whose free text fits: the whole record comes back', () => {
    const g = rng(18)
    for (let i = 0; i < 500; i += 1) {
      const e = transition(g, true)
      const note = eventNote(e)
      expect(note.length).toBeLessThanOrEqual(NOTE_MAX)
      expect(roundTrip(e)).toEqual(e)
    }
  })

  test('transitions with long free text: within the bound, identifying fields intact, free text clipped from the end', () => {
    const g = rng(1018)
    for (let i = 0; i < 300; i += 1) {
      const e = transition(g, false)
      const note = eventNote(e)
      expect(note.length).toBeLessThanOrEqual(NOTE_MAX)
      const back = roundTrip(e) as TransitionEvent
      expect(back).not.toBeNull()
      const { question, notes, brief, ...fixed } = e.record
      const { question: q2, notes: n2, brief: b2, ...fixed2 } = back.record
      expect(fixed2).toEqual(fixed)
      expect(back.row).toBe(e.row)
      expect(back.from).toBe(e.from)
      // what was kept is the start of what was there: whole notes, then one cut with `...`
      expect(n2.length).toBeLessThanOrEqual(notes.length)
      n2.forEach((n, k) => {
        if (k < n2.length - 1 || n === notes[k]) expect(n).toBe(notes[k] as string)
        else expect(n.endsWith('...') && (notes[k] as string).startsWith(n.slice(0, -3))).toBe(true)
      })
      if (q2 !== null && q2 !== question) expect(q2.endsWith('...') && (question as string).startsWith(q2.slice(0, -3))).toBe(true)
      if (b2 !== brief) expect(b2 === null || (b2.endsWith('...') && (brief as string).startsWith(b2.slice(0, -3)))).toBe(true)
      // the notes go before the question, the question before the brief
      if (q2 !== question) expect(n2).toEqual([])
    }
  })

  test('reviews, interventions, releases and the reused states come back as they went', () => {
    const g = rng(99)
    for (let i = 0; i < 300; i += 1) {
      const reviewed: ReviewedEvent = {
        state: 'reviewed',
        issue: 1 + g.int(999),
        branch: 'issue-5',
        pr: 1 + g.int(999),
        head: 'abc1234',
        verdict: g.pick(['approve', 'changes', 'unknown'] as const),
        round: 1 + g.int(5),
        patch: g.pick(['3fa2c1d0e9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4', 'none', '']),
        errors: g.int(4),
        warnings: g.int(4),
        infos: g.int(4),
        reviewer: g.pick(['adjudicator', 'no-mistakes']),
        answer: `/loop dir/answers/${text(g, 40)}.json`,
      }
      const iv: InterventionEvent = intervention(g.pick(['person', 'loop'] as const), g.pick(['op:resume', 'unknown:timeout', 'free:load', 'push']), `i5/l${g.int(99)}/s3/t`, text(g, 120), {
        issue: maybe(g, 1 + g.int(99)),
        life: maybe(g, 'ss1x2k'),
        pr: maybe(g, 1 + g.int(99)),
      })
      const release: ReleaseEvent = {
        state: g.pick(['reclaimed', 'abandoned'] as const),
        issue: 1 + g.int(999),
        branch: maybe(g, 'issue-7'),
        pr: maybe(g, 12),
        stage: g.pick(['implementing', 'in pipeline', 'ready to merge']),
        checked: text(g, 80),
        reason: 'reconcile',
      }
      const reused: ReusedEvent = { state: g.pick(REUSED_STATES), issue: 1 + g.int(99), branch: maybe(g, 'issue-3'), pr: maybe(g, 4), head: maybe(g, 'abc'), note: text(g, 80) }
      for (const e of [reviewed, iv, release, reused] as V2Event[]) {
        expect(eventNote(e).length).toBeLessThanOrEqual(NOTE_MAX)
        expect(roundTrip(e)).toEqual(e)
      }
    }
  })

  test('a reason is one line of at most 200 characters, clipped with ...', () => {
    const long = intervention('loop', 'park', 'i5/lx/s3/t', `first line\nsecond ${'x'.repeat(400)}`, { issue: 5, life: 'x', pr: null })
    expect(long.reason.length).toBe(REASON_MAX)
    expect(long.reason).toMatch(/^first line second x+\.\.\.$/)
    expect(eventNote(long).length).toBeLessThanOrEqual(NOTE_MAX)
  })
})

// --- columns, the actor, and the reused states' notes -------------------------------------------------

describe('columns and notes per state', () => {
  test('a transition carries the record\'s issue, branch, PR and head as columns, never in the note', () => {
    const e = transition(rng(3), true)
    const argv = eventArgv(e)
    expect(rowOf(argv)).toMatchObject({ state: 'transition', issue: e.record.issue, branch: e.record.branch, pr: e.record.pr, head: e.record.head })
    const t = tokensOf(rowOf(argv).note)
    for (const k of ['issue', 'branch', 'pr', 'head']) expect(t.has(k)).toBe(false)
    for (const k of ['life', 'seq', 'from', 'to']) expect(t.get(k)).toBeTruthy()
  })

  test('the reused states keep the note today\'s queries read, verbatim; a fixer\'s verdict is logged as the fixer', () => {
    const verdict = eventArgv({ state: 'verdict', issue: 5, branch: 'issue-5', pr: 9, head: 'abc', note: 'CORRECT: r1-1 fixed the off-by-one' })
    expect(verdict.slice(-4)).toEqual(['--actor', 'fixer', '--note', 'CORRECT: r1-1 fixed the off-by-one'])
    expect(eventArgv({ state: 'delegated', issue: 5, branch: 'issue-5', pr: null, head: null, note: 'brief https://x/1' })).toEqual([
      'callum-flow-event', 'delegated', '--issue', '5', '--branch', 'issue-5', '--note', 'brief https://x/1',
    ])
    for (const note of ['review', 'ci', 'conflict', 'triage']) expect(eventArgv({ state: 'fix_requested', issue: 5, branch: null, pr: 9, head: null, note }).at(-1)).toBe(note)
  })

  test('an abandoned event says why with reason=: a drop, a split, a triage drop, a reconcile release', () => {
    const note = (n: string) => eventNote({ state: 'abandoned', issue: 5, branch: null, pr: null, head: null, note: n })
    expect(noteToken(note('dropped by the owner'), 'reason')).toBe('dropped')
    expect(noteToken(note('split into #12, #13'), 'reason')).toBe('split')
    expect(noteToken(note('triage: the issue is a duplicate'), 'reason')).toBe('triage')
    expect(noteToken(note('reason=dropped'), 'reason')).toBe('dropped')
    expect(noteToken(note('something else'), 'reason')).toBe('other')
    expect(noteToken(eventNote({ state: 'abandoned', issue: 5, branch: null, pr: 7, stage: 'implementing', checked: 'no run, no PR', reason: 'reconcile' }), 'reason')).toBe('reconcile')
    for (const r of ABANDON_REASONS) expect(abandonReason(`reason=${r}`)).toBe(r)
  })

  test('a release says reconcile, its stage, its PR and what was checked', () => {
    const e: ReleaseEvent = { state: 'reclaimed', issue: 7, branch: 'issue-7', pr: 31, stage: 'in pipeline', checked: 'no run updated in 30 min', reason: 'reconcile' }
    expect(eventNote(e)).toBe('reason=reconcile stage=in%20pipeline pr=31 checked=no%20run%20updated%20in%2030%20min')
  })
})

// --- the parser ---------------------------------------------------------------------------------------

describe('the parser', () => {
  const ok = eventArgv(transition(rng(5), true))
  const good = rowOf(ok)

  test('a transition with a missing or bad identifying token is not a record', () => {
    for (const drop of ['life', 'seq', 'to', 'cut', 'attempt', 'row']) {
      const note = (good.note ?? '').split(' ').filter(w => !w.startsWith(`${drop}=`)).join(' ')
      expect(parseTransition({ ...good, note })).toBeNull()
    }
    expect(parseTransition({ ...good, note: (good.note ?? '').replace(/ to=\S+/, ' to=limbo') })).toBeNull()
    expect(parseTransition({ ...good, note: (good.note ?? '').replace(/ cut=\S+/, ' cut=maybe') })).toBeNull()
    expect(parseTransition({ ...good, issue: null })).toBeNull()
    expect(parseTransition({ ...good, state: 'loop' })).toBeNull()
  })

  test('a hand-recorded rescue reads, with no fact or life', () => {
    expect(parseIntervention({ state: 'intervention', issue: 571, branch: null, pr: null, head: null, note: 'who=person cause=rescue reason=patched%20the%20trust%20file' })).toEqual({
      state: 'intervention',
      who: 'person',
      cause: 'rescue',
      reason: 'patched the trust file',
      issue: 571,
      life: null,
      pr: null,
      fact: '',
    })
    expect(parseIntervention({ state: 'intervention', issue: null, branch: null, pr: null, head: null, note: 'who=robot cause=x' })).toBeNull()
  })

  test('other states, and the sweep\'s own reclaimed, are not v2 events', () => {
    expect(parseEvent({ state: 'loop', issue: 5, branch: null, pr: null, head: null, note: 'kind=x key=y status=done' })).toBeNull()
    expect(parseEvent({ state: 'reclaimed', issue: 5, branch: null, pr: null, head: null, note: 'lease expired' })).toBeNull()
    expect(parseEvent({ state: 'claimed', issue: 5, branch: null, pr: null, head: null, note: null })).toBeNull()
  })
})
