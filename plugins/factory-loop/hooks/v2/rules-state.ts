// The record's rules (docs/factory-loop/v2/SPEC.md 3, 4, 5, 14.1): S0 makes a record from its
// done claim, S1 claims, S2 starts a record's step, S3 applies a step result through the table,
// S4 the unknown path, S5 triage, S6 the owner's and GitHub's events; H1 renews and re-claims;
// and O1's counts, which the title and the decision log show.
//
// STUB of build unit U1. U2 fills it: until then no rule plans, and the counts come from the
// records as they are.
import type { IssueRecord, V2Ctx } from './types'

const HOUR = 3_600_000
// The title's M: issues merged in this window (D-23).
const MERGED_WINDOW_MS = 6 * HOUR

export function stateRules(_ctx: V2Ctx): void {}

// The records by where they are: queued, in flight (designing to merge-queue) and parked.
export type StateCounts = { queued: number; flight: number; parked: number }

export function stateCounts(records: readonly IssueRecord[]): StateCounts {
  const out: StateCounts = { queued: 0, flight: 0, parked: 0 }
  for (const r of records) {
    if (r.state === 'queued') out.queued += 1
    else if (r.state === 'parked') out.parked += 1
    else if (r.state !== 'closed') out.flight += 1
  }
  return out
}

// stateTitle: the title's counts, Q (the ready queue and the queued records), D (in flight) and M
// (merged in the last 6 hours), and its words of the layer's own: parked <n>.
export function stateTitle(ctx: V2Ctx): { counts: string; after: string[] } {
  const c = stateCounts(ctx.v2.records)
  const merged = ctx.v2.records.filter(r => r.state === 'closed' && (r.why === 'merged' || r.why === 'merged-by-hand') && ctx.state.now - r.since <= MERGED_WINDOW_MS).length
  return { counts: `Q:${ctx.state.queue.length + c.queued} - D:${c.flight} - M:${merged}`, after: c.parked > 0 ? [`parked ${c.parked}`] : [] }
}
