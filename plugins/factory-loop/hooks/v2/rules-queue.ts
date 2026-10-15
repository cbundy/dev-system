// The merge queue (docs/factory-loop/v2/SPEC.md 9): its order (merge-queue records whose step is
// `queue`, oldest seqAt first), Q1 (update the head when it is behind) and Q2 (merge the head when
// it is clean, green and its patch is the approved one). Only the head is ever touched.
//
// STUB of build unit U1. U7 fills it; until then the queue plans nothing.
import type { V2Ctx } from './types'

export function queueRules(_ctx: V2Ctx): void {}
