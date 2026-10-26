// The loop's queue snapshot (docs/factory-loop/v2/SPEC.md, native events): when the claim queue
// the plan saw changes, and as a heartbeat when it does not, the pass writes one `queue_snapshot`
// event (schema queue_snapshot.v1.json). Pure but for the module-level book, which driver-pass.ts
// feeds once per acting pass. Nothing here sends: the driver sends snapshotArgv without awaiting
// it, so a write never slows or fails a pass.
//
// - A change is a different fingerprint from the last pass's (issue, rank, claimable, why of every
//   candidate, the free slots and the owner's controls; never score or factors, which drift every
//   hour). A change within a minute of the last write is held and counted; the first pass a
//   minute after the write sends the newest view, folded = the changes seen since.
// - With no change, a heartbeat once a quarter hour has passed since the last write.
// - A pass with a claim writes at once as changed, so the snapshot at the claim's plan time shows
//   the order the claim was taken in.
// - A send that failed counts as written (no retry each pass) and leaves one problem line for the
//   next pass line.
import type { Ms } from './types'
import type { QueueView } from './v2/queue-view'

export const FOLD_MS = 60_000
export const HEARTBEAT_MS = 15 * 60_000
export const MAX_CANDIDATES = 50

export type SnapshotBook = {
  // the fingerprint of the last view seen, written or not
  seen: string | null
  // when the last snapshot was written
  at: Ms | null
  // changes seen since the last write
  folded: number
  // the failure of a write, for the next pass line
  problem: string | null
}

export type Decision = { write: 'changed' | 'heartbeat'; folded: number } | { hold: true }

export type SnapshotData = {
  taken_at: string
  reason: 'changed' | 'heartbeat'
  considered: number
  candidates: QueueView['rows']
  rest: Array<{ why: QueueView['rows'][number]['why']; count: number }>
  free_slots: number | null
  owner_priority: number[]
  owner_only: number[]
  owner_serial: boolean
  owner_new_off: boolean
  folded: number
}

export const freshBook = (): SnapshotBook => ({ seen: null, at: null, folded: 0, problem: null })

// fingerprint: the view without score and factors.
export function fingerprint(view: QueueView): string {
  return JSON.stringify([view.rows.map(r => [r.issue, r.rank, r.claimable, r.why]), view.free_slots, view.priority, view.only, view.serial, view.noNewWork])
}

// decide: what this pass does with its view, and the book after it. claimed: the plan has an S1 claim.
export function decide(book: SnapshotBook, view: QueueView, now: Ms, claimed: boolean): { decision: Decision; book: SnapshotBook } {
  const fp = fingerprint(view)
  const folded = book.folded + (fp === book.seen ? 0 : 1)
  const age = book.at === null ? Infinity : now - book.at
  const next = { ...book, seen: fp }
  const wrote = (write: 'changed' | 'heartbeat', n: number) => ({ decision: { write, folded: n } as Decision, book: { ...next, at: now, folded: 0 } })
  if (claimed) return wrote('changed', Math.max(1, folded))
  if (folded > 0 && age >= FOLD_MS) return wrote('changed', folded)
  if (folded > 0) return { decision: { hold: true }, book: { ...next, folded } }
  if (age >= HEARTBEAT_MS) return wrote('heartbeat', 0)
  return { decision: { hold: true }, book: next }
}

// snapshotData: the queue_snapshot.v1 payload: the first 50 candidates, the rest counted by why in order of first appearance.
export function snapshotData(view: QueueView, takenAt: Ms, reason: 'changed' | 'heartbeat', folded: number): SnapshotData {
  const rest = new Map<QueueView['rows'][number]['why'], number>()
  for (const r of view.rows.slice(MAX_CANDIDATES)) rest.set(r.why, (rest.get(r.why) ?? 0) + 1)
  return {
    taken_at: new Date(Math.floor(takenAt / 1000) * 1000).toISOString(),
    reason,
    considered: view.considered,
    candidates: view.rows.slice(0, MAX_CANDIDATES),
    rest: [...rest].map(([why, count]) => ({ why, count })),
    free_slots: view.free_slots,
    owner_priority: view.priority,
    owner_only: view.only,
    owner_serial: view.serial,
    owner_new_off: view.noNewWork,
    folded,
  }
}

export const snapshotArgv = (data: SnapshotData): string[] => ['fabriek-event', '--type', 'queue_snapshot', '--data', JSON.stringify(data)]

// --- the module's book ----------------------------------------------------------------------------

let book: SnapshotBook = freshBook()

// resetSnapshots: a new load (and the tests) start from nothing: the first pass writes.
export function resetSnapshots(): void {
  book = freshBook()
}

// nextSnapshot: the pass's view at its plan time; the argv to send, or null when this pass writes nothing.
export function nextSnapshot(view: QueueView, now: Ms, claimed: boolean): string[] | null {
  const d = decide(book, view, now, claimed)
  book = d.book
  return 'hold' in d.decision ? null : snapshotArgv(snapshotData(view, now, d.decision.write, d.decision.folded))
}

// snapshotFailed: a send was rejected, timed out or exited non-zero.
export function snapshotFailed(reason: string): void {
  book = { ...book, problem: `queue snapshot: write failed: ${reason}` }
}

// takeProblem: the failure to put on the next pass line, once.
export function takeProblem(): string | null {
  const p = book.problem
  book = { ...book, problem: null }
  return p
}
