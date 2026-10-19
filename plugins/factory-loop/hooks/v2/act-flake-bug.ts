// The `flake-bug` executor (docs/factory-loop/v2/SPEC.md 8.5 rule F1, appendix B): one bug for a
// flaky test per action, every write of it idempotent, so a retry or a lost ledger never files a
// second bug (the split executor's steps, act-split.ts):
// 1. the bug is found again by the marker in its body (<!-- factory-loop:flake:<hash> -->, among
//    the open issues by trusted authors), or created with it, after the `flaky` label is made;
// 2. it gets the `flaky` label and priorityLabel;
// 3. it is linked as a sub-issue of flakeEpic when one is set, unless the epic holds it already;
// 4. it is labelled ready last, once every link exists, only when F1 allowed it under the cap.
// Executors decide nothing: plan did.
import type { Executor } from '../exec'
import type { Action, ActionKind } from '../types'
import { childTitle, clip, createdIssue, failed, foundChild, idOf, linked, ok, refused } from './act-split'
import * as ARGV from './argv'
import { flakeCommentKey, flakeMarker, hiddenKey } from './keys'
import { neutralBody } from './prompts-work'
import { FLAKY_LABEL } from './sources-flakes'

const LIST_MS = 120_000
const FLAKY_COLOR = 'fbca04'
const FLAKY_DESCRIPTION = 'A test that failed and then passed on the same code'

type FlakeBugAction = Extract<Action, { kind: 'flake-bug' }>

// bugBody: the body F1 asked for, made safe (neutralBody: a closing keyword in a test name or a
// failure line closes nothing), then the bug's marker and one hidden marker for each flake it lists.
export function bugBody(a: FlakeBugAction['bug']): string {
  return `${neutralBody(a.body)}\n\n${flakeMarker(a.hash)}\n${a.flakeIds.map(i => hiddenKey(flakeCommentKey(a.hash, i))).join('\n')}\n`
}

async function bugOf(ctx: Parameters<Executor>[0], a: FlakeBugAction): Promise<{ number: number; id: number; made: boolean } | { exec: Awaited<ReturnType<Executor>> }> {
  const listed = await ok(ctx, ARGV.openIssuesArgv(), undefined, LIST_MS)
  if ('exec' in listed) return listed
  const found = foundChild(listed.out, `flake:${a.bug.hash}`)
  if (found === undefined) return { exec: failed('the open issues did not read', listed.out) }
  if (found !== null) return { ...found, made: false }
  const title = childTitle(a.bug.title)
  if (title === '') return { exec: refused(`${a.key}: the bug has no title`) }
  const label = await ok(ctx, ARGV.labelCreateArgv(ctx.rt.repo, { name: FLAKY_LABEL, color: FLAKY_COLOR, description: FLAKY_DESCRIPTION }))
  if ('exec' in label) return label
  const created = await ok(ctx, ARGV.issueCreateArgv(ctx.rt.repo, title), bugBody(a.bug))
  if ('exec' in created) return created
  const number = createdIssue(created.out, ctx.rt.repo)
  if (number === null) return { exec: failed(`gh issue create printed no issue of ${ctx.rt.repo}`, created.out) }
  const id = await idOf(ctx, number)
  return 'exec' in id ? id : { number, id: id.id, made: true }
}

const flakeBug: Executor = async (ctx, action) => {
  if (action.kind !== 'flake-bug') return refused(`the flake-bug executor got a ${action.kind} action`)
  const { repo, config } = ctx.rt
  const bug = await bugOf(ctx, action)
  if ('exec' in bug) return bug.exec
  const labelled = await ok(ctx, ARGV.flakeLabelsArgv(repo, bug.number, FLAKY_LABEL, config.priorityLabel))
  if ('exec' in labelled) return labelled.exec
  if (action.bug.epic !== null) {
    const sub = await linked(ctx, ARGV.subIssuesReadArgv(repo, action.bug.epic), bug.id, ARGV.subIssueArgv(repo, action.bug.epic, bug.id))
    if ('exec' in sub) return sub.exec
  }
  if (action.bug.ready) {
    const ready = await ok(ctx, ARGV.childReadyArgv(repo, bug.number, config.readyLabel))
    if ('exec' in ready) return ready.exec
  }
  const b = action.bug
  return {
    status: 'done',
    outcome: { kind: 'flake-bug', issue: bug.number, made: bug.made, ready: b.ready, test: b.test, flakes: b.flakes, windowDays: b.windowDays, firstFlakeAt: b.firstFlakeAt, reason: b.reason },
    summary: clip(`${bug.made ? 'filed' : 'found'} #${bug.number} for ${b.hash}${b.epic === null ? '' : ` under #${b.epic}`}${b.ready ? ', ready' : ', held by the cap'}`),
  }
}

export const executors: Partial<Record<ActionKind, Executor>> = { 'flake-bug': flakeBug }
