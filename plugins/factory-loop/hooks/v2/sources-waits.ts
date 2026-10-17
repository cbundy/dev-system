// The `waits` source (docs/factory-loop/v2/SPEC.md 2.4, 4.4): for each condition a waiting record
// waits on, whether it holds, read from GitHub with no model call: an issue's state from
// `callum-flow-issue-read --json N`, a PR's from `gh pr view N --json state,mergedAt`. Each pass
// reads the conditions that are not known to hold and are due on the GitHub cadence (githubEveryMs),
// the oldest-checked first, for at most ctx.prBudget reads (none during a GitHub backoff) and none
// after a rate limit met this pass. A condition read as held stays held while a record waits on
// it. A read that failed or was skipped leaves the condition open, never held: only a read that
// shows the fact clears it.
//
// Pure parsing and one loop of reads; the cache lives in observe.ts's V2Cache.
import type { Ms } from '../types'
import { issueReadArgv, prWaitArgv } from './argv'
import type { SourceCtx } from './observe'
import type { IssueRecord, WaitCondition, WaitRead } from './types'

// waitKey: a condition's key in V2State.waits: `issue:<n>` or `pr:<n>`, as the transition note writes it.
export function waitKey(c: WaitCondition): string {
  return c.kind === 'issue-closed' ? `issue:${c.issue}` : `pr:${c.pr}`
}

// conditionsOf: the distinct conditions the waiting records wait on, by key.
export function conditionsOf(records: readonly IssueRecord[]): Map<string, WaitCondition> {
  const out = new Map<string, WaitCondition>()
  for (const r of records) if (r.state === 'waiting') for (const c of r.wait ?? []) out.set(waitKey(c), c)
  return out
}

// heldOf: whether the condition holds, from its read's output; null when the output does not say
// (a shape the reader did not give), which keeps the condition open.
export function heldOf(c: WaitCondition, stdout: string): boolean | null {
  try {
    const doc: unknown = JSON.parse(stdout)
    if (doc === null || typeof doc !== 'object') return null
    if (c.kind === 'issue-closed') {
      const state = (doc as { issue?: { state?: unknown } }).issue?.state
      return state === 'closed' ? true : state === 'open' ? false : null
    }
    const pr = doc as { state?: unknown; mergedAt?: unknown }
    if (pr.state === 'MERGED') return true
    if (typeof pr.mergedAt === 'string' && pr.mergedAt !== '') return true
    return pr.state === 'OPEN' || pr.state === 'CLOSED' ? false : null
  } catch {
    return null
  }
}

// readWaits: the new cache of reads for the conditions in use, and the reads that failed. `kept` is
// the cache of earlier passes; an entry of a condition no record waits on any more is dropped.
export async function readWaits(ctx: SourceCtx, kept: Readonly<Record<string, WaitRead>>, everyMs: Ms): Promise<{ waits: Record<string, WaitRead>; failed: string[] }> {
  const wanted = conditionsOf(ctx.records)
  const waits: Record<string, WaitRead> = {}
  for (const key of wanted.keys()) {
    const k = kept[key]
    if (k !== undefined) waits[key] = k
  }
  const due = [...wanted.entries()]
    .filter(([key]) => waits[key]?.held !== true && (waits[key] === undefined || ctx.now - waits[key].at >= everyMs))
    .sort(([ka], [kb]) => (waits[ka]?.at ?? -Infinity) - (waits[kb]?.at ?? -Infinity) || ka.localeCompare(kb))
  const failed: string[] = []
  let budget = ctx.prBudget
  for (const [key, c] of due) {
    if (budget <= 0 || ctx.limited()) break
    budget -= 1
    const argv = c.kind === 'issue-closed' ? issueReadArgv(c.issue) : prWaitArgv(ctx.rt.repo, c.pr)
    try {
      const r = await ctx.run(argv)
      const held = r.exitCode === 0 ? heldOf(c, r.stdout) : null
      if (held === null) failed.push(key)
      else waits[key] = { at: ctx.now, held }
    } catch {
      failed.push(key)
    }
  }
  return { waits, failed }
}
