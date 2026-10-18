// The transition table (docs/factory-loop/v2/SPEC.md 4.3, 4.6), held as data: 36 rows, each
// naming the states it applies to, the event it takes, a pure guard, the next state and the pure
// change to the record; and the event each state logs on entry. rowFor is the only lookup:
// plan calls it and the tests enumerate it. The guards on one (state, step, event, guard input)
// are exclusive and exhaustive, so rowFor finds exactly one row or throws, which is a test failure,
// never a runtime path: plan first brings an event into the domain the table covers (normalize).
// E7 is the explicit row for an event with no meaning in the state, one per event kind.
//
// Pure: the time is the caller's `now`, the settings the caller's Config.
import type { Config, Ms } from '../types'
import { EVENT_KINDS, ISSUE_STATES, OUTSIDE_CAUSES, STATE_STEP } from './types'
import { waitKey } from './sources-waits'
import type { EmitState, IssueRecord, IssueState, Row, TableEvent, WaitCondition } from './types'

// --- the states the rows name ------------------------------------------------------------------------

// The step states (4.3): the states whose step can end unknown or call triage.
export const STEP_STATES: readonly IssueState[] = ['designing', 'building', 'reviewing', 'fixing', 'merge-queue']
// Every state but closed, which is absorbing.
export const LIVE_STATES: readonly IssueState[] = ISSUE_STATES.filter(s => s !== 'closed')

// The not-ok reasons each state's own step gives (4.2): the guard inputs of T3, T4, T9, T10, T14
// and T15. A step module that gives another one is read as unknown (normalize).
export const NOT_OK_REASONS: Readonly<Record<IssueState, readonly string[]>> = {
  queued: [],
  designing: ['question', 'split', 'wait'],
  building: ['cannot', 'no-commit'],
  reviewing: ['changes', 'ci-red', 'conflict'],
  fixing: ['declined', 'unchanged'],
  'merge-queue': ['changes', 'ci-red', 'conflict', 'patch', 'policy'],
  parked: [],
  waiting: [],
  closed: [],
}

// The not-ok reasons that send a PR to a fixer (T9, T10), with the `fix_requested` note each logs.
export const FIX_REASONS: Readonly<Record<string, 'review' | 'ci' | 'conflict'>> = { changes: 'review', 'ci-red': 'ci', conflict: 'conflict' }

// What an event carries for the rows that read it. The step modules (rules-agent.ts and the units'
// own) and the GitHub and owner events put these in TableEvent.data; a row reads only its own.
export type EventData = {
  // a step's result in words: the builder's reason, the findings, the failed checks, the conflict,
  // the guard's FAIL lines
  text?: string
  // C1: the release tag each tag-contains read compared against, by the condition's waitKey
  tags?: Record<string, string>
  // a designer's or the triage's question for the owner (T3, X4)
  question?: string
  // T2: the brief comment's URL, once the loop posted it
  brief?: string
  // T5, T11: the head a writer confirmed on origin
  head?: string
  // T8: the patch id the reviewer approved; T8, T9, T10: the PR the reviewing step ensured; E3,
  // E4: the PR GitHub's event is about
  patch?: string
  pr?: number
  // T9, T12: the findings, failed checks, conflict or decline reasons for the next step; a failed
  // check is one note in the shape prompts-work.ts checkNote gives, so the fixer gets its id and
  // its run link (the PR source does not cover a record in fixing, 2.4)
  notes?: string[]
  // X1, X2, X3: the triage's instructions
  instructions?: string
  // X2, X4: whether the branch has commits beyond the base, when the triage's reader knows
  commits?: boolean
  // E4, P1: GitHub's closedAt of the PR's hand close
  closedAt?: string
  // T16: the conditions the designer waits on, and why
  conditions?: WaitCondition[]
  // P1: the owner's note, or the trusted comments posted after the park
  note?: string
}

export function dataOf(e: TableEvent): EventData {
  return e.data !== null && typeof e.data === 'object' && !Array.isArray(e.data) ? (e.data as EventData) : {}
}

// --- the guards' facts -----------------------------------------------------------------------------------

// ownStep: the record runs its state's own step, not triage.
export function ownStep(r: IssueRecord): boolean {
  return STATE_STEP[r.state] !== null && r.step === STATE_STEP[r.state]
}

const onTriage = (r: IssueRecord) => r.step === 'triage'

// tellPeriodic: the records whose `timeout` event is a tell period (E6, 4.4): queued for its slot,
// parked, waiting on a condition, and a merge-queue record on its queue step, which waits when it is behind the head. The
// head's step runs: rules-state.ts sends a running step's timeout as its unknown (why timeout),
// so a hung head takes U1 to U4, never E6. Anywhere else a timeout is the running step's unknown.
export function tellPeriodic(r: IssueRecord): boolean {
  return r.state === 'queued' || r.state === 'parked' || r.state === 'waiting' || (r.state === 'merge-queue' && r.step === 'queue')
}

// sameTarget: where "resumeTo same state" leads (3.2): a record parked from queued or waiting keeps
// that state's own target, never queued or waiting itself.
export function sameTarget(r: IssueRecord): IssueState {
  return r.state === 'queued' || r.state === 'waiting' ? (r.resumeTo ?? 'designing') : r.state
}

// commits: the branch has commits beyond the base (X2): the event's word, else a head a writer
// confirmed on origin or a PR the life has.
function commits(r: IssueRecord, e: TableEvent): boolean {
  return dataOf(e).commits ?? (r.head !== null || r.pr !== null)
}

const outside = (e: TableEvent) => e.cause !== undefined && e.cause !== null && (OUTSIDE_CAUSES as readonly string[]).includes(e.cause)
const fixable = (e: TableEvent) => e.reason !== undefined && e.reason in FIX_REASONS
const u1 = (r: IssueRecord, e: TableEvent) => outside(e) && !r.cut
const fixValid = (r: IssueRecord, e: TableEvent, c: Config) => commits(r, e) && r.fixes < c.reviewFixCap

// --- what the rows write -----------------------------------------------------------------------------------

// A note is a short line for the step of a seq; a record keeps at most NOTES_MAX of them.
const NOTE_MAX = 1000
const NOTES_MAX = 8

function clip(text: string, max = NOTE_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 3)}...` : t
}

// the cap of a stored question: question.mjs's QUESTION_CAP, which the planner may not import
const QUESTION_CAP = 2000

// capQuestion: an agent's question as markdown: its line breaks kept, trimmed, cut by length only.
function capQuestion(text: string): string {
  const t = text.trim()
  return t.length > QUESTION_CAP ? `${t.slice(0, QUESTION_CAP - 3)}...` : t
}

// questionOf: the question an event gives, as the agent wrote it, else its one-line text.
function questionOf(e: TableEvent, fallback: string): string {
  const q = dataOf(e).question
  return q !== undefined ? capQuestion(q) : clip(textOf(e, fallback), QUESTION_CAP)
}

// textOf: an event's result in words, for a question or a note.
function textOf(e: TableEvent, fallback: string): string {
  const d = dataOf(e)
  return clip(d.text ?? d.question ?? e.reason ?? fallback)
}

// distinct: the notes given, each clipped and each once (at its last place), the empty left out.
function distinct(notes: readonly (string | null | undefined)[]): string[] {
  const kept = notes.filter((n): n is string => typeof n === 'string' && n !== '').map(n => clip(n))
  return kept.filter((n, i) => kept.lastIndexOf(n) === i)
}

// clauses: the notes given (distinct) as one line of clauses, each without its own closing mark, so
// a sentence ends nowhere but at the line's end; a clipped note keeps its '...'.
function clauses(notes: readonly (string | null | undefined)[]): string {
  return distinct(notes)
    .map(n => n.replace(/(?<!\.)[.;:,]$/, ''))
    .join('; ')
}

// added: the record's notes with these added (a same-state row keeps the seq's notes).
function added(r: IssueRecord, ...more: (string | null | undefined)[]): string[] {
  return distinct([...r.notes, ...more]).slice(-NOTES_MAX)
}

// own: the notes of a row that changes the state (they replace the old seq's).
function own(...notes: (string | null | undefined)[]): string[] {
  return distinct(notes).slice(-NOTES_MAX)
}

// attemptNote: an unknown's line, which U4's question repeats as one of the last two results.
function attemptNote(r: IssueRecord, e: TableEvent): string {
  return `attempt ${r.attempt} of ${r.step ?? 'the step'} ended unknown (${e.why ?? 'unknown'}): ${e.reason ?? 'no reason given'}`
}

const ATTEMPT = /^attempt \d+ of /

// lastTwo: U4's question, from the earlier unknown's note and this one.
function lastTwo(r: IssueRecord, e: TableEvent): string {
  const earlier = r.notes.filter(n => ATTEMPT.test(n)).slice(-1)
  const step = r.step === 'triage' ? `the triage of ${r.state}` : `${r.step ?? 'the step'} in ${r.state}`
  return clip(`${step} gave no usable result twice: ${clauses([...earlier, attemptNote(r, e)])}`, 2000)
}

const none = () => ({})

// clearedNote: the line a resumed designer reads in its notes, naming each condition that held.
function clearedNote(wait: readonly WaitCondition[], tags: Record<string, string> | undefined): string {
  const held = wait.map(c =>
    c.kind === 'issue-closed'
      ? `${c.repo ?? ''}#${c.issue} closed`
      : c.kind === 'pr-merged'
        ? `PR #${c.pr} merged`
        : `release ${tags?.[waitKey(c)] ?? 'tag'}${c.repo === undefined ? '' : ` of ${c.repo}`} contains ${c.sha}`,
  )
  // not ending on "closed": a prompt rewrites a closing keyword at a line's end (prompts.ts neutral)
  return `The loop resumed this: ${held.join(', ')}; every condition holds.`
}

// lifePrOf: the life's PR (E3, E4): the record's, else the one GitHub's event names, which the
// review step's ensure opened before reviewing ended and set the record's (8.1).
const lifePrOf = (r: IssueRecord, e: TableEvent): number | null => r.pr ?? dataOf(e).pr ?? null

// --- the rows ----------------------------------------------------------------------------------------------

// The event a state logs on entry beside `transition` (4.5): every row that enters the state logs
// it, a resume's T1 and a same-state entry (X2) included, so a reader counts every entry (7.1).
export const ENTRY_EVENTS: Readonly<Partial<Record<IssueState, EmitState>>> = { building: 'delegated', fixing: 'fix_requested', 'merge-queue': 'merge_ready' }

// T1 leads where resumeTo says, counting an entry to reviewing as a round and an entry to fixing as
// a fix, as every other entry to them counts (3.2: round counts entries to reviewing, fixes entries
// to fixing). Queued's own step, the lease, reads no notes: its notes (S0's, P1's resume note) are
// for the step T1 leads to, so they are T1's notes.
function leased(r: IssueRecord): Partial<IssueRecord> {
  const to = r.resumeTo ?? 'designing'
  return { round: to === 'reviewing' ? r.round + 1 : r.round, fixes: to === 'fixing' ? r.fixes + 1 : r.fixes, resumeTo: null, notes: r.notes }
}

// The rows of 4.3. S0 makes a record from its claim and is never matched by rowFor (madeRecord);
// E7 is the fallback, one row per event kind (E7_ROWS).
const ROWS: readonly Row[] = [
  { id: 'S0', states: [], on: 'ok', next: 'queued', change: none, via: 'claim' },
  // step results (S3)
  { id: 'T1', states: ['queued'], on: 'ok', when: r => ownStep(r), next: 'resumeTo', change: leased, via: 'lease' },
  { id: 'T2', states: ['designing'], on: 'ok', when: r => ownStep(r), next: 'building', change: (r, e) => ({ brief: dataOf(e).brief ?? r.brief }), via: 'brief' },
  {
    id: 'T3',
    states: ['designing'],
    on: 'not-ok',
    when: (r, e) => ownStep(r) && e.reason === 'question',
    next: 'parked',
    change: (_r, e) => ({ question: questionOf(e, 'the designer asks the owner'), resumeTo: 'designing' }),
    via: 'question',
  },
  { id: 'T4', states: ['designing'], on: 'not-ok', when: (r, e) => ownStep(r) && e.reason === 'split', next: 'closed', change: (_r, e) => ({ why: 'split', notes: own(textOf(e, 'split')) }), via: 'split' },
  {
    id: 'T16',
    states: ['designing'],
    on: 'not-ok',
    when: (r, e) => ownStep(r) && e.reason === 'wait',
    next: 'waiting',
    change: (_r, e) => ({ wait: dataOf(e).conditions ?? null, resumeTo: 'designing', notes: own(textOf(e, 'the designer waits on a condition')) }),
    via: 'wait',
  },
  { id: 'T5', states: ['building'], on: 'ok', when: r => ownStep(r), next: 'reviewing', change: (r, e) => ({ head: dataOf(e).head ?? r.head, round: r.round + 1 }), via: 'build' },
  {
    id: 'T6',
    states: ['building'],
    on: 'not-ok',
    when: (r, _e, c) => ownStep(r) && r.triages < c.maxTriages,
    next: 'same',
    change: (r, e) => ({ step: 'triage', attempt: 1, triages: r.triages + 1, cut: false, notes: added(r, `the builder could not finish (${e.reason ?? 'cannot'}): ${textOf(e, 'no reason given')}`) }),
    via: 'cannot',
  },
  {
    id: 'T7',
    states: ['building'],
    on: 'not-ok',
    when: (r, _e, c) => ownStep(r) && r.triages >= c.maxTriages,
    next: 'parked',
    change: (_r, e) => ({ question: clip(`the builder could not finish (${e.reason ?? 'cannot'}): ${textOf(e, 'no reason given')}`, 2000), resumeTo: 'building' }),
    via: 'cannot',
  },
  {
    id: 'T8',
    states: ['reviewing'],
    on: 'ok',
    when: r => ownStep(r),
    next: 'merge-queue',
    change: (r, e) => ({ approvedPatch: dataOf(e).patch ?? r.approvedPatch, pr: dataOf(e).pr ?? r.pr }),
    via: 'approve',
  },
  {
    id: 'T9',
    states: ['reviewing', 'merge-queue'],
    on: 'not-ok',
    when: (r, e, c) => ownStep(r) && fixable(e) && r.fixes < c.reviewFixCap,
    next: 'fixing',
    change: (r, e) => ({ fixes: r.fixes + 1, pr: dataOf(e).pr ?? r.pr, notes: own(...(dataOf(e).notes ?? [textOf(e, e.reason ?? 'changes')])) }),
    via: 'fix:',
  },
  {
    id: 'T10',
    states: ['reviewing', 'merge-queue'],
    on: 'not-ok',
    when: (r, e, c) => ownStep(r) && fixable(e) && r.fixes >= c.reviewFixCap,
    next: 'parked',
    change: (r, e) => ({
      question: clip(`the fix cap (${r.fixes} fix rounds) is reached and the PR still needs changes: ${clauses([...(dataOf(e).notes ?? []), textOf(e, e.reason ?? 'changes')])}`, 2000),
      resumeTo: 'fixing',
      pr: dataOf(e).pr ?? r.pr,
    }),
    via: 'fix-cap:',
  },
  { id: 'T11', states: ['fixing'], on: 'ok', when: r => ownStep(r), next: 'reviewing', change: (r, e) => ({ head: dataOf(e).head ?? r.head, round: r.round + 1 }), via: 'fix' },
  {
    id: 'T12',
    states: ['fixing'],
    on: 'not-ok',
    when: (r, e) => ownStep(r) && e.reason === 'declined',
    next: 'reviewing',
    change: (r, e) => ({ round: r.round + 1, notes: own(...(dataOf(e).notes ?? [textOf(e, 'every finding declined')])) }),
    via: 'declined',
  },
  {
    id: 'T17',
    states: ['fixing'],
    on: 'not-ok',
    when: (r, e) => ownStep(r) && e.reason === 'unchanged',
    next: 'reviewing',
    change: (r, e) => ({ round: r.round + 1, notes: own(...(dataOf(e).notes ?? [textOf(e, 'a finding fixed without a code change')])) }),
    via: 'unchanged',
  },
  { id: 'T13', states: ['merge-queue'], on: 'ok', when: r => ownStep(r), next: 'closed', change: () => ({ why: 'merged' }), via: 'merged' },
  { id: 'T14', states: ['merge-queue'], on: 'not-ok', when: (r, e) => ownStep(r) && e.reason === 'patch', next: 'reviewing', change: r => ({ approvedPatch: null, round: r.round + 1 }), via: 'patch' },
  {
    id: 'T15',
    states: ['merge-queue'],
    on: 'not-ok',
    when: (r, e) => ownStep(r) && e.reason === 'policy',
    next: 'parked',
    change: (_r, e) => ({ question: clip(`the merge guard refused what only the owner can change: ${textOf(e, 'policy')}`, 2000), resumeTo: 'merge-queue' }),
    via: 'policy',
  },
  // the unknown path (S4, section 5)
  { id: 'U1', states: STEP_STATES, on: 'unknown', when: (r, e) => u1(r, e), next: 'same', change: (r, e) => ({ cut: true, notes: added(r, attemptNote(r, e)) }), via: 'free:' },
  { id: 'U2', states: STEP_STATES, on: 'unknown', when: (r, e) => !u1(r, e) && r.attempt <= 1, next: 'same', change: (r, e) => ({ attempt: 2, cut: false, notes: added(r, attemptNote(r, e)) }), via: 'unknown:' },
  {
    id: 'U3',
    states: STEP_STATES,
    on: 'unknown',
    when: (r, e, c) => !u1(r, e) && r.attempt >= 2 && r.step !== 'triage' && r.triages < c.maxTriages,
    next: 'same',
    change: (r, e) => ({ step: 'triage', attempt: 1, triages: r.triages + 1, cut: false, notes: added(r, attemptNote(r, e)) }),
    via: 'unknown:',
  },
  {
    id: 'U4',
    states: STEP_STATES,
    on: 'unknown',
    when: (r, e, c) => !u1(r, e) && r.attempt >= 2 && (r.step === 'triage' || r.triages >= c.maxTriages),
    next: 'parked',
    change: (r, e) => ({ question: lastTwo(r, e), resumeTo: sameTarget(r) }),
    via: 'unknown:',
  },
  // the triage's answers (S5)
  {
    id: 'X1',
    states: STEP_STATES,
    on: 'triage',
    when: (r, e) => onTriage(r) && e.choice === 'retry',
    next: 'same',
    change: (r, e) => ({ step: STATE_STEP[r.state], attempt: 2, cut: false, notes: added(r, dataOf(e).instructions) }),
    via: 'triage:',
  },
  {
    id: 'X2',
    states: STEP_STATES,
    on: 'triage',
    when: (r, e, c) => onTriage(r) && e.choice === 'fix' && fixValid(r, e, c),
    next: 'fixing',
    change: (r, e) => ({ fixes: r.fixes + 1, notes: own(dataOf(e).instructions) }),
    via: 'triage:',
  },
  { id: 'X3', states: STEP_STATES, on: 'triage', when: (r, e) => onTriage(r) && e.choice === 'redesign', next: 'designing', change: (_r, e) => ({ notes: own(dataOf(e).instructions) }), via: 'triage:' },
  {
    id: 'X4',
    states: STEP_STATES,
    on: 'triage',
    when: (r, e, c) => onTriage(r) && (e.choice === 'park' || (e.choice === 'fix' && !fixValid(r, e, c))),
    next: 'parked',
    change: (r, e) => ({
      question:
        e.choice === 'park'
          ? questionOf(e, 'the triage asks the owner')
          : clip(`the triage chose a fixer, which is not possible here (${commits(r, e) ? `the fix cap of ${r.fixes} rounds is reached` : 'the branch has no commits beyond the base'}): ${e.reason ?? ''}`, 2000),
      resumeTo: sameTarget(r),
    }),
    via: 'triage:',
  },
  { id: 'X5', states: STEP_STATES, on: 'triage', when: (r, e) => onTriage(r) && e.choice === 'drop', next: 'closed', change: (_r, e) => ({ why: 'dropped', notes: own(`triage: ${e.reason ?? 'dropped'}`) }), via: 'triage:' },
  // the owner's and GitHub's events (S6)
  { id: 'E1', states: LIVE_STATES, on: 'drop', next: 'closed', change: () => ({ why: 'dropped', notes: own('dropped') }), via: 'drop' },
  { id: 'E2', states: LIVE_STATES, on: 'issue-closed', next: 'closed', change: () => ({ why: 'closed-on-github' }), via: 'issue-closed' },
  { id: 'E3', states: LIVE_STATES, on: 'pr-merged', when: (r, e) => lifePrOf(r, e) !== null, next: 'closed', change: (r, e) => ({ why: 'merged-by-hand', pr: lifePrOf(r, e) }), via: 'pr-merged' },
  {
    id: 'E4',
    states: LIVE_STATES.filter(s => s !== 'parked'),
    on: 'pr-closed',
    when: (r, e) => lifePrOf(r, e) !== null,
    next: 'parked',
    change: (r, e) => ({ question: `PR #${lifePrOf(r, e)} was closed by hand; a resume reopens it`, resumeTo: sameTarget(r), pr: lifePrOf(r, e), prClosedAt: dataOf(e).closedAt ?? r.prClosedAt }),
    via: 'pr-closed',
  },
  { id: 'E5', states: LIVE_STATES, on: 'claim-lost', next: 'closed', change: () => ({ why: 'claim-lost' }), via: 'claim-lost' },
  { id: 'E6', states: ['queued', 'merge-queue', 'parked', 'waiting'], on: 'timeout', when: r => tellPeriodic(r), next: 'same', change: none, via: 'timeout' },
  // the waiting state: every condition holds (S6)
  {
    id: 'C1',
    states: ['waiting'],
    on: 'cleared',
    next: 'queued',
    change: (r, e) => ({ resumeTo: r.resumeTo ?? 'designing', attempt: 1, triages: 0, cut: false, notes: own(clearedNote(r.wait ?? [], dataOf(e).tags)) }),
    via: 'cleared',
  },
  // the parked state (S6)
  {
    id: 'P1',
    states: ['parked', 'waiting'],
    on: 'unpark',
    next: 'queued',
    change: (r, e) => ({ resumeTo: r.resumeTo, attempt: 1, triages: 0, fixes: 0, cut: false, prClosedAt: laterOf(r.prClosedAt, dataOf(e).closedAt ?? null), notes: own(dataOf(e).note) }),
    via: 'unpark:',
  },
]

// E7: an event with no meaning in the state (a late result of an ended seq, pr-closed while parked,
// an unpark of a record that is not parked, pr-merged or pr-closed with no PR, every event in
// closed). It changes nothing: plan logs it in the decision log. One row per event kind, all E7.
const E7_ROWS: readonly Row[] = EVENT_KINDS.map(on => ({ id: 'E7', states: ISSUE_STATES, on, next: 'same', change: none, via: 'none' }))

export const TABLE: readonly Row[] = [...ROWS, ...E7_ROWS]

// The 35 row ids, in the table's order.
export const ROW_IDS: readonly string[] = [...new Set(TABLE.map(r => r.id))]

// laterOf: the later of two GitHub timestamps (ISO strings compare in time order).
function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return a >= b ? a : b
}

// --- the lookup --------------------------------------------------------------------------------------------

// normalize: the event as the table reads it. A timeout outside a waiting record is the running
// step's unknown (why timeout); a waiting record's stays a timeout (E6). A not-ok whose reason the state's own step
// cannot give is an outcome outside the step's known outcomes, so it is unknown (5.1).
export function normalize(r: IssueRecord, e: TableEvent): TableEvent {
  if (e.kind === 'timeout' && !tellPeriodic(r)) return { ...e, kind: 'unknown', why: e.why ?? 'timeout', reason: e.reason ?? 'the step ran past its timeout' }
  if (e.kind === 'not-ok' && ownStep(r) && !NOT_OK_REASONS[r.state].includes(e.reason ?? '')) {
    return { ...e, kind: 'unknown', why: 'bad-answer', reason: `an outcome the table does not know: not-ok ${e.reason ?? 'with no reason'}` }
  }
  return e
}

// rowFor: the one row for this record and event (4.6): exactly one row that is not E7, else E7.
// Throws when two rows match: the guards are exclusive, so that is a bug the totality test finds.
export function rowFor(r: IssueRecord, e: TableEvent, c: Config): Row {
  const ev = normalize(r, e)
  const hits = ROWS.filter(row => row.id !== 'S0' && row.on === ev.kind && row.states.includes(r.state) && (row.when === undefined || row.when(r, ev, c)))
  if (hits.length > 1) throw new Error(`rowFor: ${hits.map(h => h.id).join(', ')} all match ${r.state}/${r.step ?? 'none'} on ${ev.kind}`)
  const hit = hits[0] ?? E7_ROWS.find(row => row.on === ev.kind)
  if (hit === undefined) throw new Error(`rowFor: no row for ${ev.kind}`)
  return hit
}

// viaOf: the transition note's via code: the row's own, with the event's cause, why, choice or fix
// kind where the row's code takes one (free:<cause>, unknown:<why>, triage:<choice>, fix:<kind>).
export function viaOf(row: Row, e: TableEvent): string {
  if (!row.via.endsWith(':')) return row.via
  const tail =
    row.id === 'U1'
      ? e.cause
      : row.id.startsWith('U')
        ? e.why
        : row.id.startsWith('X')
          ? e.choice
          : row.id === 'T9' || row.id === 'T10'
            ? FIX_REASONS[e.reason ?? '']
            : e.reason
  return `${row.via}${tail ?? 'none'}`
}

// nextRecord: the record a changing row makes (4.6): seq + 1 at now, the state the row names, and
// the row's own change on top. A row that names a state (not 'same') enters it, even when it is
// the state the record is in (X2 from fixing, X3 from designing): the state's own step starts at
// attempt 1 with no cut and the row's notes alone. A same-state row keeps the step, the attempt,
// the cut and the seq's notes unless it changes them. `since` moves only with the state, so the
// label is written only on a change of state. Leaving parked clears the question; only closed
// keeps a why.
export function nextRecord(r: IssueRecord, row: Row, e: TableEvent, now: Ms): IssueRecord {
  const ev = normalize(r, e)
  const state: IssueState = row.next === 'same' ? r.state : row.next === 'resumeTo' ? (r.resumeTo ?? 'designing') : row.next
  const entered = row.next !== 'same'
  const base: IssueRecord = {
    ...r,
    seq: r.seq + 1,
    seqAt: now,
    state,
    since: state !== r.state ? now : r.since,
    step: entered ? STATE_STEP[state] : r.step,
    attempt: entered ? 1 : r.attempt,
    cut: entered ? false : r.cut,
    notes: entered ? [] : r.notes,
    question: state === 'parked' ? r.question : null,
    wait: state === 'waiting' ? r.wait : null,
    why: state === 'closed' ? r.why : null,
    resumeTo: state === 'parked' || state === 'queued' || state === 'waiting' ? r.resumeTo : null,
  }
  return { ...base, ...row.change(r, ev, now) }
}

// The claim a record is made from (S0, 3.5): the life (the claim's time in base-36 seconds), the
// branch (an adopted PR's head branch, else issue-<N>), the adopted PR and the others left alone.
export type Claimed = { issue: number; life: string; branch: string; pr: number | null; others: number[] }

// madeRecord: row S0's queued record: a lease leads to designing, or to reviewing for an adopted
// PR, whose whole diff the review reads (3.5). lives: its life's number since the issue's count
// last started (lives.ts).
export function madeRecord(claim: Claimed, now: Ms, lives = 1): IssueRecord {
  const others = claim.others.length === 0 ? [] : [`other open PRs on this issue's branches, left alone: ${claim.others.map(p => `#${p}`).join(', ')}`]
  return {
    issue: claim.issue,
    life: claim.life,
    seq: 1,
    seqAt: now,
    state: 'queued',
    since: now,
    resumeTo: claim.pr === null ? null : 'reviewing',
    branch: claim.branch,
    pr: claim.pr,
    head: null,
    approvedPatch: null,
    brief: null,
    step: 'lease',
    attempt: 1,
    cut: false,
    triages: 0,
    fixes: 0,
    round: 0,
    question: null,
    wait: null,
    why: null,
    notes: others,
    prClosedAt: null,
    lives,
  }
}

// S0's row, for the transition that makes a record.
export const ROW_S0: Row = ROWS[0] as Row
