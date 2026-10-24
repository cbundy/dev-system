// The fixing-state rows of the transition table (SPEC 4.3): T11, T12 and T17, the fix rounds that
// go back to reviewing, and T19 and T20, which park the issue at once when a second fix round in
// a row is blocked by the environment (SPEC 8.6). Split from table.ts to keep it under the size
// guard; table.ts spreads fixRows in place, giving the helpers the rows share with its other rows.
//
// Pure: the rows read only the record and the event.
import type { IssueRecord, Row, TableEvent } from './types'
import type { EventData } from './table'

// The table.ts helpers the rows use.
export type FixHelpers = {
  ownStep: (r: IssueRecord) => boolean
  dataOf: (e: TableEvent) => EventData
  textOf: (e: TableEvent, fallback: string) => string
  clip: (text: string, max?: number) => string
  own: (...notes: (string | null | undefined)[]) => string[]
}

// the reasons of one round in a park question, so two rounds fit the stored question's cap
const REASONS_MAX = 700

export function fixRows(h: FixHelpers): readonly Row[] {
  const { ownStep, dataOf, textOf, clip, own } = h
  const blockedOf = (e: TableEvent) => dataOf(e).blocked ?? []
  // envPark: a second fix round in a row with an environment-blocked finding.
  const envPark = (r: IssueRecord, e: TableEvent) => blockedOf(e).length > 0 && r.envBlocked !== null
  // envBlocked: what the record keeps of this round: its reasons on one line, null when it had none.
  const envBlocked = (e: TableEvent) => (blockedOf(e).length === 0 ? null : clip(blockedOf(e).join('; ')))
  const envQuestion = (r: IssueRecord, e: TableEvent) =>
    clip(
      `[ACTION] Owner: provide what the fixer is missing - the tool or access, a repo setting (for example uiCapture: "none"), or an answer to the finding. Two fix rounds in a row were blocked by the environment. Previous round: ${clip(r.envBlocked ?? '', REASONS_MAX)}. This round: ${clip(blockedOf(e).join('; '), REASONS_MAX)}.`,
      2000,
    )
  const notOkFix = (reason: string) => (r: IssueRecord, e: TableEvent) => ownStep(r) && e.reason === reason && !envPark(r, e)
  return [
    { id: 'T11', states: ['fixing'], on: 'ok', when: (r, e) => ownStep(r) && !envPark(r, e), next: 'reviewing', change: (r, e) => ({ head: dataOf(e).head ?? r.head, round: r.round + 1, envBlocked: envBlocked(e) }), via: 'fix' },
    {
      id: 'T12',
      states: ['fixing'],
      on: 'not-ok',
      when: notOkFix('declined'),
      next: 'reviewing',
      change: (r, e) => ({ round: r.round + 1, notes: own(...(dataOf(e).notes ?? [textOf(e, 'every finding declined')])), envBlocked: envBlocked(e) }),
      via: 'declined',
    },
    {
      id: 'T17',
      states: ['fixing'],
      on: 'not-ok',
      when: notOkFix('unchanged'),
      next: 'reviewing',
      change: (r, e) => ({ round: r.round + 1, notes: own(...(dataOf(e).notes ?? [textOf(e, 'a finding fixed without a code change')])), envBlocked: envBlocked(e) }),
      via: 'unchanged',
    },
    // a fix that pushed, and a second environment blocker in a row: the pushed head is kept
    {
      id: 'T19',
      states: ['fixing'],
      on: 'ok',
      when: (r, e) => ownStep(r) && envPark(r, e),
      next: 'parked',
      change: (r, e) => ({ head: dataOf(e).head ?? r.head, question: envQuestion(r, e), resumeTo: 'reviewing', envBlocked: envBlocked(e) }),
      via: 'env-blocked',
    },
    {
      id: 'T20',
      states: ['fixing'],
      on: 'not-ok',
      when: (r, e) => ownStep(r) && (e.reason === 'declined' || e.reason === 'unchanged') && envPark(r, e),
      next: 'parked',
      change: (r, e) => ({ question: envQuestion(r, e), resumeTo: 'reviewing', envBlocked: envBlocked(e) }),
      via: 'env-blocked',
    },
  ]
}
