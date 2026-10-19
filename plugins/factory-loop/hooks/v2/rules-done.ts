// A done close's entry actions (docs/factory-loop/v2/SPEC.md 4.5, 8.7): the designer answered that
// the issue's work is already merged, the design step checked the evidence against origin (T18),
// and the closed record then does, in order: one comment naming the evidence, the reason and what
// becomes of the issue branch; the close as completed, which also logs the `closed` event; the
// branch's delete, once the close is done and only when the branch is the issue's own merged work;
// the split-tracker check upward; and the owner's [INFO] tell. Pure.
import { wake } from '../foundation'
import type { Action } from '../types'
import { entryKey, followKey } from './keys'
import type { EntryItem } from './rules-entry'
import { doneDesignOf } from './rules-work'
import type { StepEnv } from './rules-agent'
import type { IssueRecord } from './types'

const RULE = 'S3'

function base(r: IssueRecord, key: string, reason: string) {
  return { key, class: 'free' as const, rule: RULE, reason, issue: r.issue }
}

// The branch as the design step read it, and what to do with it: delete it, keep it with the reason,
// or nothing (origin has none).
export type BranchPlan = { op: 'delete'; sha: string; why: string } | { op: 'keep'; why: string } | { op: 'none'; why: string }

export function branchPlan(r: Pick<IssueRecord, 'branch'>, d: NonNullable<ReturnType<typeof doneDesignOf>>): BranchPlan {
  const b = d.branch
  if (b === null || b.sha === null) return { op: 'none', why: `origin has no branch ${r.branch}` }
  if (b.beyond === 0) return { op: 'delete', sha: b.sha, why: 'it has no commit beyond the default branch' }
  if (d.prHead !== null && d.prHead === b.sha) return { op: 'delete', sha: b.sha, why: `its head is the merged PR's head` }
  return { op: 'keep', why: b.beyond === null ? 'its commits beyond the default branch were not read' : `it has ${b.beyond} commit${b.beyond === 1 ? '' : 's'} of its own beyond the default branch` }
}

// evidenceLine: the evidence in words, for the comment and the tell.
function evidenceLine(d: NonNullable<ReturnType<typeof doneDesignOf>>): string {
  const e = d.evidence
  const parts: string[] = []
  if (e?.pr !== null && e?.pr !== undefined) parts.push(`PR #${e.pr}${d.mergeCommit === null ? '' : ` (merge ${d.mergeCommit.slice(0, 7)})`}`)
  if (e?.commit !== null && e?.commit !== undefined) parts.push(`commit ${e.commit.slice(0, 7)}`)
  if (e?.runIt !== null && e?.runIt !== undefined) parts.push(`run it: ${e.runIt}`)
  return parts.join(', ')
}

function branchLine(r: Pick<IssueRecord, 'branch'>, p: BranchPlan): string {
  if (p.op === 'delete') return `Branch: \`${r.branch}\` is deleted from origin, since ${p.why} (it is kept instead if it moved meanwhile).`
  if (p.op === 'keep') return `Branch: \`${r.branch}\` is kept, since ${p.why}.`
  return `Branch: ${p.why}, so none is deleted.`
}

// doneItems: the entry actions of a closed record whose why is done, in their order. tracker: the
// split-tracker check chain (rules-entry.ts trackerItems), which waits for the close.
export function doneItems(ctx: StepEnv['ctx'], r: IssueRecord, tracker: EntryItem[]): EntryItem[] {
  const d = doneDesignOf(ctx, r)
  const items: EntryItem[] = []
  const add = (action: Action, tell = false) => items.push({ action, soft: false, tell })
  const plan = d === null ? null : branchPlan(r, d)
  const evidence = d === null ? (r.notes[0] ?? 'the work was already merged') : evidenceLine(d)
  const lines = [`Closed by the factory loop: the work for this issue is already merged.`, `Evidence: ${evidence}.`]
  if (d?.reason != null) lines.push(`Reason: ${d.reason}`)
  lines.push(plan === null ? 'Branch: the answer can no longer be read, so no branch is deleted.' : branchLine(r, plan))
  add({ ...base(r, entryKey(r, 'comment'), 'the done close on the issue'), kind: 'comment', on: 'issue', number: r.issue, body: lines.join('\n\n') })
  const closeKey = followKey(r, 'close-issue')
  add({ ...base(r, closeKey, 'the work is already merged'), issue: r.issue, kind: 'close-issue', logClosed: true })
  const closed = ctx.byKey.get(closeKey)?.status === 'done'
  if (closed && plan !== null && plan.op === 'delete') {
    add({ ...base(r, followKey(r, 'delete-branch'), `delete the issue branch: ${plan.why}`), kind: 'delete-branch', branch: r.branch, sha: plan.sha })
  }
  if (closed) items.push(...tracker)
  add(
    wake('tell', 'done', entryKey(r, 'tell'), RULE, r.issue, { issue: r.issue, branch: plan === null ? 'unknown' : plan.op === 'delete' ? 'deleted' : plan.op === 'keep' ? 'kept' : 'none' }, [
      `issue: https://github.com/${ctx.state.repo}/issues/${r.issue}`,
      `evidence: ${evidence}`,
      `branch: ${plan === null ? 'unknown' : plan.op === 'delete' ? `deleting ${r.branch}` : plan.op === 'keep' ? `kept ${r.branch}: ${plan.why}` : plan.why}`,
    ]),
    true,
  )
  return items
}
