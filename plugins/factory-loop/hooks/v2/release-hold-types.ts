// What the release hold reads (docs/factory-loop/v2/SPEC.md 2.4, 9.1): the open release bump PRs,
// each with its current head, the head's commit time and the state of the head's checks, which
// anchor the window the merge queue holds for.
import type { Ms } from '../types'

// The state of a head's checks: red once one failed or was cancelled; pending while one runs or
// none has reported; green when all passed or were skipped.
export type ReleaseChecks = 'pending' | 'green' | 'red'

// An open release bump PR: its branch, GitHub's creation time, its head, that head's commit time
// and earliest check start (null: not read), the state of its checks (null: not read yet) and the
// names of the failed ones.
export type ReleasePr = {
  pr: number
  branch: string
  createdAt: Ms
  head: string
  committedAt: Ms | null
  checkStart: Ms | null
  checks: ReleaseChecks | null
  failed: string[]
}

// What the merge queue's release hold reads: the open bump PRs, and how the ones that left the list
// ended (merged or closed), until their end is logged.
export type ReleasePrsRead = { prs: ReleasePr[]; left: Record<number, 'merged' | 'closed'> }

// anchorOf: where the head's hold window starts: the latest of the PR's creation, the head
// commit's time and the earliest start of the head's checks, each piece left out when unread.
export const anchorOf = (p: ReleasePr): Ms => Math.max(p.createdAt, p.committedAt ?? 0, p.checkStart ?? 0)
