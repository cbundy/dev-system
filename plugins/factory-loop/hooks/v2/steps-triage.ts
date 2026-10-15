// How the triage step runs and reads its answer (docs/factory-loop/v2/SPEC.md 5.2): the one
// bounded triage call of the unknown path, a reader in the issue's slot, on triageModel, with the
// last two results, their files and the menu (prompts-triage.ts); its answer (contracts-triage.mjs)
// is the `triage` event's choice.
//
// STUB of build unit U1. U2 fills it; until then the triage step refuses to start, never retried.
import type { StepModule } from './steps'
import { unknownResult } from './types'
import type { AgentStep } from './types'

export const STEPS: Partial<Record<AgentStep, StepModule>> = {
  triage: {
    step: 'triage',
    contract: 'triage',
    spawn: async () => 'the triage step is not built yet (U2)',
    result: async () => unknownResult('bad-answer', 'the triage step is not built yet (U2)'),
  },
}
