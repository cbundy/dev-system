// The `releasePrs` source (docs/factory-loop/v2/SPEC.md 2.4, 9.1): the open release bump PRs, which
// hold the merge queue's merges for a bounded window from their head's anchor. A bump PR is an open
// PR of this repo (not a fork's) whose head branch starts with the repo's `releaseBranchPrefix`. It
// is read with one `gh pr list` every prEveryMs, and only while the prefix is set, the hold is above
// 0 and some record is in merge-queue; none during a GitHub backoff or after a rate limit. On each
// such read, per listed bump PR, the head commit's time is read once per head (`gh pr view
// --json headRefOid,commits`) and the head's checks (`gh pr checks`); a read that failed keeps the
// last reading of the same head (a new head with none is read as pending, bounded by its window),
// and shows in `sources` when the list failed. A PR that left the list is read once with `gh pr view
// --json state,mergedAt`, for how its hold ended (merged or closed): the PRs to read are those the
// last reading listed and those whose `hold/release/pr<n>/.../start` the ledger holds with no end,
// so a restart loses nothing.
//
// Pure parsing and a few reads; the cache lives in observe.ts's V2Cache.
import type { Ms, Source } from '../types'
import { prChecksArgv, prWaitArgv, releaseHeadArgv, releasePrsArgv } from './argv'
import type { SourceCtx } from './observe'
import type { ReleaseChecks, ReleasePr, ReleasePrsRead } from './release-hold-types'
import { startedOpen, startsOf } from './rules-release-hold'
import { checksOf } from './sources-prs'
import type { CheckRun } from './sources-prs'

// What the cache keeps: the reading, when it was taken, and the PRs that left the list whose end
// is not read yet.
export type ReleaseCache = ReleasePrsRead & { at: Ms | null; gone: number[] }
export const EMPTY_RELEASE: ReleaseCache = { prs: [], left: {}, at: null, gone: [] }

// parseReleasePrs: the open same-repo PRs whose head branch starts with the prefix, from the list
// `gh pr list --json number,headRefName,headRefOid,createdAt,isCrossRepository` prints, each with
// its head and nothing of the head read yet; null when the output is not that list.
export function parseReleasePrs(stdout: string, prefix: string): ReleasePr[] | null {
  try {
    const doc: unknown = JSON.parse(stdout)
    if (!Array.isArray(doc)) return null
    const out: ReleasePr[] = []
    for (const x of doc as unknown[]) {
      if (x === null || typeof x !== 'object') return null
      const p = x as { number?: unknown; headRefName?: unknown; headRefOid?: unknown; createdAt?: unknown; isCrossRepository?: unknown }
      if (typeof p.number !== 'number' || typeof p.headRefName !== 'string' || typeof p.headRefOid !== 'string' || typeof p.createdAt !== 'string') return null
      const createdAt = Date.parse(p.createdAt)
      if (!Number.isFinite(createdAt)) return null
      if (p.isCrossRepository === false && p.headRefName.startsWith(prefix)) out.push({ pr: p.number, branch: p.headRefName, createdAt, head: p.headRefOid, committedAt: null, checkStart: null, checks: null, failed: [] })
    }
    return out
  } catch {
    return null
  }
}

// commitTimeOf: the head commit's committed time, from `gh pr view --json headRefOid,commits`; null
// when the output does not say.
export function commitTimeOf(stdout: string, head: string): Ms | null {
  try {
    const doc: unknown = JSON.parse(stdout)
    const commits = doc !== null && typeof doc === 'object' ? (doc as { commits?: unknown }).commits : null
    if (!Array.isArray(commits)) return null
    for (const c of commits as unknown[]) {
      const x = c !== null && typeof c === 'object' ? (c as { oid?: unknown; committedDate?: unknown }) : {}
      const at = typeof x.committedDate === 'string' ? Date.parse(x.committedDate) : Number.NaN
      if (x.oid === head && Number.isFinite(at)) return at
    }
    return null
  } catch {
    return null
  }
}

// checkStateOf: red once a check failed or was cancelled, pending while one runs or none has
// reported, green when all passed or were skipped; with the earliest start and the failed names.
export function checkStateOf(checks: readonly CheckRun[]): { checks: ReleaseChecks; checkStart: Ms | null; failed: string[] } {
  const failed = checks.filter(c => c.bucket === 'fail' || c.bucket === 'cancel').map(c => c.name)
  const starts = checks.flatMap(c => (c.startedAt === null ? [] : [c.startedAt]))
  const state = failed.length > 0 ? 'red' : checks.length === 0 || checks.some(c => c.bucket === 'pending') ? 'pending' : 'green'
  return { checks: state, checkStart: starts.length === 0 ? null : Math.min(...starts), failed }
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
      const gone = [...new Set([...kept.gone, ...kept.prs.map(p => p.pr), ...startedOpen(s.ledger).map(w => w.pr)])].filter(n => !listed.has(n) && kept.left[n] === undefined)
      read = { prs: await withHeads(ctx, prs, kept.prs), left: kept.left, at: now, gone }
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

// withHeads: each listed PR with its head's commit time (read once per head) and checks (every
// read); a read that failed keeps the last reading of the same head, and a new head has none.
async function withHeads(ctx: SourceCtx, prs: ReleasePr[], kept: ReleasePr[]): Promise<ReleasePr[]> {
  const out: ReleasePr[] = []
  for (const p of prs) {
    const before = kept.find(k => k.pr === p.pr && k.head === p.head)
    let next: ReleasePr = before === undefined ? p : { ...p, committedAt: before.committedAt, checkStart: before.checkStart, checks: before.checks, failed: before.failed }
    if (!ctx.limited()) {
      if (next.committedAt === null) {
        try {
          const r = await ctx.run(releaseHeadArgv(ctx.rt.repo, p.pr))
          if (r.exitCode === 0) next = { ...next, committedAt: commitTimeOf(r.stdout, p.head) }
        } catch {
          // kept: read again on the next pass
        }
      }
      try {
        const c = checksOf(await ctx.run(prChecksArgv(ctx.rt.repo, p.pr)))
        if (c !== null) next = { ...next, ...checkStateOf(c) }
      } catch {
        // kept: the last reading of this head
      }
    }
    out.push(next)
  }
  return out
}

// pruned: drops the ends of the PRs whose every window the ledger holds ended.
function pruned(ctx: SourceCtx, c: ReleaseCache): ReleaseCache {
  const starts = startsOf(ctx.state.ledger)
  const finished = (n: number) => starts.some(w => w.pr === n) && starts.every(w => w.pr !== n || w.ended)
  const left = Object.fromEntries(Object.entries(c.left).filter(([n]) => !finished(Number(n))))
  return { ...c, left, gone: c.gone.filter(n => !finished(n)) }
}
