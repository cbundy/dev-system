// The plan side of the designer's, the builder's and the fixer's steps (docs/factory-loop/v2/SPEC.md
// 4.2, 8.1, 8.7): what each step reads beyond the generic agent step (rules-agent.ts agentStep),
// such as posting a designer's brief or making a split's children before the step's result
// counts, and the events those results carry for the table (table.ts EventData, NOT_OK_REASONS).
// rules-state.ts takes each step's plan from PLANS, over the generic one.
//
// STUB of build unit U2 for U5, which fills it; until then design, build and fix run as the
// generic agent step.
import type { StepPlan } from './rules-agent'
import type { StepKind } from './types'

export const PLANS: Partial<Record<StepKind, StepPlan>> = {}
