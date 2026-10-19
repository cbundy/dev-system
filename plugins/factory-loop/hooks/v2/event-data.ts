// The types of every event v2 writes (docs/factory-loop/v2/SPEC.md 7.1), apart from the formats that
// build and read them. events.ts re-exports all of it, so every import from './events' still works.
import type { IssueRecord, IssueState } from './types'

export type TransitionEvent = { state: 'transition'; record: IssueRecord; row: string; from: IssueState | null; via: string }

// One review result (8.3).
export type ReviewedEvent = {
  state: 'reviewed'
  issue: number
  branch: string
  pr: number
  head: string
  verdict: 'approve' | 'changes' | 'unknown'
  round: number
  patch: string
  errors: number
  warnings: number
  infos: number
  reviewer: string
  answer: string
}

export const INTERVENTION_WHO = ['person', 'loop', 'judge'] as const

// One intervention (7.2): who, the cause code, a one-line reason, and the key of the fact it
// records (its ledger key is iv/<fact>), so readers count it once.
export type InterventionEvent = {
  state: 'intervention'
  who: (typeof INTERVENTION_WHO)[number]
  cause: string
  reason: string
  issue: number | null
  life: string | null
  pr: number | null
  fact: string
  // a ci-rerun row's result (docs/factory-events/schemas/intervention.v1.json); types only, no producer yet
  flaky?: boolean | null
  failed_tests?: string[] | null
  failed_jobs?: string[] | null
  head?: string | null
}

// How a release ends (6.4): back in the queue (requeue), out of the factory (leave), or rejected at
// the issue's last life (reject).
export const RELEASE_OUTCOMES = ['requeue', 'leave', 'reject'] as const

// A reconcile release (6.4): reclaimed when it puts the issue back in the queue, abandoned when the
// issue leaves the factory or is rejected. lives: the released life's number since the issue's
// count last started, null for the migration's.
export type ReleaseEvent = {
  state: 'reclaimed' | 'abandoned'
  issue: number
  branch: string | null
  pr: number | null
  stage: string
  checked: string
  reason: 'reconcile'
  outcome: (typeof RELEASE_OUTCOMES)[number]
  lives: number | null
}

// The reused states, each with the meaning it already has (7.1); the note is today's.
export type ReusedEvent = {
  state: 'delegated' | 'fix_requested' | 'merge_ready' | 'abandoned' | 'merged' | 'verdict'
  issue: number
  branch: string | null
  pr: number | null
  head: string | null
  note: string
}

// One stop gate run (gate_run.v1, docs/factory-events/schemas): written in the new format alone, by
// `callum-flow-event --type gate_run --data <json> --issue N`, so it has no note, no old-format
// line and no parser. rules-gates.ts builds it from the companion's gate lines.
export type GateRunData = {
  life: string
  seq: number
  head: string | null
  result: 'pass' | 'fail' | 'unknown'
  wait_ms: number
  run_ms: number
  concurrency: number | null
  queued_behind: number
  started_at: string
  // set on a pass row once checked, and the failed run's names and start (gate_run.v1.json)
  flaky?: boolean | null
  failed_tests?: string[] | null
  failed_at?: string | null
}
export type GateRunEvent = { state: 'gate_run'; issue: number; data: GateRunData }

// One shadow compare (shadow_read.v1): written in the new format alone, for no issue, by
// `callum-flow-event --type shadow_read --data <json>`; sources-records.ts builds the data.
export type ShadowReadData = {
  reader: string
  tool: string
  compared: number
  differences: number
  live_differences: number
  diff_keys: string[]
  old_ok: boolean
  new_ok: boolean
  settle_seconds: number
  detail: string | null
  // the writing device's first new-store time (ISO) or null, and how many events that floor left out
  scope_floor?: string | null
  out_of_scope?: number | null
}
export type ShadowReadEvent = { state: 'shadow_read'; data: ShadowReadData }

// One change in the state of the default branch (main_state.v1): written in the new format alone, for
// no issue, by `callum-flow-event --type main_state --data <json>`; rules-main.ts builds the data
// from the main source's reading. The arrays line up index by index (workflows, then deployments).
export type MainStateData = {
  observed_at: string
  branch: string
  head: string
  pr: number | null
  workflows: string[]
  workflow_ids: number[]
  run_ids: (number | null)[]
  run_attempts: (number | null)[]
  run_heads: (string | null)[]
  run_events: (string | null)[]
  conclusions: (string | null)[]
  running: boolean[]
  green: boolean
  deploy_environments: string[]
  deploy_ids: number[]
  deploy_states: (string | null)[]
  changed: 'first' | 'head' | 'workflow' | 'deploy'
}
export type MainStateEvent = { state: 'main_state'; data: MainStateData }

export type V2Event = TransitionEvent | ReviewedEvent | InterventionEvent | ReleaseEvent | ReusedEvent | GateRunEvent | ShadowReadEvent | MainStateEvent
