// How the designer's, the builder's and the fixer's steps run and read their answers
// (docs/factory-loop/v2/SPEC.md 4.2, 8.1, 8.7, 9.7, 10.8): their prompts (prompts-work.ts), their
// contracts (contracts-work.mjs: design-v2, build, fix) and what an answer means: a brief, a
// question or a split; a build with commits on origin beyond the base, or that it cannot; a fix
// with a new head on origin, or every finding declined. A writer's result reads origin's branch
// directly (`git ls-remote origin refs/heads/<branch>`), and a failed read is unknown.
//
// STUB of build unit U1. U5 fills it; until then each step refuses to start, never retried.
import type { StepModule } from './steps'
import { unknownResult } from './types'
import type { AgentStep } from './types'

const notBuilt = (step: AgentStep, contract: StepModule['contract']): StepModule => ({
  step,
  contract,
  spawn: async () => `the ${step} step is not built yet (U5)`,
  result: async () => unknownResult('bad-answer', `the ${step} step is not built yet (U5)`),
})

export const STEPS: Partial<Record<AgentStep, StepModule>> = {
  design: notBuilt('design', 'design-v2'),
  build: notBuilt('build', 'build'),
  fix: notBuilt('fix', 'fix'),
}
