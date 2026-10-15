// The slots (docs/factory-loop/v2/SPEC.md 10.1): W2 frees a loop slot whose record holds none
// (before W1, for one issue), W1 leases one for a queued record with capacity or a record in a
// slot state whose lease vanished.
//
// STUB of build unit U1. U8 fills it; until then no slot is leased or freed.
import type { V2Ctx } from './types'

export function slotRules(_ctx: V2Ctx): void {}
