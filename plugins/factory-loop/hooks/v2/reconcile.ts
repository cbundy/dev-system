// R1, every pass (docs/factory-loop/v2/SPEC.md 6.2): a live claim of this device with no record
// and no claim in flight is a ghost, released at once in act mode (release.ts), planned and logged
// in observe mode and the shadow; and the main-checkout tripwire (10.7), which tells the owner of
// a new change to the main checkout once.
//
// STUB of build unit U1. U3 fills it; until then R1 plans nothing.
import type { V2Ctx } from './types'

export function reconcile(_ctx: V2Ctx): void {}
