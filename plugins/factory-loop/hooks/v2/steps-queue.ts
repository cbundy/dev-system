// How the merge queue's step runs and reads its result (docs/factory-loop/v2/SPEC.md 4.2, 9): the
// head's step is Q1's update and Q2's merge, no agent, so it adds no StepModule; it is read from
// their outcomes (act-queue.ts), the PR's checks and its patch: ok once merged at a head a
// queue-merge of the life names; not-ok on a conflict, red CI after its re-run, a changed patch or
// a policy FAIL; unknown on a CLI failure, a `read` FAIL or a wait past its bound.
//
// STUB of build unit U1. U7 fills it.
import type { StepModule } from './steps'
import type { AgentStep } from './types'

export const STEPS: Partial<Record<AgentStep, StepModule>> = {}
