// The `slot` executor (docs/factory-loop/v2/SPEC.md 10.1, 10.2, 10.8): `factory-slot lease`,
// `prepare`, `kill` and `free`, each op with its own attempts on its action (lease 3, prepare 1,
// kill 1, free 2).
//
// STUB of build unit U1. U8 fills it; until then each executor fails, never retried.
import type { Exec, Executor } from '../exec'
import type { ActionKind } from '../types'

const notBuilt = (kind: string): Executor => async (): Promise<Exec> => ({ status: 'failed', summary: `${kind}: not built yet (U8)`, noRetry: true })

export const executors: Partial<Record<ActionKind, Executor>> = { slot: notBuilt('slot') }
