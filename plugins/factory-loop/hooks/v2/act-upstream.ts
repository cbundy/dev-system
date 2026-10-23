// The `upstream` executor (docs/factory-loop/v2/SPEC.md 8.7, appendix B): a design's request for a
// change in another repo of the factory's own, as one issue there. The loop's only write to a repo
// other than its own, so it is confined: the target must be in UPSTREAM_REPOS, the issue is created
// with `gh issue create --repo <target>` and nothing else is written, and the write is idempotent, so
// a retry or a lost ledger never files a second issue (the split executor's steps, act-split.ts):
// 1. the target's open issues are read (the reader pointed at the target by CALLUM_FLOW_REPO);
// 2. the issue carrying this request's marker (<!-- factory-loop:upstream:<own repo>#<N>/l<L>/s<seq> -->)
//    is found again, or created with it. No label is added.
// Executors decide nothing: plan did.
import type { Executor } from '../exec'
import type { Action, ActionKind } from '../types'
import { childTitle, clip, createdIssue, failed, foundChild, ok, refused } from './act-split'
import * as ARGV from './argv'
import { neutralBody } from './prompts-work'
import { UPSTREAM_REPOS } from './upstream-answer.mjs'

const LIST_MS = 120_000

type UpstreamAction = Extract<Action, { kind: 'upstream' }>

// upstreamBody: the body the designer wrote, made safe (neutralBody), then a line naming the issue it
// was raised from (no closing keyword) and the request kind, then the marker.
export function upstreamBody(a: UpstreamAction, own: string): string {
  return `${neutralBody(a.body)}\n\nRaised by the factory loop from ${own}#${a.issue ?? 0} (${a.request}).\n\n${a.marker}\n`
}

const upstream: Executor = async (ctx, action) => {
  if (action.kind !== 'upstream') return refused(`the upstream executor got a ${action.kind} action`)
  const target = action.target.toLowerCase()
  if (!UPSTREAM_REPOS.includes(target)) return refused(`${action.target} is not a repo an upstream request may go to`)
  if (action.issue === null) return refused('the upstream action names no issue')
  const listed = await ok(ctx, ARGV.openIssuesArgv(), undefined, LIST_MS, { CALLUM_FLOW_REPO: target })
  if ('exec' in listed) return listed.exec
  const marker = action.marker.replace(/^<!-- factory-loop:/, '').replace(/ -->$/, '')
  const found = foundChild(listed.out, marker)
  if (found === undefined) return failed(`the open issues of ${target} did not read`, listed.out)
  if (found !== null) {
    return { status: 'done', outcome: { kind: 'upstream', repo: target, issue: found.number, made: false }, summary: clip(`found ${target}#${found.number} for ${marker}`) }
  }
  const title = childTitle(action.title)
  if (title === '') return refused(`${action.key}: the request has no title`)
  const created = await ok(ctx, ARGV.issueCreateArgv(target, title), upstreamBody(action, ctx.rt.repo))
  if ('exec' in created) return created.exec
  const number = createdIssue(created.out, target)
  if (number === null) return failed(`gh issue create printed no issue of ${target}`, created.out)
  return { status: 'done', outcome: { kind: 'upstream', repo: target, issue: number, made: true }, summary: clip(`raised ${target}#${number} (${action.request}) from #${action.issue}`) }
}

export const executors: Partial<Record<ActionKind, Executor>> = { upstream }
