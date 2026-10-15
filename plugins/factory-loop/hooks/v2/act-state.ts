// The record's executors (docs/factory-loop/v2/SPEC.md 3.3, 3.4, 4.5, appendix B): `transition`
// re-checks its trigger against the live ledger and records, stores the next record with a
// compare on (issue, life, seq) through ActIo.v2, and pings the driver; `label` writes a state's
// label in one call, ensures the seven exist, or clears them; `comment` posts once, found again by
// its hidden key; `event` writes what events.ts builds. A reused kind's v2 behaviour (the claim's
// adoption of an open PR, 3.5; the heartbeat's numbers, H1) may be added here too: under planner
// v2 the dispatcher prefers these executors (registry.ts).
//
// STUB of build unit U1. U2 fills it; until then each executor fails, never retried.
import type { Exec, Executor } from '../exec'
import type { ActionKind } from '../types'

const notBuilt = (kind: string): Executor => async (): Promise<Exec> => ({ status: 'failed', summary: `${kind}: not built yet (U2)`, noRetry: true })

export const executors: Partial<Record<ActionKind, Executor>> = { transition: notBuilt('transition'), label: notBuilt('label'), comment: notBuilt('comment'), event: notBuilt('event') }
