// The native call of every event v2 writes (docs/factory-loop/v2/SPEC.md 7.1): the type, the data
// and the issue of `callum-flow-event --type <type> --data <json> [--issue N] [--actor A]`, one
// builder per V2Event kind. The data is exactly what the translator (images/base/
// factory-event-translate.js) makes from the line the loop used to write in the old format: the
// same keys, values and nulls, and an optional key left out where the translator leaves it out.
// events.ts builds the argv from it; act-cli.ts and act-tracker.ts take the closed and split data.
//
// Pure: no clock, no command.
import type { ReleaseEvent, ReusedEvent, V2Event } from './event-data'
import type { InterventionEvent, ReviewedEvent, TransitionEvent } from './event-data'
import type { WaitCondition } from './types'

export type NativeEvent = { type: string; data: Record<string, unknown>; issue: number | null; actor: string | null }

// an intervention's reason is one line of at most this many characters (7.1)
export const REASON_MAX = 200

// oneLine: a reason as one line of at most REASON_MAX characters.
export function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= REASON_MAX ? line : `${line.slice(0, REASON_MAX - 3)}...`
}

// Why an issue was abandoned (7.3, claim completion): a drop by the owner (E1), a designer's split
// (T4), a triage drop (X5), a reconcile release (6.4).
export const ABANDON_REASONS = ['dropped', 'split', 'triage', 'reconcile', 'other'] as const
export type AbandonReason = (typeof ABANDON_REASONS)[number]

// abandonReason: a reused `abandoned` event's reason, from its note: a note that already carries
// a `reason=` token keeps it; else its first word says (`dropped`, `split into ..`, `triage`).
export function abandonReason(note: string): AbandonReason {
  const given = note.split(' ').find(w => w.startsWith('reason='))?.slice('reason='.length)
  const named = ABANDON_REASONS.find(r => r === given)
  if (named !== undefined) return named
  const word = /^\W*(\w+)/.exec(note)?.[1]?.toLowerCase() ?? ''
  if (word === 'split') return 'split'
  if (word === 'triage') return 'triage'
  if (word === 'drop' || word === 'dropped') return 'dropped'
  return 'other'
}

// iso: epoch milliseconds as ISO 8601 with three millisecond digits (as the translator's msToIso), by
// calendar arithmetic, so the module reads no clock.
export function iso(ms: number): string {
  const days = Math.floor(ms / 86_400_000)
  const rest = ms - days * 86_400_000
  const z = days + 719_468
  const era = Math.floor(z / 146_097)
  const doe = z - era * 146_097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(year, 4)}-${p(month)}-${p(day)}T${p(Math.floor(rest / 3_600_000))}:${p(Math.floor(rest / 60_000) % 60)}:${p(Math.floor(rest / 1000) % 60)}.${p(rest % 1000, 3)}Z`
}
const text = (v: string | null | undefined) => (v === undefined || v === null || v === '' ? null : v)

function waitData(wait: readonly WaitCondition[] | null): Record<string, unknown>[] | null {
  if (wait === null || wait.length === 0) return null
  return wait.map(c => {
    if (c.kind === 'pr-merged') return { kind: c.kind, pr: c.pr }
    if (c.kind === 'issue-closed') return c.repo === undefined ? { kind: c.kind, issue: c.issue } : { kind: c.kind, issue: c.issue, repo: c.repo }
    return c.repo === undefined ? { kind: c.kind, sha: c.sha } : { kind: c.kind, sha: c.sha, repo: c.repo }
  })
}

function transitionData(e: TransitionEvent): Record<string, unknown> {
  const r = e.record
  const p = r.parts
  return {
    life: r.life,
    seq: r.seq,
    table_row: e.row,
    from_state: e.from,
    to_state: r.state,
    via: e.via,
    seq_at: iso(r.seqAt),
    state_since: iso(r.since),
    resume_to: r.resumeTo,
    branch: text(r.branch),
    pr: r.pr,
    head: text(r.head),
    approved_patch: r.approvedPatch,
    brief_url: r.brief,
    step: r.step,
    attempt: r.attempt,
    cut: r.cut,
    triages: r.triages,
    fixes: r.fixes,
    round: r.round,
    question: r.question,
    why: r.why,
    notes: [...r.notes],
    pr_closed_at: r.prClosedAt,
    lives: r.lives,
    wait: waitData(r.wait),
    conflicts: r.conflicts,
    decision: p === null ? null : p.decision,
    context: p === null ? null : p.context,
    options: p === null ? null : p.options,
    recommended: p === null ? null : p.recommended,
    recommendation: p === null ? null : p.recommendation,
  }
}

function reviewedData(e: ReviewedEvent): Record<string, unknown> {
  return {
    branch: text(e.branch),
    pr: e.pr,
    head: text(e.head),
    verdict: e.verdict,
    round: e.round,
    patch: e.patch,
    errors: e.errors,
    warnings: e.warnings,
    infos: e.infos,
    reviewer: e.reviewer,
    answer_path: e.answer,
  }
}

const listOrNull = (v: readonly string[] | null | undefined) => (v === undefined || v === null || v.length === 0 ? null : [...v])

// A ci-rerun's flake row also carries flaky, failed_tests, failed_jobs and head, a refused check's
// row failed_jobs and head; every other intervention names none of them (null).
function interventionData(e: InterventionEvent): Record<string, unknown> {
  const flakeRow = e.flaky !== undefined
  const jobsRow = flakeRow || e.failed_jobs !== undefined || e.head !== undefined
  return {
    who: e.who,
    cause: e.cause,
    life: e.life,
    fact: e.fact,
    pr: e.pr,
    detail: oneLine(e.reason),
    flaky: flakeRow ? e.flaky : null,
    failed_tests: flakeRow ? listOrNull(e.failed_tests) : null,
    failed_jobs: jobsRow ? listOrNull(e.failed_jobs) : null,
    head: jobsRow ? (e.head ?? null) : null,
  }
}

const NO_SPLIT = { split_into: [], why_split: null, why_count: null, why_parts: null, why_order: null, child_whys: null }

function releaseData(e: ReleaseEvent): { type: string; data: Record<string, unknown> } {
  if (e.state === 'reclaimed') {
    return { type: 'requeued', data: { reason: 'reconcile', stage: e.stage, lives: e.lives, branch: text(e.branch), pr: e.pr, detail: e.checked } }
  }
  const reason = e.outcome === 'reject' ? 'rejected' : 'reconcile'
  return { type: 'abandoned', data: { reason, ...NO_SPLIT, stage: e.stage, lives: e.lives, branch: text(e.branch), pr: e.pr, detail: e.checked } }
}

// A drop, a split or a triage drop: the reason says which, and a split's detail names its children.
function abandonedData(e: ReusedEvent): Record<string, unknown> {
  const reason = abandonReason(e.note)
  const given = reason === 'reconcile' ? 'other' : reason
  const split = given === 'split' ? /split into (\d+(?:\s*,\s*\d+)*)/i.exec(e.note)?.[1] : undefined
  return {
    reason: given,
    ...NO_SPLIT,
    split_into: split === undefined ? [] : split.split(',').map(n => Number(n.trim())),
    stage: null,
    lives: null,
    branch: text(e.branch),
    pr: e.pr,
    detail: e.note,
  }
}

// splitAbandonedData: the data of a v2 split's `abandoned` event: the designer's four reasons and
// each child's why (aligned with the children listed); only the children when the reasons can no
// longer be read.
export function splitAbandonedData(created: readonly number[], reasons: { why_split: string; why_count: string; why_parts: string; why_order: string } | null, childWhys: readonly string[] | null): Record<string, unknown> {
  return {
    reason: 'split',
    split_into: [...created],
    why_split: reasons === null ? null : reasons.why_split,
    why_count: reasons === null ? null : reasons.why_count,
    why_parts: reasons === null ? null : reasons.why_parts,
    why_order: reasons === null ? null : reasons.why_order,
    child_whys: reasons === null ? null : listOrNull(childWhys),
    stage: null,
    lives: null,
    branch: null,
    pr: null,
    detail: `split into ${created.join(',')}`,
  }
}

// closedData: the data of a `closed` event.
export function closedData(reason: string | null): Record<string, unknown> {
  return { reason }
}

function mergedData(e: ReusedEvent): Record<string, unknown> {
  const note = text(e.note)
  // the size is null when the event has none (the executor reads it), or has no pull request, or the read failed
  const size = e.pr === null ? null : (e.size ?? null)
  return {
    pr: e.pr,
    branch: text(e.branch),
    head: text(e.head),
    by: note === null || note === 'merged by the factory loop' ? 'factory' : 'hand',
    recovered: note !== null,
    files: size?.files ?? null,
    additions: size?.additions ?? null,
    deletions: size?.deletions ?? null,
  }
}

// A fixer's disposition: `CORRECT: <id> <reason>` fixed the finding, `WRONG: <id> <reason>` declined it.
function verdictData(e: ReusedEvent): Record<string, unknown> {
  const m = /^(CORRECT|WRONG):\s+(\S+)\s*([\s\S]*)$/.exec(e.note)
  if (m === null) throw new Error(`a verdict note reads as neither CORRECT nor WRONG: ${JSON.stringify(e.note.slice(0, 60))}`)
  return { branch: text(e.branch), pr: e.pr, head: text(e.head), finding: (m[2] as string).replace(/:$/, ''), outcome: m[1] === 'CORRECT' ? 'fixed' : 'declined', detail: (m[3] as string).trim() }
}

// nativeOf: the call that writes this event: its type, data, issue, and its actor when it has its
// own (a fixer's disposition is the fixer's, 7.1).
export function nativeOf(e: V2Event): NativeEvent {
  switch (e.state) {
    case 'transition':
      return { type: 'transition', data: transitionData(e), issue: e.record.issue, actor: null }
    case 'reviewed':
      return { type: 'reviewed', data: reviewedData(e), issue: e.issue, actor: null }
    case 'intervention':
      return { type: 'intervention', data: interventionData(e), issue: e.issue, actor: null }
    case 'reclaimed':
      return { ...releaseData(e), issue: e.issue, actor: null }
    case 'abandoned':
      return 'reason' in e && e.reason === 'reconcile' ? { ...releaseData(e), issue: e.issue, actor: null } : { type: 'abandoned', data: abandonedData(e as ReusedEvent), issue: e.issue, actor: null }
    case 'merged':
      return { type: 'merged', data: mergedData(e), issue: e.issue, actor: null }
    case 'verdict':
      return { type: 'finding_handled', data: verdictData(e), issue: e.issue, actor: 'fixer' }
    case 'gate_run':
    case 'comment_posted':
      return { type: e.state, data: { ...e.data }, issue: e.issue, actor: null }
    case 'shadow_read':
    case 'settings_changed':
    case 'main_state':
    case 'milestone_state':
      return { type: e.state, data: { ...e.data }, issue: null, actor: null }
    default:
      // an old state the loop no longer writes (delegated, fix_requested, merge_ready): the type system refuses it too
      throw new Error(`${(e as { state: string }).state} is not an event v2 writes`)
  }
}
