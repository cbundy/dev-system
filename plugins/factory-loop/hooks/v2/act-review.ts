// The review step's writes (docs/factory-loop/v2/SPEC.md 8.3): each review result as one PR comment
// with a hidden key, and its `reviewed` event and the fixer's `verdict` events, all through the
// record's executors (act-state.ts) and events.ts.
//
// STUB of build unit U1. U6 fills it.
import type { Executor } from '../exec'
import type { ActionKind } from '../types'

export const executors: Partial<Record<ActionKind, Executor>> = {}
