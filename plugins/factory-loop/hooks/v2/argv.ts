// Every command v2's executors and sources run (docs/factory-loop/v2/SPEC.md appendix B), one
// builder per argv shape, so the safety nets allow v2's writes deliberately, one argv each, and
// keep every other ban (FM coupling C10): tests/factory-loop-safety.test.js allows a banned word
// only on its own line here, and plugins/factory-loop/tests/safety.test.ts runs every builder
// through its bans. A v2 executor builds its commands here, never from literals of its own. Every
// gh command carries --repo, but `gh api`, whose repo is in its path. Pure.
import type { FactoryLabel } from './types'

// --- labels (3.4) -----------------------------------------------------------------------------------

// The state's label on, the other six off, in one call.
export function labelSetArgv(repo: string, issue: number, add: FactoryLabel, remove: readonly FactoryLabel[]): string[] {
  const argv = ['gh', 'issue', 'edit', String(issue), '--repo', repo, '--add-label', add]
  return remove.length === 0 ? argv : [...argv, '--remove-label', remove.join(',')]
}

// Every factory label off (a closed record), or a release's labels (6.4).
export function labelClearArgv(repo: string, issue: number, remove: readonly string[]): string[] {
  return ['gh', 'issue', 'edit', String(issue), '--repo', repo, '--remove-label', remove.join(',')]
}

// One of the seven, made or updated (op ensure).
export function labelCreateArgv(repo: string, label: { name: FactoryLabel; color: string; description: string }): string[] {
  return ['gh', 'label', 'create', label.name, '--repo', repo, '--color', label.color, '--description', label.description, '--force']
}

// --- comments (4.5, 8.3) ------------------------------------------------------------------------------

// A comment's body goes on stdin; it carries its hidden key, found again by the read below.
export function issueCommentArgv(repo: string, issue: number): string[] {
  return ['gh', 'issue', 'comment', String(issue), '--repo', repo, '--body-file', '-']
}

export function prCommentArgv(repo: string, pr: number): string[] {
  return ['gh', 'pr', 'comment', String(pr), '--repo', repo, '--body-file', '-']
}

// The trusted comments of an issue or a PR, through the reader (CLAUDE.md: GitHub text is read with
// callum-flow-issue-read only).
export function commentsReadArgv(on: 'issue' | 'pr', n: number): string[] {
  return on === 'issue' ? ['callum-flow-issue-read', '--json', String(n), '--comments'] : ['callum-flow-issue-read', '--json', '--pr', String(n), '--comments']
}

// --- the PR (3.5, 8.1) --------------------------------------------------------------------------------

// The open PRs, once at a claim, for adoption. gh lists 30 by default; the limit is set well above
// any count of open PRs, so the issue's PR is never cut off the list (3.5).
export const OPEN_PRS_LIMIT = 1000

export function openPrsArgv(repo: string): string[] {
  return ['gh', 'pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(OPEN_PRS_LIMIT), '--json', 'number,headRefName']
}

// The branch's PRs, every state.
export function branchPrsArgv(repo: string, branch: string): string[] {
  return ['gh', 'pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'number,state,headRefOid']
}

export function prReopenArgv(repo: string, pr: number): string[] {
  return ['gh', 'pr', 'reopen', String(pr), '--repo', repo]
}

// The loop's own body goes on stdin.
export function prCreateArgv(repo: string, base: string, branch: string, title: string): string[] {
  return ['gh', 'pr', 'create', '--repo', repo, '--base', base, '--head', branch, '--title', title, '--body-file', '-']
}

// The loop's own body, written over the PR's, on stdin.
export function prBodyArgv(repo: string, pr: number): string[] {
  return ['gh', 'pr', 'edit', String(pr), '--repo', repo, '--body-file', '-']
}

// A PR's state, merge, closedAt, head, mergeable state and author, through the reader.
export function prReadArgv(pr: number): string[] {
  return ['callum-flow-issue-read', '--json', '--pr', String(pr)]
}

// --- a split's children (8.7) -------------------------------------------------------------------------

// The child's body, with its hidden key, goes on stdin.
export function issueCreateArgv(repo: string, title: string): string[] {
  return ['gh', 'issue', 'create', '--repo', repo, '--title', title, '--body-file', '-']
}

// The child under its parent, by the child's issue id (not its number).
export function subIssueArgv(repo: string, parent: number, childId: number): string[] {
  return ['gh', 'api', '--method', 'POST', `repos/${repo}/issues/${parent}/sub_issues`, '-F', `sub_issue_id=${childId}`]
}

// The child blocked by a sibling, by the sibling's issue id.
export function blockedByArgv(repo: string, issue: number, blockerId: number): string[] {
  return ['gh', 'api', '--method', 'POST', `repos/${repo}/issues/${issue}/dependencies/blocked_by`, '-F', `issue_id=${blockerId}`]
}

// A ready child, labelled so S1 can claim it: the one ready label the loop ever adds.
export function childReadyArgv(repo: string, child: number, readyLabel: string): string[] {
  return ['gh', 'issue', 'edit', String(child), '--repo', repo, '--add-label', readyLabel]
}

// --- CI (8.5) ----------------------------------------------------------------------------------------------

// The head's check runs; the run id is in each one's link.
export function prChecksArgv(repo: string, pr: number): string[] {
  return ['gh', 'pr', 'checks', String(pr), '--repo', repo, '--json', 'name,state,bucket,startedAt,completedAt,link']
}

// The one re-run of a failed or cancelled check per round: its failed jobs only.
export function runRerunArgv(repo: string, runId: string): string[] {
  return ['gh', 'run', 'rerun', runId, '--failed', '--repo', repo]
}

// --- the merge queue (9) ---------------------------------------------------------------------------------

// GitHub merges main into the head's branch; no history is rewritten.
export function updateBranchArgv(repo: string, pr: number): string[] {
  return ['gh', 'pr', 'update-branch', String(pr), '--repo', repo]
}

// The merge, through the guard, on the approved patch only.
export function queueMergeArgv(pr: number, patch: string): string[] {
  return ['callum-flow-merge', String(pr), '--patch', patch]
}

// A head's patch id against the base (8.4).
export function patchIdArgv(ref: string, base: string): string[] {
  return ['callum-flow-patch-id', ref, base]
}

// --- origin (10.8) --------------------------------------------------------------------------------------------

// A writer's branch on origin, read directly.
export function lsRemoteArgv(branch: string): string[] {
  return ['git', 'ls-remote', 'origin', `refs/heads/${branch}`]
}

// --- claims (3.5, 4.1) -------------------------------------------------------------------------------------------

export function claimArgv(issue: number): string[] {
  return ['callum-flow-claim', String(issue)]
}

// The records' claims renewed, by number (H1).
export function heartbeatArgv(issues: readonly number[]): string[] {
  return ['callum-flow-claim', '--heartbeat', ...issues.map(String)]
}

// --- slots (10.1, 10.2, 10.8) -----------------------------------------------------------------------------------

export function slotLeaseArgv(issue: number, life: string): string[] {
  return ['factory-slot', 'lease', String(issue), life]
}

// The step marker goes as one JSON argument.
export function slotPrepareArgv(path: string, lease: string, branch: string, marker: string): string[] {
  return ['factory-slot', 'prepare', path, lease, branch, marker]
}

// Every process whose working directory is in the slot: SIGTERM, then SIGKILL after 5 s.
export function slotKillArgv(path: string): string[] {
  return ['factory-slot', 'kill', path]
}

// The loop dir is where the slot's leftovers are saved before it goes back (10.1, 10.2).
export function slotFreeArgv(path: string, lease: string, loopDir: string): string[] {
  return ['factory-slot', 'free', path, lease, loopDir]
}
