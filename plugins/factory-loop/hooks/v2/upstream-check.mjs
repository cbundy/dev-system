// Checks the owner authority of a design upstream request against the issue it cites (v2 SPEC 8.7):
// the answer script (bin/factory-answer) runs it between the contract's shape check and the write,
// so an answer whose quote is not in the cited comment (or the issue's body), or whose author the
// reader does not trust, is refused while the designer can still correct it. A `note` source is
// checked by the contract itself (upstream-answer.mjs), so it is never read here.
//
// Pure: it spawns nothing. The caller gives a runner, `(argv) => Promise<{ code, stdout, stderr }>`
// that runs `fabriek-issue-read <argv>` with CALLUM_FLOW_REPO set to the job's repo (and may
// throw). Only a definite conflict is a problem; a read that decides nothing (reader missing, a
// failed exit, unreadable JSON, timeout) leaves the authority unchecked. ES2023 alone, nothing of
// Node. Its types are upstream-check.d.mts's.

import { READ_TIMEOUT_MS } from './wait-check.mjs'
import { quoteIn, sourceKind } from './upstream-answer.mjs'

export { READ_TIMEOUT_MS }

export const UNTRUSTED_EXIT = 3
export const commentArgv = url => ['--json', '--comment', url]
export const issueBodyArgv = issue => ['--json', String(issue)]

function firstLine(text) {
  return String(text ?? '').split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
}

// checkUpstreamAuthority: an upstream answer's owner authority against its cited issue or comment.
// Gives { problems, unchecked }; only an owner authority with a URL source is read.
export async function checkUpstreamAuthority(upstream, job, runner) {
  const a = upstream?.authority
  if (a?.kind !== 'owner') return { problems: [], unchecked: [] }
  const kind = sourceKind(a.source, job)
  if (kind !== 'issue' && kind !== 'comment') return { problems: [], unchecked: [] }
  let result
  try {
    result = await runner(kind === 'issue' ? issueBodyArgv(job.issue) : commentArgv(a.source))
  } catch (err) {
    return { problems: [], unchecked: [err instanceof Error ? err.message : String(err)] }
  }
  if (result === null || typeof result !== 'object') return { problems: [], unchecked: ['fabriek-issue-read gave no result'] }
  if (result.code === UNTRUSTED_EXIT) {
    return { problems: [`authority.source ${a.source} is by an author the factory does not trust, so it is no authority to raise an issue upstream`], unchecked: [] }
  }
  if (result.code !== 0) return { problems: [], unchecked: [firstLine(result.stderr) || `fabriek-issue-read exited ${String(result.code)}`] }
  let o
  try {
    o = JSON.parse(result.stdout)
  } catch {
    return { problems: [], unchecked: ['fabriek-issue-read gave no readable JSON'] }
  }
  let body
  if (kind === 'issue') {
    body = o?.issue?.body
    if (body === null || body === undefined) body = typeof o?.issue === 'object' && o.issue !== null ? '' : undefined
  } else {
    const c = o?.comment
    const onIssue = typeof c?.issue_url === 'string' ? c.issue_url.replace(/\/+$/, '').split('/').pop() : undefined
    if (onIssue === undefined) return { problems: [], unchecked: ['fabriek-issue-read gave no issue for the comment'] }
    if (onIssue !== String(job.issue)) return { problems: [`authority.source ${a.source} is a comment on issue #${onIssue}, not on this issue #${job.issue}`], unchecked: [] }
    body = c.body ?? ''
  }
  if (typeof body !== 'string') return { problems: [], unchecked: ['fabriek-issue-read gave no readable text'] }
  if (quoteIn(a.quote, body)) return { problems: [], unchecked: [] }
  return { problems: [`authority.quote is not in ${a.source}: quote the owner's words from it word for word`], unchecked: [] }
}
