// The `prs` source (docs/factory-loop/v2/SPEC.md 2.4): for each record in reviewing or the merge
// queue with a PR, the PR (callum-flow-issue-read --json --pr <n>: state, merged, merged head,
// closedAt, head, mergeable_state, author), its check runs (gh pr checks <n> --repo R --json
// name,state,bucket,startedAt,completedAt,link, the run id from the link) and, when the head
// moved, its patch id (8.4); and the time observe first saw each head (heads:<repo>), whose
// entries go when their PR closes. Reads go in 2.4's order, within the pass's budget.
//
// STUB of build unit U1. U7 fills it; until then the source reads nothing and says so.
import type { Source } from '../types'
import type { SourceCtx } from './observe'
import type { HeadSeen } from './types'

export type CheckRun = {
  name: string
  state: string
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'
  startedAt: number | null
  completedAt: number | null
  runId: string | null
  link: string | null
}

export type PrView = {
  pr: number
  issue: number
  state: 'open' | 'closed' | 'merged'
  head: string | null
  mergedHead: string | null
  closedAt: string | null
  mergeable: string | null
  author: string | null
  checks: CheckRun[]
  patch: string | null
  readAt: number
}

export type PrsRead = { prs: PrView[] }

export const EMPTY_PRS: PrsRead = { prs: [] }

// readPrs: the PRs of the records that have one, and the heads first seen, updated.
export async function readPrs(ctx: SourceCtx): Promise<{ read: PrsRead; source: Source; heads: Record<string, HeadSeen> }> {
  return { read: EMPTY_PRS, source: { ok: false, at: null, error: 'not built yet (U7)' }, heads: ctx.heads }
}
