// The one seam for every event v2 writes (docs/factory-loop/v2/SPEC.md 7.1): the state, the
// columns, the note and the argv of `callum-flow-event`, and the note's parser. The `event`
// executor (act-state.ts), the owner ops' interventions (act-events.ts), the rebuild of records
// (record.ts) and the migration tool build and read their events here alone, so a later format
// change touches this module only.
//
// The format is today's (owner, 2026-10-15; SPEC 15 "v2's events use today's format"): existing
// `callum-flow-event` states and columns (issue, branch, pr, head; actor for a fixer's verdict),
// and v2's extra fields as `key=value` tokens in the note, encoded as the `loop` notes are
// (derive.ts loopNote, enc):
// - tokens are separated by single spaces, and a value holds no space: `%` and whitespace are
//   percent-encoded (a list item's `,` too);
// - a missing value is `none` (a string that is literally `none` is written `%6Eone`), a list is
//   comma-joined (`none` when empty), a flag is `yes` or `no`;
// - the note stays within NOTE_MAX (derive.ts LOOP_NOTE_MAX): the identifying tokens come first,
//   free text (a question, notes, a reason, a path) comes last and is clipped first.
// The reused states keep the note today's queries read (`brief <url>`, `review`, `CORRECT: ..`),
// verbatim; only `abandoned`, which no query parses, gains a `reason=` token, so the metrics can
// tell a drop, a split, a triage drop and a reconcile release apart (7.3).
//
// Pure: no clock, no command. The executors run eventArgv's argv through ExecCtx.cmd.
import type { FactoryEvent } from '../derive'
import { CLOSED_WHYS, ISSUE_STATES, STEP_KINDS } from './types'
import type { IssueRecord, IssueState } from './types'

// derive.ts LOOP_NOTE_MAX: one event row's note (tests/v2-events.test.ts checks they agree)
export const NOTE_MAX = 500
// an intervention's reason is one line of at most this many characters (7.1)
export const REASON_MAX = 200

// --- the events ---------------------------------------------------------------------------------

// A state change (4.6), and again after a re-claim (4.1): every record field travels with it, so
// a record can be rebuilt from its newest one (3.3).
export type TransitionEvent = { state: 'transition'; record: IssueRecord; row: string; from: IssueState | null; via: string }

// One review result (8.3).
export type ReviewedEvent = {
  state: 'reviewed'
  issue: number
  branch: string
  pr: number
  head: string
  verdict: 'approve' | 'changes' | 'unknown'
  round: number
  patch: string
  errors: number
  warnings: number
  infos: number
  reviewer: string
  answer: string
}

export const INTERVENTION_WHO = ['person', 'loop'] as const

// One intervention (7.2): who, the cause code, a one-line reason, and the key of the fact it
// records (its ledger key is iv/<fact>), so readers count it once.
export type InterventionEvent = {
  state: 'intervention'
  who: (typeof INTERVENTION_WHO)[number]
  cause: string
  reason: string
  issue: number | null
  life: string | null
  pr: number | null
  fact: string
}

// A reconcile release (6.4): reclaimed when the issue is labelled ready, abandoned when it leaves.
export type ReleaseEvent = {
  state: 'reclaimed' | 'abandoned'
  issue: number
  branch: string | null
  pr: number | null
  stage: string
  checked: string
  reason: 'reconcile'
}

// The reused states, each with the meaning it already has (7.1); the note is today's.
export type ReusedEvent = {
  state: 'delegated' | 'fix_requested' | 'merge_ready' | 'abandoned' | 'merged' | 'verdict'
  issue: number
  branch: string | null
  pr: number | null
  head: string | null
  note: string
}

export type V2Event = TransitionEvent | ReviewedEvent | InterventionEvent | ReleaseEvent | ReusedEvent

export const REUSED_STATES = ['delegated', 'fix_requested', 'merge_ready', 'abandoned', 'merged', 'verdict'] as const
// The states v2 writes, each through this module; the first three are new in callum-flow-event.
export const V2_EVENT_STATES = ['transition', 'reviewed', 'intervention', 'reclaimed', ...REUSED_STATES] as const

// Why an issue was abandoned, as the `reason=` token of the note says it (7.3, claim completion):
// a drop by the owner (E1), a designer's split (T4), a triage drop (X5), a reconcile release (6.4).
export const ABANDON_REASONS = ['dropped', 'split', 'triage', 'reconcile', 'other'] as const
export type AbandonReason = (typeof ABANDON_REASONS)[number]

// abandonReason: a reused `abandoned` event's reason, from its note: a note that already carries
// a `reason=` token keeps it; else its first word says (`dropped`, `split into ..`, `triage`).
export function abandonReason(note: string): AbandonReason {
  const given = tokensOf(note).get('reason')
  const named = ABANDON_REASONS.find(r => r === given)
  if (named !== undefined) return named
  const word = /^\W*(\w+)/.exec(note)?.[1]?.toLowerCase() ?? ''
  if (word === 'split') return 'split'
  if (word === 'triage') return 'triage'
  if (word === 'drop' || word === 'dropped') return 'dropped'
  return 'other'
}

// --- the value codec (derive.ts enc, dec) ---------------------------------------------------------

const NONE = 'none'

// enc: a value with no space in it: `%` and whitespace percent-encoded, so URLs stay readable.
export function enc(v: string): string {
  return v.replace(/[%\s]/g, c => encodeURIComponent(c))
}

export function dec(v: string): string {
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

// A string, or `none` for null. A string that is literally `none` has its first letter encoded,
// so it reads back as itself.
function str(v: string | null): string {
  if (v === null) return NONE
  return v === NONE ? '%6Eone' : enc(v)
}

function unstr(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined
  return v === NONE ? null : dec(v)
}

function num(v: number | null): string {
  return v === null ? NONE : String(v)
}

function unnum(v: string | undefined): number | null | undefined {
  if (v === undefined) return undefined
  if (v === NONE) return null
  const n = Number(v)
  return v.trim() !== '' && Number.isFinite(n) ? n : undefined
}

// A list: its items comma-joined, each encoded (a `,` in an item too); `none` when empty.
function list(v: readonly string[]): string {
  return v.length === 0 ? NONE : v.map(i => str(i).replace(/,/g, '%2C')).join(',')
}

function unlist(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined
  return v === NONE ? [] : v.split(',').map(dec)
}

const yn = (v: boolean) => (v ? 'yes' : 'no')

// tokensOf: a note's `key=value` tokens, the first of each key; words without `=` are skipped.
export function tokensOf(note: string | null): Map<string, string> {
  const out = new Map<string, string>()
  if (note === null) return out
  for (const word of note.split(' ')) {
    const i = word.indexOf('=')
    if (i > 0 && !out.has(word.slice(0, i))) out.set(word.slice(0, i), word.slice(i + 1))
  }
  return out
}

// noteToken: one token's value, decoded (`none` is null); undefined when the note lacks it. For
// readers that need a field or two, as the factory tools' do.
export function noteToken(note: string | null, key: string): string | null | undefined {
  return unstr(tokensOf(note).get(key))
}

// --- fitting a note into NOTE_MAX ------------------------------------------------------------------

// clipText: the text cut, with `...`, until its encoded form is at most max characters; null when
// not even one character and the `...` fit.
function clipText(text: string, max: number, encode: (v: string) => string): string | null {
  if (encode(text).length <= max) return text
  let keep = Math.min(text.length - 1, max)
  while (keep > 0) {
    const cut = `${text.slice(0, keep)}...`
    if (encode(cut).length <= max) return cut
    keep -= Math.max(1, encode(cut).length - max)
  }
  return null
}

// A free-text token: its key, its value, and whether it is a list.
type Free = { key: string; value: string | null } | { key: string; items: readonly string[] }

// fit: the fixed tokens, then the free ones, clipped from the last to the first until the note
// is within NOTE_MAX. A list loses items from its end, and the first item it lost is cut to the
// room left; a text is cut, with `...`; what cannot fit at all is `none`.
function fit(fixed: readonly string[], free: readonly Free[]): string {
  const values = free.map(f => ('items' in f ? list(f.items) : str(f.value)))
  const note = () => [...fixed, ...free.map((f, i) => `${f.key}=${values[i]}`)].join(' ')
  for (let i = free.length - 1; i >= 0 && note().length > NOTE_MAX; i -= 1) {
    const f = free[i] as Free
    const room = Math.max(0, (values[i] as string).length - (note().length - NOTE_MAX))
    if ('items' in f) {
      const kept = [...f.items]
      while (kept.length > 0 && list(kept).length > room) kept.pop()
      const next = f.items[kept.length]
      if (next !== undefined) {
        const used = kept.length === 0 ? 0 : list(kept).length + 1
        const cut = clipText(next, room - used, v => str(v).replace(/,/g, '%2C'))
        if (cut !== null) kept.push(cut)
      }
      values[i] = list(kept)
    } else {
      const cut = f.value === null ? null : clipText(f.value, room, str)
      values[i] = str(cut)
    }
  }
  return note()
}

// --- the notes --------------------------------------------------------------------------------------

// What travels in an event's own columns.
export type EventColumns = { issue: number | null; branch: string | null; pr: number | null; head: string | null }

export function eventColumns(e: V2Event): EventColumns {
  switch (e.state) {
    case 'transition':
      return { issue: e.record.issue, branch: e.record.branch, pr: e.record.pr, head: e.record.head }
    case 'reviewed':
      return { issue: e.issue, branch: e.branch, pr: e.pr, head: e.head }
    case 'intervention':
      return { issue: e.issue, branch: null, pr: e.pr, head: null }
    default:
      return { issue: e.issue, branch: e.branch, pr: e.pr, head: 'head' in e ? e.head : null }
  }
}

// The actor the event is logged as: a fixer's dispositions are the fixer's (7.1, section 15);
// null: the CLI's default.
export function eventActor(e: V2Event): string | null {
  return e.state === 'verdict' ? 'fixer' : null
}

function transitionNote(e: TransitionEvent): string {
  const r = e.record
  const fixed = [
    `row=${str(e.row)}`,
    `life=${str(r.life)}`,
    `seq=${r.seq}`,
    `from=${str(e.from)}`,
    `to=${r.state}`,
    `seqAt=${r.seqAt}`,
    `since=${r.since}`,
    `resumeTo=${str(r.resumeTo)}`,
    `step=${str(r.step)}`,
    `attempt=${r.attempt}`,
    `cut=${yn(r.cut)}`,
    `triages=${r.triages}`,
    `fixes=${r.fixes}`,
    `round=${r.round}`,
    `why=${str(r.why)}`,
    `approvedPatch=${str(r.approvedPatch)}`,
    `prClosedAt=${str(r.prClosedAt)}`,
  ]
  // the via code, the brief's URL, the question and the notes are clipped, in reverse order, only
  // when the note would not fit otherwise
  return fit(fixed, [
    { key: 'via', value: e.via },
    { key: 'brief', value: r.brief },
    { key: 'question', value: r.question },
    { key: 'notes', items: r.notes },
  ])
}

function reviewedNote(e: ReviewedEvent): string {
  const fixed = [
    `verdict=${e.verdict}`,
    `round=${e.round}`,
    `patch=${str(e.patch)}`,
    `errors=${e.errors}`,
    `warnings=${e.warnings}`,
    `infos=${e.infos}`,
    `reviewer=${str(e.reviewer)}`,
  ]
  return fit(fixed, [{ key: 'answer', value: e.answer }])
}

// oneLine: a reason as one line of at most REASON_MAX characters.
export function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= REASON_MAX ? line : `${line.slice(0, REASON_MAX - 3)}...`
}

function interventionNote(e: InterventionEvent): string {
  const fixed = [`who=${e.who}`, `cause=${str(e.cause)}`, `life=${str(e.life)}`, `fact=${str(e.fact)}`]
  return fit(fixed, [{ key: 'reason', value: oneLine(e.reason) }])
}

function releaseNote(e: ReleaseEvent): string {
  return fit([`reason=${e.reason}`, `stage=${str(e.stage)}`, `pr=${num(e.pr)}`], [{ key: 'checked', value: e.checked }])
}

// A drop, a split or a triage drop; `reconcile` is a release's alone (releaseNote).
function abandonedNote(e: ReusedEvent): string {
  const reason = abandonReason(e.note)
  return fit([`reason=${reason === 'reconcile' ? 'other' : reason}`], [{ key: 'note', value: e.note }])
}

// eventNote: the note an event carries.
export function eventNote(e: V2Event): string {
  switch (e.state) {
    case 'transition':
      return transitionNote(e)
    case 'reviewed':
      return reviewedNote(e)
    case 'intervention':
      return interventionNote(e)
    case 'reclaimed':
      return releaseNote(e)
    case 'abandoned':
      return 'reason' in e && e.reason === 'reconcile' ? releaseNote(e) : abandonedNote(e as ReusedEvent)
    default:
      return e.note
  }
}

// eventArgv: `callum-flow-event <state>` for this event: its columns as flags, its actor when it
// has its own, and its note.
export function eventArgv(e: V2Event): string[] {
  const c = eventColumns(e)
  const argv = ['callum-flow-event', e.state]
  if (c.issue !== null) argv.push('--issue', String(c.issue))
  if (c.branch !== null) argv.push('--branch', c.branch)
  if (c.pr !== null) argv.push('--pr', String(c.pr))
  if (c.head !== null) argv.push('--head', c.head)
  const actor = eventActor(e)
  if (actor !== null) argv.push('--actor', actor)
  argv.push('--note', eventNote(e))
  return argv
}

// --- the parser -----------------------------------------------------------------------------------

// What the parser reads of a logged event: its state, its columns and its note.
export type EventRow = Pick<FactoryEvent, 'state' | 'issue' | 'branch' | 'pr' | 'head' | 'note'>

const isState = (v: unknown): v is IssueState => ISSUE_STATES.some(s => s === v)

// parseTransition: the record and row a `transition` event carries, or null when it does not read.
export function parseTransition(row: EventRow): TransitionEvent | null {
  if (row.state !== 'transition' || row.issue === null || row.branch === null) return null
  const t = tokensOf(row.note)
  const life = unstr(t.get('life'))
  const seq = unnum(t.get('seq'))
  const to = t.get('to')
  const fromRaw = unstr(t.get('from'))
  const resumeTo = unstr(t.get('resumeTo'))
  const step = unstr(t.get('step'))
  const why = unstr(t.get('why'))
  const ints = ['seqAt', 'since', 'attempt', 'triages', 'fixes', 'round'].map(k => unnum(t.get(k)))
  const [seqAt, since, attempt, triages, fixes, round] = ints
  const cut = t.get('cut')
  const rowId = unstr(t.get('row'))
  const via = unstr(t.get('via'))
  const brief = unstr(t.get('brief'))
  const question = unstr(t.get('question'))
  const approvedPatch = unstr(t.get('approvedPatch'))
  const prClosedAt = unstr(t.get('prClosedAt'))
  const notes = unlist(t.get('notes'))
  if (typeof life !== 'string' || life === '' || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null
  if (!isState(to) || (fromRaw !== null && !isState(fromRaw)) || (resumeTo !== null && !isState(resumeTo))) return null
  if (step !== null && !STEP_KINDS.some(s => s === step)) return null
  if (why !== null && !CLOSED_WHYS.some(w => w === why)) return null
  if (ints.some(n => typeof n !== 'number') || (cut !== 'yes' && cut !== 'no')) return null
  if (typeof rowId !== 'string' || via === undefined || brief === undefined || question === undefined) return null
  if (approvedPatch === undefined || prClosedAt === undefined || notes === undefined) return null
  const record: IssueRecord = {
    issue: row.issue,
    life,
    seq,
    seqAt: seqAt as number,
    state: to,
    since: since as number,
    resumeTo: resumeTo as IssueState | null,
    branch: row.branch,
    pr: row.pr,
    head: row.head,
    approvedPatch,
    brief,
    step: step as IssueRecord['step'],
    attempt: attempt as number,
    cut: cut === 'yes',
    triages: triages as number,
    fixes: fixes as number,
    round: round as number,
    question,
    why: why as IssueRecord['why'],
    notes,
    prClosedAt,
  }
  // a via clipped away (a note that could not hold it) reads back empty
  return { state: 'transition', record, row: rowId, from: fromRaw as IssueState | null, via: via ?? '' }
}

function parseReviewed(row: EventRow): ReviewedEvent | null {
  const t = tokensOf(row.note)
  const verdict = t.get('verdict')
  const [round, errors, warnings, infos] = ['round', 'errors', 'warnings', 'infos'].map(k => unnum(t.get(k)))
  const patch = unstr(t.get('patch'))
  const reviewer = unstr(t.get('reviewer'))
  const answer = unstr(t.get('answer'))
  if (verdict !== 'approve' && verdict !== 'changes' && verdict !== 'unknown') return null
  if (row.issue === null || row.branch === null || row.pr === null || row.head === null) return null
  if ([round, errors, warnings, infos].some(n => typeof n !== 'number') || typeof patch !== 'string' || typeof reviewer !== 'string' || typeof answer !== 'string') return null
  return {
    state: 'reviewed',
    issue: row.issue,
    branch: row.branch,
    pr: row.pr,
    head: row.head,
    verdict,
    round: round as number,
    patch,
    errors: errors as number,
    warnings: warnings as number,
    infos: infos as number,
    reviewer,
    answer,
  }
}

// parseIntervention: an `intervention` event, a hand-recorded rescue included (which may carry
// only who, cause and reason: its fact and life are then null and empty).
export function parseIntervention(row: EventRow): InterventionEvent | null {
  if (row.state !== 'intervention') return null
  const t = tokensOf(row.note)
  const who = INTERVENTION_WHO.find(w => w === t.get('who'))
  const cause = unstr(t.get('cause'))
  if (who === undefined || typeof cause !== 'string' || cause === '') return null
  return {
    state: 'intervention',
    who,
    cause,
    reason: unstr(t.get('reason')) ?? '',
    issue: row.issue,
    life: unstr(t.get('life')) ?? null,
    pr: row.pr,
    fact: unstr(t.get('fact')) ?? '',
  }
}

function parseRelease(row: EventRow): ReleaseEvent | null {
  const t = tokensOf(row.note)
  const stage = unstr(t.get('stage'))
  const pr = unnum(t.get('pr'))
  const checked = unstr(t.get('checked'))
  if (row.state !== 'reclaimed' && row.state !== 'abandoned') return null
  if (t.get('reason') !== 'reconcile' || row.issue === null || typeof stage !== 'string' || pr === undefined || typeof checked !== 'string') return null
  return { state: row.state, issue: row.issue, branch: row.branch, pr, stage, checked, reason: 'reconcile' }
}

// parseEvent: the v2 event a logged row is, or null when it is not one (another state, a note
// that does not read, a `reclaimed` the sweep logged).
export function parseEvent(row: EventRow): V2Event | null {
  switch (row.state) {
    case 'transition':
      return parseTransition(row)
    case 'reviewed':
      return parseReviewed(row)
    case 'intervention':
      return parseIntervention(row)
    case 'reclaimed':
      return parseRelease(row)
    case 'abandoned': {
      const release = parseRelease(row)
      if (release !== null) return release
      const note = unstr(tokensOf(row.note).get('note'))
      if (row.issue === null || typeof note !== 'string') return null
      return { state: 'abandoned', issue: row.issue, branch: row.branch, pr: row.pr, head: row.head, note }
    }
    default: {
      const state = REUSED_STATES.find(s => s === row.state)
      if (state === undefined || row.issue === null) return null
      return { state, issue: row.issue, branch: row.branch, pr: row.pr, head: row.head, note: row.note ?? '' }
    }
  }
}

// --- constructors -----------------------------------------------------------------------------------

// intervention: the event of one intervention, its reason as one line.
export function intervention(who: InterventionEvent['who'], cause: string, fact: string, reason: string, at: { issue: number | null; life: string | null; pr: number | null }): InterventionEvent {
  return { state: 'intervention', who, cause, reason: oneLine(reason), issue: at.issue, life: at.life, pr: at.pr, fact }
}
