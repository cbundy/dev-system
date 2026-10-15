// How the review step runs and reads its answer (docs/factory-loop/v2/SPEC.md 8.2 to 8.5): the
// reviewer's half (the Reviewer the `reviewer` setting picks, reviewer.ts; its prompt,
// prompts-review.ts; its contract, contracts-review.mjs), keyed by patch and round, and the CI
// half: every check on the head, one re-run of a failed one, a conflict at once, and the waits on
// GitHub bounded by ciStartMs and ciRunMs.
//
// STUB of build unit U1. U6 fills it; until then the review step refuses to start, never retried.
import type { StepModule } from './steps'
import { unknownResult } from './types'
import type { AgentStep } from './types'

export const STEPS: Partial<Record<AgentStep, StepModule>> = {
  review: {
    step: 'review',
    contract: 'review',
    spawn: async () => 'the review step is not built yet (U6)',
    result: async () => unknownResult('bad-answer', 'the review step is not built yet (U6)'),
  },
}
