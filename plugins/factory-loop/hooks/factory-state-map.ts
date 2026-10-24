// The one place the plugin turns a callum-flow-factory-state issue row into a v2 state. Pure: no I/O,
// types only are imported, so parse.ts, the reconcile tool (plain Node) and the tests share it.
// plugins/factory-hud/hooks/format.ts carries a small copy of the same rule (a separate mod with no
// factory-loop import): change both together.
import type { IssueState } from './v2/types'

// Every v2 state, as a record so the compiler keeps it complete (types only are imported here, so plain Node can load this).
const STATES: Readonly<Record<IssueState, true>> = { queued: true, designing: true, building: true, reviewing: true, fixing: true, 'merge-queue': true, parked: true, waiting: true, closed: true }

// The states of live work: a claim that holds, or waits on, the factory (queued and closed are not).
export const LIVE_STATES: readonly IssueState[] = ['designing', 'building', 'reviewing', 'fixing', 'merge-queue', 'parked', 'waiting']

// The states that hold a pool slot: the shadow's pool size and the replay's both count these (designing and waiting hold none).
export const BUSY_STATES: readonly IssueState[] = ['building', 'reviewing', 'fixing', 'parked', 'merge-queue']

const MERGED_WHYS: readonly string[] = ['merged', 'merged-by-hand', 'done']

// stateOfRow: the v2 state of one issue row, and whether a closed one was merged; null for a row with no
// valid state. `ended` (GitHub closed it before the view saw it) gives closed; a detail `claim lapsed at`
// gives queued (the tool's own lapsed-claim rule). A closed row was merged when its `why` says so.
export function stateOfRow(row: Record<string, unknown>): { state: IssueState; merged: boolean } | null {
  const why = typeof row.why === 'string' ? row.why : null
  let state: IssueState | null = null
  if (row.ended === true) state = 'closed'
  else if (typeof row.detail === 'string' && row.detail.startsWith('claim lapsed at')) state = 'queued'
  else if (typeof row.state === 'string' && Object.hasOwn(STATES, row.state)) state = row.state as IssueState
  if (state === null) return null
  const merged = state === 'closed' && why !== null && MERGED_WHYS.includes(why)
  return { state, merged }
}
