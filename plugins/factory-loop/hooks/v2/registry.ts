// The v2 executors (docs/factory-loop/v2/SPEC.md 2.2, appendix B), one map from each module that
// runs actions. act.ts joins them to EXECUTORS, so every action kind has an executor; under
// planner v2 its dispatcher prefers these, so a module here may also give a reused kind (a claim,
// a heartbeat) its v2 behaviour without touching v1's. Every new kind of appendix B must have one
// here (tests/v2-switch.test.ts).
import type { Executor } from '../exec'
import type { ActionKind } from '../types'
import { executors as ci } from './act-ci'
import { executors as pr } from './act-pr'
import { executors as queue } from './act-queue'
import { executors as review } from './act-review'
import { executors as slots } from './act-slots'
import { executors as split } from './act-split'
import { executors as state } from './act-state'
import { executors as steps } from './steps'

export const V2_EXECUTORS: Partial<Record<ActionKind, Executor>> = { ...state, ...pr, ...split, ...review, ...ci, ...queue, ...slots, ...steps }
