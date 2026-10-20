// The `prs` source (docs/factory-loop/v2/SPEC.md 2.4): for each record in reviewing or the merge
// queue whose life has a PR (rules-review.ts lifePr: the record's, else the one the life's done
// ensure named, 8.1, so a PR the ensure just opened is read on the next pass), the PR
// (callum-flow-issue-read --json --pr <n>: state, merged, merged head, closedAt, head,
// mergeable_state, author, base commit), its check runs (gh pr checks <n> --repo R --json
// name,state,bucket,startedAt,completedAt,link, the run id from the link) plus its workflow runs
// (gh api repos/R/actions/runs?head_sha=H, the latest per workflow and event, a synthetic check
// for a run no visible check shows: one with no job yet is in no `gh pr checks` view) and, when the head moved,
// its patch id (8.4: callum-flow-patch-id <head> <default branch>, kept per head, so it is computed
// once); main's head on origin when a merge-queue PR is open, for Q1 (9.2); and the time
// observe first saw each head (heads:<repo>), whose entries go when their PR closes or its record
// does. Reads start in 2.4's order, up to 4 at once (PR_READ_CONCURRENCY), their results kept in it too: the queue's
// head first, then the other records in reviewing and the merge queue, for at most ctx.prBudget records (K, a budget of its own; none during a GitHub
// backoff), and stop at a rate limit met this pass (ctx.limited). A PR whose read fails in any
// part (the PR, its checks, its workflow runs, its patch id) is left out and listed in `unread` with why (and whether
// the reader refused it for an untrusted author, exit 3): only its own record waits on it, never
// the others, so the source fails only when `cut` says why reads stopped before every record was
// read. The rules read a missing PR as not read, never as a fact, except an untrusted author's,
// which is one (9.3, policy). A PR is read only when its read is due (observe.ts readDue): until
// then an earlier pass's view stands for it (ctx.kept), with its own read time.
import type { RunResult } from '../exec'
import type { LedgerEntry, Ms, Source } from '../types'
import { jobIdOf } from './refused'
import { checkRunAnnotationsArgv, lsRemoteArgv, patchIdArgv, prChecksArgv, prReadArgv, prRunsArgv, runJobsArgv } from './argv'
import type { SourceCtx } from './observe'
import { excludedOf, queueOf } from './rules-queue'
import { lifePr } from './rules-review'
import type { HeadSeen, IssueRecord } from './types'

export type CheckRun = {
  name: string
  state: string
  // refused: a GitHub Actions job GitHub did not start (the account's billing, not the code), see notStartedOf
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel' | 'refused'
  startedAt: number | null
  completedAt: number | null
  runId: string | null
  link: string | null
  // GitHub's own message for a refused job, clipped to REFUSED_MAX
  refusedWhy?: string | null
}

export type PrView = {
  pr: number
  issue: number
  state: 'open' | 'closed' | 'merged'
  head: string | null
  mergedHead: string | null
  closedAt: string | null
  mergeable: string | null
  author: string | null
  // the commit of main the PR's head was last based on (the REST pull's base.sha)
  base: string | null
  // the branch the PR targets (the REST pull's base.ref)
  baseRef: string | null
  // the PR's label names; null when the read did not show them
  labels: string[] | null
  checks: CheckRun[]
  patch: string | null
  readAt: number
}

// A PR whose read was tried this pass and failed: why, whether the reader refused it because its
// author is not trusted (callum-flow-issue-read exit 3), and since when its reads have failed: the
// first of the passes in a row that tried it and failed (ctx.unread, the last pass's), which the
// rules' bound on its wait counts from, so one failed read holds and only one that keeps failing
// ends the step.
export type PrUnread = { pr: number; issue: number; why: string; untrusted: boolean; since: Ms }

// main: the default branch and its head on origin, read when a merge-queue PR is open (sha
// null when that read failed); absent when nothing needed it. unread: the PRs tried that did not
// read. cut: why the reads stopped before every record's PR was tried (a GitHub rate limit, or no
// budget during a backoff); absent when none was left untried.
export type PrsRead = { prs: PrView[]; main?: { branch: string; sha: string | null } | null; unread?: PrUnread[]; cut?: string }

export const EMPTY_PRS: PrsRead = { prs: [] }

const READ_MS = 60_000
// a patch id fetches the head and main first
const PATCH_MS = 120_000

// --- parsing what the CLIs print ----------------------------------------------------------------------

// The REST pull object as callum-flow-issue-read --json --pr prints it ({ pr, stripped }), read
// for what the loop needs; null when it does not read.
export type Pull = { state: PrView['state']; head: string | null; mergedHead: string | null; closedAt: string | null; mergeable: string | null; author: string | null; base: string | null; baseSha: string | null; labels: string[] | null }

// labelsOf: the names of a REST pull's labels; null when the field is missing or is not a list of
// named objects (the hold then fails closed).
function labelsOf(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const names: string[] = []
  for (const l of v) {
    const n = l !== null && typeof l === 'object' ? (l as Record<string, unknown>).name : undefined
    if (typeof n !== 'string' || n === '') return null
    names.push(n)
  }
  return names
}

export function pullOf(json: string): Pull | null {
  let o: Record<string, unknown>
  try {
    const top = JSON.parse(json) as Record<string, unknown> | null
    const pr = top?.pr
    if (pr === null || typeof pr !== 'object' || Array.isArray(pr)) return null
    o = pr as Record<string, unknown>
  } catch {
    return null
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
  const sub = (v: unknown, k: string): unknown => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined)
  if (o.state !== 'open' && o.state !== 'closed') return null
  const head = str(sub(o.head, 'sha'))
  const merged = o.merged === true || str(o.merged_at) !== null
  return {
    state: merged ? 'merged' : o.state,
    head,
    mergedHead: merged ? head : null,
    closedAt: str(o.closed_at),
    mergeable: str(o.mergeable_state)?.toLowerCase() ?? null,
    author: str(sub(o.user, 'login')),
    base: str(sub(o.base, 'ref')),
    baseSha: str(sub(o.base, 'sha')),
    labels: labelsOf(o.labels),
  }
}

// the buckets `gh pr checks` names; `refused` is the loop's own (classifyRefused)
const BUCKETS: readonly CheckRun['bucket'][] = ['pass', 'fail', 'pending', 'skipping', 'cancel']

// timeOf: a check's start or end; GitHub gives the zero time for one not started or not done.
function timeOf(v: unknown): Ms | null {
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN
  return Number.isFinite(t) && t > 0 ? t : null
}

// checksOf: the head's check runs from `gh pr checks --json`, which exits 8 while one is pending
// and 1 when one failed, so the output decides, not the exit; a head with no check yet is an
// empty list. null when it does not read.
export function checksOf(r: RunResult): CheckRun[] | null {
  let list: unknown
  try {
    list = JSON.parse(r.stdout)
  } catch {
    return /no checks reported/i.test(`${r.stderr}\n${r.stdout}`) ? [] : null
  }
  if (!Array.isArray(list)) return null
  const out: CheckRun[] = []
  for (const raw of list) {
    const c = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    if (typeof c.name !== 'string') return null
    const link = typeof c.link === 'string' && c.link !== '' ? c.link : null
    out.push({
      name: c.name,
      state: typeof c.state === 'string' ? c.state : '',
      // a bucket gh does not name waits, bounded like any pending check
      bucket: BUCKETS.find(b => b === c.bucket) ?? 'pending',
      startedAt: timeOf(c.startedAt),
      completedAt: timeOf(c.completedAt),
      runId: /\/actions\/runs\/(\d+)/.exec(link ?? '')?.[1] ?? null,
      link,
    })
  }
  return out
}

export type WorkflowRun = {
  id: string
  name: string
  kind: 'pending' | 'done' | 'fail' | 'cancel'
  link: string | null
  startedAt: Ms | null
  completedAt: Ms | null
}

// runsOf: the head's workflow runs from `gh api repos/R/actions/runs?head_sha=H&per_page=100`,
// the latest run per (workflow_id, event) only (the highest run id; an older one a newer run
// replaced, for example one concurrency cancelled, is ignored), each classified. null when the
// read fails, does not parse, or lists fewer runs than total_count (fail closed).
export function runsOf(r: RunResult): WorkflowRun[] | null {
  if (r.exitCode !== 0) return null
  let o: unknown
  try {
    o = JSON.parse(r.stdout)
  } catch {
    return null
  }
  if (o === null || typeof o !== 'object') return null
  const { total_count: total, workflow_runs: list } = o as Record<string, unknown>
  if (!Array.isArray(list) || typeof total !== 'number' || total > list.length) return null
  const latest = new Map<string, { n: number; run: WorkflowRun }>()
  for (const raw of list) {
    const x = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    if (typeof x.id !== 'number' || !Number.isInteger(x.id)) return null
    const name = typeof x.name === 'string' && x.name !== '' ? x.name : typeof x.path === 'string' ? x.path : `workflow ${String(x.workflow_id)}`
    const status = typeof x.status === 'string' ? x.status : ''
    const conclusion = typeof x.conclusion === 'string' ? x.conclusion : null
    let kind: WorkflowRun['kind'] = 'pending'
    if (status === 'completed') {
      if (conclusion === 'success' || conclusion === 'skipped' || conclusion === 'neutral') kind = 'done'
      else if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure') kind = 'fail'
      else if (conclusion === 'cancelled') kind = 'cancel'
    }
    const link = typeof x.html_url === 'string' && x.html_url !== '' ? x.html_url : null
    const run: WorkflowRun = {
      id: String(x.id),
      name,
      kind,
      link,
      startedAt: timeOf(x.run_started_at) ?? timeOf(x.created_at),
      completedAt: status === 'completed' ? timeOf(x.updated_at) : null,
    }
    const key = `${String(x.workflow_id)}\u0000${String(x.event)}`
    const seen = latest.get(key)
    if (seen === undefined || x.id > seen.n) latest.set(key, { n: x.id, run: run })
  }
  return [...latest.values()].map(v => v.run)
}

// withRuns: the visible checks plus one synthetic check for each latest run whose state no visible
// check of that run shows (a run with no job yet): a pending run when no check of it is pending,
// a failed or cancelled one when no check of it is fail or cancel.
export function withRuns(checks: readonly CheckRun[], runs: readonly WorkflowRun[]): CheckRun[] {
  const out = [...checks]
  for (const run of runs) {
    if (run.kind === 'done') continue
    const mine = checks.filter(c => c.runId === run.id)
    const shown = run.kind === 'pending' ? mine.some(c => c.bucket === 'pending') : mine.some(c => c.bucket === 'fail' || c.bucket === 'cancel')
    if (shown) continue
    out.push({
      name: `${run.name} (workflow run, no job yet)`,
      state: run.kind === 'pending' ? 'PENDING' : run.kind === 'fail' ? 'FAILURE' : 'CANCELLED',
      bucket: run.kind,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      runId: run.id,
      link: run.link,
    })
  }
  return out
}

// --- refused jobs (docs/factory-loop/v2/SPEC.md 8.5, "Refused jobs") --------------------------------------

export const REFUSED_MAX = 200
// the start of the annotation GitHub puts on a job it did not start for the account's sake
const NOT_STARTED = 'The job was not started'

// A latest job of a run, as far as the classification reads it.
export type RunJob = { id: string; failed: boolean; steps: number; runnerless: boolean }

// jobsOf: the latest jobs of a run from `gh api repos/R/actions/runs/<run>/jobs?filter=latest&per_page=100`.
// null when the read fails, does not parse, or lists fewer jobs than total_count (fail closed).
export function jobsOf(r: RunResult): RunJob[] | null {
  if (r.exitCode !== 0) return null
  let o: unknown
  try {
    o = JSON.parse(r.stdout)
  } catch {
    return null
  }
  if (o === null || typeof o !== 'object') return null
  const { total_count: total, jobs: list } = o as Record<string, unknown>
  if (!Array.isArray(list) || typeof total !== 'number' || total > list.length) return null
  const out: RunJob[] = []
  for (const raw of list) {
    const x = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    if (typeof x.id !== 'number' || !Number.isInteger(x.id)) return null
    const runner = x.runner_id === 0 || x.runner_id === null || x.runner_id === undefined
    const named = typeof x.runner_name === 'string' && x.runner_name !== ''
    out.push({
      id: String(x.id),
      failed: x.status === 'completed' && x.conclusion === 'failure',
      steps: Array.isArray(x.steps) ? x.steps.length : 1,
      runnerless: runner && !named,
    })
  }
  return out
}

// notStartedOf: GitHub's message when a check run's annotations say the job was not started (the
// account's payments failed or its spending limit is reached), clipped; null when none says so, or
// the read fails or does not parse (the job then stays failed).
export function notStartedOf(r: RunResult): string | null {
  if (r.exitCode !== 0) return null
  let list: unknown
  try {
    list = JSON.parse(r.stdout)
  } catch {
    return null
  }
  if (!Array.isArray(list)) return null
  for (const raw of list) {
    const x = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const m = typeof x.message === 'string' ? x.message.replace(/\s+/g, ' ').trim() : ''
    if (m.startsWith(NOT_STARTED)) return m.length > REFUSED_MAX ? `${m.slice(0, REFUSED_MAX - 3)}...` : m
  }
  return null
}

// A job's classification never changes (a re-run makes a new job id): its refusal message, or null
// when it failed on its own. Kept by repo and job id, like PATCHES.
const JOBS = new Map<string, string | null>()

type Failed = { why: string }

// classifyRefused: the failed checks of Actions runs, with a job id, that GitHub refused to start
// (zero steps, no runner, and the annotation "The job was not started ...") become `refused`. One
// jobs read per run with checks not yet classified, one annotations read per zero-step, runnerless
// failed job. A read that fails or does not parse fails the PR's read (fail closed: never red,
// never green on a guess).
async function classifyRefused(ctx: SourceCtx, checks: CheckRun[]): Promise<CheckRun[] | Failed> {
  const repo = ctx.rt.repo
  const fresh = checks.filter(c => c.bucket === 'fail' && c.runId !== null && jobIdOf(c.link) !== null && !JOBS.has(`${repo} ${jobIdOf(c.link)}`))
  for (const runId of new Set(fresh.map(c => c.runId))) {
    if (runId === null) continue
    const w = await ctx.run(runJobsArgv(repo, runId), undefined, READ_MS).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
    const jobs = jobsOf(w)
    if (jobs === null) return { why: `gh api actions/runs/${runId}/jobs exit ${w.exitCode}: ${lastLine(w) || 'the jobs do not read whole'}` }
    for (const c of fresh.filter(x => x.runId === runId)) {
      const id = jobIdOf(c.link) ?? ''
      const job = jobs.find(j => j.id === id)
      // a job the latest attempt does not list is an older attempt's: failed, and read again next time
      if (job === undefined) continue
      if (!job.failed || job.steps > 0 || !job.runnerless) {
        JOBS.set(`${repo} ${id}`, null)
        continue
      }
      const a = await ctx.run(checkRunAnnotationsArgv(repo, id), undefined, READ_MS).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
      if (a.exitCode !== 0) return { why: `gh api check-runs/${id}/annotations exit ${a.exitCode}: ${lastLine(a)}` }
      let parses = true
      try {
        parses = Array.isArray(JSON.parse(a.stdout))
      } catch {
        parses = false
      }
      if (!parses) return { why: `the annotations of job ${id} do not parse` }
      JOBS.set(`${repo} ${id}`, notStartedOf(a))
    }
  }
  return checks.map(c => {
    const why = c.bucket === 'fail' ? JOBS.get(`${repo} ${jobIdOf(c.link)}`) : undefined
    return why === undefined || why === null ? c : { ...c, bucket: 'refused', refusedWhy: why }
  })
}

// shaOf: the head `git ls-remote origin refs/heads/<branch>` prints, or null.
export function shaOf(stdout: string, branch: string): string | null {
  for (const line of stdout.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/)
    if (ref === `refs/heads/${branch}` && sha !== undefined && /^[0-9a-f]{40,64}$/.test(sha)) return sha
  }
  return null
}

// --- one pass's reads ----------------------------------------------------------------------------------

// The patch ids computed, by repo, base and head: a head's patch id is fixed once its merge base
// is, so it is computed when the head moves and kept while the head is.
const PATCHES = new Map<string, string>()

// prRecords: the records whose PR the source reads, each with its life's PR (lifePr), in 2.4's
// order: the queue's head, then the other records in reviewing and the merge queue, oldest seq
// first.
export function prRecords(records: readonly IssueRecord[], excluded: readonly number[], ledger: readonly LedgerEntry[]): (IssueRecord & { pr: number })[] {
  const head = queueOf(records, excluded)[0]
  const rank = (r: IssueRecord) => (r === head ? 0 : 1)
  return records
    .filter(r => r.state === 'reviewing' || r.state === 'merge-queue')
    .sort((a, b) => rank(a) - rank(b) || a.seqAt - b.seqAt || a.issue - b.issue)
    .flatMap(r => {
      const pr = lifePr(ledger, r)
      return pr === null ? [] : [{ ...r, pr }]
    })
}

// The most PR reads in flight at once.
export const PR_READ_CONCURRENCY = 4

// readPrs: the PRs of the records that have one, main's head when a merge-queue PR is open, and
// the heads first seen, updated.
export async function readPrs(ctx: SourceCtx): Promise<{ read: PrsRead; source: Source; heads: Record<string, HeadSeen> }> {
  const now = ctx.now
  const want = prRecords(ctx.records, (ctx.reads === undefined ? ctx.state.control.paused : excludedOf(ctx.records, ctx.state.control.paused, ctx.reads, ctx.kept)), ctx.state.ledger)
  const kept = ctx.kept.filter(v => want.some(r => r.pr === v.pr && r.issue === v.issue))
  const due = want.filter(r => !kept.some(v => v.pr === r.pr && v.issue === r.issue))
  const checkout = ctx.state.checkout
  const defaultBranch = checkout !== null && !('error' in checkout) ? checkout.defaultBranch : null
  const prs: PrView[] = []
  const unread: PrUnread[] = []
  let cut: string | undefined
  if (due.length > 0 && ctx.prBudget <= 0) cut = 'GitHub rate limit: no PR is read this pass'
  // up to PR_READ_CONCURRENCY workers take the next record from a shared cursor; each checks the
  // rate limit before it starts one, and the results are placed by index, so 2.4's order holds
  const todo = due.slice(0, Math.max(0, ctx.prBudget))
  const slots: ({ v: Awaited<ReturnType<typeof readOne>> } | undefined)[] = todo.map(() => undefined)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < todo.length && !ctx.limited()) {
      const i = next++
      const r = todo[i]!
      slots[i] = { v: await readOne(ctx, r, defaultBranch).catch((err: unknown) => ({ why: `the PR read threw: ${String(err).slice(0, 200)}`, untrusted: false })) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PR_READ_CONCURRENCY, todo.length) }, worker))
  todo.forEach((r, i) => {
    const slot = slots[i]
    if (slot === undefined) {
      cut = 'a GitHub rate limit met this pass ended the PR reads'
      return
    }
    const v = slot.v
    if ('why' in v) {
      const since = ctx.unread.find(u => u.pr === r.pr && u.issue === r.issue)?.since ?? now
      unread.push({ pr: r.pr, issue: r.issue, why: v.why, untrusted: v.untrusted, since })
      return
    }
    prs.push(v)
  })
  prs.push(...kept)
  let main: PrsRead['main'] = null
  const queued = prs.findIndex(v => v.state === 'open' && want.some(r => r.pr === v.pr && r.state === 'merge-queue'))
  // the default branch's name, the head's base when the main checkout's read failed
  const branch = defaultBranch ?? prs[queued]?.baseRef ?? null
  if (queued >= 0 && branch !== null && !ctx.limited()) {
    const r = await ctx.run(lsRemoteArgv(branch), undefined, READ_MS).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
    // a sha that did not read holds that head alone (rules-queue.ts update)
    main = { branch, sha: r.exitCode === 0 ? shaOf(r.stdout, branch) : null }
  }
  const heads = headsOf(ctx.heads, ctx.records, prs, now, ctx.state.ledger)
  for (const k of [...PATCHES.keys()]) {
    const sha = k.split(' ').at(-1) ?? ''
    if (heads[sha] === undefined) PATCHES.delete(k)
  }
  const source: Source = cut === undefined ? { ok: true, at: now } : { ok: false, at: now, error: cut }
  const read: PrsRead = { prs, main }
  if (unread.length > 0) read.unread = unread
  if (cut !== undefined) read.cut = cut
  return { read, source, heads }
}

// readOne: one record's PR: the PR itself, and for an open one its checks and its head's patch id.
async function readOne(ctx: SourceCtx, r: IssueRecord & { pr: number }, defaultBranch: string | null): Promise<PrView | { why: string; untrusted: boolean }> {
  const failed = (why: string, untrusted = false) => ({ why, untrusted })
  const read = await ctx.run(prReadArgv(r.pr), undefined, READ_MS).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  if (read.exitCode === 3) return failed('not by a trusted author (callum-flow-issue-read exit 3)', true)
  if (read.exitCode !== 0) return failed(`callum-flow-issue-read exit ${read.exitCode}: ${lastLine(read)}`)
  const pull = pullOf(read.stdout)
  if (pull === null) return failed('the PR read does not parse')
  let checks: CheckRun[] = []
  let patch: string | null = null
  if (pull.state === 'open') {
    const c = await ctx.run(prChecksArgv(ctx.rt.repo, r.pr), undefined, READ_MS).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
    const parsed = checksOf(c)
    if (parsed === null) return failed(`gh pr checks exit ${c.exitCode}: ${lastLine(c)}`)
    checks = parsed
    if (pull.head !== null) {
      const w = await ctx.run(prRunsArgv(ctx.rt.repo, pull.head), undefined, READ_MS).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
      const runs = runsOf(w)
      if (runs === null) return failed(`gh api actions/runs exit ${w.exitCode}: ${lastLine(w) || 'the workflow runs do not read whole'}`)
      const classified = await classifyRefused(ctx, withRuns(parsed, runs))
      if ('why' in classified) return failed(classified.why)
      checks = classified
    }
    const base = defaultBranch ?? pull.base
    if (pull.head !== null && base !== null) {
      const p = await patchOf(ctx, pull.head, base)
      if (typeof p !== 'string') return failed(p.why)
      patch = p
    }
  }
  return { pr: r.pr, issue: r.issue, state: pull.state, head: pull.head, mergedHead: pull.mergedHead, closedAt: pull.closedAt, mergeable: pull.mergeable, author: pull.author, base: pull.baseSha, baseRef: pull.base, labels: pull.labels, checks, patch, readAt: ctx.now }
}

async function patchOf(ctx: SourceCtx, head: string, base: string): Promise<string | { why: string }> {
  const key = `${ctx.rt.repo} ${base} ${head}`
  const kept = PATCHES.get(key)
  if (kept !== undefined) return kept
  const r = await ctx.run(patchIdArgv(head, base), undefined, PATCH_MS).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  const id = r.stdout.trim()
  if (r.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(id)) return { why: `the patch id of ${head.slice(0, 7)} did not compute: ${lastLine(r) || `exit ${r.exitCode}`}` }
  PATCHES.set(key, id)
  return id
}

// headsOf: the heads first seen (2.4): an open PR's head the first time it is read; a head goes
// when its PR is read closed or merged, or its record closed (a closed record stays in the store
// for a week). A record's PR is its life's (lifePr). A head whose PR no record names stays:
// records that could not be read are no reason to forget when a head was first seen.
export function headsOf(before: Readonly<Record<string, HeadSeen>>, records: readonly IssueRecord[], prs: readonly PrView[], now: Ms, ledger: readonly LedgerEntry[]): Record<string, HeadSeen> {
  const prsOf = (rs: IssueRecord[]) => rs.flatMap(r => lifePr(ledger, r) ?? [])
  const live = new Set(prsOf(records.filter(r => r.state !== 'closed')))
  const closed = new Set(prsOf(records.filter(r => r.state === 'closed')).filter(pr => !live.has(pr)))
  const ended = new Set(prs.filter(v => v.state !== 'open').map(v => v.pr))
  const out: Record<string, HeadSeen> = {}
  for (const [sha, h] of Object.entries(before)) if (!closed.has(h.pr) && !ended.has(h.pr)) out[sha] = h
  for (const v of prs) if (v.state === 'open' && v.head !== null && out[v.head] === undefined) out[v.head] = { pr: v.pr, at: now }
  return out
}

function lastLine(r: { stdout: string; stderr: string }): string {
  return (r.stderr.trim() || r.stdout.trim()).split('\n').pop()?.slice(0, 200) ?? ''
}
