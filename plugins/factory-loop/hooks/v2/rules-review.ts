// The plan side of the review step (docs/factory-loop/v2/SPEC.md 8.1 to 8.5): in reviewing, the
// PR's ensure first, then the reviewer keyed by patch and round (it may build on rules-agent.ts
// agentStep with its own key), the CI half (a re-run of a failed check, a conflict at once, the
// waits on GitHub bounded by ciStartMs and ciRunMs), and the step's result for the table: ok with
// the approved patch and the PR, not-ok with changes, ci-red or conflict, or unknown (table.ts
// EventData, NOT_OK_REASONS). rules-state.ts takes the review step's plan from PLANS.
//
// STUB of build unit U2 for U6, which fills it; until then a record in reviewing waits, and its
// skip line says so.
import { notBuiltStep } from './rules-agent'
import type { StepPlan } from './rules-agent'
import type { StepKind } from './types'

export const PLANS: Partial<Record<StepKind, StepPlan>> = { review: notBuiltStep('review', 'U6') }
