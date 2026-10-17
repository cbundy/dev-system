// The milestone and release reads of one observe pass: the Next release milestone's counts, and,
// while it qualifies for the release review (a closed item, no open one), the last release tag and
// the oldest merge since it (O3's fields). Each is read on the milestone cadence; a failed read
// keeps the last reading and never blocks a wake.
import { parseCommitDate, parseMilestone, parseOldestMerge, parseReleaseTag } from './parse'
import type { Milestone, ReleaseInfo } from './types'

type Timed<T> = { at: number; value: T }
type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
export type MilestoneCache = { milestone?: Timed<Milestone | null>; release?: Timed<ReleaseInfo> }

// readRelease: gh only (a local checkout's refs may be stale). The tag commit's date, not the
// release's publishedAt, so a PR merged between tagging and publishing counts. No release yet:
// tag null, and every merge counts.
async function readRelease(run: Run, repo: string, base: string | null): Promise<ReleaseInfo | null> {
  const view = await run(['gh', 'release', 'view', '--repo', repo, '--json', 'tagName'])
  let tag: string | null = null
  let since: number | null = null
  if (view.exitCode === 0) {
    tag = parseReleaseTag(view.stdout)
    if (tag === null) return null
    const c = await run(['gh', 'api', `repos/${repo}/commits/${tag}`, '--jq', '.commit.committer.date'])
    since = c.exitCode === 0 ? parseCommitDate(c.stdout) : null
    if (since === null) return null
  } else if (!/release not found/i.test(view.stderr)) {
    return null
  }
  const search = since === null ? [] : ['--search', `merged:>=${new Date(since).toISOString()}`]
  const list = await run(['gh', 'pr', 'list', '--repo', repo, '--state', 'merged', ...(base === null ? [] : ['--base', base]), ...search, '--json', 'mergedAt', '--limit', '100'])
  const oldest = list.exitCode === 0 ? parseOldestMerge(list.stdout) : undefined
  return oldest === undefined ? null : { tag, oldest }
}

export async function readMilestone(
  cache: MilestoneCache,
  o: { now: number; every: number; repo: string; base: string | null; run: Run },
): Promise<void> {
  // nothing printed means the repo has not opted in
  if (cache.milestone === undefined || o.now - cache.milestone.at >= o.every) {
    try {
      const r = await o.run(['callum-flow-milestone', 'show', 'next'])
      if (r.exitCode === 0) cache.milestone = { at: o.now, value: parseMilestone(r.stdout) }
    } catch {
      // leave the last reading
    }
  }
  const ms = cache.milestone?.value ?? null
  if (ms !== null && ms.closed > 0 && ms.open === 0 && (cache.release === undefined || o.now - cache.release.at >= o.every)) {
    try {
      const info = await readRelease(o.run, o.repo, o.base)
      if (info !== null) cache.release = { at: o.now, value: info }
    } catch {
      // leave the last reading
    }
  }
}
