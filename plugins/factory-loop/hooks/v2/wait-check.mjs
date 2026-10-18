// Checks a design wait's conditions against GitHub (#980; v2 SPEC 8.7, 13.7.3a): the answer
// script (bin/factory-answer) runs it between the contract's shape check and the write, so a wait
// that can never clear (a commit of another repo, a repo with no release, an issue or PR that does
// not exist) is refused while the designer can still correct it.
//
// Pure: it spawns nothing. The caller gives a runner, `(argv) => Promise<{ code, stdout, stderr }>`
// that runs `gh <argv>` (and may throw: gh missing, a timeout), so the answer script and the
// registered answer tools can each supply their own. Every read comes out as a definite yes, a
// definite no or unknown (statusOf); only a definite no is a problem. An unknown read (gh missing,
// network, rate limit, auth, timeout, anything unrecognised) leaves its condition unchecked: the
// answer is still recorded, since the loop re-checks every condition itself.
// ES2023 alone, nothing of Node. Its types are wait-check.d.mts's.

export const READ_TIMEOUT_MS = 15000

// statusOf: what one finished `gh` read says: 'yes' (exit 0), 'no' (the thing is definitely not
// there: HTTP 404 or 422, "release not found", "Could not resolve to a PullRequest") or 'unknown'.
// A rate limit or an auth error is unknown even when it carries a 403 or 404.
export function statusOf(result) {
  if (result === null || typeof result !== 'object') return 'unknown'
  if (result.code === 0) return 'yes'
  const text = String(result.stderr ?? '')
  if (/rate limit|abuse|bad credentials|authentication|auth login|requires authentication|\(HTTP (401|403|429|5\d\d)\)/i.test(text)) return 'unknown'
  if (/\(HTTP (404|422)\)/.test(text)) return 'no'
  if (/release not found/i.test(text)) return 'no'
  if (/Could not resolve to a PullRequest/i.test(text)) return 'no'
  return 'unknown'
}

export const commitArgv = (repo, sha) => ['api', `repos/${repo}/commits/${sha}`, '--jq', '.sha']
export const releaseArgv = repo => ['release', 'view', '--repo', repo, '--json', 'tagName']
export const issueArgv = (repo, n) => ['api', `repos/${repo}/issues/${n}`, '--jq', '.number']
export const prArgv = (repo, n) => ['pr', 'view', String(n), '--repo', repo, '--json', 'state,mergedAt']

// read: one gh read as a status and a reason for an unknown one; a throwing runner is unknown.
async function read(runner, argv) {
  let result
  try {
    result = await runner(argv)
  } catch (err) {
    return { status: 'unknown', result: null, why: err instanceof Error ? err.message : String(err) }
  }
  const status = statusOf(result)
  const why = status === 'unknown' ? firstLine(result?.stderr) || (result?.code === 0 ? '' : `gh exited ${String(result?.code)}`) : ''
  return { status, result, why }
}

function firstLine(text) {
  return String(text ?? '').split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
}

// checkWait: the conditions of a checked wait answer, read for `repo` (a condition's own `repo`
// wins). Gives { problems, unchecked }: problems are `conditions[i] ...` texts for the definite
// negatives; unchecked are `conditions[i] (why)` texts for the reads that decided nothing.
export async function checkWait(conditions, repo, runner) {
  const problems = []
  const unchecked = []
  const releases = new Map()
  const releaseOf = r => {
    if (!releases.has(r)) releases.set(r, read(runner, releaseArgv(r)))
    return releases.get(r)
  }
  await Promise.all(
    conditions.map(async (c, i) => {
      const at = `conditions[${i}]`
      const r = typeof c.repo === 'string' && c.repo !== '' ? c.repo : repo
      if (c.kind === 'tag-contains') {
        const sha = String(c.sha).toLowerCase()
        const [commit, release] = await Promise.all([read(runner, commitArgv(r, sha)), releaseOf(r)])
        if (commit.status === 'no') problems.push([i, `${at}: ${sha} is not a commit of ${r}; a wait on another repo's release names that repo`])
        else if (release.status === 'no') problems.push([i, `${at}: ${r} has no release yet, so no release tag can ever carry ${sha}`])
        else if (commit.status === 'unknown') unchecked.push([i, `${at} (${commit.why})`])
        else if (release.status === 'unknown') unchecked.push([i, `${at} (${release.why})`])
      } else if (c.kind === 'issue-closed') {
        const issue = await read(runner, issueArgv(r, c.issue))
        if (issue.status === 'no') problems.push([i, `${at}: issue #${c.issue} does not exist in ${r}; name an issue of ${r}`])
        else if (issue.status === 'unknown') unchecked.push([i, `${at} (${issue.why})`])
      } else if (c.kind === 'pr-merged') {
        const pr = await read(runner, prArgv(r, c.pr))
        let status = pr.status
        let closed = false
        if (status === 'yes') {
          try {
            const o = JSON.parse(pr.result.stdout)
            closed = o.state === 'CLOSED' && (o.mergedAt === null || o.mergedAt === undefined)
          } catch {
            status = 'unknown'
            pr.why = 'gh gave no readable PR state'
          }
        }
        if (status === 'no') problems.push([i, `${at}: PR #${c.pr} does not exist in ${r}; name a pull request of ${r}`])
        else if (closed) problems.push([i, `${at}: PR #${c.pr} of ${r} is closed without being merged, so it can never be merged; name another pull request`])
        else if (status === 'unknown') unchecked.push([i, `${at} (${pr.why})`])
      }
    }),
  )
  const byIndex = (a, b) => a[0] - b[0]
  return { problems: problems.sort(byIndex).map(p => p[1]), unchecked: unchecked.sort(byIndex).map(p => p[1]) }
}
