// The merge queue (docs/factory-loop/v2/SPEC.md 9): its order (merge-queue records whose step is
// `queue`, oldest seqAt first), Q1 (update the head when it is behind) and Q2 (merge the head when
// it is clean, green and its patch is the approved one). Only the head is ever touched.
// PLANS gives the queue step's reading to rules-state.ts: waiting for a record behind the head (told
// after its period, E6), and the head's result for the table (ok once merged by the loop; not-ok
// with conflict, ci-red, patch or policy; unknown; table.ts EventData, NOT_OK_REASONS).
//
// STUB of build unit U1. U7 fills it; until then the queue plans nothing, and a record in the merge
// queue waits with a skip line that says so.
import { notBuiltStep } from './rules-agent'
import type { StepPlan } from './rules-agent'
import type { StepKind, V2Ctx } from './types'

export function queueRules(_ctx: V2Ctx): void {}

export const PLANS: Partial<Record<StepKind, StepPlan>> = { queue: notBuiltStep('queue', 'U7') }
