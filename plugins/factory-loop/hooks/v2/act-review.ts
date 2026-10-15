// The review step's writes (docs/factory-loop/v2/SPEC.md 8.3, 7.1): each review result as one PR
// comment with a hidden key, its `reviewed` event, and the fixer's dispositions as `verdict` events
// (actor fixer). They need no executor of their own: rules-review.ts plans each as a keyed
// `comment` or `event` action, built by reviewer.ts and events.ts, and act-state.ts runs them,
// the comment executor finding its hidden key before it posts, so a retry never posts twice
// (4.5). This module stays the review step's place in the registry (registry.ts), and adds none:
// a kind given here would shadow act-state.ts's own.
import type { Executor } from '../exec'
import type { ActionKind } from '../types'

export const executors: Partial<Record<ActionKind, Executor>> = {}
