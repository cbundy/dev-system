// The milestone and release reads of one observe pass: the Next release milestone's counts, and,
// while it qualifies for the release review (a closed item, no open one), the last release tag and
// the oldest merge since it (O3's fields). Each is read on the milestone cadence; a failed read
// keeps the last reading and never blocks a wake. While a v2 record waits on a tag-contains
// condition (`tagWanted`), the newest release tag is read on the same cadence even when the
// milestone does not qualify: `gh release view` alone, into `cache.tag`. A condition that names
// another repo reads that repo's newest tag the same way, into `cache.tags[repo]`.
import { parseMilestone, parseOldestMerge, parseReleaseTag, parseTagCommit } from './parse'
import type { Milestone, ReleaseInfo } from './types'

type Timed<T> = { at: number; value: T }
type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
// closed: when the oldest closed issue of the milestone closed (ISO); null: none, the list was full, or the read failed
export type MilestoneCache = { milestone?: Timed<Milestone | null>; release?: Timed<ReleaseInfo>; tag?: Timed<string | null>; tags?: Record<string, Timed<string | null>>; closed?: Timed<string | null> }

// readRelease: gh only (a local checkout's refs may be stale). The tag commit's date, not the
// release's publishedAt, so a PR merged between tagging and publishing counts; the release's own
// bump PR (the tag's commit) does not. No release yet: tag null and oldest unknown (null), and
// so when the list fills the limit (the oldest of the newest merges would understate it).
const LIST_LIMIT = 200
async function readRelease(run: Run, repo: string, base: string | null): Promise<ReleaseInfo | null> {
  const view = await run(['gh', 'release', 'view', '--repo', repo, '--json', 'tagName'])
  if (view.exitCode !== 0) return /release not found/i.test(view.stderr) ? { tag: null, oldest: null } : null
  const tag = parseReleaseTag(view.stdout)
  if (tag === null) return null
  const c = await run(['gh', 'api', `repos/${repo}/commits/${tag}`, '--jq', '.sha,.commit.committer.date'])
  const commit = c.exitCode === 0 ? parseTagCommit(c.stdout) : null
  if (commit === null) return null
  const list = await run([
    'gh', 'pr', 'list', '--repo', repo, '--state', 'merged', ...(base === null ? [] : ['--base', base]),
    '--search', `merged:>=${new Date(commit.at).toISOString()}`, '--json', 'mergedAt,mergeCommit', '--limit', String(LIST_LIMIT),
  ])
  if (list.exitCode !== 0) return null
  const oldest = parseOldestMerge(list.stdout, commit.sha)
  if (oldest === undefined) return null
  return { tag, oldest: (JSON.parse(list.stdout) as unknown[]).length >= LIST_LIMIT ? null : oldest }
}

// readTag: the newest release's tag by gh alone; null when there is no release yet; undefined when
// the read failed (the last reading stands).
async function readTag(run: Run, repo: string): Promise<string | null | undefined> {
  const view = await run(['gh', 'release', 'view', '--repo', repo, '--json', 'tagName'])
  if (view.exitCode !== 0) return /release not found/i.test(view.stderr) ? null : undefined
  return parseReleaseTag(view.stdout) ?? undefined
}

// readOldestClosed: when the oldest closed issue of the Next release milestone closed; null when none
// is closed, when the list filled the limit (the oldest of the newest would understate it) or when the
// read failed.
async function readOldestClosed(run: Run, repo: string): Promise<string | null> {
  const r = await run(['gh', 'issue', 'list', '--repo', repo, '--milestone', 'Next release', '--state', 'closed', '--json', 'closedAt', '--limit', String(LIST_LIMIT)])
  if (r.exitCode !== 0) return null
  let list: unknown
  try {
    list = JSON.parse(r.stdout)
  } catch {
    return null
  }
  if (!Array.isArray(list) || list.length >= LIST_LIMIT) return null
  let oldest: number | null = null
  for (const item of list) {
    const at = typeof item === 'object' && item !== null && typeof (item as { closedAt?: unknown }).closedAt === 'string' ? Date.parse((item as { closedAt: string }).closedAt) : NaN
    if (!Number.isNaN(at) && (oldest === null || at < oldest)) oldest = at
  }
  return oldest === null ? null : new Date(oldest).toISOString()
}

// newestTag: the newest release tag the milestone reads hold: the full release read's or the tag view's, whichever is newer.
// undefined when neither read is held; null when a read showed no release.
export function newestTag(cache: MilestoneCache): string | null | undefined {
  const r = cache.release
  const t = cache.tag
  if (r !== undefined && (t === undefined || r.at >= t.at)) return r.value.tag
  return t === undefined ? undefined : t.value
}

type Waiter = { state: string; wait: readonly { kind: string; repo?: string }[] | null }

// waitsOnTag: whether a record waits on a tag-contains condition of the loop's own repo (the tag
// view is then wanted); a condition naming another repo reads that repo's tag instead (tagRepos).
export function waitsOnTag(records: readonly Waiter[]): boolean {
  return records.some(r => r.state === 'waiting' && (r.wait ?? []).some(c => c.kind === 'tag-contains' && c.repo === undefined))
}

// tagRepos: the distinct other repos that a waiting record's tag-contains condition names, sorted.
export function tagRepos(records: readonly Waiter[]): string[] {
  const out = new Set<string>()
  for (const r of records) if (r.state === 'waiting') for (const c of r.wait ?? []) if (c.kind === 'tag-contains' && c.repo !== undefined) out.add(c.repo)
  return [...out].sort()
}

// repoTags: the newest release tag read of each other repo (null: it has no release yet).
export function repoTags(cache: MilestoneCache): Record<string, string | null> {
  return Object.fromEntries(Object.entries(cache.tags ?? {}).map(([repo, t]) => [repo, t.value]))
}

export async function readMilestone(
  cache: MilestoneCache,
  o: { now: number; every: number; repo: string; base: string | null; run: Run; tagWanted?: boolean; tagRepos?: readonly string[]; backoff?: boolean },
): Promise<void> {
  // nothing printed means the repo has not opted in
  if (cache.milestone === undefined || o.now - cache.milestone.at >= o.every) {
    try {
      const r = await o.run(['fabriek-milestone', 'show', 'next'])
      if (r.exitCode === 0) cache.milestone = { at: o.now, value: parseMilestone(r.stdout) }
    } catch {
      // leave the last reading
    }
  }
  const ms = cache.milestone?.value ?? null
  let releaseRead = false
  if (ms !== null && ms.closed > 0 && ms.open === 0 && (cache.release === undefined || o.now - cache.release.at >= o.every)) {
    try {
      const info = await readRelease(o.run, o.repo, o.base)
      if (info !== null) {
        cache.release = { at: o.now, value: info }
        releaseRead = true
      }
    } catch {
      // leave the last reading
    }
  }
  // the tags of other repos a record waits on, on the same cadence; a repo no record names is dropped
  const repos = o.tagRepos ?? []
  for (const repo of Object.keys(cache.tags ?? {})) if (!repos.includes(repo)) delete cache.tags?.[repo]
  for (const repo of repos) {
    const kept = cache.tags?.[repo]
    if (kept !== undefined && o.now - kept.at < o.every) continue
    try {
      const tag = await readTag(o.run, repo)
      if (tag !== undefined) (cache.tags ??= {})[repo] = { at: o.now, value: tag }
    } catch {
      // leave the last reading
    }
  }
  // the closed-issue read, on the cadence, while the milestone exists; a failed read caches null
  if (ms !== null && o.backoff !== true && (cache.closed === undefined || o.now - cache.closed.at >= o.every)) {
    try {
      cache.closed = { at: o.now, value: await readOldestClosed(o.run, o.repo) }
    } catch {
      cache.closed = { at: o.now, value: null }
    }
  }
  // the tag is read while a record waits on it and whenever the milestone exists (the release log, O4)
  if (o.tagWanted !== true && ms === null) return
  // the full read refreshed the tag; else the tag view alone, on the cadence
  if (releaseRead) {
    cache.tag = { at: o.now, value: cache.release?.value.tag ?? null }
  } else if (o.backoff !== true && (cache.tag === undefined || o.now - cache.tag.at >= o.every)) {
    try {
      const tag = await readTag(o.run, o.repo)
      if (tag !== undefined) cache.tag = { at: o.now, value: tag }
    } catch {
      // leave the last reading
    }
  }
}
