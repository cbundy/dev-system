// The `waits` source (docs/factory-loop/v2/SPEC.md 2.4, 4.4): for each condition a waiting record
// waits on, whether it holds, read from GitHub with no model call: an issue's state from
// `fabriek-issue-read --json N`, a PR's from `gh pr view N --json state,mergedAt`. Each pass
// reads the conditions that are not known to hold and are due on the GitHub cadence (githubEveryMs),
// the oldest-checked first, for at most ctx.prBudget reads (none during a GitHub backoff) and none
// after a rate limit met this pass. A condition read as held stays held while a record waits on
// it. A tag-contains condition is read with the compare API against the newest release tag of its
// repo (ctx.tag for the loop's own, ctx.tags[repo] for another), once per tag: a not-held result is
// read again only when that tag changes. An issue-closed condition naming a repo is read with the
// reader's CALLUM_FLOW_REPO set to it. A read that
// failed or was skipped leaves the condition open, never held: only a read that
// shows the fact clears it. A failed read, or a tag condition whose repo has no release tag, starts
// the condition's unread time (V2State.waitsUnread); a read that says held or not held, or a stored
// read against a known tag, clears it, and a skipped read leaves it as it was.
//
// Pure parsing and one loop of reads; the cache lives in observe.ts's V2Cache.
import type { Ms } from '../types'
import { compareArgv, issueReadArgv, prWaitArgv } from './argv'
import type { SourceCtx } from './observe'
import type { IssueRecord, WaitCondition, WaitRead, WaitUnread } from './types'

// waitKey: a condition's key in V2State.waits: `issue:<n>`, `pr:<n>` or `tag:<sha>`; with a `repo`,
// `issue:<repo>#<n>` or `tag:<repo>@<sha>`, so a foreign and a local condition never share an entry.
export function waitKey(c: WaitCondition): string {
  if (c.kind === 'pr-merged') return `pr:${c.pr}`
  if (c.kind === 'issue-closed') return c.repo === undefined ? `issue:${c.issue}` : `issue:${c.repo}#${c.issue}`
  return c.repo === undefined ? `tag:${c.sha}` : `tag:${c.repo}@${c.sha}`
}

// tagOf: the newest release tag a tag-contains condition is compared against: the loop's own
// (ctx.tag), or its repo's (ctx.tags); null when none is known.
function tagOf(ctx: SourceCtx, c: Extract<WaitCondition, { kind: 'tag-contains' }>): string | null {
  return c.repo === undefined ? ctx.tag : ctx.tags[c.repo] ?? null
}

// conditionsOf: the distinct conditions the waiting records wait on, by key.
export function conditionsOf(records: readonly IssueRecord[]): Map<string, WaitCondition> {
  const out = new Map<string, WaitCondition>()
  for (const r of records) if (r.state === 'waiting') for (const c of r.wait ?? []) out.set(waitKey(c), c)
  return out
}

// parseCompareStatus (here, not in parse.ts: the planner reaches this module and may import
// hooks/v2/ alone): the status line `gh api repos/R/compare/<tag>...<sha> --jq .status` prints, read as whether the tag contains the sha: `behind` (the sha is an ancestor of the tag) and
// `identical` hold, `ahead` and `diverged` do not; null for anything else (the read says nothing).
export function parseCompareStatus(text: string): boolean | null {
  const s = text.trim()
  return s === 'behind' || s === 'identical' ? true : s === 'ahead' || s === 'diverged' ? false : null
}

// heldOf: whether the condition holds, from its read's output; null when the output does not say
// (a shape the reader did not give), which keeps the condition open.
export function heldOf(c: WaitCondition, stdout: string): boolean | null {
  if (c.kind === 'tag-contains') return parseCompareStatus(stdout)
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

// readWaits: the new cache of reads for the conditions in use, the reads that failed, and the
// conditions that cannot be read (`unread`). `kept` and `keptUnread` are the caches of earlier
// passes; an entry of a condition no record waits on any more is dropped.
export async function readWaits(
  ctx: SourceCtx,
  kept: Readonly<Record<string, WaitRead>>,
  everyMs: Ms,
  keptUnread: Readonly<Record<string, WaitUnread>> = {},
): Promise<{ waits: Record<string, WaitRead>; failed: string[]; unread: Record<string, WaitUnread> }> {
  const wanted = conditionsOf(ctx.records)
  const waits: Record<string, WaitRead> = {}
  const unread: Record<string, WaitUnread> = {}
  for (const key of wanted.keys()) {
    const k = kept[key]
    if (k !== undefined) waits[key] = k
    const u = keptUnread[key]
    if (u !== undefined) unread[key] = u
  }
  // markUnread: the unread time starts at the first pass of a kind and a change of why restarts it
  const markUnread = (key: string, why: WaitUnread['why']): void => {
    if (unread[key]?.why !== why) unread[key] = { since: ctx.now, why }
  }
  for (const [key, c] of wanted) {
    if (waits[key]?.held === true) delete unread[key]
    else if (c.kind === 'tag-contains') {
      const tag = tagOf(ctx, c)
      if (tag === null) markUnread(key, 'no-release')
      else if (waits[key]?.tag === tag) delete unread[key]
    }
  }
  const due = [...wanted.entries()]
    .filter(([key, c]) => {
      const w = waits[key]
      if (w?.held === true) return false
      // a tag condition is read once per tag of its repo; with no tag known (none released yet, or its read failed) it stays open
      if (c.kind === 'tag-contains') {
        const tag = tagOf(ctx, c)
        return tag !== null && w?.tag !== tag
      }
      return w === undefined || ctx.now - w.at >= everyMs
    })
    .sort(([ka], [kb]) => (waits[ka]?.at ?? -Infinity) - (waits[kb]?.at ?? -Infinity) || ka.localeCompare(kb))
  const failed: string[] = []
  let budget = ctx.prBudget
  for (const [key, c] of due) {
    if (budget <= 0 || ctx.limited()) break
    budget -= 1
    const tag = c.kind === 'tag-contains' ? tagOf(ctx, c) : null
    const argv = c.kind === 'issue-closed' ? issueReadArgv(c.issue) : c.kind === 'pr-merged' ? prWaitArgv(ctx.rt.repo, c.pr) : compareArgv(c.repo ?? ctx.rt.repo, tag ?? '', c.sha)
    // an issue of another repo is read through the reader pointed at that repo
    const env = c.kind === 'issue-closed' && c.repo !== undefined ? { ...ctx.rt.env, FABRIEK_REPO: c.repo, CALLUM_FLOW_REPO: c.repo } : undefined
    try {
      const r = await ctx.run(argv, undefined, undefined, env)
      const held = r.exitCode === 0 ? heldOf(c, r.stdout) : null
      if (held === null) {
        failed.push(key)
        markUnread(key, 'read-failed')
      } else {
        waits[key] = c.kind === 'tag-contains' ? { at: ctx.now, held, tag: tag ?? undefined } : { at: ctx.now, held }
        delete unread[key]
      }
    } catch {
      failed.push(key)
      markUnread(key, 'read-failed')
    }
  }
  return { waits, failed, unread }
}
