// The events the loop writes outside a plan's actions (docs/factory-loop/v2/SPEC.md 7.2): an owner
// op's person intervention, which register.ts ownerOp logs here once the op has landed (every op
// but status and help, the issues it names attached, a fleet-level one attached to none). Every
// event goes through events.ts.
//
// STUB of build unit U1. U4 fills it; until then it logs nothing and says so.
import type { ActEnv } from '../act'

// What an op that landed was: its canonical text (control.ts formatOp), its name and the issues
// it names.
export type OpLanded = { text: string; name: string; issues: number[]; at: number }

// logOwnerOp: the op's intervention, logged; notes on what failed, for the decision log.
export async function logOwnerOp(_env: Pick<ActEnv, 'io' | 'rt' | 'commands'>, op: OpLanded): Promise<string[]> {
  return [`intervention op:${op.name} not logged: act-events.ts is not built yet (U4)`]
}
