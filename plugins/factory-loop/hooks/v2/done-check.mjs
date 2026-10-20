// Checks a design done answer's evidence against GitHub (v2 SPEC 8.7, 13.7.3a): the answer script
// (bin/factory-answer) runs it between the contract's shape check and the write, so a done close
// on a PR that is not merged, or a commit that is not on the default branch, is refused while the
// designer can still correct it. The loop checks the evidence again against origin itself
// (steps-work.ts), so a read that decided nothing here only leaves it unchecked.
//
// Pure: it spawns nothing. The caller gives a runner, `(argv) => Promise<{ code, stdout, stderr }>`
// that runs `gh <argv>` (and may throw). Reads reuse wait-check.mjs's statusOf: only a definite no
// is a problem. ES2023 alone, nothing of Node. Its types are done-check.d.mts's.

import { READ_TIMEOUT_MS, prArgv as waitPrArgv, statusOf } from './wait-check.mjs'

export { READ_TIMEOUT_MS }

export const donePrArgv = (repo, n) => [...waitPrArgv(repo, n).slice(0, -1), 'state,mergedAt,mergeCommit,headRefOid']
export const defaultBranchArgv = repo => ['api', `repos/${repo}`, '--jq', '.default_branch']
export const compareArgv = (repo, base, sha) => ['api', `repos/${repo}/compare/${base}...${sha}`, '--jq', '.status']

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

// onDefault: whether `sha` is on the default branch: 'yes' (behind or identical), 'no' (ahead,
// diverged, or not a commit of the repo), or 'unknown' with a why.
async function onDefault(runner, repo, sha, what) {
  const branch = await read(runner, defaultBranchArgv(repo))
  if (branch.status === 'no') return { problem: `${what}: ${repo} does not exist or has no default branch` }
  const name = branch.status === 'yes' ? String(branch.result.stdout).trim() : ''
  if (branch.status !== 'yes' || name === '') return { unchecked: `${what} (${branch.why || 'gh gave no default branch'})` }
  const cmp = await read(runner, compareArgv(repo, name, sha))
  if (cmp.status === 'no') return { problem: `${what}: ${sha} is not a commit of ${repo}` }
  if (cmp.status === 'unknown') return { unchecked: `${what} (${cmp.why})` }
  const status = String(cmp.result.stdout).trim()
  if (status === 'behind' || status === 'identical') return {}
  if (status === 'ahead' || status === 'diverged') return { problem: `${what}: ${sha} is not on ${name} (compare says ${status}); the work is not merged, so answer a brief instead` }
  return { unchecked: `${what} (gh compare said ${JSON.stringify(status)})` }
}

// checkDone: the evidence of a checked done answer, read for `repo`. Gives { problems, unchecked }.
export async function checkDone(evidence, repo, runner) {
  const problems = []
  const unchecked = []
  const reads = []
  if (typeof evidence.pr === 'number') {
    reads.push(
      (async () => {
        const what = `evidence.pr ${evidence.pr}`
        const pr = await read(runner, donePrArgv(repo, evidence.pr))
        if (pr.status === 'no') return problems.push(`${what}: PR #${evidence.pr} does not exist in ${repo}`)
        if (pr.status === 'unknown') return unchecked.push(`${what} (${pr.why})`)
        let o
        try {
          o = JSON.parse(pr.result.stdout)
        } catch {
          return unchecked.push(`${what} (gh gave no readable PR state)`)
        }
        const merged = o.state === 'MERGED' && o.mergedAt !== null && o.mergedAt !== undefined
        if (!merged) problems.push(`${what}: PR #${evidence.pr} of ${repo} is ${String(o.state).toLowerCase()}, not merged; answer done only for work already merged`)
      })(),
    )
  }
  if (typeof evidence.commit === 'string') {
    reads.push(
      (async () => {
        const what = `evidence.commit ${evidence.commit}`
        const there = await onDefault(runner, repo, evidence.commit, what)
        if (there.problem !== undefined) problems.push(there.problem)
        else if (there.unchecked !== undefined) unchecked.push(there.unchecked)
      })(),
    )
  }
  await Promise.all(reads)
  return { problems: problems.sort(), unchecked: unchecked.sort() }
}
