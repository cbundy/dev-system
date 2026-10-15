// The `ci-rerun` executor (docs/factory-loop/v2/SPEC.md 8.5): one re-run of a failed or cancelled
// check, `gh run rerun <run id> --failed --repo R`, keyed by round and run id.
//
// STUB of build unit U1. U6 fills it; until then each executor fails, never retried.
import type { Exec, Executor } from '../exec'
import type { ActionKind } from '../types'

const notBuilt = (kind: string): Executor => async (): Promise<Exec> => ({ status: 'failed', summary: `${kind}: not built yet (U6)`, noRetry: true })

export const executors: Partial<Record<ActionKind, Executor>> = { 'ci-rerun': notBuilt('ci-rerun') }
