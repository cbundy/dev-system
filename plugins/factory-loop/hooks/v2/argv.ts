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

// R1's release in one call (6.4): `ready` on (requeue) or factory:rejected on (reject), and the
// seven state labels off.
export function labelReleaseArgv(repo: string, issue: number, add: string, remove: readonly FactoryLabel[]): string[] {
  return ['gh', 'issue', 'edit', String(issue), '--repo', repo, '--add-label', add, '--remove-label', remove.join(',')]
}

// One of the eight, made or updated (op ensure).
export function labelCreateArgv(repo: string, label: { name: string; color: string; description: string }): string[] {
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

// The open PRs with the fields the release hold reads (sources-release.ts): head branch, creation
// time and whether the PR is from a fork.
export function releasePrsArgv(repo: string): string[] {
  return ['gh', 'pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(OPEN_PRS_LIMIT), '--json', 'number,headRefName,createdAt,isCrossRepository']
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

// A PR's state and merge time, for a wait on its merge (sources-waits.ts): no model, no reader.
export function prWaitArgv(repo: string, pr: number): string[] {
  return ['gh', 'pr', 'view', String(pr), '--repo', repo, '--json', 'state,mergedAt']
}

// Whether a release tag contains a commit: the compare status of the sha against the tag
// (behind or identical: the tag carries it).
export function compareArgv(repo: string, tag: string, sha: string): string[] {
  return ['gh', 'api', `repos/${repo}/compare/${tag}...${sha}`, '--jq', '.status']
}

// A PR's state, merge, closedAt, head, mergeable state and author, through the reader.
export function prReadArgv(pr: number): string[] {
  return ['callum-flow-issue-read', '--json', '--pr', String(pr)]
}

// The issue's Rollout (merge, run-it or keep-open), which the PR body's linkage follows (8.1).
export function rolloutArgv(issue: number): string[] {
  return ['callum-flow-rollout', String(issue)]
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

// A flake bug's two labels, each add idempotent: the flaky label and the repo's priority label.
export function flakeLabelsArgv(repo: string, issue: number, flaky: string, priority: string): string[] {
  return ['gh', 'issue', 'edit', String(issue), '--repo', repo, '--add-label', flaky, '--add-label', priority]
}

// The open issues by trusted authors, whole, through the reader: a child made before a retry is
// found again by the hidden key in its body.
export function openIssuesArgv(): string[] {
  return ['callum-flow-issue-read', '--json', '--list', '--state', 'open']
}

// One issue, through the reader: its REST id, which the sub-issue and dependency links take.
export function issueReadArgv(issue: number): string[] {
  return ['callum-flow-issue-read', '--json', String(issue)]
}

// The ids of the parent's sub-issues, so a link made before a retry is not made twice.
export function subIssuesReadArgv(repo: string, parent: number): string[] {
  return ['gh', 'api', `repos/${repo}/issues/${parent}/sub_issues`, '--paginate', '--jq', '.[].id']
}

// The number and state of each of the parent's sub-issues, one `<number> <state>` a line.
export function subIssueStatesArgv(repo: string, parent: number): string[] {
  return ['gh', 'api', `repos/${repo}/issues/${parent}/sub_issues`, '--paginate', '--jq', '.[] | "\\(.number) \\(.state)"']
}

// A split's tracker closed as completed once every sub-issue is closed (the comment names them).
export function trackerCloseArgv(repo: string, parent: number, comment: string): string[] {
  return ['gh', 'issue', 'close', String(parent), '--repo', repo, '--reason', 'completed', '--comment', comment]
}

// The ids of the issues a child is blocked by, likewise.
export function blockersReadArgv(repo: string, issue: number): string[] {
  return ['gh', 'api', `repos/${repo}/issues/${issue}/dependencies/blocked_by`, '--paginate', '--jq', '.[].id']
}

// --- CI (8.5) ----------------------------------------------------------------------------------------------

// The head's check runs; the run id is in each one's link.
export function prChecksArgv(repo: string, pr: number): string[] {
  return ['gh', 'pr', 'checks', String(pr), '--repo', repo, '--json', 'name,state,bucket,startedAt,completedAt,link']
}

// The head's workflow runs: a run whose jobs have no check run yet (queued on a concurrency group)
// is in no `gh pr checks` view, so the loop reads the runs too (sources-prs.ts runsOf).
export function prRunsArgv(repo: string, head: string): string[] {
  return ['gh', 'api', `repos/${repo}/actions/runs?head_sha=${head}&per_page=100`]
}

// --- the default branch's state (sources-main.ts, 2.4) ---------------------------------------------------------

// The repo's default branch name.
export function defaultBranchArgv(repo: string): string[] {
  return ['gh', 'api', `repos/${repo}`, '--jq', '.default_branch']
}

// The sha the branch points at.
export function branchHeadArgv(repo: string, branch: string): string[] {
  return ['gh', 'api', `repos/${repo}/commits/${branch}`, '--jq', '.sha']
}

// The pull requests a commit came from.
export function commitPullsArgv(repo: string, head: string): string[] {
  return ['gh', 'api', `repos/${repo}/commits/${head}/pulls`]
}

// The repo's workflows (the caller keeps the active ones).
export function workflowsArgv(repo: string): string[] {
  return ['gh', 'api', `repos/${repo}/actions/workflows?per_page=100`]
}

// A workflow's newest runs on the branch.
export function workflowRunsArgv(repo: string, workflow: number, branch: string): string[] {
  return ['gh', 'api', `repos/${repo}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&per_page=10`]
}

// The deployments of a commit.
export function deploymentsArgv(repo: string, head: string): string[] {
  return ['gh', 'api', `repos/${repo}/deployments?sha=${head}&per_page=100`]
}

// A deployment's newest status.
export function deploymentStatusArgv(repo: string, deployment: number): string[] {
  return ['gh', 'api', `repos/${repo}/deployments/${deployment}/statuses?per_page=1`]
}

// The one re-run of a failed or cancelled check per round: its failed jobs only.
export function runRerunArgv(repo: string, runId: string): string[] {
  return ['gh', 'run', 'rerun', runId, '--failed', '--repo', repo]
}

// The failed jobs' log of a run (flake-names.ts reads the job and test names from it), read before the re-run.
export function runViewLogFailedArgv(repo: string, runId: string): string[] {
  return ['gh', 'run', 'view', runId, '--log-failed', '--repo', repo]
}

// --- the merge queue (9) ---------------------------------------------------------------------------------

// GitHub merges main into the head's branch; no history is rewritten.
export function updateBranchArgv(repo: string, pr: number): string[] {
  return ['gh', 'pr', 'update-branch', String(pr), '--repo', repo]
}

// The merge, through the guard, on the approved patch only. The record's issue goes with it, so
// the guard never reads the issue from the branch name (9.3).
export function queueMergeArgv(pr: number, patch: string, issue: number): string[] {
  return ['callum-flow-merge', String(pr), '--patch', patch, '--issue', String(issue)]
}

// A head's patch id against the base (8.4).
export function patchIdArgv(ref: string, base: string): string[] {
  return ['callum-flow-patch-id', ref, base]
}

// The pause between two reads of a PR whose update GitHub applies in the background (9.2): the
// executors have no timer of their own.
export function pollPauseArgv(seconds: number): string[] {
  return ['sleep', String(seconds)]
}

// --- origin (10.8) --------------------------------------------------------------------------------------------

// A writer's branch on origin, read directly.
export function lsRemoteArgv(branch: string): string[] {
  return ['git', 'ls-remote', 'origin', `refs/heads/${branch}`]
}

// Origin's commits brought into the slot, so the head read above can be compared with the base
// and with the head the agent answered. It moves no branch and touches no tree.
export function fetchArgv(): string[] {
  return ['git', 'fetch', '--quiet', 'origin']
}

// How many commits the head has beyond origin's default branch.
export function beyondBaseArgv(base: string, head: string): string[] {
  return ['git', 'rev-list', '--count', `origin/${base}..${head}`]
}

// A PR's merge commit and head, as GitHub reports them: two shas on one line, the merge commit
// empty when the PR is not merged.
export function prMergeArgv(repo: string, pr: number): string[] {
  return ['gh', 'pr', 'view', String(pr), '--repo', repo, '--json', 'mergeCommit,headRefOid', '--jq', '[.mergeCommit.oid // "-", .headRefOid] | join(" ")']
}

// Whether a commit is the head or one of its ancestors: exit 0 yes, 1 no.
export function isAncestorArgv(commit: string, head: string): string[] {
  return ['git', 'merge-base', '--is-ancestor', commit, head]
}

// --- the builder's model (7.1) ---------------------------------------------------------------------

// The model the builder runs on; the tool logs `implementer_routed` itself.
export function implementerRouteArgv(issue: number): string[] {
  return ['callum-flow-implementer-route', String(issue)]
}

// --- the designer's model (7.1) ---------------------------------------------------------------------

// The model the designer runs on; the tool logs `designer_routed` itself.
export function designerRouteArgv(issue: number): string[] {
  return ['callum-flow-designer-route', String(issue)]
}

// The loop's own `designer_routed`, written when the route could not run.
export function designerFallbackArgv(issue: number, model: string): string[] {
  return [
    'callum-flow-event',
    '--type',
    'designer_routed',
    '--issue',
    String(issue),
    '--data',
    JSON.stringify({ model, reason: 'fallback', bucket: null, sonnet_pct: null }),
  ]
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
// keepScratch: the life's scratch folders stay (a parked issue's life, which a resume continues).
export function slotFreeArgv(path: string, lease: string, loopDir: string, keepScratch = false): string[] {
  return ['factory-slot', 'free', path, lease, loopDir, ...(keepScratch ? ['--keep-scratch'] : [])]
}
