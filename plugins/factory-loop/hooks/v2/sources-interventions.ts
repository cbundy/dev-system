// The facts the interventions of docs/factory-loop/v2/SPEC.md 7.2 come from, beside the ledger and
// the records: the companion's log (<loop dir>/companion.jsonl: one line per refusal and per stop
// gate that could not run), the digests of control.json and the OFF file and of the two settings
// files (against the last ones the loop read or wrote), and the pushes no loop step produced.
// rules-interventions.ts turns each fact into one `intervention` event.
//
// STUB of build unit U1. U4 fills it; until then the source reads nothing and says so.
import type { Source } from '../types'
import type { SourceCtx } from './observe'

// One line of the companion's log (10.4, 10.6).
export type CompanionLine = { at: number; issue: number | null; life: string | null; seq: number | null; cause: string; reason: string }

export type InterventionFacts = {
  companion: CompanionLine[]
  controlDigest: string | null
  configDigest: string | null
}

export const EMPTY_INTERVENTIONS: InterventionFacts = { companion: [], controlDigest: null, configDigest: null }

export async function readInterventions(_ctx: SourceCtx): Promise<{ read: InterventionFacts; source: Source }> {
  return { read: EMPTY_INTERVENTIONS, source: { ok: false, at: null, error: 'not built yet (U4)' } }
}
