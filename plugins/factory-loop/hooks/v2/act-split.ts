// The `split` executor (docs/factory-loop/v2/SPEC.md 8.7): one child per action, found again by
// the hidden key in its body or created, linked as a sub-issue with its blocked_by links, and
// labelled ready when the designer asked.
//
// STUB of build unit U1. U5 fills it; until then each executor fails, never retried.
import type { Exec, Executor } from '../exec'
import type { ActionKind } from '../types'

const notBuilt = (kind: string): Executor => async (): Promise<Exec> => ({ status: 'failed', summary: `${kind}: not built yet (U5)`, noRetry: true })

export const executors: Partial<Record<ActionKind, Executor>> = { split: notBuilt('split') }
