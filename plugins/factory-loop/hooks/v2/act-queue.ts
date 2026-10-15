// The merge queue's executors (docs/factory-loop/v2/SPEC.md 9.2, 9.3): `queue-update` runs
// `gh pr update-branch` on the head and reads its PR until the head moves (30 s), recording the
// new head; `queue-merge` runs `callum-flow-merge <p> --patch <id>` and reads the guard's FAIL
// classes.
//
// STUB of build unit U1. U7 fills it; until then each executor fails, never retried.
import type { Exec, Executor } from '../exec'
import type { ActionKind } from '../types'

const notBuilt = (kind: string): Executor => async (): Promise<Exec> => ({ status: 'failed', summary: `${kind}: not built yet (U7)`, noRetry: true })

export const executors: Partial<Record<ActionKind, Executor>> = { 'queue-update': notBuilt('queue-update'), 'queue-merge': notBuilt('queue-merge') }
