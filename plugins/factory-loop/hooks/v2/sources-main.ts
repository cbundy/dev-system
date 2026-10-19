// The `main` source (docs/factory-loop/v2/SPEC.md 2.4, 9.5): the state of the repo's default branch,
// read only to be logged as a `main_state` event (rules-main.ts M1). One read is the head, the
// merged PR it came from (only when the head moved), each active workflow's newest completed run on
// the branch and whether a newer one is queued or running, and the newest deployment of each
// environment at the head with its newest status. It runs in act mode only, every mainEveryMs, and
// reads nothing during a GitHub backoff or once a rate limit met this pass ends the loop's reads
// (checked before each call). When it is skipped or not yet due the last reading stands. One call
// that fails, or whose output is not understood, fails the whole read: `sources.main` says so and
// the pass carries no reading, so a partial read is never shown as green.
//
// Pure parsing and a few reads; the cache lives in observe.ts's V2Cache.
import type { Ms, Source } from '../types'
import { branchHeadArgv, commitPullsArgv, defaultBranchArgv, deploymentStatusArgv, deploymentsArgv, workflowRunsArgv, workflowsArgv } from './argv'
import type { SourceCtx } from './observe'
import type { MainDeployment, MainReading, MainRun, MainWorkflow } from './types'

// What the cache keeps: the default branch (read once per load), the head and the PR it came from
// as the last read that succeeded showed them, when the last read was taken (a failed one too), its
// reading (null when it failed) and the source's state.
export type MainCache = { at: Ms | null; branch: string | null; head: string | null; pr: number | null; reading: MainReading | null; source: Source | null }
export const EMPTY_MAIN: MainCache = { at: null, branch: null, head: null, pr: null, reading: null, source: null }

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)
const isId = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1
const WORD = /^[a-z_]+$/
const SHA = /^[0-9a-f]{40}$/

function json(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return undefined
  }
}

// parseBranch: the default branch name `--jq .default_branch` prints; null when it is not one.
export function parseBranch(stdout: string): string | null {
  const name = stdout.trim()
  return name !== '' && !/\s/.test(name) ? name : null
}

// parseHead: the 40-character sha `--jq .sha` prints; null when it is not one.
export function parseHead(stdout: string): string | null {
  const sha = stdout.trim()
  return SHA.test(sha) ? sha : null
}

// parsePr: the PR a commit came from, from the commit's pull list: the one that is merged and
// whose base is the branch (the newest by number when several are), else `{ pr: null }`; null when
// the output is not that list.
export function parsePr(stdout: string, branch: string): { pr: number | null } | null {
  const doc = json(stdout)
  if (!Array.isArray(doc)) return null
  let pr: number | null = null
  for (const x of doc as unknown[]) {
    if (!isObject(x) || !isId(x.number)) return null
    const base = x.base
    if (typeof x.merged_at === 'string' && x.merged_at !== '' && isObject(base) && base.ref === branch && (pr === null || x.number > pr)) pr = x.number
  }
  return { pr }
}

// parseWorkflows: the active workflows of `actions/workflows`, by id; null when the output is not that list.
export function parseWorkflows(stdout: string): { id: number; name: string }[] | null {
  const doc = json(stdout)
  if (!isObject(doc) || !Array.isArray(doc.workflows)) return null
  const out: { id: number; name: string }[] = []
  for (const x of doc.workflows as unknown[]) {
    if (!isObject(x) || !isId(x.id) || typeof x.name !== 'string' || x.name === '' || typeof x.state !== 'string') return null
    if (x.state === 'active') out.push({ id: x.id, name: x.name })
  }
  return out.sort((a, b) => a.id - b.id)
}

// A run in one of these is not over: a queued, waiting, requested, pending or running one.
const OPEN_STATUSES = ['queued', 'waiting', 'requested', 'pending', 'in_progress']

// parseRuns: from a workflow's runs, newest first as GitHub lists them, the newest completed run
// (null when there is none) and whether a run newer than it is open; null when the output is not
// that list. A re-run in progress is its run with a newer attempt and an open status, so it counts.
export function parseRuns(stdout: string): { run: MainRun | null; running: boolean } | null {
  const doc = json(stdout)
  if (!isObject(doc) || !Array.isArray(doc.workflow_runs)) return null
  let running = false
  for (const x of doc.workflow_runs as unknown[]) {
    if (!isObject(x) || typeof x.status !== 'string') return null
    if (x.status !== 'completed') {
      if (OPEN_STATUSES.includes(x.status)) running = true
      continue
    }
    if (!isId(x.id) || !isId(x.run_attempt) || typeof x.head_sha !== 'string' || !SHA.test(x.head_sha)) return null
    if (typeof x.event !== 'string' || !WORD.test(x.event) || typeof x.conclusion !== 'string' || !WORD.test(x.conclusion)) return null
    return { run: { id: x.id, attempt: x.run_attempt, head: x.head_sha, event: x.event, conclusion: x.conclusion }, running }
  }
  return { run: null, running }
}

// parseDeployments: the newest deployment (the highest id) of each environment, by environment;
// null when the output is not that list.
export function parseDeployments(stdout: string): { environment: string; id: number }[] | null {
  const doc = json(stdout)
  if (!Array.isArray(doc)) return null
  const newest = new Map<string, number>()
  for (const x of doc as unknown[]) {
    if (!isObject(x) || !isId(x.id) || typeof x.environment !== 'string' || x.environment === '') return null
    const seen = newest.get(x.environment)
    if (seen === undefined || x.id > seen) newest.set(x.environment, x.id)
  }
  return [...newest].map(([environment, id]) => ({ environment, id })).sort((a, b) => (a.environment < b.environment ? -1 : a.environment > b.environment ? 1 : 0))
}

// parseStatus: the state of a deployment's newest status, or `{ state: null }` when it has none;
// null when the output is not the list of statuses.
export function parseStatus(stdout: string): { state: string | null } | null {
  const doc = json(stdout)
  if (!Array.isArray(doc)) return null
  if (doc.length === 0) return { state: null }
  const first: unknown = doc[0]
  return isObject(first) && typeof first.state === 'string' && WORD.test(first.state) ? { state: first.state } : null
}

// The read ended before it began or part way: a rate limit met this pass.
class Limited extends Error {}

// readMain: the new cache, and the source's state.
export async function readMain(ctx: SourceCtx, kept: MainCache): Promise<{ read: MainCache; source: Source }> {
  const { rt, now } = ctx
  const stood = (): { read: MainCache; source: Source } => ({ read: kept, source: kept.source ?? { ok: true, at: kept.at ?? now } })
  if (rt.mode !== 'act') return stood()
  const s = ctx.state
  const blocked = (s.githubBackoffUntil !== null && now < s.githubBackoffUntil) || ctx.limited()
  const due = kept.at === null || now - kept.at >= rt.config.mainEveryMs
  if (blocked || !due) return stood()
  const repo = rt.repo
  // call: one command's output; a rate limit met since the last call ends the read, a failure fails it
  const call = async (argv: string[]): Promise<string> => {
    if (ctx.limited()) throw new Limited()
    const r = await ctx.run(argv)
    if (r.exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(' ')} exited ${r.exitCode}`)
    return r.stdout
  }
  const understood = <T>(v: T | null, what: string): T => {
    if (v === null) throw new Error(`${what} was not understood`)
    return v
  }
  try {
    const branch = kept.branch ?? understood(parseBranch(await call(defaultBranchArgv(repo))), 'the default branch')
    const head = understood(parseHead(await call(branchHeadArgv(repo, branch))), 'the head commit')
    const pr = head === kept.head ? kept.pr : understood(parsePr(await call(commitPullsArgv(repo, head)), branch), 'the head commit\'s pull requests').pr
    const workflows: MainWorkflow[] = []
    for (const w of understood(parseWorkflows(await call(workflowsArgv(repo))), 'the workflow list')) {
      const runs = understood(parseRuns(await call(workflowRunsArgv(repo, w.id, branch))), `the runs of workflow ${w.id}`)
      workflows.push({ id: w.id, name: w.name, ...runs })
    }
    const deployments: MainDeployment[] = []
    for (const d of understood(parseDeployments(await call(deploymentsArgv(repo, head))), 'the deployment list')) {
      deployments.push({ ...d, state: understood(parseStatus(await call(deploymentStatusArgv(repo, d.id))), `the status of deployment ${d.id}`).state })
    }
    const source: Source = { ok: true, at: now }
    return { read: { at: now, branch, head, pr, reading: { observedAt: new Date(now).toISOString(), branch, head, pr, workflows, deployments }, source }, source }
  } catch (e) {
    if (e instanceof Limited) return stood()
    const source: Source = { ok: false, at: null, error: e instanceof Error ? e.message : String(e) }
    return { read: { ...kept, at: now, reading: null, source }, source }
  }
}
