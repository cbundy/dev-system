// The `pr` executor (docs/factory-loop/v2/SPEC.md 8.1): op ensure lists the branch's PRs, uses an
// open one, reopens a closed unmerged one or creates one, then writes the loop's body when the
// PR's differs; op body writes the body alone (a linkage FAIL, 9.3). The body is the loop's own,
// every free-text part through prompts.ts neutral().
//
// STUB of build unit U1. U5 fills it; until then each executor fails, never retried.
import type { Exec, Executor } from '../exec'
import type { ActionKind } from '../types'

const notBuilt = (kind: string): Executor => async (): Promise<Exec> => ({ status: 'failed', summary: `${kind}: not built yet (U5)`, noRetry: true })

export const executors: Partial<Record<ActionKind, Executor>> = { pr: notBuilt('pr') }
