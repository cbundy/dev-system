// The in-flight paths source (docs/factory-loop/v2/SPEC.md 2.4, epic #995): while config.intakeStamp is
// on, for each record that is not closed and has a pushed head, the top-level paths the branch changed
// against origin's default branch. The overlap factor (score.ts) holds an issue back when the paths
// its stamp expects to touch meet those of another live record.
//
// A successful read is cached by `<issue> <head>`, so each head is read at most once until it moves;
// a failed read gives null for that record this pass and is tried again on a later pass. Nothing is
// read without the switch, without a known default branch, during a GitHub backoff or once a rate
// limit ends this pass's reads (checked before each record, as the other sources do).
import type { SourceCtx } from './observe'
import { catFileArgv, diffNamesArgv, fetchBaseArgv, fetchShaArgv, mergeBaseArgv } from './argv'

// By `<issue> <head>`: the top-level paths a successful read showed.
export type PathsCache = Record<string, string[]>
export type PathsRead = { paths: Record<number, string[] | null>; cache: PathsCache }
export const EMPTY_PATHS: PathsRead = { paths: {}, cache: {} }

const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/

// topLevel: the first segment of each path, de-duplicated and sorted.
export function topLevel(paths: readonly string[]): string[] {
  return [...new Set(paths.map(p => p.trim().split('/')[0] ?? '').filter(p => p !== ''))].sort()
}

// readPaths: the paths of each live record's pushed head; a record with no entry in `paths` was
// skipped (closed, no head, or nothing read this pass), and null is a read that failed.
export async function readPaths(ctx: SourceCtx, cache: PathsCache, blocked: () => boolean): Promise<PathsRead> {
  if (ctx.rt.config.intakeStamp !== 'on') return EMPTY_PATHS
  const checkout = ctx.state.checkout
  const base = checkout === null || 'error' in checkout ? '' : checkout.defaultBranch
  if (base === '') return EMPTY_PATHS
  const paths: Record<number, string[] | null> = {}
  const next: PathsCache = {}
  let baseOk: boolean | null = null
  const ok = async (argv: string[]): Promise<string | null> => {
    try {
      const r = await ctx.run(argv)
      return r.exitCode === 0 ? r.stdout : null
    } catch {
      return null
    }
  }
  for (const r of ctx.records) {
    if (r.state === 'closed' || r.head === null || !SHA.test(r.head)) continue
    const key = `${r.issue} ${r.head}`
    const kept = cache[key]
    if (kept !== undefined) {
      paths[r.issue] = kept
      next[key] = kept
      continue
    }
    if (blocked()) continue
    // the base is fetched once a pass; a fetch that failed leaves every uncached record unread
    baseOk ??= (await ok(fetchBaseArgv(base))) !== null
    if (!baseOk) {
      paths[r.issue] = null
      continue
    }
    if ((await ok(catFileArgv(r.head))) === null) await ok(fetchShaArgv(r.head))
    const mb = (await ok(mergeBaseArgv(base, r.head)))?.trim() ?? ''
    const diff = mb === '' ? null : await ok(diffNamesArgv(mb, r.head))
    if (diff === null) {
      paths[r.issue] = null
      continue
    }
    const read = topLevel(diff.split('\n'))
    paths[r.issue] = read
    next[key] = read
  }
  return { paths, cache: next }
}
