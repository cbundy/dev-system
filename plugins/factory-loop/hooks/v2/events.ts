// The one seam for every event v2 writes (docs/factory-loop/v2/SPEC.md 7.1): the native call of
// `callum-flow-event` (event-native.ts builds the type and data), and, for the readers that still
// need them, the old format's note and its parser. The `event` executor (act-state.ts), the owner
// ops' interventions (act-events.ts) and factory-reconcile build their argv here alone.
//
// Since epic #534 v2 writes the new format natively: `callum-flow-event --type <type> --data <json>
// [--issue N] [--actor A]`, the data the translator (images/base/factory-event-translate.js) made
// from the old lines. Nothing is written as a note any more. The note builders and the token codec
// stay for what still reads the old format: the `old` source (parseEvent), the reconcile and plan
// replay of old logs, and the once keys (eventNote, onceKey, logOnce), which sources-facts.ts
// also builds from the new rows.
//
// Pure: no clock, no command. The executors run eventArgv's argv through ExecCtx.cmd.
import type { FactoryEvent } from '../derive'
import { CLOSED_WHYS, ISSUE_STATES, STEP_KINDS } from './types'
import type { IssueRecord, IssueState, WaitCondition } from './types'
import { NONE, dec, enc, str, unstr } from './codec'
import { partsOfTokens, partsTokens } from './park-parts'
import { INTERVENTION_WHO, RELEASE_OUTCOMES } from './event-data'
import { abandonReason, nativeOf, oneLine } from './event-native'
import type { GateRunData, InterventionEvent, ReleaseEvent, ReusedEvent, ReviewedEvent, ShadowReadData, TransitionEvent, V2Event } from './event-data'


// --- the events ---------------------------------------------------------------------------------

// The event types live in event-data.ts; they are re-exported here so every import from './events' works.
export * from './event-data'
export { dec, enc } from './codec'
export { ABANDON_REASONS, REASON_MAX, abandonReason, oneLine } from './event-native'
export type { AbandonReason } from './event-native'

export const REUSED_STATES = ['abandoned', 'merged', 'verdict'] as const
// The states v2 writes, each through this module.
export const V2_EVENT_STATES = ['transition', 'reviewed', 'intervention', 'reclaimed', ...REUSED_STATES] as const

// --- the value codec (derive.ts enc, dec) ---------------------------------------------------------

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
export function list(v: readonly string[]): string {
  return v.length === 0 ? NONE : v.map(i => str(i).replace(/,/g, '%2C')).join(',')
}

function unlist(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined
  return v === NONE ? [] : v.split(',').map(dec)
}

// The wait conditions (3.2): `issue:<n>`, `pr:<n>` and `tag:<sha>`, comma-joined, with the long forms
// `issue:<owner>/<name>#<n>` and `tag:<owner>/<name>@<sha>` for a condition on another repo; `none` outside waiting.
function waitToken(wait: readonly WaitCondition[] | null): string {
  if (wait == null || wait.length === 0) return NONE
  return wait
    .map(c =>
      c.kind === 'issue-closed' ? (c.repo === undefined ? `issue:${c.issue}` : `issue:${c.repo}#${c.issue}`) : c.kind === 'pr-merged' ? `pr:${c.pr}` : c.repo === undefined ? `tag:${c.sha}` : `tag:${c.repo}@${c.sha}`,
    )
    .join(',')
}

// unwait: the conditions of a wait token; null for `none` or an absent token (a note from before
// the field); undefined when it does not read.
function unwait(v: string | undefined): WaitCondition[] | null | undefined {
  if (v === undefined || v === NONE) return null
  const out: WaitCondition[] = []
  for (const item of v.split(',')) {
    const t = /^tag:(?:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)@)?([0-9a-f]{7,40})$/.exec(item)
    if (t !== null) {
      if (t[1] !== undefined && t[1] !== t[1].toLowerCase()) return undefined
      out.push(t[1] === undefined ? { kind: 'tag-contains', sha: t[2] as string } : { kind: 'tag-contains', sha: t[2] as string, repo: t[1] })
      continue
    }
    const l = /^issue:([a-z0-9._-]+\/[a-z0-9._-]+)#([1-9]\d*)$/.exec(item)
    if (l !== null) {
      out.push({ kind: 'issue-closed', issue: Number(l[2]), repo: l[1] as string })
      continue
    }
    const m = /^(issue|pr):([1-9]\d*)$/.exec(item)
    if (m === null) return undefined
    out.push(m[1] === 'issue' ? { kind: 'issue-closed', issue: Number(m[2]) } : { kind: 'pr-merged', pr: Number(m[2]) })
  }
  return out.length > 8 ? undefined : out
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
    case 'gate_run':
      return { issue: e.issue, branch: null, pr: null, head: e.data.head }
    case 'comment_posted':
      return { issue: e.issue, branch: null, pr: null, head: null }
    case 'shadow_read':
    case 'settings_changed':
      return { issue: null, branch: null, pr: null, head: null }
    case 'milestone_state':
      return { issue: null, branch: null, pr: null, head: null }
    case 'main_state':
      return { issue: null, branch: null, pr: e.data.pr, head: e.data.head }
    default:
      return { issue: e.issue, branch: e.branch, pr: e.pr, head: 'head' in e ? e.head : null }
  }
}

function transitionNote(e: TransitionEvent): string {
  const r = e.record
  return [
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
    `conflicts=${r.conflicts}`,
    `round=${r.round}`,
    `why=${str(r.why)}`,
    `approvedPatch=${str(r.approvedPatch)}`,
    `prClosedAt=${str(r.prClosedAt)}`,
    `lives=${r.lives}`,
    `wait=${waitToken(r.wait)}`,
    `via=${str(e.via)}`,
    `brief=${str(r.brief)}`,
    `question=${str(r.question)}`,
    ...partsTokens(r.parts),
    `notes=${list(r.notes)}`,
  ].join(' ')
}

function reviewedNote(e: ReviewedEvent): string {
  return [
    `verdict=${e.verdict}`,
    `round=${e.round}`,
    `patch=${str(e.patch)}`,
    `errors=${e.errors}`,
    `warnings=${e.warnings}`,
    `infos=${e.infos}`,
    `reviewer=${str(e.reviewer)}`,
    `answer=${str(e.answer)}`,
  ].join(' ')
}

// A ci-rerun's flake row (rules-flakes.ts) also carries flaky, failed_tests, failed_jobs and head, a refused check's row
// (rules-refused.ts) failed_jobs and head; every
// other intervention's note is as it always was.
function interventionNote(e: InterventionEvent): string {
  const base = [`who=${e.who}`, `cause=${str(e.cause)}`, `life=${str(e.life)}`, `fact=${str(e.fact)}`, `reason=${str(oneLine(e.reason))}`]
  if (e.flaky === undefined) {
    // a refused check's row (rules-refused.ts) names its jobs and head without a re-run's result
    if (e.failed_jobs === undefined && e.head === undefined) return base.join(' ')
    return [...base, `failed_jobs=${list(e.failed_jobs ?? [])}`, `head=${str(e.head ?? null)}`].join(' ')
  }
  const flaky = e.flaky === null ? NONE : e.flaky ? 'yes' : 'no'
  return [...base, `flaky=${flaky}`, `failed_tests=${list(e.failed_tests ?? [])}`, `failed_jobs=${list(e.failed_jobs ?? [])}`, `head=${str(e.head ?? null)}`].join(' ')
}

function releaseNote(e: ReleaseEvent): string {
  return [`reason=${e.reason}`, `outcome=${e.outcome}`, `lives=${num(e.lives)}`, `stage=${str(e.stage)}`, `pr=${num(e.pr)}`, `checked=${str(e.checked)}`].join(' ')
}

// A drop, a split or a triage drop; `reconcile` is a release's alone (releaseNote).
function abandonedNote(e: ReusedEvent): string {
  const reason = abandonReason(e.note)
  return [`reason=${reason === 'reconcile' ? 'other' : reason}`, `note=${str(e.note)}`].join(' ')
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
    case 'shadow_read':
    case 'settings_changed':
    case 'gate_run':
    case 'main_state':
    case 'milestone_state':
    case 'comment_posted':
      // no old-format note: the payload is its own JSON (eventArgv)
      return JSON.stringify(e.data)
    case 'abandoned':
      return 'reason' in e && e.reason === 'reconcile' ? releaseNote(e) : abandonedNote(e as ReusedEvent)
    default:
      return e.note
  }
}

// eventArgv: `callum-flow-event --type <type> --data <json>` for this event, with its issue and,
// when it has its own, its actor (a fixer's disposition).
export function eventArgv(e: V2Event): string[] {
  const n = nativeOf(e)
  const argv = ['callum-flow-event', '--type', n.type, '--data', JSON.stringify(n.data)]
  if (n.issue !== null) argv.push('--issue', String(n.issue))
  if (n.actor !== null) argv.push('--actor', n.actor)
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
  // a note from before the field carries no count: it read as none
  const conflicts = t.get('conflicts') === undefined ? 0 : unnum(t.get('conflicts'))
  const cut = t.get('cut')
  const rowId = unstr(t.get('row'))
  const via = unstr(t.get('via'))
  const brief = unstr(t.get('brief'))
  const question = unstr(t.get('question'))
  const approvedPatch = unstr(t.get('approvedPatch'))
  const prClosedAt = unstr(t.get('prClosedAt'))
  const notes = unlist(t.get('notes'))
  const wait = unwait(t.get('wait'))
  const parts = partsOfTokens(k => t.get(k))
  // a note from before the field carries no count: its life is read as a first one
  const lives = t.get('lives') === undefined ? 1 : unnum(t.get('lives'))
  if (typeof life !== 'string' || life === '' || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null
  if (!isState(to) || (fromRaw !== null && !isState(fromRaw)) || (resumeTo !== null && !isState(resumeTo))) return null
  if (step !== null && !STEP_KINDS.some(s => s === step)) return null
  if (why !== null && !CLOSED_WHYS.some(w => w === why)) return null
  if (ints.some(n => typeof n !== 'number') || (cut !== 'yes' && cut !== 'no')) return null
  if (typeof rowId !== 'string' || via === undefined || brief === undefined || question === undefined) return null
  if (approvedPatch === undefined || prClosedAt === undefined || notes === undefined) return null
  if (typeof conflicts !== 'number' || !Number.isInteger(conflicts) || conflicts < 0) return null
  if (typeof lives !== 'number' || !Number.isInteger(lives) || lives < 1) return null
  if (wait === undefined || parts === undefined) return null
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
    conflicts,
    round: round as number,
    question,
    parts,
    wait,
    why: why as IssueRecord['why'],
    notes,
    prClosedAt,
    lives,
  }
  // a via an older, clipped note lost reads back empty
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
  const flakyToken = t.get('flaky')
  const tests = unlist(t.get('failed_tests'))
  const jobs = unlist(t.get('failed_jobs'))
  const head = unstr(t.get('head'))
  return {
    state: 'intervention',
    who,
    cause,
    reason: unstr(t.get('reason')) ?? '',
    issue: row.issue,
    life: unstr(t.get('life')) ?? null,
    pr: row.pr,
    fact: unstr(t.get('fact')) ?? '',
    ...(flakyToken === undefined ? {} : { flaky: flakyToken === 'yes' ? true : flakyToken === 'no' ? false : null }),
    ...(tests === undefined ? {} : { failed_tests: tests.length === 0 ? null : tests }),
    ...(jobs === undefined ? {} : { failed_jobs: jobs.length === 0 ? null : jobs }),
    ...(head === undefined ? {} : { head }),
  }
}

function parseRelease(row: EventRow): ReleaseEvent | null {
  const t = tokensOf(row.note)
  const stage = unstr(t.get('stage'))
  const pr = unnum(t.get('pr'))
  const checked = unstr(t.get('checked'))
  if (row.state !== 'reclaimed' && row.state !== 'abandoned') return null
  if (t.get('reason') !== 'reconcile' || row.issue === null || typeof stage !== 'string' || pr === undefined || typeof checked !== 'string') return null
  // a release logged before these fields: its state says its outcome, and it carries no count
  const outcome = RELEASE_OUTCOMES.find(o => o === t.get('outcome')) ?? (row.state === 'reclaimed' ? 'requeue' : 'leave')
  const lives = unnum(t.get('lives')) ?? null
  return { state: row.state, issue: row.issue, branch: row.branch, pr, stage, checked, reason: 'reconcile', outcome, lives }
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

// --- logged once (7.2) ------------------------------------------------------------------------------

// onceKey: the fact a logged row records, for the events keyed by a fact that outlives the store (a
// companion line, a recorded answer, a head): an intervention by its cause and fact, a review result
// by its answer file, one per review attempt. Read from the note as logged, so a planned event and
// its row read back agree. null for any other event: its ledger key alone logs it once.
export function onceKey(row: EventRow): string | null {
  const t = tokensOf(row.note)
  // a flake row (rules-flakes.ts) shares its fact with the ci-rerun row it settles, so it has its own key
  const id = row.state === 'intervention' ? [t.get('cause'), t.get('fact'), ...(t.has('flaky') ? ['flake'] : [])] : row.state === 'reviewed' ? [t.get('answer')] : []
  if (id.length === 0 || id.some(v => v === undefined || v === NONE)) return null
  return [row.state, row.issue ?? NONE, ...id].join(' ')
}

// logOnce: an event action's event, marked logged when the event log already holds its fact (its
// onceKey among those of the pass's read of the log, V2State.logged), whatever the ledger lost (a
// wiped store, 3.3): the executor then settles it with no second write.
export function logOnce<E extends V2Event>(logged: readonly string[], event: E): { event: E; logged?: true } {
  const key = onceKey({ state: event.state, ...eventColumns(event), note: eventNote(event) })
  return key !== null && logged.includes(key) ? { event, logged: true } : { event }
}

// --- constructors -----------------------------------------------------------------------------------

// intervention: the event of one intervention, its reason as one line.
export function intervention(who: InterventionEvent['who'], cause: string, fact: string, reason: string, at: { issue: number | null; life: string | null; pr: number | null }): InterventionEvent {
  return { state: 'intervention', who, cause, reason: oneLine(reason), issue: at.issue, life: at.life, pr: at.pr, fact }
}
