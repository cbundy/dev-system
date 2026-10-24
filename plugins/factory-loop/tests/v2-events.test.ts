// The event seam (docs/factory-loop/v2/SPEC.md 7.1, property 18 of 17.1): every event v2 writes is
// built by hooks/v2/events.ts as a native call of callum-flow-event (its type and data), and the
// old format's note, which the readers of the old source still parse, parses back to the same
// fields, whole. Properties over generated events, not exact notes: the one exact note is the
// format's own example. oldArgv below is the fixture-side builder of the old line the loop wrote
// before it went native. tests/factory-loop-v2-events.test.js holds the native data to the
// translator's and runs the argvs through the real callum-flow-event.
import { describe, expect, test } from 'claude-code/testing'

import {
  ABANDON_REASONS,
  REASON_MAX,
  REUSED_STATES,
  abandonReason,
  dec,
  enc,
  eventArgv,
  eventColumns,
  eventNote,
  intervention,
  list,
  noteToken,
  parseEvent,
  parseIntervention,
  parseTransition,
  tokensOf,
} from '../hooks/v2/events'
import { prMergedAtOf, prSizeOf } from '../hooks/v2/argv'
import type { EventRow, InterventionEvent, ReleaseEvent, ReusedEvent, ReviewedEvent, TransitionEvent, V2Event } from '../hooks/v2/events'
import type { PrSize } from '../hooks/v2/event-data'
import { endedOf } from '../hooks/v2/lives'
import { CLOSED_WHYS, ISSUE_STATES, STEP_KINDS } from '../hooks/v2/types'
import type { IssueRecord, IssueState, OptionKey, ParkParts, WaitCondition } from '../hooks/v2/types'
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

function parts(g: Rng, max: number): ParkParts {
  const n = 2 + g.int(5)
  const options = Array.from({ length: n }, (_, i) => ({ key: 'ABCDEF'[i] as OptionKey, title: text(g, max), detail: maybe(g, text(g, max)) }))
  const withOptions = g.next() < 0.7
  return {
    decision: text(g, max),
    context: maybe(g, text(g, max)),
    options: withOptions ? options : null,
    recommended: withOptions && g.next() < 0.5 ? (options[g.int(n)] as { key: OptionKey }).key : null,
    recommendation: maybe(g, text(g, max)),
  }
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
    conflicts: g.int(6),
    round: g.int(6),
    question: maybe(g, text(g, free)),
    parts: maybe(g, parts(g, free)),
    why: state === 'closed' ? g.pick(CLOSED_WHYS) : null,
    notes: Array.from({ length: g.int(small ? 3 : 8) }, () => text(g, free)),
    prClosedAt: maybe(g, '2026-10-15T09:30:00Z'),
    wait: state === 'waiting' ? Array.from({ length: 1 + g.int(8) }, (): WaitCondition => (g.next() < 0.5 ? { kind: 'issue-closed', issue: 1 + g.int(9999) } : { kind: 'pr-merged', pr: 1 + g.int(9999) })) : null,
    lives: 1 + g.int(3),
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

// oldArgv: the argv the loop wrote before it went native: the old state, its columns, a fixer's
// actor and the note (kept builders, for the readers of the old source).
function oldArgv(e: V2Event): string[] {
  const c = eventColumns(e)
  const argv = ['callum-flow-event', e.state]
  if (c.issue !== null) argv.push('--issue', String(c.issue))
  if (c.branch !== null) argv.push('--branch', c.branch)
  if (c.pr !== null) argv.push('--pr', String(c.pr))
  if (c.head !== null) argv.push('--head', c.head)
  if (e.state === 'verdict') argv.push('--actor', 'fixer')
  argv.push('--note', eventNote(e))
  return argv
}

// splitNote: the note of a v2 split's `abandoned` event as the loop wrote it, in the token shape the
// translator reads, with the designer's four reasons and each child's why.
function splitNote(created: readonly number[], reasons: { why_split: string; why_count: string; why_parts: string; why_order: string } | null, childWhys: readonly string[] | null): string {
  const words = `split into ${created.join(',')}`
  if (reasons === null) return words
  return ['reason=split', `note=${enc(words)}`, `why_split=${enc(reasons.why_split)}`, `why_count=${enc(reasons.why_count)}`, `why_parts=${enc(reasons.why_parts)}`, `why_order=${enc(reasons.why_order)}`, `child_whys=${list(childWhys ?? [])}`].join(' ')
}

const roundTrip = (e: V2Event) => parseEvent(rowOf(oldArgv(e)))

// --- the format ----------------------------------------------------------------------------------------

describe('the note format (v2 SPEC 7.1)', () => {
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
        conflicts: 2,
        round: 1,
        question: null,
        parts: null,
        why: null,
        notes: ['check ci', 'a,b'],
        prClosedAt: null,
        wait: null,
        lives: 1,
      },
    }
    expect(eventNote(e)).toBe(
      'row=T9 life=ss1x2k seq=8 from=reviewing to=fixing seqAt=1000 since=1000 resumeTo=none step=fix attempt=1 cut=no triages=0 fixes=1 conflicts=2 round=1 why=none ' +
        'approvedPatch=none prClosedAt=none lives=1 wait=none via=ci-red brief=https://x/1#c question=none decision=none context=none options=none recommended=none recommendation=none notes=check%20ci,a%2Cb',
    )
  })
})

describe('the wait token (v2 SPEC 3.2, 7.1)', () => {
  const waiting = (wait: WaitCondition[] | null): TransitionEvent => ({
    state: 'transition',
    row: 'T16',
    from: 'designing',
    via: 'wait',
    record: {
      issue: 571,
      life: 'ss1x2k',
      seq: 3,
      seqAt: 1_000,
      state: 'waiting',
      since: 1_000,
      resumeTo: 'designing',
      branch: 'issue-571',
      pr: null,
      head: null,
      approvedPatch: null,
      brief: null,
      step: null,
      attempt: 1,
      cut: false,
      triages: 0,
      fixes: 0,
      conflicts: 0,
      round: 0,
      question: null,
      parts: null,
      why: null,
      notes: [],
      prClosedAt: null,
      wait,
      lives: 1,
    },
  })

  test('conflicts=<n> follows fixes=<n>; a note without the token reads 0, a bad one is no transition', () => {
    const e = { ...waiting(null), record: { ...waiting(null).record, conflicts: 3 } }
    const note = eventNote(e)
    expect(note).toContain(' fixes=0 conflicts=3 round=0')
    expect(roundTrip(e)).toEqual(e)
    const row: EventRow = { state: 'transition', issue: 571, branch: 'issue-571', pr: null, head: null, note: note.replace(' conflicts=3', '') }
    expect(parseTransition(row)?.record.conflicts).toBe(0)
    for (const bad of ['-1', '1.5', 'x', 'none']) expect(parseTransition({ ...row, note: `${row.note} conflicts=${bad}` })).toBeNull()
  })

  test('issue:<n>, pr:<n> and tag:<sha>, comma-joined, as the image translator reads them; none outside waiting; a note without the token reads null', () => {
    const wait: WaitCondition[] = [
      { kind: 'issue-closed', issue: 57 },
      { kind: 'pr-merged', pr: 812 },
      { kind: 'tag-contains', sha: '35bb655' },
    ]
    expect(tokensOf(eventNote(waiting(wait))).get('wait')).toBe('issue:57,pr:812,tag:35bb655')
    expect(tokensOf(eventNote(waiting(null))).get('wait')).toBe('none')
    expect(roundTrip(waiting(wait))).toEqual(waiting(wait))
    const note = eventNote(waiting(wait)).replace(' wait=issue:57,pr:812,tag:35bb655', '')
    const row: EventRow = { state: 'transition', issue: 571, branch: 'issue-571', pr: null, head: null, note }
    expect(parseTransition(row)?.record.wait).toBeNull()
    // a token that does not read is no transition
    expect(parseTransition({ ...row, note: `${note} wait=issue:0` })).toBeNull()
    expect(parseTransition({ ...row, note: `${note} wait=tag:35bb655` })?.record.wait).toEqual([{ kind: 'tag-contains', sha: '35bb655' }])
    expect(parseTransition({ ...row, note: `${note} wait=tag:35BB655` })).toBeNull()
    expect(parseTransition({ ...row, note: `${note} wait=tag:35bb65` })).toBeNull()
  })

  test('the long forms issue:<owner>/<name>#<n> and tag:<owner>/<name>@<sha> round-trip beside the short ones; bad repo forms do not read', () => {
    const wait: WaitCondition[] = [
      { kind: 'issue-closed', issue: 57 },
      { kind: 'issue-closed', issue: 57, repo: 'cbundy/dev-system' },
      { kind: 'pr-merged', pr: 812 },
      { kind: 'tag-contains', sha: '35bb655' },
      { kind: 'tag-contains', sha: '35bb655', repo: 'cbundy/dev-system' },
    ]
    expect(tokensOf(eventNote(waiting(wait))).get('wait')).toBe('issue:57,issue:cbundy/dev-system#57,pr:812,tag:35bb655,tag:cbundy/dev-system@35bb655')
    expect(roundTrip(waiting(wait))).toEqual(waiting(wait))
    const short: WaitCondition[] = [{ kind: 'issue-closed', issue: 57 }, { kind: 'pr-merged', pr: 812 }, { kind: 'tag-contains', sha: '35bb655' }]
    expect(tokensOf(eventNote(waiting(short))).get('wait')).toBe('issue:57,pr:812,tag:35bb655')
    const note = eventNote(waiting(wait)).replace(/ wait=\S+/, '')
    const row: EventRow = { state: 'transition', issue: 571, branch: 'issue-571', pr: null, head: null, note }
    for (const bad of ['tag:Owner/Name@35bb655', 'tag:a@35bb655', 'issue:a/b#0', 'pr:a/b#1', 'tag:a/b@', 'issue:A/b#1', 'issue:a/b#']) {
      expect({ bad, read: parseTransition({ ...row, note: `${note} wait=${bad}` }) }).toEqual({ bad, read: null })
    }
  })
})

// --- property 18: every note parses back, and fits ----------------------------------------------------

describe('every event events.ts builds parses back to the same fields (property 18)', () => {
  test('transitions, short or with long free text: the whole record comes back, nothing clipped', () => {
    const g = rng(18)
    for (let i = 0; i < 800; i += 1) {
      const e = transition(g, i % 2 === 0)
      expect(roundTrip(e)).toEqual(e)
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
      const iv: InterventionEvent = intervention(g.pick(['person', 'loop', 'judge'] as const), g.pick(['op:resume', 'unknown:timeout', 'free:load', 'push']), `i5/l${g.int(99)}/s3/t`, text(g, 120), {
        issue: maybe(g, 1 + g.int(99)),
        life: maybe(g, 'ss1x2k'),
        pr: maybe(g, 1 + g.int(99)),
      })
      const outcome = g.pick(['requeue', 'leave', 'reject'] as const)
      const release: ReleaseEvent = {
        state: outcome === 'requeue' ? 'reclaimed' : 'abandoned',
        issue: 1 + g.int(999),
        branch: maybe(g, 'issue-7'),
        pr: maybe(g, 12),
        stage: g.pick(['implementing', 'in pipeline', 'ready to merge']),
        checked: text(g, 80),
        reason: 'reconcile',
        outcome,
        lives: maybe(g, 1 + g.int(3)),
      }
      const reused: ReusedEvent = { state: g.pick(REUSED_STATES), issue: 1 + g.int(99), branch: maybe(g, 'issue-3'), pr: maybe(g, 4), head: maybe(g, 'abc'), note: text(g, 80) }
      for (const e of [reviewed, iv, release, reused] as V2Event[]) {
        expect(roundTrip(e)).toEqual(e)
      }
    }
  })

  test('a reason is one line of at most 200 characters, clipped with ...', () => {
    const long = intervention('loop', 'park', 'i5/lx/s3/t', `first line\nsecond ${'x'.repeat(400)}`, { issue: 5, life: 'x', pr: null })
    expect(long.reason.length).toBe(REASON_MAX)
    expect(long.reason).toMatch(/^first line second x+\.\.\.$/)
  })
})

// --- columns, the actor, and the reused states' notes -------------------------------------------------

describe('columns and notes per state', () => {
  test('a transition carries the record\'s issue, branch, PR and head as columns, never in the note', () => {
    const e = transition(rng(3), true)
    const argv = oldArgv(e)
    expect(rowOf(argv)).toMatchObject({ state: 'transition', issue: e.record.issue, branch: e.record.branch, pr: e.record.pr, head: e.record.head })
    const t = tokensOf(rowOf(argv).note)
    for (const k of ['issue', 'branch', 'pr', 'head']) expect(t.has(k)).toBe(false)
    for (const k of ['life', 'seq', 'from', 'to']) expect(t.get(k)).toBeTruthy()
  })

  test('the reused states keep the old note, verbatim; a fixer\'s verdict was logged as the fixer', () => {
    const verdict = oldArgv({ state: 'verdict', issue: 5, branch: 'issue-5', pr: 9, head: 'abc', note: 'CORRECT: r1-1 fixed the off-by-one' })
    expect(verdict.slice(-4)).toEqual(['--actor', 'fixer', '--note', 'CORRECT: r1-1 fixed the off-by-one'])
    expect(oldArgv({ state: 'merged', issue: 5, branch: 'issue-5', pr: 9, head: null, note: 'merged by the factory loop' }).slice(-2)).toEqual(['--note', 'merged by the factory loop'])
  })

  test('an abandoned event says why with reason=: a drop, a split, a triage drop, a reconcile release', () => {
    const note = (n: string) => eventNote({ state: 'abandoned', issue: 5, branch: null, pr: null, head: null, note: n })
    expect(noteToken(note('dropped by the owner'), 'reason')).toBe('dropped')
    expect(noteToken(note('split into #12, #13'), 'reason')).toBe('split')
    expect(noteToken(note('triage: the issue is a duplicate'), 'reason')).toBe('triage')
    expect(noteToken(note('reason=dropped'), 'reason')).toBe('dropped')
    expect(noteToken(note('something else'), 'reason')).toBe('other')
    expect(noteToken(eventNote({ state: 'abandoned', issue: 5, branch: null, pr: 7, stage: 'implementing', checked: 'no run, no PR', reason: 'reconcile', outcome: 'leave', lives: null }), 'reason')).toBe('reconcile')
    for (const r of ABANDON_REASONS) expect(abandonReason(`reason=${r}`)).toBe(r)
  })

  test('a split note with the designer\'s reasons still reads: its reason is split and its note the words', () => {
    const reasons = { why_split: 'Two areas', why_count: 'Two', why_parts: 'Apart', why_order: 'Independent' }
    const note = splitNote([12, 13], reasons, ['One', 'Two'])
    expect(note).toBe('reason=split note=split%20into%2012,13 why_split=Two%20areas why_count=Two why_parts=Apart why_order=Independent child_whys=One,Two')
    expect(abandonReason(note)).toBe('split')
    expect(noteToken(note, 'why_split')).toBe('Two areas')
    expect(parseEvent({ state: 'abandoned', issue: 5, branch: null, pr: null, head: null, note })).toMatchObject({ state: 'abandoned', note: 'split into 12,13' })
    expect(splitNote([12, 13], null, null)).toBe('split into 12,13')
    expect(splitNote([12, 13], reasons, null)).toEndWith('child_whys=none')
  })

  test('a release says reconcile, how it ended, the life it released, its stage, its PR and what was checked', () => {
    const e: ReleaseEvent = { state: 'reclaimed', issue: 7, branch: 'issue-7', pr: 31, stage: 'in pipeline', checked: 'no run updated in 30 min', reason: 'reconcile', outcome: 'requeue', lives: 2 }
    expect(eventNote(e)).toBe('reason=reconcile outcome=requeue lives=2 stage=in%20pipeline pr=31 checked=no%20run%20updated%20in%2030%20min')
    const migration: ReleaseEvent = { ...e, state: 'abandoned', outcome: 'leave', lives: null }
    expect(eventNote(migration)).toBe('reason=reconcile outcome=leave lives=none stage=in%20pipeline pr=31 checked=no%20run%20updated%20in%2030%20min')
  })

  test('a closed record with why done round-trips, and its life reads as already merged', () => {
    const e = transition(rng(11), true)
    const done: TransitionEvent = { ...e, record: { ...e.record, state: 'closed', why: 'done' } }
    expect(roundTrip(done)).toEqual(done)
    expect(endedOf(done.record)).toMatch(/^its work had merged already/)
  })

  test('a note from before the outcome and lives fields reads: a release by its state, with no count; a transition as a first life', () => {
    const old = (state: string) => ({ state, issue: 7, branch: null, pr: null, head: null, note: 'reason=reconcile stage=implementing pr=none checked=x' })
    expect(parseEvent(old('reclaimed'))).toMatchObject({ outcome: 'requeue', lives: null })
    expect(parseEvent(old('abandoned'))).toMatchObject({ outcome: 'leave', lives: null })
    const row = rowOf(oldArgv(transition(rng(6), true)))
    expect(parseTransition({ ...row, note: (row.note ?? '').replace(/ lives=\d+/, '') })?.record.lives).toBe(1)
    expect(parseTransition({ ...row, note: (row.note ?? '').replace(/ lives=\d+/, ' lives=0') })).toBeNull()
  })
})

// --- the parser ---------------------------------------------------------------------------------------

describe('the parser', () => {
  const ok = oldArgv(transition(rng(5), true))
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
    expect(parseIntervention({ state: 'intervention', issue: 7, branch: null, pr: null, head: null, note: 'who=judge cause=op:pause' })?.who).toBe('judge')
  })

  test('other states, and the sweep\'s own reclaimed, are not v2 events', () => {
    expect(parseEvent({ state: 'loop', issue: 5, branch: null, pr: null, head: null, note: 'kind=x key=y status=done' })).toBeNull()
    expect(parseEvent({ state: 'reclaimed', issue: 5, branch: null, pr: null, head: null, note: 'lease expired' })).toBeNull()
    expect(parseEvent({ state: 'claimed', issue: 5, branch: null, pr: null, head: null, note: null })).toBeNull()
  })
})

// --- the native call (v2 SPEC 7.1): the type and data callum-flow-event takes ---------------------------

describe('eventArgv: the native call of every event', () => {
  const data = (argv: string[]) => JSON.parse(argv[4] as string) as Record<string, unknown>

  test('the shape: --type, --data, then --issue and --actor when the event has them; never a state, a column, --note or --new-only', () => {
    const g = rng(7)
    const t = transition(g, true)
    const argv = eventArgv(t)
    expect(argv.slice(0, 4)).toEqual(['callum-flow-event', '--type', 'transition', '--data'])
    expect(argv.slice(5)).toEqual(['--issue', String(t.record.issue)])
    for (const flag of ['--note', '--branch', '--pr', '--head', '--new-only']) expect(argv).not.toContain(flag)
    expect(eventArgv.length).toBe(1)
  })

  test('a transition: the translator\'s field names, the times as ISO, the parts and wait as data', () => {
    const e = transition(rng(5), true)
    const d = data(eventArgv(e))
    expect(d).toMatchObject({ life: e.record.life, seq: e.record.seq, table_row: e.row, from_state: e.from, to_state: e.record.state, via: e.via, lives: e.record.lives, conflicts: e.record.conflicts, cut: e.record.cut })
    expect(d.seq_at).toBe(new Date(e.record.seqAt).toISOString())
    expect(d.state_since).toBe(new Date(e.record.since).toISOString())
    expect(d.wait).toEqual(e.record.wait === null || e.record.wait.length === 0 ? null : e.record.wait)
    expect(Object.keys(d)).toContain('decision')
  })

  test('a fixer\'s verdict is a finding_handled for the fixer; a bad verdict note is no event', () => {
    const argv = eventArgv({ state: 'verdict', issue: 5, branch: 'issue-5', pr: 9, head: 'abc1234', note: 'WRONG: r1-1 the test covers it' })
    expect(argv).toEqual(['callum-flow-event', '--type', 'finding_handled', '--data', JSON.stringify({ branch: 'issue-5', pr: 9, head: 'abc1234', finding: 'r1-1', outcome: 'declined', detail: 'the test covers it' }), '--issue', '5', '--actor', 'fixer'])
    expect(data(eventArgv({ state: 'verdict', issue: 5, branch: 'issue-5', pr: null, head: null, note: 'CORRECT: r2-3: fixed' }))).toMatchObject({ finding: 'r2-3', outcome: 'fixed', detail: 'fixed', pr: null, head: null })
    expect(() => eventArgv({ state: 'verdict', issue: 5, branch: 'issue-5', pr: null, head: null, note: 'maybe' })).toThrow(/neither CORRECT nor WRONG/)
  })

  test('prSizeOf: per-file counts kept, an empty path or a bad count dropped from file_lines, null on bad JSON or missing totals', () => {
    const out = prSizeOf(JSON.stringify({
      files: [{ path: 'a.js', additions: 3, deletions: 1 }, { path: '', additions: 1, deletions: 1 }, { path: 'b.md', additions: 'x', deletions: 0 }, { path: 'c.md', additions: -1, deletions: 0 }, { path: 'd.md', additions: 1.5, deletions: 0 }, null],
      additions: 9,
      deletions: 4,
    }))
    expect(out).toEqual({ files: ['a.js', 'b.md', 'c.md', 'd.md'], fileLines: [{ path: 'a.js', additions: 3, deletions: 1 }], additions: 9, deletions: 4 })
    expect(prSizeOf('not json')).toBeNull()
    expect(prSizeOf('{"files": []}')).toBeNull()
  })

  test('a merge: by the factory when the loop merged it, by hand otherwise; recovered when logged afterwards', () => {
    const merged = (note: string) => data(eventArgv({ state: 'merged', issue: 5, branch: 'issue-5', pr: 9, head: 'abc1234', note }))
    expect(merged('merged by the factory loop')).toEqual({ pr: 9, branch: 'issue-5', head: 'abc1234', by: 'factory', recovered: true, files: null, file_lines: null, additions: null, deletions: null, merged_at: null, title: null })
    expect(merged('merged by hand')).toMatchObject({ by: 'hand', recovered: true })
    expect(merged('')).toMatchObject({ by: 'factory', recovered: false })
    // the size the executor read rides along; without one, a failed read or no pull request it is null
    const sized = (pr: number | null, size?: PrSize | null) => data(eventArgv({ state: 'merged', issue: 5, branch: 'issue-5', pr, head: 'abc1234', note: 'merged by hand', ...(size === undefined ? {} : { size }) }))
    const fileLines = [{ path: 'a.js', additions: 8, deletions: 1 }, { path: 'b/c.sh', additions: 4, deletions: 2 }]
    const size = { files: ['a.js', 'b/c.sh'], fileLines, additions: 12, deletions: 3 }
    expect(sized(9, size)).toEqual({ pr: 9, branch: 'issue-5', head: 'abc1234', by: 'hand', recovered: true, files: ['a.js', 'b/c.sh'], file_lines: fileLines, additions: 12, deletions: 3, merged_at: null, title: null })
    expect(sized(9, null)).toMatchObject({ files: null, file_lines: null, additions: null, deletions: null })
    expect(sized(9, { files: null, fileLines: null, additions: null, deletions: null })).toMatchObject({ files: null, file_lines: null, additions: null, deletions: null })
    expect(sized(null, size)).toMatchObject({ pr: null, files: null, file_lines: null, additions: null, deletions: null })
    // merged_at is the time the executor read, as given; null when unread or with no pull request; title is always null
    const at = (pr: number | null, mergedAt?: string | null) => data(eventArgv({ state: 'merged', issue: 5, branch: 'issue-5', pr, head: 'abc1234', note: 'merged by hand', ...(mergedAt === undefined ? {} : { mergedAt }) }))
    expect(at(9, '2026-10-22T21:22:01Z')).toMatchObject({ merged_at: '2026-10-22T21:22:01Z', title: null })
    expect(at(9, null)).toMatchObject({ merged_at: null, title: null })
    expect(at(9)).toMatchObject({ merged_at: null, title: null })
    expect(at(null, '2026-10-22T21:22:01Z')).toMatchObject({ merged_at: null, title: null })
    expect(prMergedAtOf('{"mergedAt":"2026-10-22T21:22:01Z"}')).toBe('2026-10-22T21:22:01Z')
    expect(prMergedAtOf('{"mergedAt":""}')).toBeNull()
    expect(prMergedAtOf('{"mergedAt":5}')).toBeNull()
    expect(prMergedAtOf('{}')).toBeNull()
    expect(prMergedAtOf('not json')).toBeNull()
  })

  test('an abandoned: a drop, a split with its children, a triage drop, and a release by its outcome', () => {
    const abandoned = (note: string) => data(eventArgv({ state: 'abandoned', issue: 5, branch: null, pr: null, head: null, note }))
    expect(abandoned('dropped by the owner')).toMatchObject({ reason: 'dropped', split_into: [], detail: 'dropped by the owner', branch: null, pr: null })
    expect(abandoned('split into 12, 13')).toMatchObject({ reason: 'split', split_into: [12, 13] })
    expect(abandoned('triage: duplicate')).toMatchObject({ reason: 'triage' })
    const release = (outcome: ReleaseEvent['outcome'], lives: number | null) => {
      const e: ReleaseEvent = { state: outcome === 'requeue' ? 'reclaimed' : 'abandoned', issue: 7, branch: 'issue-7', pr: 31, stage: 'in pipeline', checked: 'no run', reason: 'reconcile', outcome, lives }
      return eventArgv(e)
    }
    expect(release('requeue', 2).slice(0, 3)).toEqual(['callum-flow-event', '--type', 'requeued'])
    expect(data(release('requeue', 2))).toEqual({ reason: 'reconcile', stage: 'in pipeline', lives: 2, branch: 'issue-7', pr: 31, detail: 'no run' })
    expect(data(release('leave', null))).toMatchObject({ reason: 'reconcile', lives: null, split_into: [], child_whys: null, detail: 'no run' })
    expect(data(release('reject', 3))).toMatchObject({ reason: 'rejected', lives: 3 })
  })

  test('an intervention: the flake fields only on a flake row, the jobs and head on a refused check\'s', () => {
    const base = intervention('loop', 'ci-rerun', 'i5/lx/rerun/r1/9', 'a failed check re-run', { issue: 5, life: 'x', pr: 9 })
    expect(data(eventArgv(base))).toEqual({ who: 'loop', cause: 'ci-rerun', life: 'x', fact: 'i5/lx/rerun/r1/9', pr: 9, detail: 'a failed check re-run', flaky: null, failed_tests: null, failed_jobs: null, head: null })
    expect(data(eventArgv({ ...base, flaky: true, head: 'abc1234', failed_jobs: ['ci'], failed_tests: ['a, b'] }))).toMatchObject({ flaky: true, head: 'abc1234', failed_jobs: ['ci'], failed_tests: ['a, b'] })
    expect(data(eventArgv({ ...base, flaky: false, failed_jobs: null, failed_tests: [] }))).toMatchObject({ flaky: false, failed_jobs: null, failed_tests: null, head: null })
    expect(data(eventArgv({ ...base, failed_jobs: ['ci'], head: 'abc1234' }))).toMatchObject({ flaky: null, failed_tests: null, failed_jobs: ['ci'], head: 'abc1234' })
  })

  test('a fleet-level intervention names no issue; the new-format events keep their argv', () => {
    const iv = intervention('person', 'op:mode', 'op/fleet/mode', 'mode act', { issue: null, life: null, pr: null })
    expect(eventArgv(iv)).not.toContain('--issue')
    expect(eventArgv({ state: 'comment_posted', issue: 5, data: { life: 'x', seq: 1, to_state: 'parked', comment_url: 'https://x/1' } })).toEqual(['callum-flow-event', '--type', 'comment_posted', '--data', '{"life":"x","seq":1,"to_state":"parked","comment_url":"https://x/1"}', '--issue', '5'])
  })

  test('the states the loop no longer writes build no event', () => {
    for (const state of ['delegated', 'fix_requested', 'merge_ready']) expect(() => eventArgv({ state, issue: 5, branch: null, pr: null, head: null, note: 'x' } as never)).toThrow(/not an event v2 writes/)
    expect(REUSED_STATES).toEqual(['abandoned', 'merged', 'verdict'])
  })
})
