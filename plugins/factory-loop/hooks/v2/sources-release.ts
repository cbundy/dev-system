// The `releasePrs` source (docs/factory-loop/v2/SPEC.md 2.4, 9.1): the open release bump PRs, which
// hold the merge queue's merges for a bounded window from their creation. A bump PR is an open PR
// of this repo (not a fork's) whose head branch starts with the repo's `releaseBranchPrefix`. It is
// read with one `gh pr list` every prEveryMs, and only while the prefix is set, the hold is above 0
// and some record is in merge-queue; none during a GitHub backoff or after a rate limit. A read that
// failed keeps the last reading, which the window still bounds (the PR's own createdAt), and shows
// in `sources`. A PR that left the list is read once with `gh pr view --json state,mergedAt`, for how
// its hold ended (merged or closed): the PRs to read are those the last reading listed and those
// whose `hold/release/pr<n>/start` the ledger holds with no end, so a restart loses nothing.
//
// Pure parsing and a few reads; the cache lives in observe.ts's V2Cache.
import type { LedgerEntry, Ms, Source } from '../types'
import { prWaitArgv, releasePrsArgv } from './argv'
import { interventionKey } from './keys'
import type { SourceCtx } from './observe'
import { releaseFact, startedOpen } from './rules-release-hold'
import type { ReleasePr, ReleasePrsRead } from './types'

// What the cache keeps: the reading, when it was taken, and the PRs that left the list whose end
// is not read yet.
export type ReleaseCache = ReleasePrsRead & { at: Ms | null; gone: number[] }
export const EMPTY_RELEASE: ReleaseCache = { prs: [], left: {}, at: null, gone: [] }

// parseReleasePrs: the open same-repo PRs whose head branch starts with the prefix, from the list
// `gh pr list --json number,headRefName,createdAt,isCrossRepository` prints; null when the output
// is not that list.
export function parseReleasePrs(stdout: string, prefix: string): ReleasePr[] | null {
  try {
    const doc: unknown = JSON.parse(stdout)
    if (!Array.isArray(doc)) return null
    const out: ReleasePr[] = []
    for (const x of doc as unknown[]) {
      if (x === null || typeof x !== 'object') return null
      const p = x as { number?: unknown; headRefName?: unknown; createdAt?: unknown; isCrossRepository?: unknown }
      if (typeof p.number !== 'number' || typeof p.headRefName !== 'string' || typeof p.createdAt !== 'string') return null
      const createdAt = Date.parse(p.createdAt)
      if (!Number.isFinite(createdAt)) return null
      if (p.isCrossRepository === false && p.headRefName.startsWith(prefix)) out.push({ pr: p.number, branch: p.headRefName, createdAt })
    }
    return out
  } catch {
    return null
  }
}

// endOf: how a PR that left the list ended, from `gh pr view --json state,mergedAt`; null when the
// output does not say (or the PR is still open).
export function endOf(stdout: string): 'merged' | 'closed' | null {
  try {
    const doc: unknown = JSON.parse(stdout)
    if (doc === null || typeof doc !== 'object') return null
    const pr = doc as { state?: unknown; mergedAt?: unknown }
    if (pr.state === 'MERGED' || (typeof pr.mergedAt === 'string' && pr.mergedAt !== '')) return 'merged'
    return pr.state === 'CLOSED' ? 'closed' : null
  } catch {
    return null
  }
}

// readReleasePrs: the new cache, and the source's state.
export async function readReleasePrs(ctx: SourceCtx, kept: ReleaseCache): Promise<{ read: ReleaseCache; source: Source }> {
  const { rt, now } = ctx
  const prefix = rt.config.releaseBranchPrefix
  if (prefix === null || rt.config.releaseHoldMs <= 0 || !ctx.records.some(r => r.state === 'merge-queue')) return { read: EMPTY_RELEASE, source: { ok: true, at: now } }
  const s = ctx.state
  const blocked = (s.githubBackoffUntil !== null && now < s.githubBackoffUntil) || ctx.limited()
  const due = kept.at === null || now - kept.at >= rt.config.prEveryMs
  let read = kept
  let source: Source = { ok: true, at: kept.at ?? now }
  if (blocked || !due) return { read: pruned(ctx, read), source }
  try {
    const r = await ctx.run(releasePrsArgv(rt.repo))
    const prs = r.exitCode === 0 ? parseReleasePrs(r.stdout, prefix) : null
    if (prs === null) source = { ok: false, at: null, error: r.exitCode === 0 ? 'the open PR list was not understood' : `gh pr list exited ${r.exitCode}` }
    else {
      const listed = new Set(prs.map(p => p.pr))
      const gone = [...new Set([...kept.gone, ...kept.prs.map(p => p.pr), ...startedOpen(s.ledger)])].filter(n => !listed.has(n) && kept.left[n] === undefined)
      read = { prs, left: kept.left, at: now, gone }
      source = { ok: true, at: now }
    }
  } catch (e) {
    source = { ok: false, at: null, error: e instanceof Error ? e.message : String(e) }
  }
  if (read === kept) return { read: pruned(ctx, kept), source }
  // the state of each PR that left the list, once; a read that fails is tried again on a later pass
  const left = { ...read.left }
  const gone: number[] = []
  for (const n of read.gone) {
    if (ctx.limited()) {
      gone.push(n)
      continue
    }
    let end: 'merged' | 'closed' | null = null
    try {
      const r = await ctx.run(prWaitArgv(rt.repo, n))
      end = r.exitCode === 0 ? endOf(r.stdout) : null
    } catch {
      end = null
    }
    if (end === null) gone.push(n)
    else left[n] = end
  }
  return { read: pruned(ctx, { ...read, left, gone }), source }
}

// pruned: drops the ends whose intervention the ledger holds done.
function pruned(ctx: SourceCtx, c: ReleaseCache): ReleaseCache {
  const done = new Set(ctx.state.ledger.filter(e => e.status === 'done').map(e => e.key))
  const left = Object.fromEntries(Object.entries(c.left).filter(([n]) => !done.has(interventionKey(releaseFact(Number(n), 'end')))))
  return { ...c, left, gone: c.gone.filter(n => !done.has(interventionKey(releaseFact(n, 'end')))) }
}
