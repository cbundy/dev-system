// The `close-tracker` executor (docs/factory-loop/v2/SPEC.md 8.7, appendix B): a split's parent is a
// tracker until every sub-issue is closed, then the loop closes it (owner, 2026-10-18, #946), so it
// stops blocking what it blocks. It runs when a split child's merge is done (rules-entry.ts), reads
// the truth live and writes at most once:
// 1. the issue (the merged child) must show closed, else the check fails retryably (the close-on-merge
//    lags, or an epic base's close is yet to show);
// 2. its parent is found only by the hidden split key in its trusted body; none: done, nothing closed;
// 3. a parent already closed: done; a parent with any sub-issue open (whatever the close reason of the
//    others): done, left open, the open ones named;
// 4. otherwise the parent is closed as completed with a comment, and the `closed` event is logged.
// Executors decide nothing: plan did.
import { commandFailure, NO_EXIT } from '../act-cli'
import type { Exec, ExecCtx, Executor, RunResult } from '../exec'
import type { Action, ActionKind } from '../types'
import * as ARGV from './argv'
import { blockerOf } from './act-split'
import { closedData } from './event-native'

const SEC = 1000
const GH_MS = 60 * SEC
const SUMMARY_MAX = 200

// The hidden key a split child's body carries (act-split.ts childBody): the parent, the life, the seq
// and the child's key.
const CHILD_KEY = /<!-- factory-loop:i(\d+)\/l[0-9a-z]+\/s\d+\/child\/[a-z0-9-]+ -->/

// splitParentOf: the parent named by the hidden key of the body of `callum-flow-issue-read --json <n>`;
// null when the body has none; undefined when the read is not in its shape.
export function splitParentOf(json: string): number | null | undefined {
  try {
    const body = (JSON.parse(json) as { issue?: { body?: unknown } }).issue?.body
    if (body === undefined || body === null) return null
    if (typeof body !== 'string') return undefined
    const m = CHILD_KEY.exec(body)
    return m?.[1] === undefined ? null : Number(m[1])
  } catch {
    return undefined
  }
}

// subIssueStates: the `<number> <state>` lines of the sub-issue read; null when a line is not one.
export function subIssueStates(stdout: string): { number: number; open: boolean }[] | null {
  const out: { number: number; open: boolean }[] = []
  for (const line of stdout.split('\n').map(l => l.trim()).filter(l => l !== '')) {
    const m = /^(\d+) (open|closed)$/.exec(line)
    if (m?.[1] === undefined) return null
    out.push({ number: Number(m[1]), open: m[2] === 'open' })
  }
  return out
}

// trackerComment: the comment on the closed tracker. No closing keyword: the sub-issues are listed
// bare, never after a keyword.
export function trackerComment(subs: readonly number[]): string {
  return `Every sub-issue of this split is finished (${subs.map(n => `#${n}`).join(' ')}), so the factory loop closes this tracker.`
}

async function ok(ctx: ExecCtx, argv: string[]): Promise<{ out: string } | { exec: Exec }> {
  let r: RunResult
  try {
    r = await ctx.cmd(argv, { timeoutMs: GH_MS })
  } catch (err) {
    return { exec: { status: 'failed', outcome: { kind: 'cli', exit: NO_EXIT, detail: message(err).slice(0, 2000) }, summary: clip(`${argv.slice(0, 3).join(' ')}: ${message(err)}`) } }
  }
  return r.exitCode === 0 ? { out: r.stdout } : { exec: commandFailure(argv, r) }
}

function failed(summary: string, detail: string): Exec {
  return { status: 'failed', outcome: { kind: 'cli', exit: 0, detail: detail.slice(0, 2000) }, summary: clip(summary) }
}

function done(parent: number | null, closed: boolean, open: number[], summary: string): Exec {
  return { status: 'done', outcome: { kind: 'close-tracker', parent, closed, open }, summary: clip(summary) }
}

const closeTracker: Executor = async (ctx, action: Action) => {
  if (action.kind !== 'close-tracker') return { status: 'failed', summary: clip(`refused: the close-tracker executor got a ${action.kind} action`), noRetry: true }
  if (action.issue === null) return { status: 'failed', summary: 'refused: the close-tracker action names no issue', noRetry: true }
  const repo = ctx.rt.repo
  const n = action.issue
  const own = await ok(ctx, ARGV.issueReadArgv(n))
  if ('exec' in own) return own.exec
  const self = blockerOf(own.out)
  if (self === null) return failed(`the state of #${n} did not read`, own.out)
  if (self.open) return failed(`#${n} is still open`, own.out)
  const parent = splitParentOf(own.out)
  if (parent === undefined) return failed(`the body of #${n} did not read`, own.out)
  if (parent === null) return done(null, false, [], `#${n} is no split child, nothing to close`)
  const read = await ok(ctx, ARGV.issueReadArgv(parent))
  if ('exec' in read) return read.exec
  const p = blockerOf(read.out)
  if (p === null) return failed(`the state of #${parent} did not read`, read.out)
  if (p.pr) return { status: 'failed', summary: clip(`refused: #${parent} is a pull request, not an issue`), noRetry: true }
  if (!p.open) return done(parent, false, [], `#${parent} is already closed`)
  const listed = await ok(ctx, ARGV.subIssueStatesArgv(repo, parent))
  if ('exec' in listed) return listed.exec
  const subs = subIssueStates(listed.out)
  if (subs === null) return failed(`the sub-issues of #${parent} did not read`, listed.out)
  const open = subs.filter(s => s.open).map(s => s.number)
  // a tracker with no sub-issue read is never closed: the links are not what plan expected
  if (subs.length === 0) return done(parent, false, [], `kept #${parent} open: it lists no sub-issue`)
  if (open.length > 0) return done(parent, false, open, `kept #${parent} open: ${open.map(x => `#${x}`).join(' ')} open`)
  const numbers = subs.map(s => s.number)
  const closed = await ok(ctx, ARGV.trackerCloseArgv(repo, parent, trackerComment(numbers)))
  if ('exec' in closed) return closed.exec
  // best effort: the close is made, and a retry must not lose the chain upward; the sweep logs the close too
  let logged = ''
  try {
    await ctx.event('closed', closedData('completed'), { issue: parent })
  } catch (err) {
    logged = ` (the closed event did not log: ${message(err)})`
  }
  return done(parent, true, [], `closing #${parent}: ${numbers.map(x => `#${x}`).join(' ')} done${logged}`)
}

export const executors: Partial<Record<ActionKind, Executor>> = { 'close-tracker': closeTracker }

function clip(text: string): string {
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 3)}...` : text
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
