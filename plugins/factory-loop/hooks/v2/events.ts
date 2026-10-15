// The one seam for every event v2 writes (docs/factory-loop/v2/SPEC.md 7.1): the state, the
// columns, the note and the argv of `callum-flow-event`. The `event` executor (act-state.ts), the
// owner ops' interventions (act-events.ts) and the migration tool build their events here alone,
// so the format changes in one module.
//
// STUB of build unit U1: the types and signatures. U4 fills it: the three new states and the
// key=value note tokens of the owner's decision of 2026-10-15 (today's format, encoded as the
// `loop` notes are, derive.ts loopNote). Until then eventArgv writes the event's state and
// columns with a plain note line.
import type { IssueRecord, IssueState } from './types'

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

// One intervention (7.2): who, the cause code, a one-line reason, and the key of the fact it
// records, so readers count it once.
export type InterventionEvent = {
  state: 'intervention'
  who: 'person' | 'loop'
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

// The reused states, each with the meaning it already has (7.1).
export type ReusedEvent = {
  state: 'delegated' | 'fix_requested' | 'merge_ready' | 'abandoned' | 'merged' | 'verdict'
  issue: number
  branch: string | null
  pr: number | null
  head: string | null
  note: string
}

export type V2Event = TransitionEvent | ReviewedEvent | InterventionEvent | ReleaseEvent | ReusedEvent

// The issue, branch, PR and head an event carries in its own columns.
function columns(e: V2Event): { issue: number | null; branch: string | null; pr: number | null; head: string | null } {
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

// eventNote: the short line for people the event's note carries.
export function eventNote(e: V2Event): string {
  switch (e.state) {
    case 'transition':
      return `${e.from ?? 'none'} -> ${e.record.state} (${e.row})`
    case 'reviewed':
      return `${e.verdict} r${e.round}`
    case 'intervention':
      return `${e.who} ${e.cause}: ${e.reason}`
    case 'reclaimed':
    case 'abandoned':
      return 'note' in e ? e.note : `reconcile: no live step in ${e.stage}: ${e.checked}`
    default:
      return e.note
  }
}

// eventArgv: `callum-flow-event <state>` for this event, its columns as flags and its note.
export function eventArgv(e: V2Event): string[] {
  const c = columns(e)
  const argv = ['callum-flow-event', e.state]
  if (c.issue !== null) argv.push('--issue', String(c.issue))
  if (c.branch !== null) argv.push('--branch', c.branch)
  if (c.pr !== null) argv.push('--pr', String(c.pr))
  if (c.head !== null) argv.push('--head', c.head)
  argv.push('--note', eventNote(e))
  return argv
}
