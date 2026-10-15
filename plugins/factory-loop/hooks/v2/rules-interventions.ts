// The interventions (docs/factory-loop/v2/SPEC.md 7.2), derived, never emitted ad hoc: one
// `intervention` event, keyed iv/<the fact's key>, for each fact in the ledger (a done transition
// by its row and event, a CI re-run, a release, a re-claim, a body re-render, an exhausted effect),
// the records, the State (heads, digests, the module load, the rail, the tripwire, the breaker)
// and the companion's log (sources-interventions.ts).
//
// STUB of build unit U1. U4 fills it; until then no intervention is planned.
import type { V2Ctx } from './types'

export function interventionRules(_ctx: V2Ctx): void {}
