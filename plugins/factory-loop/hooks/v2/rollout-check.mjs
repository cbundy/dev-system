// Checks a design brief's Rollout against the issue's own headings (#987; v2 SPEC 8.7, 13.7.3a): the
// answer script (bin/factory-answer) runs it between the contract's shape check and the write, so a
// brief that says merge over an issue body that still has a `## Run it` heading is refused while the
// designer can still correct it, not first at PR open (fabriek-rollout, act-pr.ts), which stays
// the backstop.
//
// Pure: it spawns nothing. The caller gives a runner, `(argv) => Promise<{ code, stdout, stderr }>`
// that runs `fabriek-issue-read <argv>` (and may throw). Only a definite conflict is a problem; a
// read that decides nothing (reader missing, non-zero exit, unreadable JSON, timeout) leaves the
// Rollout unchecked. ES2023 alone, nothing of Node. Its types are rollout-check.d.mts's.

import { READ_TIMEOUT_MS } from './wait-check.mjs'
import { rolloutOf } from './contracts-work.mjs'

export { READ_TIMEOUT_MS }

export const issueBodyArgv = issue => ['--json', String(issue)]

// hasRunItHeading: fabriek-rollout's test of a body: a heading of level 1-6 whose text is
// `Run it` alone on its line, any case, outside fenced code (a line starting with ``` or ~~~
// toggles a fence).
export function hasRunItHeading(body) {
  let fence = false
  for (const line of String(body).split('\n')) {
    if (/^[ \t]*(```|~~~)/.test(line)) fence = !fence
    else if (!fence && /^#{1,6}[ \t]+run it[ \t]*$/i.test(line)) return true
  }
  return false
}

// conflictReason: the reason fabriek-rollout gives for a merge brief over a Run it heading.
export const conflictReason = issue => `brief says merge but issue #${issue} has a '## Run it' heading`

function firstLine(text) {
  return String(text ?? '').split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
}

// checkRollout: a brief's Rollout against issue `issue`'s body. Gives { problems, unchecked }.
export async function checkRollout(brief, issue, runner) {
  if (rolloutOf(brief) !== 'merge') return { problems: [], unchecked: [] }
  let result
  try {
    result = await runner(issueBodyArgv(issue))
  } catch (err) {
    return { problems: [], unchecked: [err instanceof Error ? err.message : String(err)] }
  }
  if (result === null || typeof result !== 'object' || result.code !== 0) {
    const why = firstLine(result?.stderr) || `fabriek-issue-read exited ${String(result?.code)}`
    return { problems: [], unchecked: [why] }
  }
  let body
  try {
    const o = JSON.parse(result.stdout)
    body = o?.issue?.body
    if (body === null || body === undefined) body = typeof o?.issue === 'object' && o.issue !== null ? '' : undefined
  } catch {
    body = undefined
  }
  if (typeof body !== 'string') return { problems: [], unchecked: ['fabriek-issue-read gave no readable issue body'] }
  if (!hasRunItHeading(body)) return { problems: [], unchecked: [] }
  return {
    problems: [
      `${conflictReason(issue)}. Answer run-it when that Run it stands; when the heading is stale (its Run it moved elsewhere), answer a question asking the owner to rename or remove it, since the designer never edits an issue`,
    ],
    unchecked: [],
  }
}
